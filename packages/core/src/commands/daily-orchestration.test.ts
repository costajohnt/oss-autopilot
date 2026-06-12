/**
 * Tests for runDaily() / executeDailyCheck() orchestration in daily.ts
 *
 * Coverage focus: the main orchestration flow that was previously at ~8.69% coverage.
 * Helper functions (computeRepoSignals, computeActionMenu, groupPRsByRepo) are
 * already tested in daily.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FetchedPR, DailyDigest, CommentedIssue } from '../core/types.js';
import { makeFetchedPR } from '../core/test-utils.js';
import type { FetchPRsResult } from '../core/pr-monitor.js';

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

// PRMonitor method mocks
const mockFetchUserOpenPRs = vi.fn<() => Promise<FetchPRsResult>>();
const mockFetchUserMergedPRCounts = vi.fn();
const mockFetchUserClosedPRCounts = vi.fn();
const mockFetchRepoMetadata = vi.fn();
const mockFetchRecentlyClosedPRs = vi.fn();
const mockFetchRecentlyMergedPRs = vi.fn();
const mockGenerateDigest = vi.fn();

// IssueConversationMonitor method mocks
const mockFetchCommentedIssues = vi.fn();

// StateManager method mocks
const mockGetState = vi.fn();
const mockIsGistMode = vi.fn(() => false);
const mockUpdateRepoScore = vi.fn();
const mockAddTrustedProject = vi.fn();
const mockSetMonthlyMergedCounts = vi.fn();
const mockSetMonthlyClosedCounts = vi.fn();
const mockSetMonthlyOpenedCounts = vi.fn();
const mockSetLastDigest = vi.fn();
const mockSave = vi.fn();
const mockIsPRShelved = vi.fn();
const mockUnshelvePR = vi.fn();
const mockGetStats = vi.fn();
const mockGetIssueDismissedAt = vi.fn();
const mockUndismissIssue = vi.fn();
const mockGetStatusOverride = vi.fn();

// daily.ts imports everything from '../core/index.js', so we mock the whole barrel export.
// PRMonitor and IssueConversationMonitor are used as classes (new PRMonitor(...)),
// so we use actual class syntax (not arrow functions) in the mock implementations.
vi.mock('../core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/index.js')>();

  // Capture module-level mocks via closure — the inner class refers to them by name
  class MockPRMonitor {
    fetchUserOpenPRs = mockFetchUserOpenPRs;
    fetchUserMergedPRCounts = mockFetchUserMergedPRCounts;
    fetchUserClosedPRCounts = mockFetchUserClosedPRCounts;
    fetchRepoMetadata = mockFetchRepoMetadata;
    fetchRecentlyClosedPRs = mockFetchRecentlyClosedPRs;
    fetchRecentlyMergedPRs = mockFetchRecentlyMergedPRs;
    generateDigest = mockGenerateDigest;
  }

  class MockIssueConversationMonitor {
    fetchCommentedIssues = mockFetchCommentedIssues;
  }

  return {
    ...actual,
    getStateManager: vi.fn(() => ({
      getState: mockGetState,
      updateRepoScore: mockUpdateRepoScore,
      addTrustedProject: mockAddTrustedProject,
      setMonthlyMergedCounts: mockSetMonthlyMergedCounts,
      setMonthlyClosedCounts: mockSetMonthlyClosedCounts,
      setMonthlyOpenedCounts: mockSetMonthlyOpenedCounts,
      setLastDigest: mockSetLastDigest,
      setLastStrategyAt: vi.fn(),
      save: mockSave,
      isPRShelved: mockIsPRShelved,
      unshelvePR: mockUnshelvePR,
      getStats: mockGetStats,
      getIssueDismissedAt: mockGetIssueDismissedAt,
      undismissIssue: mockUndismissIssue,
      getStatusOverride: mockGetStatusOverride,
      getStateStaleness: vi.fn(() => null),
      getLoadRecovery: vi.fn(() => null),
      isGistMode: mockIsGistMode,
      batch: (fn: () => void) => fn(),
    })),
    requireGitHubToken: vi.fn(() => 'test-token'),
    formatRelativeTime: vi.fn(() => '2 days ago'),
    PRMonitor: MockPRMonitor,
    IssueConversationMonitor: MockIssueConversationMonitor,
  };
});

// applyStatusOverrides (in daily-logic.ts) imports getStateManager from './state.js' directly,
// not via the barrel. Mock it so the real function resolves to the same mock state manager.
vi.mock('../core/state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: mockGetState,
    getStatusOverride: mockGetStatusOverride,
    save: mockSave,
    batch: (fn: () => void) => fn(),
  })),
}));

// Import AFTER all mocks are declared
import { executeDailyCheck, runDaily, runDailyForDisplay } from './daily.js';
import { requireGitHubToken } from '../core/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a FetchedPR with repo as required (mirrors orchestration's per-repo grouping). */
function makePR(overrides: Parameters<typeof makeFetchedPR>[0] & { repo: string }) {
  return makeFetchedPR({ daysSinceActivity: 5, ...overrides });
}

