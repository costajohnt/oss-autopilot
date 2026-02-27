/**
 * Tests for runDaily() / executeDailyCheck() orchestration in daily.ts
 *
 * Coverage focus: the main orchestration flow that was previously at ~8.69% coverage.
 * Helper functions (computeRepoSignals, computeActionMenu, groupPRsByRepo) are
 * already tested in daily.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FetchedPR, DailyDigest, CommentedIssue } from '../core/types.js';
import type { FetchPRsResult } from '../core/pr-monitor.js';

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

// PRMonitor method mocks
const mockFetchUserOpenPRs = vi.fn<() => Promise<FetchPRsResult>>();
const mockFetchUserMergedPRCounts = vi.fn();
const mockFetchUserClosedPRCounts = vi.fn();
const mockFetchRepoStarCounts = vi.fn();
const mockFetchRecentlyClosedPRs = vi.fn();
const mockFetchRecentlyMergedPRs = vi.fn();
const mockGenerateDigest = vi.fn();

// IssueConversationMonitor method mocks
const mockFetchCommentedIssues = vi.fn();

// StateManager method mocks
const mockGetState = vi.fn();
const mockUpdateRepoScore = vi.fn();
const mockAddTrustedProject = vi.fn();
const mockSetMonthlyMergedCounts = vi.fn();
const mockSetMonthlyClosedCounts = vi.fn();
const mockSetMonthlyOpenedCounts = vi.fn();
const mockExpireSnoozes = vi.fn();
const mockSetLastDigest = vi.fn();
const mockSave = vi.fn();
const mockIsPRShelved = vi.fn();
const mockUnshelvePR = vi.fn();
const mockGetStats = vi.fn();
const mockIsSnoozed = vi.fn();
const mockGetIssueDismissedAt = vi.fn();
const mockUndismissIssue = vi.fn();

// daily.ts imports everything from '../core/index.js', so we mock the whole barrel export.
// PRMonitor and IssueConversationMonitor are used as classes (new PRMonitor(...)),
// so we use actual class syntax (not arrow functions) in the mock implementations.
vi.mock('../core/index.js', () => {
  // Capture module-level mocks via closure — the inner class refers to them by name
  class MockPRMonitor {
    fetchUserOpenPRs = mockFetchUserOpenPRs;
    fetchUserMergedPRCounts = mockFetchUserMergedPRCounts;
    fetchUserClosedPRCounts = mockFetchUserClosedPRCounts;
    fetchRepoStarCounts = mockFetchRepoStarCounts;
    fetchRecentlyClosedPRs = mockFetchRecentlyClosedPRs;
    fetchRecentlyMergedPRs = mockFetchRecentlyMergedPRs;
    generateDigest = mockGenerateDigest;
  }

  class MockIssueConversationMonitor {
    fetchCommentedIssues = mockFetchCommentedIssues;
  }

  return {
    getStateManager: vi.fn(() => ({
      getState: mockGetState,
      updateRepoScore: mockUpdateRepoScore,
      addTrustedProject: mockAddTrustedProject,
      setMonthlyMergedCounts: mockSetMonthlyMergedCounts,
      setMonthlyClosedCounts: mockSetMonthlyClosedCounts,
      setMonthlyOpenedCounts: mockSetMonthlyOpenedCounts,
      expireSnoozes: mockExpireSnoozes,
      setLastDigest: mockSetLastDigest,
      save: mockSave,
      isPRShelved: mockIsPRShelved,
      unshelvePR: mockUnshelvePR,
      getStats: mockGetStats,
      isSnoozed: mockIsSnoozed,
      getIssueDismissedAt: mockGetIssueDismissedAt,
      undismissIssue: mockUndismissIssue,
    })),
    getGitHubToken: vi.fn(() => 'test-token'),
    formatRelativeTime: vi.fn(() => '2 days ago'),
    PRMonitor: MockPRMonitor,
    IssueConversationMonitor: MockIssueConversationMonitor,
  };
});

vi.mock('../formatters/json.js', async () => {
  const actual = await vi.importActual<typeof import('../formatters/json.js')>('../formatters/json.js');
  return {
    ...actual,
    outputJson: vi.fn(),
    outputJsonError: vi.fn(),
  };
});

// Import AFTER all mocks are declared
import { executeDailyCheck, runDaily } from './daily.js';
import { getGitHubToken } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a minimal FetchedPR for orchestration testing */
function makePR(overrides: Partial<FetchedPR> & { repo: string; number?: number }): FetchedPR {
  const num = overrides.number ?? 1;
  return {
    id: num,
    url: `https://github.com/${overrides.repo}/pull/${num}`,
    number: num,
    title: 'Test PR',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    daysSinceActivity: 5,
    ciStatus: 'passing',
    failingCheckNames: [],
    classifiedChecks: [],
    hasMergeConflict: false,
    reviewDecision: 'approved',
    hasUnrespondedComment: false,
    hasIncompleteChecklist: false,
    maintainerActionHints: [],
    status: 'healthy',
    displayLabel: '[Healthy]',
    displayDescription: 'Everything looks good — normal review cycle',
    ...overrides,
  };
}

