/**
 * Tests for vet-list command (#764)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VetOutput } from '../formatters/json.js';

const mockVetIssue = vi.fn();
const mockVerifyIssuesBatch = vi.hoisted(() => vi.fn());

vi.mock('./scout-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('./scout-bridge.js')>('./scout-bridge.js');
  return {
    ...actual,
    createAutopilotScout: vi.fn(async () => ({
      vetIssue: mockVetIssue,
    })),
  };
});

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    // parseGitHubUrl stays real (from actual) so verify targets resolve.
    getOctokit: () => ({}),
    requireGitHubToken: () => 'fake-token',
    verifyIssuesBatch: mockVerifyIssuesBatch,
    getStateManager: () => ({
      getRepoScore: () => undefined,
      getState: () => ({ config: { githubUsername: 'costajohnt' } }),
    }),
  };
});

vi.mock('./startup.js', () => ({
  detectIssueList: vi.fn(),
}));

vi.mock('./parse-list.js', () => ({
  runParseList: vi.fn(),
  pruneIssueList: vi.fn(),
}));

// Mock fs so the prune path doesn't hit the real filesystem
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import * as fs from 'node:fs';
import { detectIssueList } from './startup.js';
import { runParseList } from './parse-list.js';
import { runVetList, classifyListStatus } from './vet-list.js';

const mockDetectIssueList = vi.mocked(detectIssueList);
const mockRunParseList = vi.mocked(runParseList);
const mockReadFileSync = vi.mocked(fs.readFileSync);

function makeVetOutput(overrides: Partial<VetOutput> = {}): VetOutput {
  return {
    issue: {
      repo: 'owner/repo',
      number: 1,
      title: 'Test issue',
      url: 'https://github.com/owner/repo/issues/1',
      labels: ['bug'],
    },
    recommendation: 'approve',
    reasonsToApprove: ['Active project'],
    reasonsToSkip: [],
    projectHealth: { stars: 500 },
    vettingResult: { isViable: true },
    grade: { score: 7, reason: 'test fixture' },
    ...overrides,
  };
}

describe('classifyListStatus', () => {
  it('should return still_available for approved issues', () => {
    const result = classifyListStatus(makeVetOutput({ recommendation: 'approve', reasonsToSkip: [] }));
    expect(result).toBe('still_available');
  });

  it('should return still_available for needs_review issues', () => {
    const result = classifyListStatus(makeVetOutput({ recommendation: 'needs_review', reasonsToSkip: [] }));
    expect(result).toBe('still_available');
  });

  it('should return closed when skip reasons mention closed', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Issue is closed'],
      }),
    );
    expect(result).toBe('closed');
  });

  it('should return claimed when skip reasons mention claimed', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Issue is already claimed by another user'],
      }),
    );
    expect(result).toBe('claimed');
  });

  it('should return claimed when skip reasons mention assigned', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Issue is assigned to someone'],
      }),
    );
    expect(result).toBe('claimed');
  });

  it('should return has_pr when skip reasons mention existing PR', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Has existing PR addressing this'],
      }),
    );
    expect(result).toBe('has_pr');
  });

  it('should return has_pr when skip reasons mention linked PR', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Has linked PR #42'],
      }),
    );
    expect(result).toBe('has_pr');
  });

  it('should return has_pr when skip reasons mention pull request', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Open pull request found'],
      }),
    );
    expect(result).toBe('has_pr');
  });

  // ── has_stalled_pr revive opportunity (#97 / scout 0.9.0) ──────────────

  it('returns has_stalled_pr via skipReason when linked PR is open AND stalled', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Has linked PR #42'],
        linkedPR: {
          number: 42,
          state: 'open',
          url: 'https://github.com/owner/repo/pull/42',
          updatedAt: '2020-01-01T00:00:00Z',
          isStalled: true,
        },
      }),
      'has_linked_pr',
    );
    expect(result).toBe('has_stalled_pr');
  });

  it('returns has_pr via skipReason when linked PR is open but fresh', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Has linked PR #42'],
        linkedPR: {
          number: 42,
          state: 'open',
          url: 'https://github.com/owner/repo/pull/42',
          updatedAt: new Date().toISOString(),
          isStalled: false,
        },
      }),
      'has_linked_pr',
    );
    expect(result).toBe('has_pr');
  });

  it('routes stalled-PR substring fallback to has_stalled_pr when isStalled=true', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Has linked PR #42'],
        linkedPR: {
          number: 42,
          state: 'open',
          url: 'https://github.com/owner/repo/pull/42',
          updatedAt: '2020-01-01T00:00:00Z',
          isStalled: true,
        },
      }),
    );
    expect(result).toBe('has_stalled_pr');
  });

  it('does NOT route closed/merged linked PRs to has_stalled_pr even with stale updatedAt', () => {
    // Defensive — buildCandidateLinkedPR should already set isStalled=false
    // for non-open states, but the classifier also checks state explicitly.
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Has linked PR #42'],
        linkedPR: {
          number: 42,
          state: 'merged',
          url: 'https://github.com/owner/repo/pull/42',
          updatedAt: '2020-01-01T00:00:00Z',
          isStalled: false,
        },
      }),
      'has_linked_pr',
    );
    expect(result).toBe('has_pr');
  });

  it('should return still_available for skipped issues with other reasons', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Project is inactive'],
      }),
    );
    expect(result).toBe('still_available');
  });

  it('should prioritize closed over claimed', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Issue is closed', 'Issue was claimed'],
      }),
    );
    expect(result).toBe('closed');
  });

  // ── #1043 structured skipReason preference ───────────────────────────

  it('prefers scout-emitted skipReason enum over substring match (#1043)', () => {
    // Scout could reword the free-text ("Issue was resolved") so the
    // substring match against 'closed' no longer fires. The enum takes
    // precedence and routes correctly.
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Issue was resolved'],
      }),
      'issue_closed',
    );
    expect(result).toBe('closed');
  });

  it('routes via enum to claimed/has_pr when scout emits the enum (#1043)', () => {
    expect(classifyListStatus(makeVetOutput({ recommendation: 'skip', reasonsToSkip: [] }), 'claimed')).toBe('claimed');
    expect(classifyListStatus(makeVetOutput({ recommendation: 'skip', reasonsToSkip: [] }), 'has_linked_pr')).toBe(
      'has_pr',
    );
  });

  it('falls through to recommendation-based branches for non-routing enum values (#1043)', () => {
    // score_too_low and anti_llm_policy are skip reasons that shouldn't
    // change the list status — let the recommendation drive it.
    expect(classifyListStatus(makeVetOutput({ recommendation: 'approve' }), 'score_too_low')).toBe('still_available');
    expect(classifyListStatus(makeVetOutput({ recommendation: 'skip' }), 'anti_llm_policy')).toBe('still_available');
  });
});

describe('extractSkipReason', () => {
  it('returns the scout-emitted enum value', async () => {
    const { extractSkipReason } = await import('./vet-list.js');
    expect(extractSkipReason({ skipReason: 'issue_closed' })).toBe('issue_closed');
  });

  it('returns undefined when skipReason is missing', async () => {
    const { extractSkipReason } = await import('./vet-list.js');
    expect(extractSkipReason({ other: 'field' })).toBeUndefined();
  });

  it('ignores unknown enum values (forward-compat poison guard)', async () => {
    const { extractSkipReason } = await import('./vet-list.js');
    expect(extractSkipReason({ skipReason: 'future_value_not_in_enum' })).toBeUndefined();
  });

  it('ignores non-string values', async () => {
    const { extractSkipReason } = await import('./vet-list.js');
    expect(extractSkipReason({ skipReason: 42 })).toBeUndefined();
    expect(extractSkipReason(null)).toBeUndefined();
    expect(extractSkipReason('not an object')).toBeUndefined();
  });
});

describe('runVetList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: verify errors for every entry, exercising the scout-heuristic
    // fallback path so the plumbing tests below (detect/parse/concurrency/prune)
    // keep their pre-#1494 behavior. The verdict-primary path has its own tests
    // here and full coverage in vet-list.contract.test.ts.
    mockVerifyIssuesBatch.mockImplementation(
      async (_octokit: unknown, items: Array<{ owner: string; repo: string; number: number }>) =>
        items.map((params) => ({ params, error: new Error('verify unavailable in test') })),
    );
  });

  it('uses the verify verdict and skips scout for ruled-out issues (#1494)', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 2,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Closed one',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/1',
        },
        {
          repo: 'other/lib',
          number: 2,
          title: 'Available one',
          tier: 'Maybe',
          url: 'https://github.com/other/lib/issues/2',
        },
      ],
      completed: [],
      availableCount: 2,
      completedCount: 0,
    });
    mockVerifyIssuesBatch.mockResolvedValue([
      {
        params: { owner: 'owner', repo: 'repo', number: 1 },
        verification: {
          url: 'https://github.com/owner/repo/issues/1',
          owner: 'owner',
          repo: 'repo',
          number: 1,
          title: 'Closed one',
          state: 'closed',
          stateReason: 'completed',
          closedAt: null,
          assignees: [],
          linkedPRs: [],
          verdict: 'closed',
          verdictReason: 'issue closed (completed)',
          userLogin: 'costajohnt',
        },
      },
      {
        params: { owner: 'other', repo: 'lib', number: 2 },
        verification: {
          url: 'https://github.com/other/lib/issues/2',
          owner: 'other',
          repo: 'lib',
          number: 2,
          title: 'Available one',
          state: 'open',
          stateReason: null,
          closedAt: null,
          assignees: [],
          linkedPRs: [],
          verdict: 'available',
          verdictReason: 'open, unassigned, no claiming PRs',
          userLogin: 'costajohnt',
        },
      },
    ]);
    mockVetIssue.mockResolvedValueOnce({
      issue: {
        repo: 'other/lib',
        number: 2,
        title: 'Available one',
        url: 'https://github.com/other/lib/issues/2',
        labels: [],
      },
      recommendation: 'approve' as const,
      reasonsToApprove: ['OK'],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    });

    const result = await runVetList({ concurrency: 1 });

    expect(result.results[0].listStatus).toBe('closed');
    expect(result.results[0].verification?.verdict).toBe('closed');
    expect(result.results[1].listStatus).toBe('still_available');
    // Scout was consulted only for the available issue, not the closed one.
    expect(mockVetIssue).toHaveBeenCalledTimes(1);
    expect(mockVetIssue).toHaveBeenCalledWith('https://github.com/other/lib/issues/2');
  });

  it('tags scout-fallback rows with verifyError when verify failed transiently (#1494)', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 1,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Fix bug',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/1',
        },
      ],
      completed: [],
      availableCount: 1,
      completedCount: 0,
    });
    // beforeEach default: verify errors transiently for every entry.
    mockVetIssue.mockResolvedValueOnce({
      issue: {
        repo: 'owner/repo',
        number: 1,
        title: 'Fix bug',
        url: 'https://github.com/owner/repo/issues/1',
        labels: [],
      },
      recommendation: 'approve' as const,
      reasonsToApprove: ['OK'],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    });

    const result = await runVetList({ concurrency: 1 });

    // Heuristic still drives listStatus, but verifyError makes the failed
    // authoritative check visible and verification stays absent.
    expect(result.results[0].listStatus).toBe('still_available');
    expect(result.results[0].verifyError).toBe('verify unavailable in test');
    expect(result.results[0].verification).toBeUndefined();
  });

  it('tags non-issue (PR) URLs as not verified, still falling back to scout (#1494)', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 1,
      completedCount: 0,
    });
    // parse-list also accepts PR URLs; verify-issue can't classify them, so they
    // are never enrolled in the verify batch.
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 7,
          title: 'A PR link',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/pull/7',
        },
      ],
      completed: [],
      availableCount: 1,
      completedCount: 0,
    });
    mockVerifyIssuesBatch.mockResolvedValue([]); // no issue targets enrolled
    mockVetIssue.mockResolvedValueOnce({
      issue: {
        repo: 'owner/repo',
        number: 7,
        title: 'A PR link',
        url: 'https://github.com/owner/repo/pull/7',
        labels: [],
      },
      recommendation: 'approve' as const,
      reasonsToApprove: ['OK'],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    });

    const result = await runVetList({ concurrency: 1 });

    expect(result.results[0].listStatus).toBe('still_available');
    expect(result.results[0].verification).toBeUndefined();
    expect(result.results[0].verifyError).toContain('not a verifiable issue URL');
    // Scout is still consulted for the PR URL — pre-#1494 behavior preserved.
    expect(mockVetIssue).toHaveBeenCalledWith('https://github.com/owner/repo/pull/7');
  });

  it('keeps the verification when scout grading throws on an in-play issue (#1494)', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 1,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 4,
          title: 'At risk',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/4',
        },
      ],
      completed: [],
      availableCount: 1,
      completedCount: 0,
    });
    mockVerifyIssuesBatch.mockResolvedValue([
      {
        params: { owner: 'owner', repo: 'repo', number: 4 },
        verification: {
          url: 'https://github.com/owner/repo/issues/4',
          owner: 'owner',
          repo: 'repo',
          number: 4,
          title: 'At risk',
          state: 'open',
          stateReason: null,
          closedAt: null,
          assignees: [],
          linkedPRs: [],
          verdict: 'at-risk',
          verdictReason: 'open PR cross-references this issue',
          userLogin: 'costajohnt',
        },
      },
    ]);
    // Verify succeeded (at-risk → in play), but scout grading then fails.
    mockVetIssue.mockRejectedValueOnce(new Error('grading blew up'));

    const result = await runVetList({ concurrency: 1 });

    // The row is an error (grading failed) BUT the authoritative verdict facts
    // survive, and there is no verifyError (verify itself succeeded).
    expect(result.results[0].listStatus).toBe('error');
    expect(result.results[0].errorMessage).toBe('grading blew up');
    expect(result.results[0].verification?.verdict).toBe('at-risk');
    expect(result.results[0].verifyError).toBeUndefined();
  });

  it('lets the verify verdict override scout when they disagree (#1494)', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 1,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Available',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/1',
        },
      ],
      completed: [],
      availableCount: 1,
      completedCount: 0,
    });
    mockVerifyIssuesBatch.mockResolvedValue([
      {
        params: { owner: 'owner', repo: 'repo', number: 1 },
        verification: {
          url: 'https://github.com/owner/repo/issues/1',
          owner: 'owner',
          repo: 'repo',
          number: 1,
          title: 'Available',
          state: 'open',
          stateReason: null,
          closedAt: null,
          assignees: [],
          linkedPRs: [],
          verdict: 'available',
          verdictReason: 'open, unassigned, no claiming PRs',
          userLogin: 'costajohnt',
        },
      },
    ]);
    // Scout's heuristic would say "closed" — but the verdict is authoritative.
    mockVetIssue.mockResolvedValueOnce({
      issue: {
        repo: 'owner/repo',
        number: 1,
        title: 'Available',
        url: 'https://github.com/owner/repo/issues/1',
        labels: [],
      },
      recommendation: 'skip' as const,
      reasonsToApprove: [],
      reasonsToSkip: ['Issue is closed'],
      projectHealth: {},
      vettingResult: {},
    });

    const result = await runVetList({ concurrency: 1 });

    // Verdict wins: still_available, NOT closed (which the old heuristic gave).
    expect(result.results[0].listStatus).toBe('still_available');
    expect(result.results[0].verification?.verdict).toBe('available');
    // Scout's recommendation still flows through for context.
    expect(result.results[0].recommendation).toBe('skip');
  });

  it('should throw when no issue list is found and no path provided', async () => {
    mockDetectIssueList.mockReturnValue(undefined);

    await expect(runVetList()).rejects.toThrow('No issue list found');
  });

  it('should return empty results for an empty list', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 0,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({ available: [], completed: [], availableCount: 0, completedCount: 0 });

    const result = await runVetList();

    expect(result.results).toEqual([]);
    expect(result.summary).toEqual({
      total: 0,
      stillAvailable: 0,
      claimed: 0,
      closed: 0,
      hasPR: 0,
      hasStalledPR: 0,
      atRisk: 0,
      ownOpenPr: 0,
      errors: 0,
    });
  });

  it('should vet available issues and return results', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 2,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Fix bug',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/1',
        },
        {
          repo: 'other/lib',
          number: 2,
          title: 'Add feature',
          tier: 'Maybe',
          url: 'https://github.com/other/lib/issues/2',
        },
      ],
      completed: [],
      availableCount: 2,
      completedCount: 0,
    });

    const candidate1 = {
      issue: {
        repo: 'owner/repo',
        number: 1,
        title: 'Fix bug',
        url: 'https://github.com/owner/repo/issues/1',
        labels: ['bug'],
      },
      recommendation: 'approve' as const,
      reasonsToApprove: ['Good first issue'],
      reasonsToSkip: [],
      projectHealth: { stars: 100 },
      vettingResult: { isViable: true },
    };
    const candidate2 = {
      issue: {
        repo: 'other/lib',
        number: 2,
        title: 'Add feature',
        url: 'https://github.com/other/lib/issues/2',
        labels: ['enhancement'],
      },
      recommendation: 'skip' as const,
      reasonsToApprove: [],
      reasonsToSkip: ['Issue is closed'],
      projectHealth: { stars: 50 },
      vettingResult: { isViable: false },
    };
    mockVetIssue.mockResolvedValueOnce(candidate1).mockResolvedValueOnce(candidate2);

    const result = await runVetList();

    expect(result.results).toHaveLength(2);
    expect(result.results[0].listStatus).toBe('still_available');
    expect(result.results[0].issue.repo).toBe('owner/repo');
    expect(result.results[1].listStatus).toBe('closed');
    expect(result.results[1].issue.repo).toBe('other/lib');
    expect(result.summary.total).toBe(2);
    expect(result.summary.stillAvailable).toBe(1);
    expect(result.summary.closed).toBe(1);
  });

  it('should handle per-issue errors without failing the batch', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 2,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Fix bug',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/1',
        },
        {
          repo: 'other/lib',
          number: 2,
          title: 'Add feature',
          tier: 'Maybe',
          url: 'https://github.com/other/lib/issues/2',
        },
      ],
      completed: [],
      availableCount: 2,
      completedCount: 0,
    });

    const candidate1 = {
      issue: {
        repo: 'owner/repo',
        number: 1,
        title: 'Fix bug',
        url: 'https://github.com/owner/repo/issues/1',
        labels: ['bug'],
      },
      recommendation: 'approve' as const,
      reasonsToApprove: ['Active project'],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    };
    mockVetIssue.mockResolvedValueOnce(candidate1).mockRejectedValueOnce(new Error('Rate limit exceeded'));

    const result = await runVetList({ concurrency: 1 });

    expect(result.results).toHaveLength(2);
    expect(result.results[0].listStatus).toBe('still_available');
    expect(result.results[1].listStatus).toBe('error');
    expect(result.results[1].errorMessage).toBe('Rate limit exceeded');
    expect(result.results[1].recommendation).toBe('skip');
    expect(result.summary.errors).toBe(1);
    expect(result.summary.stillAvailable).toBe(1);
  });

  it('should use provided path instead of auto-detecting', async () => {
    mockRunParseList.mockResolvedValue({ available: [], completed: [], availableCount: 0, completedCount: 0 });

    await runVetList({ issueListPath: '/custom/path.md' });

    expect(mockDetectIssueList).not.toHaveBeenCalled();
    expect(mockRunParseList).toHaveBeenCalledWith({ filePath: '/custom/path.md' });
  });

  it('should use detectIssueList when no path is provided', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/detected/issues.md',
      source: 'auto-detected',
      availableCount: 0,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({ available: [], completed: [], availableCount: 0, completedCount: 0 });

    await runVetList();

    expect(mockDetectIssueList).toHaveBeenCalled();
    expect(mockRunParseList).toHaveBeenCalledWith({ filePath: '/detected/issues.md' });
  });

  it('should respect concurrency option', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 3,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        { repo: 'a/b', number: 1, title: 'One', tier: 'T1', url: 'https://github.com/a/b/issues/1' },
        { repo: 'c/d', number: 2, title: 'Two', tier: 'T1', url: 'https://github.com/c/d/issues/2' },
        { repo: 'e/f', number: 3, title: 'Three', tier: 'T1', url: 'https://github.com/e/f/issues/3' },
      ],
      completed: [],
      availableCount: 3,
      completedCount: 0,
    });

    const makeCandidate = (repo: string, num: number, title: string, url: string) => ({
      issue: { repo, number: num, title, url, labels: [] },
      recommendation: 'approve' as const,
      reasonsToApprove: ['OK'],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    });

    mockVetIssue
      .mockResolvedValueOnce(makeCandidate('a/b', 1, 'One', 'https://github.com/a/b/issues/1'))
      .mockResolvedValueOnce(makeCandidate('c/d', 2, 'Two', 'https://github.com/c/d/issues/2'))
      .mockResolvedValueOnce(makeCandidate('e/f', 3, 'Three', 'https://github.com/e/f/issues/3'));

    const result = await runVetList({ concurrency: 2 });

    expect(result.results).toHaveLength(3);
    expect(result.summary.total).toBe(3);
    expect(result.summary.stillAvailable).toBe(3);
  });

  it('should handle non-Error thrown values in per-issue errors', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 1,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Fix bug',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/1',
        },
      ],
      completed: [],
      availableCount: 1,
      completedCount: 0,
    });

    mockVetIssue.mockRejectedValueOnce('string error');

    const result = await runVetList();

    expect(result.results).toHaveLength(1);
    expect(result.results[0].listStatus).toBe('error');
    expect(result.results[0].errorMessage).toBe('string error');
  });

  it('returns pruneResult with removedCount 0 and the error when the prune fails (#1448)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 1,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Fix bug',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/1',
        },
      ],
      completed: [],
      availableCount: 1,
      completedCount: 0,
    });
    mockVetIssue.mockResolvedValueOnce({
      issue: {
        repo: 'owner/repo',
        number: 1,
        title: 'Fix bug',
        url: 'https://github.com/owner/repo/issues/1',
        labels: [],
      },
      recommendation: 'approve' as const,
      reasonsToApprove: ['OK'],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    });
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const result = await runVetList({ prune: true });

    // Previously a failed prune returned a plain success with pruneResult
    // absent — the same shape as "prune not requested".
    expect(result.pruneResult).toEqual({ removedCount: 0, error: 'EACCES: permission denied' });
    consoleSpy.mockRestore();
  });
});
