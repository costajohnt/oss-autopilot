/**
 * vet-list records each vetted repo's contribution policy (#2013): read from
 * scout's CONTRIBUTING text only, unreviewed, without replacing a stored
 * reading unless it is a ban.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  vetIssue: vi.fn(),
  setRepoPolicy: vi.fn(),
  verifyIssuesBatch: vi.fn(),
  runParseList: vi.fn(),
  state: { value: {} as Record<string, unknown> },
}));

vi.mock('./scout-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('./scout-bridge.js')>('./scout-bridge.js');
  return { ...actual, createAutopilotScout: vi.fn(async () => ({ vetIssue: mocks.vetIssue })) };
});

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getOctokit: () => ({}),
    requireGitHubToken: () => 'fake-token',
    verifyIssuesBatch: mocks.verifyIssuesBatch,
    getStateManager: () => ({
      getRepoScore: () => {},
      getState: () => mocks.state.value,
      recordPickSnapshots: vi.fn(),
      setRepoPolicy: mocks.setRepoPolicy,
      isGistMode: () => false,
      reloadIfChanged: () => false,
    }),
  };
});

vi.mock('./parse-list.js', () => ({ runParseList: mocks.runParseList, pruneIssueList: vi.fn() }));

import { runVetList } from './vet-list.js';

const BAN = 'We do not accept AI-generated contributions.';
const GATE = 'Comment on the issue and get assigned before opening a PR.';
const NO_MATCH = { matched: false, matchedKeywords: [], sourceFile: null };
const STORED = {
  aiPolicy: 'disclosure-required',
  cla: 'none',
  commitRules: [],
  prGate: 'maintainer-label',
  source: [],
  reviewedByUser: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function candidate(repo: string, rawContent: string, antiLLMPolicy: unknown) {
  return {
    antiLLMPolicy,
    issue: { repo, number: 1, title: 't', url: `https://github.com/${repo}/issues/1`, labels: [] },
    recommendation: 'approve' as const,
    reasonsToApprove: [],
    reasonsToSkip: [],
    projectHealth: {},
    vettingResult: { contributionGuidelines: { rawContent } },
  };
}

function listOf(repos: string[]): void {
  const available = repos.map((repo) => ({
    repo,
    number: 1,
    title: 't',
    tier: 'Pursue',
    url: `https://github.com/${repo}/issues/1`,
  }));
  const counts = { availableCount: repos.length, completedCount: 0, blockedCount: 0 };
  mocks.runParseList.mockResolvedValue({ available, completed: [], blocked: [], ...counts });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyIssuesBatch.mockImplementation(async (_octokit: unknown, items: unknown[]) =>
    items.map((params) => ({ params, error: new Error('verify unavailable in test') })),
  );
  mocks.state.value = { config: { githubUsername: 'me' }, repoPolicies: { 'kept/repo': STORED } };
});

describe('runVetList: repo contribution policy (#2013)', () => {
  it('records each new reading unreviewed, keeps a stored one, and records nothing without a scan', async () => {
    listOf(['new/repo', 'kept/repo', 'nothing/scanned']);
    mocks.vetIssue.mockImplementation(async (url: string) => {
      if (url.includes('new/repo')) return candidate('new/repo', GATE, NO_MATCH);
      if (url.includes('kept/repo')) return candidate('kept/repo', GATE, NO_MATCH);
      return candidate('nothing/scanned', BAN, null);
    });

    const result = await runVetList({ issueListPath: 'issues.md' });

    expect(mocks.setRepoPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.setRepoPolicy).toHaveBeenCalledWith(
      'new/repo',
      expect.objectContaining({ prGate: 'claim-first', reviewedByUser: false }),
    );
    expect(result.results.find((r) => r.issue.repo === 'new/repo')?.policy).toMatchObject({ prGate: 'claim-first' });
    // The row shows the stored reading it kept, not the narrower one it did not record.
    expect(result.results.find((r) => r.issue.repo === 'kept/repo')?.policy).toMatchObject({
      prGate: 'maintainer-label',
    });
  });

  it('records a ban over a stored reading and makes the row a skip', async () => {
    listOf(['kept/repo']);
    mocks.vetIssue.mockResolvedValue(candidate('kept/repo', BAN, NO_MATCH));

    const result = await runVetList({ issueListPath: 'issues.md' });

    expect(mocks.setRepoPolicy).toHaveBeenCalledWith('kept/repo', expect.objectContaining({ aiPolicy: 'banned' }));
    expect(result.results[0].recommendation).toBe('skip');
    expect(result.results[0].reasonsToSkip.join(' ')).toContain('does not accept AI-assisted contributions');
  });

  it('never replaces a record the user set, while it still records others in the same run', async () => {
    mocks.state.value = { config: {}, repoPolicies: { 'kept/repo': { ...STORED, reviewedByUser: true } } };
    listOf(['kept/repo', 'new/repo']);
    mocks.vetIssue.mockImplementation(async (url: string) =>
      candidate(url.includes('kept/repo') ? 'kept/repo' : 'new/repo', BAN, NO_MATCH),
    );

    await runVetList({ issueListPath: 'issues.md' });

    expect(mocks.setRepoPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.setRepoPolicy).toHaveBeenCalledWith('new/repo', expect.objectContaining({ aiPolicy: 'banned' }));
  });
});
