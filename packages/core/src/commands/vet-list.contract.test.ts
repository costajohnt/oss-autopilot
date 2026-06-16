/**
 * --json contract test for the `vet-list` command (#965, #986, #1494).
 *
 * As of #1494 vet-list verifies each entry FIRST (deterministic GraphQL) and
 * derives the list status from that verdict, only falling back to scout's
 * heuristic when verify itself errors. The mixed-status fixture pins every
 * outcome of the new taxonomy:
 *   still_available / at_risk / claimed / own_open_pr / closed / error
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/vet-list.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

const mocks = vi.hoisted(() => ({
  vetIssue: vi.fn(),
  getRepoScore: vi.fn(),
  detectIssueList: vi.fn(),
  runParseList: vi.fn(),
  verifyIssuesBatch: vi.fn(),
}));

vi.mock('./scout-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('./scout-bridge.js')>('./scout-bridge.js');
  return {
    ...actual,
    createAutopilotScout: vi.fn(async () => ({ vetIssue: mocks.vetIssue })),
  };
});

vi.mock('./startup.js', () => ({ detectIssueList: mocks.detectIssueList }));
vi.mock('./parse-list.js', () => ({
  runParseList: mocks.runParseList,
  pruneIssueList: vi.fn(),
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    // parseGitHubUrl + classifyLinkedPR stay real (from actual).
    getOctokit: () => ({}),
    requireGitHubToken: () => 'fake-token',
    verifyIssuesBatch: mocks.verifyIssuesBatch,
    getStateManager: () => ({
      getRepoScore: mocks.getRepoScore,
      getState: () => ({ config: { githubUsername: 'costajohnt' } }),
    }),
  };
});

import { runVetList } from './vet-list.js';
import { ValidationError } from '../core/errors.js';
import type { BatchVerificationResult, IssueAvailabilityVerdict } from '../core/index.js';

const HEALTH_APPROVE = {
  repo: 'owner/repo-a',
  lastCommitAt: '2026-04-15T00:00:00.000Z',
  daysSinceLastCommit: 3,
  openIssuesCount: 10,
  avgIssueResponseDays: 0,
  ciStatus: 'passing' as const,
  isActive: true,
};

/** Build a successful verification batch entry for the given issue. */
function verified(
  repo: string,
  number: number,
  verdict: IssueAvailabilityVerdict,
  overrides: Partial<NonNullable<BatchVerificationResult['verification']>> = {},
): BatchVerificationResult {
  const [owner, name] = repo.split('/');
  return {
    params: { owner, repo: name, number },
    verification: {
      url: `https://github.com/${repo}/issues/${number}`,
      owner,
      repo: name,
      number,
      title: `issue ${number}`,
      state: verdict === 'closed' ? 'closed' : 'open',
      stateReason: verdict === 'closed' ? 'completed' : null,
      closedAt: null,
      assignees: [],
      linkedPRs: [],
      verdict,
      verdictReason: `verdict: ${verdict}`,
      userLogin: 'costajohnt',
      ...overrides,
    },
  };
}

const CLOSING_PR = {
  number: 99,
  url: 'https://github.com/owner/repo/pull/99',
  title: 'a closing PR',
  state: 'open' as const,
  isDraft: false,
  author: 'rival',
  isOwn: false,
  linkType: 'closing' as const,
  updatedAt: '2026-06-01T00:00:00.000Z',
};