/** Build a minimal DailyDigest for mock responses */
function makeDigest(prs: FetchedPR[] = []): DailyDigest {
  return {
    generatedAt: '2026-01-25T10:00:00Z',
    openPRs: prs,
    needsAddressingPRs: prs.filter((p) => p.status === 'needs_addressing'),
    waitingOnMaintainerPRs: prs.filter((p) => p.status === 'waiting_on_maintainer'),
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
    version: 3,
    activeIssues: [],
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
    },
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
  mockFetchRepoMetadata.mockResolvedValue(new Map<string, { stars: number; language: string | null }>());
  mockFetchRecentlyClosedPRs.mockResolvedValue([]);
  mockFetchRecentlyMergedPRs.mockResolvedValue([]);
  mockGenerateDigest.mockReturnValue(makeDigest());

  // Default issue conversation response (no issues)
  mockFetchCommentedIssues.mockResolvedValue({ issues: [], failures: [] });

  // Default state manager side-effect mocks
  mockIsPRShelved.mockReturnValue(false);
  mockUnshelvePR.mockReturnValue(true);
  mockGetIssueDismissedAt.mockReturnValue(undefined);
  mockGetStatusOverride.mockReturnValue(undefined);
  mockUpdateRepoScore.mockImplementation(() => {});
  mockAddTrustedProject.mockImplementation(() => {});
  mockSave.mockImplementation(() => {});
  // setLastDigest must update the mock state so partitionPRs can read it back
  mockSetLastDigest.mockImplementation((digest: DailyDigest) => {
    const state = mockGetState();
    state.lastDigest = digest;
    state.lastDigestAt = digest.generatedAt;
  });
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

  it('calls fetchRepoMetadata with all repo keys from state', async () => {
    mockGetState.mockReturnValue(
      makeDefaultState({
        repoScores: {
          'owner/repo-a': { repo: 'owner/repo-a', mergedPRCount: 2, closedWithoutMergeCount: 0, score: 5 },
          'owner/repo-b': { repo: 'owner/repo-b', mergedPRCount: 1, closedWithoutMergeCount: 0, score: 4 },
        },
      }),
    );
    await executeDailyCheck('test-token');
    const [calledRepos] = mockFetchRepoMetadata.mock.calls[0];
    expect(calledRepos).toContain('owner/repo-a');
    expect(calledRepos).toContain('owner/repo-b');
  });

  it('calls batch to persist state after partitioning', async () => {
    await executeDailyCheck('test-token');
    // State persistence is handled by batch() + autoSave() inside mutations
    // Verify the key mutation was called (setLastDigest)
    expect(mockSetLastDigest).toHaveBeenCalled();
  });

  it('calls setLastDigest to persist digest in state', async () => {
    await executeDailyCheck('test-token');
    expect(mockSetLastDigest).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — PR partitioning (active vs shelved)
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — PR partitioning', () => {
  it('puts non-shelved, non-dormant PRs into active list', async () => {
    const activePR = makePR({ repo: 'owner/repo', number: 1, status: 'waiting_on_maintainer' });
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
    const dormantPR = makePR({
      repo: 'owner/repo',
      number: 2,
      status: 'waiting_on_maintainer',
      stalenessTier: 'dormant',
    });
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

  it('keeps dormant PR active when it needs addressing (motivating use case)', async () => {
    // This is THE key scenario: a long-dormant PR gets new maintainer activity.
    // It should surface as active, not be hidden in the shelved section.
    const dormantButNeedy = makePR({
      repo: 'owner/repo',
      number: 6,
      status: 'needs_addressing',
      actionReason: 'needs_response',
      stalenessTier: 'dormant',
    });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [dormantButNeedy], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([dormantButNeedy]));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    // Should be active, NOT shelved
    expect(result.digest.shelvedPRs).toHaveLength(0);
    const allGroupedPRUrls = result.repoGroups.flatMap((g) => g.prUrls);
    expect(allGroupedPRUrls).toContain(dormantButNeedy.url);
    // Should appear in actionable issues (compact format uses prUrl)
    expect(result.actionableIssues.some((i) => i.prUrl === dormantButNeedy.url)).toBe(true);
  });

  it('puts explicitly shelved PRs into shelvedPRs section', async () => {
    const shelvedPR = makePR({ repo: 'owner/repo', number: 3, status: 'waiting_on_maintainer' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [shelvedPR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([shelvedPR]));
    // This PR is explicitly shelved in state
    mockIsPRShelved.mockReturnValue(true);

    const result = await executeDailyCheck('test-token');

    expect(result.digest.shelvedPRs).toHaveLength(1);
    expect(result.digest.shelvedPRs[0].url).toBe(shelvedPR.url);
  });

  it('auto-unshelves a shelved PR when it has a critical status', async () => {
    const criticalPR = makePR({
      repo: 'owner/repo',
      number: 4,
      status: 'needs_addressing',
      actionReason: 'needs_response',
    });
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
    const shelvedWaiting = makePR({ repo: 'owner/repo', number: 5, status: 'waiting_on_maintainer' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [shelvedWaiting], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([shelvedWaiting]));
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
      makePR({ repo: 'owner/repo', number: 1, status: 'waiting_on_maintainer' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'waiting_on_maintainer' }),
      makePR({ repo: 'owner/repo', number: 3, status: 'waiting_on_maintainer' }),
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
    const prs = Array.from({ length: 10 }, (_, i) =>
      makePR({ repo: 'owner/repo', number: i + 1, status: 'waiting_on_maintainer' }),
    );
    mockFetchUserOpenPRs.mockResolvedValue({ prs, failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest(prs));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(result.capacity.hasCapacity).toBe(false);
    expect(result.capacity.activePRCount).toBe(10);
  });

  it('reports no capacity when critical issues exist (even under limit)', async () => {
    const prs = [makePR({ repo: 'owner/repo', number: 1, status: 'needs_addressing', actionReason: 'needs_response' })];
    mockFetchUserOpenPRs.mockResolvedValue({ prs, failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest(prs));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(result.capacity.hasCapacity).toBe(false);
    expect(result.capacity.criticalIssueCount).toBe(1);
  });

  it('excludes shelved PRs from capacity count', async () => {
    const activePR = makePR({ repo: 'owner/repo', number: 1, status: 'waiting_on_maintainer' });
    const shelvedPR = makePR({ repo: 'owner/repo', number: 2, status: 'waiting_on_maintainer' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [activePR, shelvedPR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([activePR, shelvedPR]));
    mockIsPRShelved.mockImplementation((url: string) => url === shelvedPR.url);

    const result = await executeDailyCheck('test-token');

    // Only the active PR counts
    expect(result.capacity.activePRCount).toBe(1);
    expect(result.capacity.shelvedPRCount).toBe(1);
    expect(result.capacity.hasCapacity).toBe(true);
  });

  it('needs_addressing status counts against capacity regardless of actionReason', async () => {
    const actionReasons = ['needs_response', 'needs_changes', 'failing_ci', 'merge_conflict'] as const;
    for (const actionReason of actionReasons) {
      // Reset mocks between iterations (beforeEach only runs once per it())
      vi.clearAllMocks();
      mockGetState.mockReturnValue(makeDefaultState());
      mockFetchUserOpenPRs.mockResolvedValue({ prs: [], failures: [] });
      mockFetchUserMergedPRCounts.mockResolvedValue(makeMergedResult());
      mockFetchUserClosedPRCounts.mockResolvedValue(makeClosedResult());
      mockFetchRepoMetadata.mockResolvedValue(new Map<string, { stars: number; language: string | null }>());
      mockFetchRecentlyClosedPRs.mockResolvedValue([]);
      mockFetchRecentlyMergedPRs.mockResolvedValue([]);
      mockFetchCommentedIssues.mockResolvedValue({ issues: [], failures: [] });
      mockIsPRShelved.mockReturnValue(false);
      mockGetIssueDismissedAt.mockReturnValue(undefined);
      mockSave.mockImplementation(() => {});

      const pr = makePR({ repo: 'owner/repo', number: 1, status: 'needs_addressing', actionReason });
      mockFetchUserOpenPRs.mockResolvedValue({ prs: [pr], failures: [] });
      mockGenerateDigest.mockReturnValue(makeDigest([pr]));

      const result = await executeDailyCheck('test-token');
      expect(result.capacity.criticalIssueCount).toBeGreaterThan(0);
      expect(result.capacity.hasCapacity).toBe(false);
    }
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
    const prs = [makePR({ repo: 'owner/repo', number: 1, status: 'waiting_on_maintainer' })];
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
    const prs = [makePR({ repo: 'owner/repo', number: 1, status: 'needs_addressing', actionReason: 'needs_response' })];
    mockFetchUserOpenPRs.mockResolvedValue({ prs, failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest(prs));
    mockIsPRShelved.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(result.actionMenu.items[0].key).toBe('address_all');
    expect(result.actionMenu.context.hasActionableIssues).toBe(true);
  });

  it('digest.summary.totalActivePRs reflects active (non-shelved) PRs', async () => {
    const activePR = makePR({ repo: 'owner/repo', number: 1, status: 'waiting_on_maintainer' });
    const shelvedPR = makePR({ repo: 'owner/repo', number: 2, status: 'waiting_on_maintainer' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [activePR, shelvedPR], failures: [] });
    mockGenerateDigest.mockReturnValue(makeDigest([activePR, shelvedPR]));
    mockIsPRShelved.mockImplementation((url: string) => url === shelvedPR.url);

    const result = await executeDailyCheck('test-token');

    // Only the 1 active PR counted in the summary
    expect(result.digest.summary.totalActivePRs).toBe(1);
  });

  it('repoGroups groups PRs by repository', async () => {
    const pr1 = makePR({ repo: 'owner/repo-a', number: 1, status: 'waiting_on_maintainer' });
    const pr2 = makePR({ repo: 'owner/repo-a', number: 2, status: 'waiting_on_maintainer' });
    const pr3 = makePR({ repo: 'owner/repo-b', number: 3, status: 'waiting_on_maintainer' });
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

  it('updates star counts and language from fetchRepoMetadata', async () => {
    mockGetState.mockReturnValue(
      makeDefaultState({
        repoScores: {
          'owner/starred-repo': { repo: 'owner/starred-repo', mergedPRCount: 1, closedWithoutMergeCount: 0, score: 5 },
        },
      }),
    );
    const metadata = new Map<string, { stars: number; language: string | null }>([
      ['owner/starred-repo', { stars: 1500, language: 'TypeScript' }],
    ]);
    mockFetchRepoMetadata.mockResolvedValue(metadata);

    await executeDailyCheck('test-token');

    expect(mockUpdateRepoScore).toHaveBeenCalledWith('owner/starred-repo', {
      stargazersCount: 1500,
      language: 'TypeScript',
    });
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
  it('surfaces gist-mode degradation in the warnings envelope (#1431)', async () => {
    // Config says gist, but this process's manager is local-only (transient
    // init fallback or a localOnly entry point). Previously the only signal
    // was stderr — invisible to --json/cron consumers.
    mockGetState.mockReturnValue(makeDefaultState({ config: { ...makeDefaultState().config, persistence: 'gist' } }));
    mockIsGistMode.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: 'gist-init', operation: 'Gist persistence degraded' })]),
    );
  });

  it('does not warn when gist mode is active or local mode is configured', async () => {
    mockGetState.mockReturnValue(makeDefaultState({ config: { ...makeDefaultState().config, persistence: 'gist' } }));
    mockIsGistMode.mockReturnValue(true);
    const gistResult = await executeDailyCheck('test-token');
    expect(gistResult.warnings.filter((w) => w.phase === 'gist-init')).toEqual([]);

    mockGetState.mockReturnValue(makeDefaultState());
    const localResult = await executeDailyCheck('test-token');
    expect(localResult.warnings.filter((w) => w.phase === 'gist-init')).toEqual([]);
  });

  it('continues if fetchRecentlyClosedPRs fails', async () => {
    mockFetchRecentlyClosedPRs.mockRejectedValue(new Error('Network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await executeDailyCheck('test-token');

    // Should still return a valid result
    expect(result).toHaveProperty('digest');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('fetch recently closed PRs'));
    // New structured warnings surface the same failure for programmatic consumers (#1042).
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: 'fetch', operation: 'fetch recently closed PRs' })]),
    );
    consoleSpy.mockRestore();
  });

  it('continues if fetchRecentlyMergedPRs fails', async () => {
    mockFetchRecentlyMergedPRs.mockRejectedValue(new Error('Network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await executeDailyCheck('test-token');

    expect(result).toHaveProperty('digest');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('fetch recently merged PRs'));
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: 'fetch', operation: 'fetch recently merged PRs' })]),
    );
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

  it('continues if fetchRepoMetadata fails with non-rate-limit error, using empty map', async () => {
    mockFetchRepoMetadata.mockRejectedValue(new Error('Network timeout'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await executeDailyCheck('test-token');

    expect(result).toHaveProperty('digest');
    // No metadata updates should have been attempted
    const metadataCalls = (mockUpdateRepoScore.mock.calls as Array<[string, { stargazersCount?: number }]>).filter(
      ([, update]) => 'stargazersCount' in update,
    );
    expect(metadataCalls).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('propagates rate limit errors from fetchRepoMetadata (#677)', async () => {
    const rateLimitError = Object.assign(new Error('API rate limit exceeded'), { status: 429 });
    mockFetchRepoMetadata.mockRejectedValue(rateLimitError);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(executeDailyCheck('test-token')).rejects.toThrow('API rate limit exceeded');
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
    userLastCommentBody: '',
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
      userLastCommentBody: '',
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
  it('returns a DailyOutput with deduplicated data', async () => {
    vi.mocked(requireGitHubToken).mockReturnValue('test-token');

    const result = await runDaily();

    expect(result).toHaveProperty('digest');
    expect(result).toHaveProperty('capacity');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('briefSummary');
  });

  it('propagates errors to the caller', async () => {
    vi.mocked(requireGitHubToken).mockReturnValue('test-token');
    mockFetchUserOpenPRs.mockRejectedValue(new Error('Unexpected API failure'));

    await expect(runDaily()).rejects.toThrow('Unexpected API failure');
  });
});

describe('runDailyForDisplay()', () => {
  it('returns a full DailyCheckResult with non-deduplicated data', async () => {
    vi.mocked(requireGitHubToken).mockReturnValue('test-token');

    const result = await runDailyForDisplay();

    // Full result has digest with FetchedPR objects (not URL strings)
    expect(result).toHaveProperty('digest');
    expect(result).toHaveProperty('capacity');
    expect(result).toHaveProperty('repoGroups');
    // repoGroups in full result have .prs (not .prUrls)
    if (result.repoGroups.length > 0) {
      expect(result.repoGroups[0]).toHaveProperty('prs');
    }
  });
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — status override integration (#644)
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — status overrides (#644)', () => {
  /** Build state with a statusOverrides entry, merging into the default config. */
  function stateWithOverrides(overrides: Record<string, { status: string; setAt: string; lastActivityAt: string }>) {
    const base = makeDefaultState();
    return { ...base, config: { ...base.config, statusOverrides: overrides } };
  }

  /** Wire up mocks so getStatusOverride returns the given override for a specific URL. */
  function setupOverrideMock(prUrl: string, override: { status: string; setAt: string; lastActivityAt: string }) {
    mockGetStatusOverride.mockImplementation((url: string) => (url === prUrl ? override : undefined));
  }

  it('PR overridden to waiting_on_maintainer does not appear in actionable issues', async () => {
    const overriddenPR = makePR({
      repo: 'owner/repo',
      number: 1,
      status: 'needs_addressing',
      actionReason: 'needs_response',
    });
    const normalPR = makePR({
      repo: 'owner/repo',
      number: 2,
      status: 'needs_addressing',
      actionReason: 'failing_ci',
    });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [overriddenPR, normalPR], failures: [] });
    mockIsPRShelved.mockReturnValue(false);

    const override = {
      status: 'waiting_on_maintainer',
      setAt: '2026-01-20T00:00:00Z',
      lastActivityAt: overriddenPR.updatedAt,
    };
    mockGetState.mockReturnValue(stateWithOverrides({ [overriddenPR.url]: override }));
    setupOverrideMock(overriddenPR.url, override);
    mockGenerateDigest.mockImplementation((prs: FetchedPR[]) => makeDigest(prs));

    const result = await executeDailyCheck('test-token');

    const actionableUrls = result.actionableIssues.map((i) => i.prUrl);
    expect(actionableUrls).not.toContain(overriddenPR.url);
    expect(actionableUrls).toContain(normalPR.url);
    expect(result.capacity.criticalIssueCount).toBe(1); // only normalPR
  });

  it('persists the RAW status in lastDigest while the categorized output reflects the override (#1445)', async () => {
    const overriddenPR = makePR({
      repo: 'owner/repo',
      number: 1,
      status: 'needs_addressing',
      actionReason: 'needs_response',
    });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [overriddenPR], failures: [] });
    mockIsPRShelved.mockReturnValue(false);

    const override = {
      status: 'waiting_on_maintainer',
      setAt: '2026-01-20T00:00:00Z',
      lastActivityAt: overriddenPR.updatedAt,
    };
    mockGetState.mockReturnValue(stateWithOverrides({ [overriddenPR.url]: override }));
    setupOverrideMock(overriddenPR.url, override);
    mockGenerateDigest.mockImplementation((prs: FetchedPR[]) => makeDigest(prs));

    const result = await executeDailyCheck('test-token');

    // The persisted digest carries the RAW status: applyStatusOverrides can
    // apply overrides but never un-apply baked ones, so persisting the
    // override-applied digest would make clearing an override a silent no-op
    // on dashboard rebuilds (#1445).
    expect(mockSetLastDigest).toHaveBeenCalledOnce();
    const persisted = mockSetLastDigest.mock.calls[0][0] as DailyDigest;
    const persistedPR = persisted.openPRs.find((p) => p.url === overriddenPR.url);
    expect(persistedPR?.status).toBe('needs_addressing');
    expect(persisted.needsAddressingPRs.map((p) => p.url)).toContain(overriddenPR.url);
    expect(persisted.waitingOnMaintainerPRs).toHaveLength(0);

    // The returned (categorized) output still reflects the override — daily's
    // own view stays override-applied (#644). Category arrays are compact
    // URL references after toDailyOutput (#287).
    const outputPR = result.digest.openPRs.find((p) => p.url === overriddenPR.url);
    expect(outputPR?.status).toBe('waiting_on_maintainer');
    expect(result.digest.waitingOnMaintainerPRs).toContain(overriddenPR.url);
    expect(result.digest.needsAddressingPRs).toHaveLength(0);
    expect(result.actionableIssues.map((i) => i.prUrl)).not.toContain(overriddenPR.url);
  });

  it('PR overridden to needs_addressing appears in actionable issues', async () => {
    const overriddenPR = makePR({
      repo: 'owner/repo',
      number: 1,
      status: 'waiting_on_maintainer',
      waitReason: 'pending_review',
    });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [overriddenPR], failures: [] });
    mockIsPRShelved.mockReturnValue(false);

    const override = {
      status: 'needs_addressing',
      setAt: '2026-01-20T00:00:00Z',
      lastActivityAt: overriddenPR.updatedAt,
    };
    mockGetState.mockReturnValue(stateWithOverrides({ [overriddenPR.url]: override }));
    setupOverrideMock(overriddenPR.url, override);
    mockGenerateDigest.mockImplementation((prs: FetchedPR[]) => makeDigest(prs));

    const result = await executeDailyCheck('test-token');

    const actionableUrls = result.actionableIssues.map((i) => i.prUrl);
    expect(actionableUrls).toContain(overriddenPR.url);
    expect(result.capacity.criticalIssueCount).toBe(1);
  });
});
