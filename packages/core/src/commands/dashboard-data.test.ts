/**
 * Tests for dashboard-data aggregation helpers
 */

import { describe, it, expect } from 'vitest';
import { computePRsByRepo, computeTopRepos, getMonthlyData } from './dashboard-data.js';
import type { DailyDigest, AgentState } from '../core/types.js';

function makeDigest(overrides: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: new Date().toISOString(),
    openPRs: [],
    prsNeedingResponse: [],
    ciFailingPRs: [],
    ciBlockedPRs: [],
    ciNotRunningPRs: [],
    mergeConflictPRs: [],
    needsRebasePRs: [],
    missingRequiredFilesPRs: [],
    incompleteChecklistPRs: [],
    needsChangesPRs: [],
    changesAddressedPRs: [],
    waitingOnMaintainerPRs: [],
    approachingDormant: [],
    dormantPRs: [],
    healthyPRs: [],
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