describe('vet-list --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.detectIssueList.mockReturnValue({ path: '/fake/issue-list.md' });
    mocks.runParseList.mockResolvedValue({
      available: [
        { repo: 'owner/repo-a', number: 1, title: 'Still available', url: 'https://github.com/owner/repo-a/issues/1' },
        { repo: 'owner/repo-b', number: 2, title: 'Already claimed', url: 'https://github.com/owner/repo-b/issues/2' },
        { repo: 'owner/repo-c', number: 3, title: 'Will error', url: 'https://github.com/owner/repo-c/issues/3' },
        { repo: 'owner/repo-d', number: 4, title: 'At risk', url: 'https://github.com/owner/repo-d/issues/4' },
        { repo: 'owner/repo-e', number: 5, title: 'My open PR', url: 'https://github.com/owner/repo-e/issues/5' },
        { repo: 'owner/repo-f', number: 6, title: 'Closed upstream', url: 'https://github.com/owner/repo-f/issues/6' },
      ],
    });
    mocks.getRepoScore.mockReturnValue({ mergedPRCount: 4, closedWithoutMergeCount: 1, avgResponseDays: 3 });
  });

  it('mixed-status batch output matches the golden shape', async () => {
    // Verify FIRST: one entry per available issue, aligned by order. #3 fails
    // with a definitive ValidationError (deleted/private issue) — it becomes an
    // error row WITHOUT re-grading via scout, tagged with verifyError. The rest
    // carry deterministic verdicts.
    mocks.verifyIssuesBatch.mockResolvedValue([
      verified('owner/repo-a', 1, 'available'),
      verified('owner/repo-b', 2, 'taken', {
        verdictReason: 'open PR by rival closes this issue',
        linkedPRs: [CLOSING_PR],
      }),
      {
        params: { owner: 'owner', repo: 'repo-c', number: 3 },
        error: new ValidationError(
          'Issue not found: owner/repo-c#3. Check the URL — it may point at a pull request or a deleted/private issue.',
        ),
      },
      verified('owner/repo-d', 4, 'at-risk', {
        verdictReason: 'open PR cross-references this issue (mention only)',
        linkedPRs: [
          { ...CLOSING_PR, number: 41, linkType: 'cross-referenced', url: 'https://github.com/owner/repo-d/pull/41' },
        ],
      }),
      verified('owner/repo-e', 5, 'own-open-pr', {
        verdictReason: 'you already have an open PR for this issue',
        linkedPRs: [
          {
            ...CLOSING_PR,
            number: 51,
            author: 'costajohnt',
            isOwn: true,
            url: 'https://github.com/owner/repo-e/pull/51',
          },
        ],
      }),
      verified('owner/repo-f', 6, 'closed'),
    ] satisfies BatchVerificationResult[]);

    // Scout is only consulted for the in-play (available/at-risk) issues —
    // never for closed/taken/own_open_pr, and never for the definitive
    // ValidationError row (#3). With concurrency 1 the calls are deterministic:
    // #1 (available), #4 (at-risk).
    mocks.vetIssue
      .mockResolvedValueOnce({
        issue: {
          repo: 'owner/repo-a',
          number: 1,
          title: 'Still available',
          url: 'https://github.com/owner/repo-a/issues/1',
          labels: ['good first issue'],
        },
        recommendation: 'approve' as const,
        reasonsToApprove: ['Active project'],
        reasonsToSkip: [],
        projectHealth: HEALTH_APPROVE,
        vettingResult: { passedAllChecks: true, checks: {}, notes: [] },
      })
      .mockResolvedValueOnce({
        issue: {
          repo: 'owner/repo-d',
          number: 4,
          title: 'At risk',
          url: 'https://github.com/owner/repo-d/issues/4',
          labels: [],
        },
        recommendation: 'needs_review' as const,
        reasonsToApprove: ['Looks reasonable'],
        reasonsToSkip: ['Open PR mentions this issue'],
        projectHealth: { ...HEALTH_APPROVE, repo: 'owner/repo-d' },
        vettingResult: { passedAllChecks: false, checks: {}, notes: [] },
      });

    const result = await runVetList({ concurrency: 1 });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/vet-list.mixed.json');
  });

  it('empty list output matches the golden shape', async () => {
    mocks.runParseList.mockResolvedValue({ available: [] });

    const result = await runVetList({});
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/vet-list.empty.json');
  });
});
