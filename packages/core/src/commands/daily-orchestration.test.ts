/**
 * Tests for runDaily() / executeDailyCheck() orchestration in daily.ts
 *
 * Coverage focus: the main orchestration flow that was previously at ~8.69% coverage.
 * Helper functions (computeRepoSignals, computeActionMenu, groupPRsByRepo) are
 * already tested in daily.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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
const mockAddMergedPRs = vi.fn(() => ({ added: 0, dropped: 0 }));
const mockAddClosedPRs = vi.fn(() => ({ added: 0, dropped: 0 }));

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
      addMergedPRs: mockAddMergedPRs,
      addClosedPRs: mockAddClosedPRs,
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
      isGistDegraded: vi.fn(() => false),
      batch: (fn: () => void) => fn(),
    })),
    requireGitHubToken: vi.fn(() => 'test-token'),
    formatRelativeTime: vi.fn(() => '2 days ago'),
    PRMonitor: MockPRMonitor,
    IssueConversationMonitor: MockIssueConversationMonitor,
  };
});

// Pin the #1458 deletion of daily's scout pass: if anything in the daily
// pipeline ever constructs a scout again (the deleted Phase 3.5 called
// createAutopilotScout → createScout, then a dead checkpoint()), the spy
// below catches it. The actual module is kept for everything else.
const mockCreateScout = vi.fn();
vi.mock('@oss-scout/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oss-scout/core')>();
  return {
    ...actual,
    createScout: mockCreateScout,
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

  it('surfaces a repo-scores warning when only SOME merged count updates fail (#1448)', async () => {
    const mergedRepos = new Map([
      ['owner/repo-a', { count: 3, lastMergedAt: '2026-01-10T00:00:00Z' }],
      ['owner/repo-b', { count: 1, lastMergedAt: '2026-01-05T00:00:00Z' }],
    ]);
    mockFetchUserMergedPRCounts.mockResolvedValue(makeMergedResult(mergedRepos));
    // Only repo-a's merged-count update throws; repo-b succeeds. Previously the
    // warning fired only when ALL updates failed, leaving 1-of-2 envelope-silent.
    mockUpdateRepoScore.mockImplementation((repo: string, patch: Record<string, unknown>) => {
      if (repo === 'owner/repo-a' && 'mergedPRCount' in patch && patch.mergedPRCount === 3) {
        throw new Error('corrupted repo score');
      }
    });

    const result = await executeDailyCheck('test-token');

    const warning = result.warnings.find((w) => w.phase === 'repo-scores' && w.operation === 'update merged counts');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('1 of 2 merged count update(s) failed');
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
  it('fails with a clear error (not a TypeError) when digest generation throws on a first-ever run (#1456)', async () => {
    // No persisted lastDigest (first-ever run) and generateDigest throws:
    // previously this fell through to `getState().lastDigest!` and died with
    // an unrelated TypeError at `digest.summary` in Phase 5.
    mockGenerateDigest.mockImplementation(() => {
      throw new Error('digest exploded');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(executeDailyCheck('test-token')).rejects.toThrow(
      /Daily digest generation failed and no previously persisted digest exists.*digest exploded/,
    );
    await expect(executeDailyCheck('test-token')).rejects.not.toBeInstanceOf(TypeError);
    consoleSpy.mockRestore();
  });

  it('falls back to the persisted digest and records a partition warning when digest generation throws on a later run', async () => {
    const persisted = makeDigest();
    mockGetState.mockReturnValue(makeDefaultState({ lastDigest: persisted }));
    mockGenerateDigest.mockImplementation(() => {
      throw new Error('digest exploded');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await executeDailyCheck('test-token');

    expect(result.digest.generatedAt).toBe(persisted.generatedAt);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'partition', message: expect.stringContaining('digest exploded') }),
      ]),
    );
    consoleSpy.mockRestore();
  });

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
// executeDailyCheck() — scout pass removal (#1458)
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — scout pass removal (#1458)', () => {
  const recentlyMerged = [
    {
      url: 'https://github.com/owner/repo/pull/1',
      repo: 'owner/repo',
      number: 1,
      title: 'Fix the thing',
      mergedAt: '2026-06-01T00:00:00Z',
    },
  ];
  const recentlyClosed = [
    {
      url: 'https://github.com/owner/repo/pull/2',
      repo: 'owner/repo',
      number: 2,
      title: 'Abandoned attempt',
      closedAt: '2026-06-02T00:00:00Z',
    },
  ];

  it('records recently merged/closed PRs in the ledger without ever constructing a scout', async () => {
    mockFetchRecentlyMergedPRs.mockResolvedValue(recentlyMerged);
    mockFetchRecentlyClosedPRs.mockResolvedValue(recentlyClosed);
    // mockReturnValue survives clearAllMocks; earlier gist tests set true.
    mockIsGistMode.mockReturnValue(false);

    const result = await executeDailyCheck('test-token');

    // Phase 3 still owns the ledger write...
    expect(mockAddMergedPRs).toHaveBeenCalledWith([
      { url: recentlyMerged[0].url, title: recentlyMerged[0].title, mergedAt: recentlyMerged[0].mergedAt },
    ]);
    expect(mockAddClosedPRs).toHaveBeenCalledWith([
      { url: recentlyClosed[0].url, title: recentlyClosed[0].title, closedAt: recentlyClosed[0].closedAt },
    ]);
    // ...and no scout is built (so its dead checkpoint() can't be called either).
    // The deleted Phase 3.5 only ran on this nonempty-recent-PRs path.
    expect(mockCreateScout).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// executeDailyCheck() — outcome ledger persistence (#1461)
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — outcome ledger (#1461)', () => {
  const mergedPR = {
    url: 'https://github.com/org/repo/pull/7',
    repo: 'org/repo',
    number: 7,
    title: 'Merged PR',
    mergedAt: '2026-01-24T12:00:00Z',
    openedAt: '2026-01-10T00:00:00Z',
  };
  const closedPR = {
    url: 'https://github.com/org/repo/pull/8',
    repo: 'org/repo',
    number: 8,
    title: 'Closed PR',
    closedAt: '2026-01-24T13:00:00Z',
    openedAt: '2026-01-11T00:00:00Z',
  };

  it('persists openedAt from the recently-merged/closed fetch results', async () => {
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR]);
    mockFetchRecentlyClosedPRs.mockResolvedValue([closedPR]);

    await executeDailyCheck('test-token');

    expect(mockAddMergedPRs).toHaveBeenCalledWith([
      expect.objectContaining({
        url: mergedPR.url,
        title: mergedPR.title,
        mergedAt: mergedPR.mergedAt,
        openedAt: '2026-01-10T00:00:00Z',
      }),
    ]);
    expect(mockAddClosedPRs).toHaveBeenCalledWith([
      expect.objectContaining({
        url: closedPR.url,
        title: closedPR.title,
        closedAt: closedPR.closedAt,
        openedAt: '2026-01-11T00:00:00Z',
      }),
    ]);
  });

  it('recovers firstMaintainerResponseAt from the previous persisted digest', async () => {
    // The just-merged PR was open during the previous enriched run, so the
    // persisted digest's openPRs entry carries its first maintainer response.
    const previouslyOpen = makePR({
      repo: 'org/repo',
      number: 7,
      url: mergedPR.url,
      status: 'waiting_on_maintainer',
      firstMaintainerResponseAt: '2026-01-12T09:00:00Z',
    });
    mockGetState.mockReturnValue(makeDefaultState({ lastDigest: makeDigest([previouslyOpen]) }));
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR]);

    await executeDailyCheck('test-token');

    expect(mockAddMergedPRs).toHaveBeenCalledWith([
      expect.objectContaining({
        url: mergedPR.url,
        firstMaintainerResponseAt: '2026-01-12T09:00:00Z',
      }),
    ]);
  });

  it('leaves firstMaintainerResponseAt undefined when the PR never appeared in a digest', async () => {
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR]);

    await executeDailyCheck('test-token');

    const [persisted] = mockAddMergedPRs.mock.calls[0] as unknown as [Array<Record<string, unknown>>];
    expect(persisted[0].firstMaintainerResponseAt).toBeUndefined();
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

// ---------------------------------------------------------------------------
// executeDailyCheck() — merge loop (#1463)
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — merge loop (#1463)', () => {
  const ISSUE_URL = 'https://github.com/foo/bar/issues/1';
  const PR_URL = 'https://github.com/foo/bar/pull/123';
  const mergedPR = {
    url: PR_URL,
    repo: 'foo/bar',
    number: 123,
    title: 'Fix the thing',
    mergedAt: '2026-06-10T12:00:00Z',
  };

  let tmpDir: string;
  let listPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-merge-loop-'));
    listPath = path.join(tmpDir, 'issue-list.md');
    fs.writeFileSync(
      listPath,
      [
        '### foo/bar',
        `- [#1](${ISSUE_URL}) — first issue`,
        `  - **In Progress** — PR [#123](${PR_URL}) open.`,
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** State wired for the merge loop: configured list path + unextracted ledger entry. */
  function stateWithListAndLedger() {
    const state = makeDefaultState({
      mergedPRs: [{ url: PR_URL, title: mergedPR.title, mergedAt: mergedPR.mergedAt }],
    });
    (state.config as Record<string, unknown>).issueListPath = listPath;
    return state;
  }

  it('auto-marks the matching curated-list entry done and surfaces it in listUpdates', async () => {
    mockGetState.mockReturnValue(stateWithListAndLedger());
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR]);

    const result = await executeDailyCheck('test-token');

    expect(result.listUpdates).toEqual([
      {
        prUrl: PR_URL,
        issueUrl: ISSUE_URL,
        listPath: path.resolve(listPath),
        repoHeadingStruck: true,
      },
    ]);
    const written = fs.readFileSync(listPath, 'utf8');
    expect(written).toContain(`- ~~[#1](${ISSUE_URL}) — first issue~~`);
    expect(written).toContain(`  - **Done** — PR [#123](${PR_URL}) submitted, merged 2026-06-10.`);
    expect(result.warnings).toEqual([]);
  });

  it('adds the extract_learnings menu item for recent merges without extracted learnings', async () => {
    mockGetState.mockReturnValue(stateWithListAndLedger());
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR]);

    const result = await executeDailyCheck('test-token');

    const item = result.actionMenu.items.find((i) => i.key === 'extract_learnings');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Extract learnings from 1 recently merged PR');
  });

  it('omits extract_learnings when the merge already has learnings extracted', async () => {
    const state = stateWithListAndLedger();
    (state.mergedPRs as Array<Record<string, unknown>>)[0].learningsExtractedAt = '2026-06-11T00:00:00.000Z';
    mockGetState.mockReturnValue(state);
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR]);

    const result = await executeDailyCheck('test-token');

    expect(result.actionMenu.items.find((i) => i.key === 'extract_learnings')).toBeUndefined();
  });

  it('omits listUpdates entirely on a merge-free run', async () => {
    mockFetchRecentlyMergedPRs.mockResolvedValue([]);

    const result = await executeDailyCheck('test-token');

    expect('listUpdates' in result).toBe(false);
    expect(result.actionMenu.items.find((i) => i.key === 'extract_learnings')).toBeUndefined();
  });

  it('omits listUpdates when no list entry mentions the merged PR (silent no-op)', async () => {
    fs.writeFileSync(listPath, '### foo/bar\n- [#9](https://github.com/foo/bar/issues/9) — unrelated\n', 'utf8');
    mockGetState.mockReturnValue(stateWithListAndLedger());
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR]);

    const result = await executeDailyCheck('test-token');

    expect(result.listUpdates).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});
