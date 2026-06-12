/**
 * Tests for dashboard-data aggregation helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DailyDigest, ShelvedPRRef, StoredMergedPR, StoredClosedPR } from '../core/types.js';
import { makeDailyDigest, makeAgentState as makeState, makeFetchedPR } from '../core/test-utils.js';

// ── Mock function declarations (vi.hoisted so they are available in vi.mock factories) ──
const {
  mockSetMonthlyMergedCounts,
  mockSetMonthlyClosedCounts,
  mockSetMonthlyOpenedCounts,
  mockGetState,
  mockBatch,
  mockSetLastDigest,
  mockAddMergedPRs,
  mockAddClosedPRs,
  mockGetMergedPRWatermark,
  mockGetClosedPRWatermark,
  mockGetMergedPRs,
  mockGetClosedPRs,
  mockReloadIfChanged,
  mockFetchUserOpenPRs,
  mockFetchRecentlyClosedPRs,
  mockFetchRecentlyMergedPRs,
  mockFetchUserMergedPRCounts,
  mockFetchUserClosedPRCounts,
  mockGenerateDigest,
  mockFetchCommentedIssues,
  mockGetOctokit,
  mockFetchMergedPRsSince,
  mockFetchClosedPRsSince,
  mockBuildStarFilter,
  mockToShelvedPRRef,
  mockApplyStatusOverrides,
  mockIsRateLimitOrAuthError,
  mockWarn,
} = vi.hoisted(() => ({
  mockSetMonthlyMergedCounts: vi.fn(),
  mockSetMonthlyClosedCounts: vi.fn(),
  mockSetMonthlyOpenedCounts: vi.fn(),
  mockGetState: vi.fn(),
  mockBatch: vi.fn((fn: () => void) => fn()),
  mockSetLastDigest: vi.fn(),
  mockAddMergedPRs: vi.fn(),
  mockAddClosedPRs: vi.fn(),
  mockGetMergedPRWatermark: vi.fn(),
  mockGetClosedPRWatermark: vi.fn(),
  mockGetMergedPRs: vi.fn().mockReturnValue([]),
  mockGetClosedPRs: vi.fn().mockReturnValue([]),
  mockReloadIfChanged: vi.fn().mockReturnValue(false),
  mockFetchUserOpenPRs: vi.fn(),
  mockFetchRecentlyClosedPRs: vi.fn(),
  mockFetchRecentlyMergedPRs: vi.fn(),
  mockFetchUserMergedPRCounts: vi.fn(),
  mockFetchUserClosedPRCounts: vi.fn(),
  mockGenerateDigest: vi.fn(),
  mockFetchCommentedIssues: vi.fn(),
  mockGetOctokit: vi.fn().mockReturnValue({}),
  mockFetchMergedPRsSince: vi.fn().mockResolvedValue([]),
  mockFetchClosedPRsSince: vi.fn().mockResolvedValue([]),
  mockBuildStarFilter: vi.fn().mockReturnValue(undefined),
  // Identity by default (also re-installed in beforeEach after clearAllMocks);
  // #1416 ordering tests swap in a status-flipping implementation to prove
  // overrides are applied before partitioning. An undefined-returning default
  // would crash fetchDashboardData inside its swallow-and-warn persistence
  // guard — a false green.
  mockApplyStatusOverrides: vi.fn((prs: unknown, _state?: unknown) => prs),
  mockToShelvedPRRef: vi.fn((pr: any) => ({
    number: pr.number,
    url: pr.url,
    title: pr.title,
    repo: pr.repo,
    daysSinceActivity: pr.daysSinceActivity,
    status: pr.status,
  })),
  mockIsRateLimitOrAuthError: vi.fn().mockReturnValue(false),
  mockWarn: vi.fn(),
}));

vi.mock('../core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/index.js')>();

  class MockPRMonitor {
    fetchUserOpenPRs = mockFetchUserOpenPRs;
    fetchRecentlyClosedPRs = mockFetchRecentlyClosedPRs;
    fetchRecentlyMergedPRs = mockFetchRecentlyMergedPRs;
    fetchUserMergedPRCounts = mockFetchUserMergedPRCounts;
    fetchUserClosedPRCounts = mockFetchUserClosedPRCounts;
    generateDigest = mockGenerateDigest;
  }

  class MockIssueConversationMonitor {
    fetchCommentedIssues = mockFetchCommentedIssues;
  }

  return {
    ...actual,
    getStateManager: vi.fn(() => ({
      getState: mockGetState,
      setMonthlyMergedCounts: mockSetMonthlyMergedCounts,
      setMonthlyClosedCounts: mockSetMonthlyClosedCounts,
      setMonthlyOpenedCounts: mockSetMonthlyOpenedCounts,
      batch: mockBatch,
      setLastDigest: mockSetLastDigest,
      addMergedPRs: mockAddMergedPRs,
      addClosedPRs: mockAddClosedPRs,
      getMergedPRWatermark: mockGetMergedPRWatermark,
      getClosedPRWatermark: mockGetClosedPRWatermark,
      getMergedPRs: mockGetMergedPRs,
      getClosedPRs: mockGetClosedPRs,
      reloadIfChanged: mockReloadIfChanged,
    })),
    getOctokit: mockGetOctokit,
    PRMonitor: MockPRMonitor,
    IssueConversationMonitor: MockIssueConversationMonitor,
    // dashboard-data.ts now imports these from the core barrel directly
    // (#1208 M7 moved buildStarFilter from daily.ts → daily-logic.ts).
    // Override here so the existing mockBuildStarFilter / mockToShelvedPRRef
    // wiring keeps working.
    buildStarFilter: (...args: unknown[]) => mockBuildStarFilter(...args),
    toShelvedPRRef: (pr: unknown) => mockToShelvedPRRef(pr),
    applyStatusOverrides: (prs: unknown, state: unknown) => mockApplyStatusOverrides(prs, state),
  };
});

vi.mock('../core/logger.js', () => ({
  warn: (...args: unknown[]) => mockWarn(...args),
}));

vi.mock('../core/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/errors.js')>();
  const mockedIsRateLimitOrAuthError = (...args: unknown[]) => mockIsRateLimitOrAuthError(...args);
  return {
    ...actual,
    isRateLimitOrAuthError: mockedIsRateLimitOrAuthError,
    // Override nonFatalCatch so it consults the mocked predicate, not the
    // original in-module reference (which is not replaced by `...actual`).
    nonFatalCatch: <T>(params: { module: string; label: string; fallback: T }) => {
      return (err: unknown): T => {
        if (mockedIsRateLimitOrAuthError(err)) throw err;
        mockWarn(params.module, `Failed to ${params.label}: ${actual.errorMessage(err)}`);
        return params.fallback;
      };
    },
  };
});

vi.mock('../core/github-stats.js', () => ({
  emptyPRCountsResult: () => ({
    repos: new Map(),
    monthlyCounts: {},
    monthlyOpenedCounts: {},
    dailyActivityCounts: {},
  }),
  fetchMergedPRsSince: (...args: unknown[]) => mockFetchMergedPRsSince(...args),
  fetchClosedPRsSince: (...args: unknown[]) => mockFetchClosedPRsSince(...args),
}));

vi.mock('./daily.js', () => ({
  toShelvedPRRef: (pr: unknown) => mockToShelvedPRRef(pr),
  buildStarFilter: (...args: unknown[]) => mockBuildStarFilter(...args),
}));

import {
  buildDashboardStats,
  computePRsByRepo,
  computeTopRepos,
  getMonthlyData,
  mergeMonthlyCounts,
  storedToMergedPRs,
  storedToClosedPRs,
  updateMonthlyAnalytics,
  fetchDashboardData,
} from './dashboard-data.js';

function makeDigest(overrides: Partial<DailyDigest> = {}): DailyDigest {
  return makeDailyDigest({ generatedAt: new Date().toISOString(), ...overrides });
}

// ---------------------------------------------------------------------------
// buildDashboardStats
// ---------------------------------------------------------------------------

describe('buildDashboardStats', () => {
  it('returns zeros when digest has no summary', () => {
    const digest = makeDigest();
    // Remove summary to trigger the default fallback
    (digest as any).summary = undefined;
    const stats = buildDashboardStats(digest, makeState());
    expect(stats).toEqual({
      activePRs: 0,
      shelvedPRs: 0,
      mergedPRs: 0,
      closedPRs: 0,
      mergeRate: '0.0%',
    });
  });

  it('pulls activePRs from summary.totalActivePRs', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 5, totalNeedingAttention: 2, totalMergedAllTime: 10, mergeRate: 80 },
    });
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.activePRs).toBe(5);
  });

  it('counts shelvedPRs from digest.shelvedPRs array length', () => {
    const shelvedPRs: ShelvedPRRef[] = [
      { number: 1, url: 'u1', title: 't1', repo: 'r/1', daysSinceActivity: 5, status: 'waiting_on_maintainer' },
      { number: 2, url: 'u2', title: 't2', repo: 'r/2', daysSinceActivity: 10, status: 'needs_addressing' },
    ];
    const digest = makeDigest({ shelvedPRs });
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.shelvedPRs).toBe(2);
  });

  it('pulls mergedPRs from summary.totalMergedAllTime', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 42, mergeRate: 85 },
    });
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.mergedPRs).toBe(42);
  });

  it('sums closedWithoutMergeCount across repoScores that meet minStars', () => {
    const state = makeState({
      repoScores: {
        'a/b': {
          repo: 'a/b',
          score: 5,
          mergedPRCount: 1,
          closedWithoutMergeCount: 3,
          stargazersCount: 100,
          avgResponseDays: null,
          lastEvaluatedAt: '2025-06-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
        'c/d': {
          repo: 'c/d',
          score: 7,
          mergedPRCount: 2,
          closedWithoutMergeCount: 1,
          stargazersCount: 200,
          avgResponseDays: null,
          lastEvaluatedAt: '2025-06-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
      },
    });
    const stats = buildDashboardStats(makeDigest(), state);
    expect(stats.closedPRs).toBe(4); // 3 + 1
  });

  it('excludes repos below minStars from closedPRs count (#576)', () => {
    const state = makeState({
      config: { githubUsername: 'testuser', shelvedPRUrls: [], minStars: 50 },
      repoScores: {
        'big/repo': {
          repo: 'big/repo',
          score: 8,
          mergedPRCount: 5,
          closedWithoutMergeCount: 3,
          stargazersCount: 500,
          avgResponseDays: null,
          lastEvaluatedAt: '2025-06-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
        'tiny/repo': {
          repo: 'tiny/repo',
          score: 2,
          mergedPRCount: 1,
          closedWithoutMergeCount: 10,
          stargazersCount: 5,
          avgResponseDays: null,
          lastEvaluatedAt: '2025-06-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
      },
    });
    const stats = buildDashboardStats(makeDigest(), state);
    expect(stats.closedPRs).toBe(3); // only big/repo; tiny/repo (5 stars) excluded
  });

  it('formats mergeRate as a percentage string', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 72.3456 },
    });
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.mergeRate).toBe('72.3%');
  });

  it('handles null/undefined mergeRate gracefully', () => {
    const digest = makeDigest();
    (digest.summary as any).mergeRate = null;
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.mergeRate).toBe('0.0%');
  });

  it('excludes repos with undefined stargazersCount from closedPRs count', () => {
    const state = makeState({
      repoScores: {
        'known/repo': {
          repo: 'known/repo',
          score: 8,
          mergedPRCount: 2,
          closedWithoutMergeCount: 4,
          stargazersCount: 500,
          avgResponseDays: null,
          lastEvaluatedAt: '2025-06-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
        'unknown/repo': {
          repo: 'unknown/repo',
          score: 3,
          mergedPRCount: 1,
          closedWithoutMergeCount: 7,
          avgResponseDays: null,
          lastEvaluatedAt: '2025-06-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
      },
    });
    const stats = buildDashboardStats(makeDigest(), state);
    expect(stats.closedPRs).toBe(4); // only known/repo; unknown/repo has no stargazersCount
  });

  it('handles missing repoScores gracefully', () => {
    const state = makeState();
    (state as any).repoScores = undefined;
    const stats = buildDashboardStats(makeDigest(), state);
    expect(stats.closedPRs).toBe(0);
  });

  it('handles missing shelvedPRs array', () => {
    const digest = makeDigest();
    (digest as any).shelvedPRs = undefined;
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.shelvedPRs).toBe(0);
  });
});

describe('computePRsByRepo', () => {
  it('should group active PRs by repo', () => {
    const digest = makeDigest({
      openPRs: [
        { repo: 'owner/alpha', url: 'https://github.com/owner/alpha/pull/1' },
        { repo: 'owner/alpha', url: 'https://github.com/owner/alpha/pull/2' },
        { repo: 'owner/beta', url: 'https://github.com/owner/beta/pull/1' },
      ] as any[],
    });
    const state = makeState();

    const result = computePRsByRepo(digest, state);

    expect(result['owner/alpha'].active).toBe(2);
    expect(result['owner/beta'].active).toBe(1);
  });

  it('should include merged/closed counts from repoScores', () => {
    const digest = makeDigest();
    const state = makeState({
      repoScores: {
        'owner/alpha': { mergedPRCount: 5, closedWithoutMergeCount: 2, stargazersCount: 100 } as any,
        'owner/beta': { mergedPRCount: 10, closedWithoutMergeCount: 0, stargazersCount: 200 } as any,
      },
    });

    const result = computePRsByRepo(digest, state);

    expect(result['owner/alpha']).toEqual({ active: 0, merged: 5, closed: 2 });
    expect(result['owner/beta']).toEqual({ active: 0, merged: 10, closed: 0 });
  });

  it('should combine active PRs and repoScores for the same repo', () => {
    const digest = makeDigest({
      openPRs: [{ repo: 'owner/alpha', url: 'https://github.com/owner/alpha/pull/3' }] as any[],
    });
    const state = makeState({
      repoScores: {
        'owner/alpha': { mergedPRCount: 3, closedWithoutMergeCount: 1, stargazersCount: 100 } as any,
      },
    });

    const result = computePRsByRepo(digest, state);

    expect(result['owner/alpha']).toEqual({ active: 1, merged: 3, closed: 1 });
  });

  it('should exclude repoScores below minStars', () => {
    const digest = makeDigest();
    const state = makeState({
      repoScores: {
        'owner/popular': { mergedPRCount: 5, closedWithoutMergeCount: 2, stargazersCount: 100 } as any,
        'owner/tiny': { mergedPRCount: 3, closedWithoutMergeCount: 1, stargazersCount: 10 } as any,
        'owner/unknown': { mergedPRCount: 2, closedWithoutMergeCount: 1 } as any,
      },
    });

    const result = computePRsByRepo(digest, state);

    expect(result['owner/popular']).toEqual({ active: 0, merged: 5, closed: 2 });
    expect(result['owner/tiny']).toBeUndefined(); // below default minStars (50)
    expect(result['owner/unknown']).toBeUndefined(); // undefined stars excluded
  });

  it('should return empty object when no PRs and no scores', () => {
    const result = computePRsByRepo(makeDigest(), makeState());
    expect(result).toEqual({});
  });
});

describe('computeTopRepos', () => {
  it('should sort repos by total PR count descending', () => {
    const prsByRepo = {
      'small/repo': { active: 1, merged: 0, closed: 0 },
      'big/repo': { active: 2, merged: 10, closed: 3 },
      'medium/repo': { active: 0, merged: 5, closed: 1 },
    };

    const result = computeTopRepos(prsByRepo);

    expect(result[0][0]).toBe('big/repo');
    expect(result[1][0]).toBe('medium/repo');
    expect(result[2][0]).toBe('small/repo');
  });

  it('should limit results to the specified count', () => {
    const prsByRepo = {
      'repo/a': { active: 1, merged: 0, closed: 0 },
      'repo/b': { active: 2, merged: 0, closed: 0 },
      'repo/c': { active: 3, merged: 0, closed: 0 },
      'repo/d': { active: 4, merged: 0, closed: 0 },
    };

    const result = computeTopRepos(prsByRepo, 2);

    expect(result).toHaveLength(2);
    expect(result[0][0]).toBe('repo/d');
    expect(result[1][0]).toBe('repo/c');
  });

  it('should default limit to 10', () => {
    const prsByRepo: Record<string, { active: number; merged: number; closed: number }> = {};
    for (let i = 0; i < 15; i++) {
      prsByRepo[`repo/r${i}`] = { active: i, merged: 0, closed: 0 };
    }

    const result = computeTopRepos(prsByRepo);

    expect(result).toHaveLength(10);
  });

  it('should return empty array for empty input', () => {
    expect(computeTopRepos({})).toEqual([]);
  });
});

describe('getMonthlyData', () => {
  it('should extract monthly counts from state', () => {
    const state = makeState({
      monthlyMergedCounts: { '2026-01': 3, '2026-02': 5 },
      monthlyClosedCounts: { '2026-01': 1 },
      monthlyOpenedCounts: { '2026-01': 4, '2026-02': 6 },
    });

    const result = getMonthlyData(state);

    expect(result.monthlyMerged).toEqual({ '2026-01': 3, '2026-02': 5 });
    expect(result.monthlyClosed).toEqual({ '2026-01': 1 });
    expect(result.monthlyOpened).toEqual({ '2026-01': 4, '2026-02': 6 });
  });

  it('should return empty objects when state has no monthly data', () => {
    const state = makeState();

    const result = getMonthlyData(state);

    expect(result.monthlyMerged).toEqual({});
    expect(result.monthlyClosed).toEqual({});
    expect(result.monthlyOpened).toEqual({});
  });
});

describe('mergeMonthlyCounts', () => {
  it('preserves existing months not in fresh data', () => {
    const existing = { '2025-06': 9, '2025-07': 26, '2026-01': 11 };
    const fresh = { '2026-02': 14, '2026-03': 4 };
    const result = mergeMonthlyCounts(existing, fresh);
    expect(result).toEqual({
      '2025-06': 9,
      '2025-07': 26,
      '2026-01': 11,
      '2026-02': 14,
      '2026-03': 4,
    });
  });

  it('updates existing months when fresh data has them', () => {
    const existing = { '2026-02': 10, '2026-03': 2 };
    const fresh = { '2026-02': 14, '2026-03': 4 };
    const result = mergeMonthlyCounts(existing, fresh);
    expect(result).toEqual({ '2026-02': 14, '2026-03': 4 });
  });

  it('returns copy of existing when fresh is empty', () => {
    const existing = { '2025-06': 9, '2025-07': 26 };
    const result = mergeMonthlyCounts(existing, {});
    expect(result).toEqual(existing);
    expect(result).not.toBe(existing);
  });

  it('returns fresh data when existing is empty', () => {
    const fresh = { '2026-02': 14, '2026-03': 4 };
    const result = mergeMonthlyCounts({}, fresh);
    expect(result).toEqual(fresh);
  });

  it('does not mutate inputs', () => {
    const existing = { '2026-01': 5 };
    const fresh = { '2026-02': 10 };
    mergeMonthlyCounts(existing, fresh);
    expect(existing).toEqual({ '2026-01': 5 });
    expect(fresh).toEqual({ '2026-02': 10 });
  });

  it('does not shrink an existing month when fresh count is lower (#1035)', () => {
    // Scenario: fresh fetch was capped at 3 pages and only covered a partial
    // window of an older month. Without anti-regression, the smaller partial
    // count would silently overwrite the authoritative historical count.
    const existing = { '2025-11': 42, '2026-01': 9 };
    const fresh = { '2025-11': 8, '2026-01': 11 };
    const result = mergeMonthlyCounts(existing, fresh);
    expect(result).toEqual({ '2025-11': 42, '2026-01': 11 });
  });

  it('takes the maximum when fresh equals existing (identity)', () => {
    const existing = { '2025-11': 42 };
    const fresh = { '2025-11': 42 };
    const result = mergeMonthlyCounts(existing, fresh);
    expect(result).toEqual({ '2025-11': 42 });
  });
});

// ---------------------------------------------------------------------------
// storedToMergedPRs
// ---------------------------------------------------------------------------

describe('storedToMergedPRs', () => {
  it('converts stored PRs to MergedPR format with parsed repo and number', () => {
    const stored: StoredMergedPR[] = [
      { url: 'https://github.com/owner/repo/pull/42', title: 'Fix bug', mergedAt: '2025-06-10T00:00:00Z' },
    ];

    const result = storedToMergedPRs(stored);

    expect(result).toEqual([
      {
        url: 'https://github.com/owner/repo/pull/42',
        repo: 'owner/repo',
        number: 42,
        title: 'Fix bug',
        mergedAt: '2025-06-10T00:00:00Z',
      },
    ]);
  });

  it('skips entries with unparseable URLs', () => {
    const stored: StoredMergedPR[] = [
      { url: 'https://example.com/not-a-pr', title: 'Bad URL', mergedAt: '2025-06-10T00:00:00Z' },
      { url: 'https://github.com/owner/repo/pull/1', title: 'Good', mergedAt: '2025-06-10T00:00:00Z' },
    ];

    const result = storedToMergedPRs(stored);

    expect(result).toHaveLength(1);
    expect(result[0].repo).toBe('owner/repo');
  });

  it('returns empty array for empty input', () => {
    expect(storedToMergedPRs([])).toEqual([]);
  });

  it('handles multiple PRs from different repos', () => {
    const stored: StoredMergedPR[] = [
      { url: 'https://github.com/a/b/pull/1', title: 'PR1', mergedAt: '2025-06-10T00:00:00Z' },
      { url: 'https://github.com/c/d/pull/99', title: 'PR2', mergedAt: '2025-06-09T00:00:00Z' },
    ];

    const result = storedToMergedPRs(stored);

    expect(result).toHaveLength(2);
    expect(result[0].repo).toBe('a/b');
    expect(result[0].number).toBe(1);
    expect(result[1].repo).toBe('c/d');
    expect(result[1].number).toBe(99);
  });
});

describe('storedToClosedPRs', () => {
  it('converts stored PRs to ClosedPR format with parsed repo and number', () => {
    const stored: StoredClosedPR[] = [
      { url: 'https://github.com/owner/repo/pull/42', title: 'Close bug', closedAt: '2025-06-10T00:00:00Z' },
    ];

    const result = storedToClosedPRs(stored);

    expect(result).toEqual([
      {
        url: 'https://github.com/owner/repo/pull/42',
        repo: 'owner/repo',
        number: 42,
        title: 'Close bug',
        closedAt: '2025-06-10T00:00:00Z',
      },
    ]);
  });

  it('skips entries with unparseable URLs', () => {
    const stored: StoredClosedPR[] = [
      { url: 'https://example.com/not-a-pr', title: 'Bad URL', closedAt: '2025-06-10T00:00:00Z' },
      { url: 'https://github.com/owner/repo/pull/1', title: 'Good', closedAt: '2025-06-10T00:00:00Z' },
    ];

    const result = storedToClosedPRs(stored);

    expect(result).toHaveLength(1);
    expect(result[0].repo).toBe('owner/repo');
  });

  it('returns empty array for empty input', () => {
    expect(storedToClosedPRs([])).toEqual([]);
  });

  it('handles multiple PRs from different repos', () => {
    const stored: StoredClosedPR[] = [
      { url: 'https://github.com/a/b/pull/1', title: 'PR1', closedAt: '2025-06-10T00:00:00Z' },
      { url: 'https://github.com/c/d/pull/99', title: 'PR2', closedAt: '2025-06-09T00:00:00Z' },
    ];

    const result = storedToClosedPRs(stored);

    expect(result).toHaveLength(2);
    expect(result[0].repo).toBe('a/b');
    expect(result[0].number).toBe(1);
    expect(result[1].repo).toBe('c/d');
    expect(result[1].number).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// buildDashboardStats with storedMergedCount
// ---------------------------------------------------------------------------

describe('buildDashboardStats with storedMergedCount', () => {
  it('uses storedMergedCount when higher than totalMergedAllTime', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 50, mergeRate: 80 },
    });
    const stats = buildDashboardStats(digest, makeState(), 120);
    expect(stats.mergedPRs).toBe(120);
  });

  it('uses totalMergedAllTime when higher than storedMergedCount', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 500, mergeRate: 80 },
    });
    const stats = buildDashboardStats(digest, makeState(), 200);
    expect(stats.mergedPRs).toBe(500);
  });

  it('falls back to totalMergedAllTime when storedMergedCount is undefined', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 42, mergeRate: 80 },
    });
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.mergedPRs).toBe(42);
  });

  it('uses storedMergedCount of 0 correctly (does not fall back)', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 10, mergeRate: 80 },
    });
    // storedMergedCount=0 is explicitly provided, so Math.max(0, 10) = 10
    const stats = buildDashboardStats(digest, makeState(), 0);
    expect(stats.mergedPRs).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// buildDashboardStats with storedClosedCount
// ---------------------------------------------------------------------------

describe('buildDashboardStats with storedClosedCount', () => {
  const stateWithClosedScores = makeState({
    repoScores: {
      'owner/repo-a': { stargazersCount: 100, mergedPRCount: 5, closedWithoutMergeCount: 8 } as never,
      'owner/repo-b': { stargazersCount: 200, mergedPRCount: 3, closedWithoutMergeCount: 12 } as never,
    },
  });

  it('uses storedClosedCount when higher than aggregate', () => {
    const digest = makeDigest();
    // aggregate = 8 + 12 = 20
    const stats = buildDashboardStats(digest, stateWithClosedScores, undefined, 50);
    expect(stats.closedPRs).toBe(50);
  });

  it('uses aggregate when higher than storedClosedCount', () => {
    const digest = makeDigest();
    // aggregate = 20, storedClosedCount = 5
    const stats = buildDashboardStats(digest, stateWithClosedScores, undefined, 5);
    expect(stats.closedPRs).toBe(20);
  });

  it('falls back to aggregate when storedClosedCount is undefined', () => {
    const digest = makeDigest();
    const stats = buildDashboardStats(digest, stateWithClosedScores);
    expect(stats.closedPRs).toBe(20);
  });

  it('uses storedClosedCount of 0 correctly (Math.max with aggregate)', () => {
    const digest = makeDigest();
    // storedClosedCount=0, aggregate=20 → Math.max(0, 20) = 20
    const stats = buildDashboardStats(digest, stateWithClosedScores, undefined, 0);
    expect(stats.closedPRs).toBe(20);
  });

  it('excludes repos below minStars from aggregate', () => {
    const stateWithLowStars = makeState({
      config: { githubUsername: 'testuser', shelvedPRUrls: [], minStars: 150 },
      repoScores: {
        'owner/repo-a': { stargazersCount: 100, mergedPRCount: 5, closedWithoutMergeCount: 8 } as never,
        'owner/repo-b': { stargazersCount: 200, mergedPRCount: 3, closedWithoutMergeCount: 12 } as never,
      },
    });
    const digest = makeDigest();
    // repo-a (100 stars) is below minStars=150, so aggregate = 12 only
    const stats = buildDashboardStats(digest, stateWithLowStars);
    expect(stats.closedPRs).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// updateMonthlyAnalytics
// ---------------------------------------------------------------------------

describe('updateMonthlyAnalytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // mockReset (not just clear): throwing implementations installed by the
    // failure tests below would otherwise leak into later tests and skew the
    // returned failure labels (#1447).
    mockSetMonthlyMergedCounts.mockReset();
    mockSetMonthlyClosedCounts.mockReset();
    mockSetMonthlyOpenedCounts.mockReset();
    mockGetState.mockReturnValue({
      monthlyMergedCounts: {},
      monthlyClosedCounts: {},
      monthlyOpenedCounts: {},
    });
  });

  it('stores monthly merged counts when non-empty', () => {
    const failures = updateMonthlyAnalytics([], { '2026-01': 5 }, {}, {}, {});
    expect(mockSetMonthlyMergedCounts).toHaveBeenCalledWith({ '2026-01': 5 });
    expect(failures).toEqual([]);
  });

  it('skips storing merged counts when empty', () => {
    updateMonthlyAnalytics([], {}, {}, {}, {});
    expect(mockSetMonthlyMergedCounts).not.toHaveBeenCalled();
  });

  it('stores monthly closed counts when non-empty', () => {
    updateMonthlyAnalytics([], {}, { '2026-02': 3 }, {}, {});
    expect(mockSetMonthlyClosedCounts).toHaveBeenCalledWith({ '2026-02': 3 });
  });

  it('skips storing closed counts when empty', () => {
    updateMonthlyAnalytics([], {}, {}, {}, {});
    expect(mockSetMonthlyClosedCounts).not.toHaveBeenCalled();
  });

  it('combines opened from merged + closed + active PRs', () => {
    const prs = [{ createdAt: '2026-01-15T00:00:00Z' }];
    const openedFromMerged = { '2026-01': 2, '2026-02': 1 };
    const openedFromClosed = { '2026-01': 3 };

    updateMonthlyAnalytics(prs, {}, {}, openedFromMerged, openedFromClosed);

    // 2026-01: 2 (merged) + 3 (closed) + 1 (active PR) = 6
    // 2026-02: 1 (merged)
    expect(mockSetMonthlyOpenedCounts).toHaveBeenCalledWith({ '2026-01': 6, '2026-02': 1 });
  });

  it('skips storing opened counts when all inputs empty', () => {
    updateMonthlyAnalytics([], {}, {}, {}, {});
    expect(mockSetMonthlyOpenedCounts).not.toHaveBeenCalled();
  });

  it('handles PR with missing createdAt', () => {
    const prs = [{ createdAt: '2026-03-01T00:00:00Z' }, {}, { createdAt: undefined }];

    updateMonthlyAnalytics(prs, {}, {}, {}, {});

    // Only the first PR has a valid createdAt
    expect(mockSetMonthlyOpenedCounts).toHaveBeenCalledWith({ '2026-03': 1 });
  });

  it('warns and continues when setMonthlyMergedCounts throws', () => {
    mockSetMonthlyMergedCounts.mockImplementation(() => {
      throw new Error('disk full');
    });

    // Should not throw
    const failures = updateMonthlyAnalytics([], { '2026-01': 5 }, { '2026-01': 2 }, {}, {});

    expect(mockWarn).toHaveBeenCalledWith(
      'dashboard-data',
      expect.stringContaining('Failed to store monthly merged counts'),
    );
    // Closed counts should still be stored despite merged failure
    expect(mockSetMonthlyClosedCounts).toHaveBeenCalledWith({ '2026-01': 2 });
    // The failure is reported back so fetchDashboardData can surface it (#1447)
    expect(failures).toEqual(['store monthly merged counts']);
  });

  it('warns and continues when setMonthlyClosedCounts throws', () => {
    mockSetMonthlyClosedCounts.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const failures = updateMonthlyAnalytics([], { '2026-01': 5 }, { '2026-01': 2 }, { '2026-01': 1 }, {});

    expect(mockWarn).toHaveBeenCalledWith(
      'dashboard-data',
      expect.stringContaining('Failed to store monthly closed counts'),
    );
    // Merged and opened should still be stored
    expect(mockSetMonthlyMergedCounts).toHaveBeenCalled();
    expect(mockSetMonthlyOpenedCounts).toHaveBeenCalled();
    expect(failures).toEqual(['store monthly closed counts']);
  });

  it('warns and continues when setMonthlyOpenedCounts throws', () => {
    mockSetMonthlyOpenedCounts.mockImplementation(() => {
      throw new Error('io error');
    });

    const failures = updateMonthlyAnalytics([], {}, {}, { '2026-01': 1 }, {});

    expect(mockWarn).toHaveBeenCalledWith(
      'dashboard-data',
      expect.stringContaining('Failed to store monthly opened counts'),
    );
    expect(failures).toEqual(['store monthly opened counts']);
  });
});

// ---------------------------------------------------------------------------
// fetchDashboardData
// ---------------------------------------------------------------------------

describe('fetchDashboardData', () => {
  /** Build a default state for mockGetState */
  function makeDefaultState(overrides: Record<string, unknown> = {}) {
    return {
      version: 3,
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
      lastDigest: null as DailyDigest | null,
      monthlyMergedCounts: {},
      monthlyClosedCounts: {},
      monthlyOpenedCounts: {},
      ...overrides,
    };
  }

  /** Default merged/closed PR counts response */
  function makePRCountsResult() {
    return {
      repos: new Map(),
      monthlyCounts: {},
      monthlyOpenedCounts: {},
      dailyActivityCounts: {},
    };
  }

  /** Build a minimal DailyDigest for mock responses */
  function makeMockDigest(prs: any[] = []): DailyDigest {
    return makeDailyDigest({
      generatedAt: '2026-03-11T10:00:00Z',
      openPRs: prs,
      summary: {
        totalActivePRs: prs.length,
        totalNeedingAttention: 0,
        totalMergedAllTime: 5,
        mergeRate: 83.3,
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    const state = makeDefaultState();
    mockGetState.mockReturnValue(state);
    mockBatch.mockImplementation((fn: () => void) => fn());
    mockGetMergedPRWatermark.mockReturnValue(undefined);
    mockGetClosedPRWatermark.mockReturnValue(undefined);
    mockGetMergedPRs.mockReturnValue([]);
    mockGetClosedPRs.mockReturnValue([]);
    // The real addMergedPRs/addClosedPRs return { dropped }; an undefined
    // return makes the destructure in fetchDashboardData throw, which now
    // pollutes partialFailures with phantom persist failures (#1447). Also
    // resets throwing implementations leaked from earlier tests.
    mockAddMergedPRs.mockReset().mockReturnValue({ dropped: 0 });
    mockAddClosedPRs.mockReset().mockReturnValue({ dropped: 0 });
    // Reset monthly setters so throwing implementations from the
    // updateMonthlyAnalytics failure tests above don't leak in here.
    mockSetMonthlyMergedCounts.mockReset();
    mockSetMonthlyClosedCounts.mockReset();
    mockSetMonthlyOpenedCounts.mockReset();

    // PRMonitor defaults
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [], failures: [] });
    mockFetchRecentlyClosedPRs.mockResolvedValue([]);
    mockFetchRecentlyMergedPRs.mockResolvedValue([]);
    mockFetchUserMergedPRCounts.mockResolvedValue(makePRCountsResult());
    mockFetchUserClosedPRCounts.mockResolvedValue(makePRCountsResult());
    mockFetchCommentedIssues.mockResolvedValue({ issues: [], failures: [] });
    mockFetchMergedPRsSince.mockResolvedValue([]);
    mockFetchClosedPRsSince.mockResolvedValue([]);

    // generateDigest returns a valid digest and setLastDigest stores it
    mockGenerateDigest.mockReturnValue(makeMockDigest());
    mockSetLastDigest.mockImplementation((digest: DailyDigest) => {
      const s = mockGetState();
      s.lastDigest = digest;
    });

    mockIsRateLimitOrAuthError.mockReturnValue(false);
    mockBuildStarFilter.mockReturnValue(undefined);
    mockApplyStatusOverrides.mockImplementation((prs: unknown) => prs);
  });

  it('fetches and returns dashboard data successfully (happy path)', async () => {
    const pr = makeFetchedPR({ repo: 'owner/repo', number: 42 });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [pr], failures: [] });

    const digest = makeMockDigest([pr]);
    mockGenerateDigest.mockReturnValue(digest);

    const result = await fetchDashboardData('test-token');

    expect(result.digest).toBeDefined();
    expect(result.commentedIssues).toEqual([]);
    expect(result.allMergedPRs).toEqual([]);
    expect(result.allClosedPRs).toEqual([]);
    expect(mockFetchUserOpenPRs).toHaveBeenCalled();
    expect(mockGenerateDigest).toHaveBeenCalled();
    expect(mockSetLastDigest).toHaveBeenCalled();
  });

  describe('partitions on post-override status (#1416)', () => {
    const PR_URL = 'https://github.com/owner/repo/pull/7';

    /** Dormant PR — the class where overrides survive until new activity. */
    function makeDormantPR(status: 'needs_addressing' | 'waiting_on_maintainer') {
      return makeFetchedPR({
        repo: 'owner/repo',
        number: 7,
        status,
        stalenessTier: 'dormant',
        daysSinceActivity: 40,
      });
    }

    /** Simulate a live override the way the real applyStatusOverrides reports it. */
    function flipStatusTo(status: 'needs_addressing' | 'waiting_on_maintainer') {
      mockApplyStatusOverrides.mockImplementation((prs: unknown) =>
        (prs as Array<{ url: string }>).map((p) => (p.url === PR_URL ? { ...p, status } : p)),
      );
    }

    beforeEach(() => {
      // Build the digest from whatever PR list the partition hands over, so
      // the test observes which statuses generateDigest actually consumed.
      mockGenerateDigest.mockImplementation((prs: never[]) => makeMockDigest(prs));
    });

    it('shelves a dormant PR whose override flips needs_addressing -> waiting_on_maintainer', async () => {
      mockFetchUserOpenPRs.mockResolvedValue({ prs: [makeDormantPR('needs_addressing')], failures: [] });
      flipStatusTo('waiting_on_maintainer');

      const result = await fetchDashboardData('test-token');

      // The cached/persisted digest keeps RAW statuses so a later override
      // CLEAR takes effect on rebuild instead of being baked in…
      const digestInput = mockGenerateDigest.mock.calls[0][0] as Array<{ status: string }>;
      expect(digestInput[0].status).toBe('needs_addressing');
      // …while the shelve partition uses the post-override status, agreeing
      // with the CLI rule: dormant + non-critical => shelved.
      expect((result.digest.shelvedPRs ?? []).map((ref) => ref.url)).toContain(PR_URL);
      expect(result.digest.summary.totalActivePRs).toBe(0);
    });

    it('keeps active a dormant PR whose override flips waiting_on_maintainer -> needs_addressing', async () => {
      mockFetchUserOpenPRs.mockResolvedValue({ prs: [makeDormantPR('waiting_on_maintainer')], failures: [] });
      flipStatusTo('needs_addressing');

      const result = await fetchDashboardData('test-token');

      // Raw status persisted; partition derived from the overridden status.
      const digestInput = mockGenerateDigest.mock.calls[0][0] as Array<{ status: string }>;
      expect(digestInput[0].status).toBe('waiting_on_maintainer');
      // Critical is never display-shelved, matching the daily check's partition.
      expect(result.digest.shelvedPRs ?? []).toEqual([]);
      expect(result.digest.summary.totalActivePRs).toBe(1);
    });
  });

  it('re-throws rate limit error from fetchUserOpenPRs', async () => {
    const rateLimitError = new Error('API rate limit exceeded');
    mockFetchUserOpenPRs.mockRejectedValue(rateLimitError);

    await expect(fetchDashboardData('test-token')).rejects.toThrow('API rate limit exceeded');
  });

  it('degrades gracefully when fetchRecentlyClosedPRs fails', async () => {
    mockFetchRecentlyClosedPRs.mockRejectedValue(new Error('timeout'));

    const result = await fetchDashboardData('test-token');

    expect(result.digest).toBeDefined();
    expect(mockWarn).toHaveBeenCalledWith(
      'dashboard-data',
      expect.stringContaining('Failed to fetch recently closed PRs'),
    );
  });

  it('re-throws rate limit error from fetchRecentlyClosedPRs', async () => {
    const rateLimitError = new Error('API rate limit exceeded');
    mockFetchRecentlyClosedPRs.mockRejectedValue(rateLimitError);
    mockIsRateLimitOrAuthError.mockImplementation((err: unknown) => err === rateLimitError);

    await expect(fetchDashboardData('test-token')).rejects.toThrow('API rate limit exceeded');
  });

  it('degrades gracefully when fetchRecentlyMergedPRs fails', async () => {
    mockFetchRecentlyMergedPRs.mockRejectedValue(new Error('network error'));

    const result = await fetchDashboardData('test-token');

    expect(result.digest).toBeDefined();
    expect(mockWarn).toHaveBeenCalledWith(
      'dashboard-data',
      expect.stringContaining('Failed to fetch recently merged PRs'),
    );
  });

  it('degrades gracefully when fetchUserMergedPRCounts fails', async () => {
    mockFetchUserMergedPRCounts.mockRejectedValue(new Error('search API error'));

    const result = await fetchDashboardData('test-token');

    expect(result.digest).toBeDefined();
    expect(mockWarn).toHaveBeenCalledWith(
      'dashboard-data',
      expect.stringContaining('Failed to fetch merged PR counts'),
    );
  });

  it('degrades gracefully when fetchUserClosedPRCounts fails', async () => {
    mockFetchUserClosedPRCounts.mockRejectedValue(new Error('search API error'));

    const result = await fetchDashboardData('test-token');

    expect(result.digest).toBeDefined();
    expect(mockWarn).toHaveBeenCalledWith(
      'dashboard-data',
      expect.stringContaining('Failed to fetch closed PR counts'),
    );
  });

  it('warns on general issue conversation fetch failure', async () => {
    mockFetchCommentedIssues.mockRejectedValue(new Error('socket timeout'));

    const result = await fetchDashboardData('test-token');

    expect(result.commentedIssues).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith('dashboard-data', expect.stringContaining('Issue conversation fetch failed'));
  });

  it("handles 'No GitHub username configured' from issue monitor", async () => {
    mockFetchCommentedIssues.mockRejectedValue(new Error('No GitHub username configured'));

    const result = await fetchDashboardData('test-token');

    expect(result.digest).toBeDefined();
    expect(result.commentedIssues).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      'dashboard-data',
      expect.stringContaining('Issue conversation tracking requires setup'),
    );
  });

  it('warns and continues when state batch fails', async () => {
    mockBatch.mockImplementation(() => {
      throw new Error('disk write failed');
    });
    // Pre-populate lastDigest on state to simulate a previous successful fetch,
    // so the function can still return data despite the batch failure
    const state = makeDefaultState();
    const digest = makeMockDigest();
    state.lastDigest = digest;
    mockGetState.mockReturnValue(state);

    const result = await fetchDashboardData('test-token');

    expect(mockWarn).toHaveBeenCalledWith(
      'dashboard-data',
      expect.stringContaining('Failed to persist dashboard state'),
    );
    expect(result.digest).toBeDefined();
    // The stale cached digest is served, but the banner says why (#1447)
    expect(result.partialFailures).toContain('persist dashboard state');
  });

  it('throws when digest is null after batch', async () => {
    // batch runs but setLastDigest doesn't update state (mock doesn't store)
    mockSetLastDigest.mockImplementation(() => {
      // intentionally do nothing — digest stays null
    });
    const state = makeDefaultState({ lastDigest: null });
    mockGetState.mockReturnValue(state);

    await expect(fetchDashboardData('test-token')).rejects.toThrow(
      'Dashboard data fetch failed: digest was not generated',
    );
  });

  it('applies shelve partitioning for dormant PRs', async () => {
    const activePR = makeFetchedPR({
      repo: 'owner/active',
      number: 1,
      stalenessTier: 'active',
      status: 'waiting_on_maintainer',
    });
    const dormantPR = makeFetchedPR({
      repo: 'owner/dormant',
      number: 2,
      stalenessTier: 'dormant',
      status: 'waiting_on_maintainer',
    });

    mockFetchUserOpenPRs.mockResolvedValue({ prs: [activePR, dormantPR], failures: [] });

    const digest = makeMockDigest([activePR, dormantPR]);
    mockGenerateDigest.mockReturnValue(digest);

    const result = await fetchDashboardData('test-token');

    // dormant PR should be in shelvedPRs
    expect(result.digest.shelvedPRs).toHaveLength(1);
    expect(mockToShelvedPRRef).toHaveBeenCalled();
    // totalActivePRs should exclude the dormant PR
    expect(result.digest.summary.totalActivePRs).toBe(1);
  });

  it('converts stored PRs via storedToMergedPRs/storedToClosedPRs', async () => {
    mockGetMergedPRs.mockReturnValue([
      { url: 'https://github.com/owner/repo/pull/10', title: 'Merged PR', mergedAt: '2026-01-01T00:00:00Z' },
    ]);
    mockGetClosedPRs.mockReturnValue([
      { url: 'https://github.com/owner/repo/pull/20', title: 'Closed PR', closedAt: '2026-01-02T00:00:00Z' },
    ]);

    const result = await fetchDashboardData('test-token');

    expect(result.allMergedPRs).toHaveLength(1);
    expect(result.allMergedPRs[0].repo).toBe('owner/repo');
    expect(result.allMergedPRs[0].number).toBe(10);
    expect(result.allClosedPRs).toHaveLength(1);
    expect(result.allClosedPRs[0].repo).toBe('owner/repo');
    expect(result.allClosedPRs[0].number).toBe(20);
  });

  it('isolates addMergedPRs failure from addClosedPRs', async () => {
    mockAddMergedPRs.mockImplementation(() => {
      throw new Error('merged storage failed');
    });
    mockFetchMergedPRsSince.mockResolvedValue([
      { url: 'https://github.com/a/b/pull/1', title: 'New merged', mergedAt: '2026-01-01T00:00:00Z' },
    ]);
    mockFetchClosedPRsSince.mockResolvedValue([
      { url: 'https://github.com/a/b/pull/2', title: 'New closed', closedAt: '2026-01-02T00:00:00Z' },
    ]);

    const result = await fetchDashboardData('test-token');

    // addMergedPRs failed but addClosedPRs should still have been called
    expect(mockAddMergedPRs).toHaveBeenCalled();
    expect(mockAddClosedPRs).toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith('dashboard-data', expect.stringContaining('Failed to store merged PRs'));
    expect(result.digest).toBeDefined();
    // The persist failure is surfaced, not just logged (#1447)
    expect(result.partialFailures).toContain('store merged PRs');
    expect(result.partialFailures).not.toContain('store closed PRs');
  });

  it('isolates addClosedPRs failure from addMergedPRs', async () => {
    mockAddClosedPRs.mockImplementation(() => {
      throw new Error('closed storage failed');
    });
    mockFetchClosedPRsSince.mockResolvedValue([
      { url: 'https://github.com/a/b/pull/2', title: 'New closed', closedAt: '2026-01-02T00:00:00Z' },
    ]);

    const result = await fetchDashboardData('test-token');

    expect(mockAddMergedPRs).toHaveBeenCalled();
    expect(mockAddClosedPRs).toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith('dashboard-data', expect.stringContaining('Failed to store closed PRs'));
    expect(result.digest).toBeDefined();
    expect(result.partialFailures).toContain('store closed PRs');
    expect(result.partialFailures).not.toContain('store merged PRs');
  });

  // ── outcome ledger threading (#1461) ─────────────────────────────────

  it('passes openedAt through to addMergedPRs/addClosedPRs (#1461)', async () => {
    mockFetchMergedPRsSince.mockResolvedValue([
      {
        url: 'https://github.com/a/b/pull/1',
        title: 'New merged',
        mergedAt: '2026-01-10T00:00:00Z',
        openedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    mockFetchClosedPRsSince.mockResolvedValue([
      {
        url: 'https://github.com/a/b/pull/2',
        title: 'New closed',
        closedAt: '2026-01-11T00:00:00Z',
        openedAt: '2026-01-02T00:00:00Z',
      },
    ]);

    await fetchDashboardData('test-token');

    expect(mockAddMergedPRs).toHaveBeenCalledWith([
      expect.objectContaining({ url: 'https://github.com/a/b/pull/1', openedAt: '2026-01-01T00:00:00Z' }),
    ]);
    expect(mockAddClosedPRs).toHaveBeenCalledWith([
      expect.objectContaining({ url: 'https://github.com/a/b/pull/2', openedAt: '2026-01-02T00:00:00Z' }),
    ]);
  });

  it('recovers firstMaintainerResponseAt from the previous persisted digest (#1461)', async () => {
    const prUrl = 'https://github.com/a/b/pull/1';
    const previouslyOpen = makeFetchedPR({
      repo: 'a/b',
      number: 1,
      url: prUrl,
      firstMaintainerResponseAt: '2026-01-03T09:00:00Z',
    });
    mockGetState.mockReturnValue(makeDefaultState({ lastDigest: makeMockDigest([previouslyOpen]) }));
    mockFetchMergedPRsSince.mockResolvedValue([
      { url: prUrl, title: 'New merged', mergedAt: '2026-01-10T00:00:00Z', openedAt: '2026-01-01T00:00:00Z' },
    ]);

    await fetchDashboardData('test-token');

    expect(mockAddMergedPRs).toHaveBeenCalledWith([
      expect.objectContaining({ url: prUrl, firstMaintainerResponseAt: '2026-01-03T09:00:00Z' }),
    ]);
  });

  it('leaves firstMaintainerResponseAt undefined when the PR never appeared in a digest (#1461)', async () => {
    mockFetchMergedPRsSince.mockResolvedValue([
      { url: 'https://github.com/a/b/pull/1', title: 'New merged', mergedAt: '2026-01-10T00:00:00Z' },
    ]);

    await fetchDashboardData('test-token');

    const [persisted] = mockAddMergedPRs.mock.calls[0] as unknown as [Array<Record<string, unknown>>];
    expect(persisted[0].firstMaintainerResponseAt).toBeUndefined();
  });

  // ── partialFailures surfacing (#1035) ────────────────────────────────

  it('returns empty partialFailures when all sub-fetches succeed', async () => {
    const result = await fetchDashboardData('test-token');
    expect(result.partialFailures).toEqual([]);
  });

  it('records the failing label in partialFailures when a sub-fetch degrades', async () => {
    mockFetchRecentlyMergedPRs.mockRejectedValue(new Error('network timeout'));
    const result = await fetchDashboardData('test-token');
    expect(result.partialFailures).toContain('fetch recently merged PRs');
  });

  it('accumulates multiple labels when several sub-fetches fail', async () => {
    mockFetchRecentlyMergedPRs.mockRejectedValue(new Error('network error'));
    mockFetchRecentlyClosedPRs.mockRejectedValue(new Error('network error'));
    mockFetchUserMergedPRCounts.mockRejectedValue(new Error('search API error'));
    const result = await fetchDashboardData('test-token');
    expect(result.partialFailures).toEqual(
      expect.arrayContaining(['fetch recently merged PRs', 'fetch recently closed PRs', 'fetch merged PR counts']),
    );
    expect(result.partialFailures.length).toBe(3);
  });

  it('does not record a rate-limit-or-auth rejection in partialFailures (re-throws instead)', async () => {
    const rateLimitError = new Error('API rate limit exceeded');
    mockFetchRecentlyMergedPRs.mockRejectedValue(rateLimitError);
    mockIsRateLimitOrAuthError.mockImplementation((err: unknown) => err === rateLimitError);
    await expect(fetchDashboardData('test-token')).rejects.toThrow('API rate limit exceeded');
  });

  // ── persist failures land in partialFailures too (#1447) ─────────────

  it('records a monthly-counts persist failure in partialFailures while still serving data', async () => {
    mockFetchUserMergedPRCounts.mockResolvedValue({
      ...makePRCountsResult(),
      monthlyCounts: { '2026-01': 5 },
    });
    mockSetMonthlyMergedCounts.mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = await fetchDashboardData('test-token');

    expect(result.partialFailures).toContain('store monthly merged counts');
    expect(result.digest).toBeDefined();
  });

  it('records a digest persist failure in partialFailures while serving the cached digest', async () => {
    const cachedDigest = makeMockDigest();
    const state = makeDefaultState({ lastDigest: cachedDigest });
    mockGetState.mockReturnValue(state);
    mockSetLastDigest.mockImplementation(() => {
      throw new Error('disk write failed');
    });

    const result = await fetchDashboardData('test-token');

    expect(result.partialFailures).toContain('persist dashboard state');
    expect(result.digest).toBe(cachedDigest);
  });
});