/** Build a minimal DailyDigest for mock responses */
function makeDigest(prs: FetchedPR[] = []): DailyDigest {
  return {
    generatedAt: '2026-01-25T10:00:00Z',
    openPRs: prs,
    prsNeedingResponse: prs.filter((p) => p.status === 'needs_response'),
    ciFailingPRs: prs.filter((p) => p.status === 'failing_ci'),
    ciBlockedPRs: [],
    ciNotRunningPRs: [],
    mergeConflictPRs: prs.filter((p) => p.status === 'merge_conflict'),
    needsRebasePRs: [],
    missingRequiredFilesPRs: [],
    incompleteChecklistPRs: [],
    needsChangesPRs: prs.filter((p) => p.status === 'needs_changes'),
    changesAddressedPRs: [],
    waitingOnMaintainerPRs: [],
    approachingDormant: [],
    dormantPRs: prs.filter((p) => p.status === 'dormant'),
    healthyPRs: prs.filter((p) => p.status === 'healthy'),
    recentlyClosedPRs: [],
    recentlyMergedPRs: [],
    shelvedPRs: [],
    autoUnshelvedPRs: [],
    summary: {
      totalActivePRs: prs.length,
      totalNeedingAttention: 0,
      totalMergedAllTime: 5,
      mergeRate: 83.3,
    },
  };
}

/** Return a default (empty) state shape for getState() */
function makeDefaultState(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    activePRs: [],
    activeIssues: [],
    dormantPRs: [],
    mergedPRs: [],
    closedPRs: [],
    repoScores: {},
    config: {
      setupComplete: true,
      githubUsername: 'testuser',
      maxActivePRs: 10,
      languages: ['TypeScript'],
      labels: [],
      excludeRepos: [],
      trustedProjects: [],
      shelvedPRUrls: [],
      dismissedIssues: {},
      snoozedPRs: {},
    },
    events: [],
    lastRunAt: '2026-01-24T10:00:00Z',
    ...overrides,
  };
}

/** Default merged PR counts response */
function makeMergedResult(repos: Map<string, { count: number; lastMergedAt: string }> = new Map()) {
  return {
    repos,
    monthlyCounts: {},
    monthlyOpenedCounts: {},
    dailyActivityCounts: {},
  };
}

/** Default closed PR counts response */
function makeClosedResult(repos: Map<string, number> = new Map()) {
  return {
    repos,
    monthlyCounts: {},
    monthlyOpenedCounts: {},
    dailyActivityCounts: {},
  };
}

// ---------------------------------------------------------------------------
// Common beforeEach setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default state: no PRs, no scores
  mockGetState.mockReturnValue(makeDefaultState());

  // Default PR monitor responses (no PRs, no failures)
  mockFetchUserOpenPRs.mockResolvedValue({ prs: [], failures: [] });
  mockFetchUserMergedPRCounts.mockResolvedValue(makeMergedResult());
  mockFetchUserClosedPRCounts.mockResolvedValue(makeClosedResult());
  mockFetchRepoStarCounts.mockResolvedValue(new Map<string, number>());
  mockFetchRecentlyClosedPRs.mockResolvedValue([]);
  mockFetchRecentlyMergedPRs.mockResolvedValue([]);
  mockGenerateDigest.mockReturnValue(makeDigest());

  // Default issue conversation response (no issues)
  mockFetchCommentedIssues.mockResolvedValue({ issues: [], failures: [] });

  // Default state manager side-effect mocks
  mockExpireSnoozes.mockReturnValue([]);
  mockIsPRShelved.mockReturnValue(false);
  mockUnshelvePR.mockReturnValue(true);
  mockIsSnoozed.mockReturnValue(false);
  mockGetIssueDismissedAt.mockReturnValue(undefined);
  mockUpdateRepoScore.mockImplementation(() => {});
  mockAddTrustedProject.mockImplementation(() => {});
  mockSave.mockImplementation(() => {});
});

