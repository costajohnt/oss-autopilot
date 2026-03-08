/**
 * Tests for dashboard-data aggregation helpers
 */

import { describe, it, expect } from 'vitest';
import {
  buildDashboardStats,
  computePRsByRepo,
  computeTopRepos,
  getMonthlyData,
  mergeMonthlyCounts,
  storedToMergedPRs,
  storedToClosedPRs,
} from './dashboard-data.js';
import type { DailyDigest, AgentState, ShelvedPRRef, StoredMergedPR, StoredClosedPR } from '../core/types.js';

function makeDigest(overrides: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: new Date().toISOString(),
    openPRs: [],
    needsAddressingPRs: [],
    waitingOnMaintainerPRs: [],
    recentlyClosedPRs: [],
    recentlyMergedPRs: [],
    shelvedPRs: [],
    autoUnshelvedPRs: [],
    summary: {
      totalActivePRs: 0,
      totalNeedingAttention: 0,
      totalMergedAllTime: 0,
      mergeRate: 0,
    },
    ...overrides,
  } as DailyDigest;
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    version: 2,
    repoScores: {},
    config: { githubUsername: 'testuser', shelvedPRUrls: [] },
    events: [],
    lastRunAt: new Date().toISOString(),
    activeIssues: [],
    ...overrides,
  } as AgentState;
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
