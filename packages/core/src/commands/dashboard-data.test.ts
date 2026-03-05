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
} from './dashboard-data.js';
import type { DailyDigest, AgentState, ShelvedPRRef } from '../core/types.js';

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
      { number: 1, url: 'u1', title: 't1', repo: 'r/1', daysSinceActivity: 5, status: 'healthy' },
      { number: 2, url: 'u2', title: 't2', repo: 'r/2', daysSinceActivity: 10, status: 'dormant' },
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

  it('sums closedWithoutMergeCount across all repoScores', () => {
    const state = makeState({
      repoScores: {
        'a/b': {
          repo: 'a/b',
          score: 5,
          mergedPRCount: 1,
          closedWithoutMergeCount: 3,
          avgResponseDays: null,
          lastEvaluatedAt: '2025-06-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
        'c/d': {
          repo: 'c/d',
          score: 7,
          mergedPRCount: 2,
          closedWithoutMergeCount: 1,
          avgResponseDays: null,
          lastEvaluatedAt: '2025-06-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
      },
    });
    const stats = buildDashboardStats(makeDigest(), state);
    expect(stats.closedPRs).toBe(4); // 3 + 1
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
        'owner/alpha': { mergedPRCount: 5, closedWithoutMergeCount: 2 } as any,
        'owner/beta': { mergedPRCount: 10, closedWithoutMergeCount: 0 } as any,
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
        'owner/alpha': { mergedPRCount: 3, closedWithoutMergeCount: 1 } as any,
      },
    });

    const result = computePRsByRepo(digest, state);

    expect(result['owner/alpha']).toEqual({ active: 1, merged: 3, closed: 1 });
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