afterEach(() => {
  // Restores any vi.spyOn() spies created within individual tests (e.g., console.error spies).
  // vi.fn() module mocks are reset by vi.clearAllMocks() in beforeEach instead.
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — happy path
// ---------------------------------------------------------------------------

describe('executeDailyCheck()', () => {
  it('returns a DailyOutput with the correct top-level shape', async () => {
    const result = await executeDailyCheck('test-token');

    expect(result).toHaveProperty('digest');
    expect(result).toHaveProperty('capacity');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('briefSummary');
    expect(result).toHaveProperty('actionableIssues');
    expect(result).toHaveProperty('actionMenu');
    expect(result).toHaveProperty('commentedIssues');
    expect(result).toHaveProperty('repoGroups');
    expect(result).toHaveProperty('failures');
    expect(Array.isArray(result.updates)).toBe(true);
    expect(result.updates).toHaveLength(0);
  });

  it('returns empty failures when all PRs fetch successfully', async () => {
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [], failures: [] });
    const result = await executeDailyCheck('test-token');
    expect(result.failures).toHaveLength(0);
  });

  it('propagates failures from fetchUserOpenPRs', async () => {
    const failures = [{ prUrl: 'https://github.com/owner/repo/pull/1', error: 'Rate limit exceeded' }];
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [], failures });
    const result = await executeDailyCheck('test-token');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].prUrl).toBe('https://github.com/owner/repo/pull/1');
  });

  it('calls fetchUserMergedPRCounts and fetchUserClosedPRCounts', async () => {
    await executeDailyCheck('test-token');
    expect(mockFetchUserMergedPRCounts).toHaveBeenCalledOnce();
    expect(mockFetchUserClosedPRCounts).toHaveBeenCalledOnce();
  });

  it('calls fetchRepoStarCounts with all repo keys from state', async () => {
    mockGetState.mockReturnValue(
      makeDefaultState({
        repoScores: {
          'owner/repo-a': { repo: 'owner/repo-a', mergedPRCount: 2, closedWithoutMergeCount: 0, score: 5 },
          'owner/repo-b': { repo: 'owner/repo-b', mergedPRCount: 1, closedWithoutMergeCount: 0, score: 4 },
        },
      }),
    );
    await executeDailyCheck('test-token');
    const [calledRepos] = mockFetchRepoStarCounts.mock.calls[0];
    expect(calledRepos).toContain('owner/repo-a');
    expect(calledRepos).toContain('owner/repo-b');
  });

  it('saves state after the check', async () => {
    await executeDailyCheck('test-token');
    expect(mockSave).toHaveBeenCalled();
  });

  it('calls setLastDigest to persist digest in state', async () => {
    await executeDailyCheck('test-token');
    expect(mockSetLastDigest).toHaveBeenCalledOnce();
  });

  it('calls expireSnoozes to expire stale snoozes', async () => {
    await executeDailyCheck('test-token');
    expect(mockExpireSnoozes).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — PR partitioning (active vs shelved)
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — PR partitioning', () => {
  it('puts non-shelved, non-dormant PRs into active list', async () => {
    const activePR = makePR({ repo: 'owner/repo', number: 1, status: 'healthy' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [activePR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([activePR]));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    // Active PRs appear in repoGroups (as PR URLs in compact format)
    const allGroupedPRUrls = result.repoGroups.flatMap((g) => g.prUrls);
    expect(allGroupedPRUrls).toContain(activePR.url);
    // Not in shelved section of digest
    expect(result.digest.shelvedPRs).toHaveLength(0);
  });

  it('puts dormant PRs into shelvedPRs (auto-shelved, not persisted)', async () => {
    const dormantPR = makePR({ repo: 'owner/repo', number: 2, status: 'dormant' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [dormantPR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([dormantPR]));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(result.digest.shelvedPRs).toHaveLength(1);
    expect(result.digest.shelvedPRs[0].url).toBe(dormantPR.url);
    // Not in repoGroups (active only)
    const allGroupedPRUrls = result.repoGroups.flatMap((g) => g.prUrls);
    expect(allGroupedPRUrls).toHaveLength(0);
  });

  it('puts explicitly shelved PRs into shelvedPRs section', async () => {
    const shelvedPR = makePR({ repo: 'owner/repo', number: 3, status: 'healthy' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [shelvedPR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([shelvedPR]));
    // This PR is explicitly shelved in state
    mockIsPRShelved.mockReturnValue(true);

    const result = await executeDailyCheck('test-token');

    expect(result.digest.shelvedPRs).toHaveLength(1);
    expect(result.digest.shelvedPRs[0].url).toBe(shelvedPR.url);
  });

  it('auto-unshelves a shelved PR when it has a critical status', async () => {
    const criticalPR = makePR({ repo: 'owner/repo', number: 4, status: 'needs_response' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [criticalPR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([criticalPR]));
    // Shelved, but has needs_response (critical) status
    mockIsPRShelved.mockReturnValue(true);

    const result = await executeDailyCheck('test-token');

    // Should be auto-unshelved → moved to active
    expect(mockUnshelvePR).toHaveBeenCalledWith(criticalPR.url);
    expect(result.digest.autoUnshelvedPRs).toHaveLength(1);
    expect(result.digest.autoUnshelvedPRs[0].url).toBe(criticalPR.url);
    // Should appear in active (repoGroups) not shelved
    const allGroupedPRUrls = result.repoGroups.flatMap((g) => g.prUrls);
    expect(allGroupedPRUrls).toContain(criticalPR.url);
  });

  it('keeps shelved PR with non-critical status in shelvedPRs (no auto-unshelf)', async () => {
    const shelvedHealthy = makePR({ repo: 'owner/repo', number: 5, status: 'healthy' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [shelvedHealthy], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([shelvedHealthy]));
    mockIsPRShelved.mockReturnValue(true);

    const result = await executeDailyCheck('test-token');

    expect(mockUnshelvePR).not.toHaveBeenCalled();
    expect(result.digest.shelvedPRs).toHaveLength(1);
    expect(result.digest.autoUnshelvedPRs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — capacity assessment
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — capacity assessment', () => {
  it('reports has capacity when under limit with no critical issues', async () => {
    // 3 healthy PRs, limit is 10
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'healthy' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'healthy' }),
      makePR({ repo: 'owner/repo', number: 3, status: 'healthy' }),
    ];
    mockFetchUserOpenPRs.mockResolvedValue({ prs, failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest(prs));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(result.capacity.hasCapacity).toBe(true);
    expect(result.capacity.activePRCount).toBe(3);
    expect(result.capacity.maxActivePRs).toBe(10);
    expect(result.capacity.criticalIssueCount).toBe(0);
  });

  it('reports no capacity when at or over the PR limit', async () => {
    // 10 PRs at the limit of 10
    const prs = Array.from({ length: 10 }, (_, i) => makePR({ repo: 'owner/repo', number: i + 1, status: 'healthy' }));
    mockFetchUserOpenPRs.mockResolvedValue({ prs, failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest(prs));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(result.capacity.hasCapacity).toBe(false);
    expect(result.capacity.activePRCount).toBe(10);
  });

  it('reports no capacity when critical issues exist (even under limit)', async () => {
    const prs = [makePR({ repo: 'owner/repo', number: 1, status: 'needs_response' })];
    mockFetchUserOpenPRs.mockResolvedValue({ prs, failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest(prs));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(result.capacity.hasCapacity).toBe(false);
    expect(result.capacity.criticalIssueCount).toBe(1);
  });

  it('excludes shelved PRs from capacity count', async () => {
    const activePR = makePR({ repo: 'owner/repo', number: 1, status: 'healthy' });
    const shelvedPR = makePR({ repo: 'owner/repo', number: 2, status: 'healthy' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [activePR, shelvedPR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([activePR, shelvedPR]));
    mockIsPRShelved.mockImplementation((url: string) => url === shelvedPR.url);

    const result = await executeDailyCheck('test-token');

    // Only the active PR counts
    expect(result.capacity.activePRCount).toBe(1);
    expect(result.capacity.shelvedPRCount).toBe(1);
    expect(result.capacity.hasCapacity).toBe(true);
  });

  it('all four critical statuses count against capacity', async () => {
    const statuses = ['needs_response', 'needs_changes', 'failing_ci', 'merge_conflict'] as const;
    for (const status of statuses) {
      // Reset mocks between iterations (beforeEach only runs once per it())
      vi.clearAllMocks();
      mockGetState.mockReturnValue(makeDefaultState());
      mockFetchUserOpenPRs.mockResolvedValue({ prs: [], failures: [] });
      mockFetchUserMergedPRCounts.mockResolvedValue(makeMergedResult());
      mockFetchUserClosedPRCounts.mockResolvedValue(makeClosedResult());
      mockFetchRepoStarCounts.mockResolvedValue(new Map<string, number>());
      mockFetchRecentlyClosedPRs.mockResolvedValue([]);
      mockFetchRecentlyMergedPRs.mockResolvedValue([]);
      mockFetchCommentedIssues.mockResolvedValue({ issues: [], failures: [] });
      mockExpireSnoozes.mockReturnValue([]);
      mockIsPRShelved.mockReturnValue(false);
      mockIsSnoozed.mockReturnValue(false);
      mockGetIssueDismissedAt.mockReturnValue(undefined);
      mockSave.mockImplementation(() => {});

      const pr = makePR({ repo: 'owner/repo', number: 1, status });
      mockFetchUserOpenPRs.mockResolvedValue({ prs: [pr], failures: [] });
      mockGenerateDigest.mockReturnValue(makeDigest([pr]));

      const result = await executeDailyCheck('test-token');
      expect(result.capacity.criticalIssueCount).toBeGreaterThan(0);
      expect(result.capacity.hasCapacity).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — snoozed PR filtering
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — snoozed PR filtering', () => {
  it('excludes snoozed PRs from actionableIssues for ci_failing type', async () => {
    const snoozedPR = makePR({ repo: 'owner/repo', number: 1, status: 'failing_ci' });
    const activePR = makePR({ repo: 'owner/repo', number: 2, status: 'failing_ci' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [snoozedPR, activePR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([snoozedPR, activePR]));
    mockIsPRShelved.mockReturnValue(false);

    // The snoozedPRs config key is used to filter
    mockGetState.mockReturnValue(
      makeDefaultState({
        config: {
          setupComplete: true,
          githubUsername: 'testuser',
          maxActivePRs: 10,
          languages: ['TypeScript'],
          labels: [],
          excludeRepos: [],
          trustedProjects: [],
          shelvedPRUrls: [],
          dismissedIssues: {},
          snoozedPRs: { [snoozedPR.url]: { expiresAt: '2099-01-01T00:00:00Z' } },
        },
      }),
    );
    // isSnoozed returns true only for the snoozed PR
    mockIsSnoozed.mockImplementation((url: string) => url === snoozedPR.url);

    const result = await executeDailyCheck('test-token');

    // Only activePR should be in actionableIssues (compact format: prUrl instead of pr)
    const ciFailingIssues = result.actionableIssues.filter((i) => i.type === 'ci_failing');
    expect(ciFailingIssues).toHaveLength(1);
    expect(ciFailingIssues[0].prUrl).toBe(activePR.url);
  });

  it('includes snoozed PR in active PRs (still shows in digest)', async () => {
    const snoozedPR = makePR({ repo: 'owner/repo', number: 1, status: 'failing_ci' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [snoozedPR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([snoozedPR]));
    mockIsPRShelved.mockReturnValue(false);
    mockGetState.mockReturnValue(
      makeDefaultState({
        config: {
          setupComplete: true,
          githubUsername: 'testuser',
          maxActivePRs: 10,
          languages: [],
          labels: [],
          excludeRepos: [],
          trustedProjects: [],
          shelvedPRUrls: [],
          dismissedIssues: {},
          snoozedPRs: { [snoozedPR.url]: { expiresAt: '2099-01-01T00:00:00Z' } },
        },
      }),
    );
    mockIsSnoozed.mockReturnValue(true);

    const result = await executeDailyCheck('test-token');

    // PR is still active (appears in repoGroups) even when snoozed
    const allGroupedPRUrls = result.repoGroups.flatMap((g) => g.prUrls);
    expect(allGroupedPRUrls).toContain(snoozedPR.url);
  });
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — JSON output shape
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — output shape', () => {
  it('summary string contains header text', async () => {
    const result = await executeDailyCheck('test-token');
    expect(typeof result.summary).toBe('string');
    expect(result.summary).toContain('OSS Dashboard');
  });

  it('briefSummary contains active PR count', async () => {
    const prs = [makePR({ repo: 'owner/repo', number: 1, status: 'healthy' })];
    mockFetchUserOpenPRs.mockResolvedValue({ prs, failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest(prs));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(typeof result.briefSummary).toBe('string');
    expect(result.briefSummary).toContain('Active PRs');
  });

  it('actionMenu always contains search and done items', async () => {
    const result = await executeDailyCheck('test-token');
    const keys = result.actionMenu.items.map((i) => i.key);
    expect(keys).toContain('search');
    expect(keys).toContain('done');
    expect(keys[keys.length - 1]).toBe('done');
  });

  it('actionMenu includes address_all when actionable issues exist', async () => {
    const prs = [makePR({ repo: 'owner/repo', number: 1, status: 'needs_response' })];
    mockFetchUserOpenPRs.mockResolvedValue({ prs, failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest(prs));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(result.actionMenu.items[0].key).toBe('address_all');
    expect(result.actionMenu.context.hasActionableIssues).toBe(true);
  });

  it('digest.summary.totalActivePRs reflects active (non-shelved) PRs', async () => {
    const activePR = makePR({ repo: 'owner/repo', number: 1, status: 'healthy' });
    const shelvedPR = makePR({ repo: 'owner/repo', number: 2, status: 'healthy' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [activePR, shelvedPR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([activePR, shelvedPR]));
    mockIsPRShelved.mockImplementation((url: string) => url === shelvedPR.url);

    const result = await executeDailyCheck('test-token');

    // Only the 1 active PR counted in the summary
    expect(result.digest.summary.totalActivePRs).toBe(1);
  });

  it('repoGroups groups PRs by repository', async () => {
    const pr1 = makePR({ repo: 'owner/repo-a', number: 1, status: 'healthy' });
    const pr2 = makePR({ repo: 'owner/repo-a', number: 2, status: 'healthy' });
    const pr3 = makePR({ repo: 'owner/repo-b', number: 3, status: 'healthy' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [pr1, pr2, pr3], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([pr1, pr2, pr3]));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(result.repoGroups).toHaveLength(2);
    const groupA = result.repoGroups.find((g) => g.repo === 'owner/repo-a');
    expect(groupA?.prUrls).toHaveLength(2);
    const groupB = result.repoGroups.find((g) => g.repo === 'owner/repo-b');
    expect(groupB?.prUrls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — repo score / merged count updates
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — repo score updates', () => {
  it('updates merged PR counts in state for each repo', async () => {
    const mergedRepos = new Map([
      ['owner/repo-a', { count: 3, lastMergedAt: '2026-01-10T00:00:00Z' }],
      ['owner/repo-b', { count: 1, lastMergedAt: '2026-01-05T00:00:00Z' }],
    ]);
    mockFetchUserMergedPRCounts.mockResolvedValue(makeMergedResult(mergedRepos));

    await executeDailyCheck('test-token');

    expect(mockUpdateRepoScore).toHaveBeenCalledWith('owner/repo-a', {
      mergedPRCount: 3,
      lastMergedAt: '2026-01-10T00:00:00Z',
    });
    expect(mockUpdateRepoScore).toHaveBeenCalledWith('owner/repo-b', {
      mergedPRCount: 1,
      lastMergedAt: '2026-01-05T00:00:00Z',
    });
  });

  it('syncs trusted projects for repos with merged PRs', async () => {
    const mergedRepos = new Map([['owner/repo-trusted', { count: 2, lastMergedAt: '2026-01-10T00:00:00Z' }]]);
    mockFetchUserMergedPRCounts.mockResolvedValue(makeMergedResult(mergedRepos));

    await executeDailyCheck('test-token');

    expect(mockAddTrustedProject).toHaveBeenCalledWith('owner/repo-trusted');
  });

  it('updates star counts from fetchRepoStarCounts', async () => {
    mockGetState.mockReturnValue(
      makeDefaultState({
        repoScores: {
          'owner/starred-repo': { repo: 'owner/starred-repo', mergedPRCount: 1, closedWithoutMergeCount: 0, score: 5 },
        },
      }),
    );
    const starCounts = new Map([['owner/starred-repo', 1500]]);
    mockFetchRepoStarCounts.mockResolvedValue(starCounts);

    await executeDailyCheck('test-token');

    expect(mockUpdateRepoScore).toHaveBeenCalledWith('owner/starred-repo', { stargazersCount: 1500 });
  });

  it('stores monthly merged counts', async () => {
    const monthlyCounts = { '2026-01': 2, '2025-12': 1 };
    mockFetchUserMergedPRCounts.mockResolvedValue({
      repos: new Map(),
      monthlyCounts,
      monthlyOpenedCounts: {},
      dailyActivityCounts: {},
    });

    await executeDailyCheck('test-token');

    expect(mockSetMonthlyMergedCounts).toHaveBeenCalledWith(monthlyCounts);
  });

  it('stores monthly closed counts', async () => {
    const monthlyClosedCounts = { '2026-01': 1 };
    mockFetchUserClosedPRCounts.mockResolvedValue({
      repos: new Map(),
      monthlyCounts: monthlyClosedCounts,
      monthlyOpenedCounts: {},
      dailyActivityCounts: {},
    });

    await executeDailyCheck('test-token');

    expect(mockSetMonthlyClosedCounts).toHaveBeenCalledWith(monthlyClosedCounts);
  });
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — error / resilience paths
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — error resilience', () => {
  it('continues if fetchRecentlyClosedPRs fails', async () => {
    mockFetchRecentlyClosedPRs.mockRejectedValue(new Error('Network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await executeDailyCheck('test-token');

    // Should still return a valid result
    expect(result).toHaveProperty('digest');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch recently closed PRs'));
    consoleSpy.mockRestore();
  });

  it('continues if fetchRecentlyMergedPRs fails', async () => {
    mockFetchRecentlyMergedPRs.mockRejectedValue(new Error('Network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await executeDailyCheck('test-token');

    expect(result).toHaveProperty('digest');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch recently merged PRs'));
    consoleSpy.mockRestore();
  });

  it('continues if fetchCommentedIssues fails', async () => {
    mockFetchCommentedIssues.mockRejectedValue(new Error('API error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await executeDailyCheck('test-token');

    expect(result).toHaveProperty('digest');
    expect(result.commentedIssues).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('continues if fetchRepoStarCounts fails, using empty map', async () => {
    mockFetchRepoStarCounts.mockRejectedValue(new Error('Rate limited'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await executeDailyCheck('test-token');

    expect(result).toHaveProperty('digest');
    // No star updates should have been attempted
    const starCalls = (mockUpdateRepoScore.mock.calls as Array<[string, { stargazersCount?: number }]>).filter(
      ([, update]) => 'stargazersCount' in update,
    );
    expect(starCalls).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('logs warning when PR fetch failures occur', async () => {
    const failures = [{ prUrl: 'https://github.com/owner/repo/pull/99', error: 'Not found' }];
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [], failures });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await executeDailyCheck('test-token');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('1 PR fetch(es) failed'));
    consoleSpy.mockRestore();
  });

  it('skips stale repo reset when API returns 0 merged results but state has repos with merges', async () => {
    mockGetState.mockReturnValue(
      makeDefaultState({
        repoScores: {
          'owner/existing': { repo: 'owner/existing', mergedPRCount: 3, closedWithoutMergeCount: 0, score: 7 },
        },
      }),
    );
    // API returns empty (simulates transient failure)
    mockFetchUserMergedPRCounts.mockResolvedValue(makeMergedResult(new Map()));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await executeDailyCheck('test-token');

    // Should NOT have zeroed out the existing score (stale-reset protection)
    const zeroCalls = (mockUpdateRepoScore.mock.calls as Array<[string, { mergedPRCount?: number }]>).filter(
      ([, update]) => update.mergedPRCount === 0,
    );
    expect(zeroCalls).toHaveLength(0);
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — issue conversation / dismiss filtering
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — issue conversation', () => {
  const makeIssue = (
    overrides: { status?: 'waiting' | 'acknowledged'; url?: string; number?: number } = {},
  ): CommentedIssue => ({
    repo: 'owner/repo',
    number: overrides.number ?? 10,
    title: 'Test issue',
    url: overrides.url ?? 'https://github.com/owner/repo/issues/10',
    status: overrides.status ?? 'waiting',
    userLastCommentedAt: '2026-01-10T00:00:00Z',
    labels: [],
    daysSinceUserComment: 5,
  });

  it('includes non-dismissed issues in commentedIssues', async () => {
    const issue = makeIssue();
    mockFetchCommentedIssues.mockResolvedValue({ issues: [issue], failures: [] });
    mockGetIssueDismissedAt.mockReturnValue(undefined);

    const result = await executeDailyCheck('test-token');

    expect(result.commentedIssues).toHaveLength(1);
    expect(result.commentedIssues[0].url).toBe(issue.url);
  });

  it('filters out dismissed issues that have no new activity', async () => {
    const issue = makeIssue({ url: 'https://github.com/owner/repo/issues/11' });
    mockFetchCommentedIssues.mockResolvedValue({ issues: [issue], failures: [] });
    // Dismissed AFTER the last known activity
    mockGetIssueDismissedAt.mockReturnValue('2026-01-20T00:00:00Z');

    const result = await executeDailyCheck('test-token');

    expect(result.commentedIssues).toHaveLength(0);
  });

  it('resurfaces dismissed issue when new_response arrives after dismiss timestamp', async () => {
    const issue: CommentedIssue = {
      repo: 'owner/repo',
      number: 12,
      title: 'Issue with new response',
      url: 'https://github.com/owner/repo/issues/12',
      status: 'new_response',
      userLastCommentedAt: '2026-01-10T00:00:00Z',
      lastResponseAuthor: 'maintainer',
      lastResponseBody: 'LGTM!',
      lastResponseAt: '2026-02-01T00:00:00Z', // After the dismiss timestamp
      labels: [],
      daysSinceUserComment: 5,
      isFromMaintainer: true,
    };
    mockFetchCommentedIssues.mockResolvedValue({ issues: [issue], failures: [] });
    // Dismissed BEFORE the new response
    mockGetIssueDismissedAt.mockReturnValue('2026-01-15T00:00:00Z');

    const result = await executeDailyCheck('test-token');

    expect(result.commentedIssues).toHaveLength(1);
    expect(mockUndismissIssue).toHaveBeenCalledWith(issue.url);
  });
});

// ---------------------------------------------------------------------------
// runDaily() — outer wrapper
// ---------------------------------------------------------------------------

describe('runDaily()', () => {
  beforeEach(() => {
    // Suppress process.exit in tests
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  it('outputs JSON when --json flag is set', async () => {
    vi.mocked(getGitHubToken).mockReturnValue('test-token');

    await runDaily({ json: true });

    expect(outputJson).toHaveBeenCalledOnce();
    const [arg] = vi.mocked(outputJson).mock.calls[0];
    expect(arg).toHaveProperty('digest');
    expect(arg).toHaveProperty('capacity');
  });

  it('prints to console in non-JSON mode', async () => {
    vi.mocked(getGitHubToken).mockReturnValue('test-token');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDaily({ json: false });

    expect(outputJson).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('outputs JSON error and exits on unexpected throw in JSON mode', async () => {
    vi.mocked(getGitHubToken).mockReturnValue('test-token');
    mockFetchUserOpenPRs.mockRejectedValue(new Error('Unexpected API failure'));

    await expect(runDaily({ json: true })).rejects.toThrow('process.exit called');
    expect(outputJsonError).toHaveBeenCalledWith(expect.stringContaining('Daily check failed'));
  });

  it('outputs fatal console error and exits on unexpected throw in non-JSON mode', async () => {
    vi.mocked(getGitHubToken).mockReturnValue('test-token');
    mockFetchUserOpenPRs.mockRejectedValue(new Error('Unexpected API failure'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runDaily({ json: false })).rejects.toThrow('process.exit called');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[FATAL]'));
    consoleSpy.mockRestore();
  });
});
