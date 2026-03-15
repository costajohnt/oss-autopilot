import { describe, it, expect, vi } from 'vitest';
import * as logger from './logger.js';
import {
  calculateScore,
  getRepoScore,
  updateRepoScore,
  incrementMergedCount,
  incrementClosedCount,
  markRepoHostile,
  getReposWithMergedPRs,
  getReposWithOpenPRs,
  getHighScoringRepos,
  getLowScoringRepos,
  getStats,
  reconcilePRCounts,
} from './repo-score-manager.js';
import { makeAgentState, makeRepoScore } from './test-utils.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Return an ISO timestamp N days in the past. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * MS_PER_DAY).toISOString();
}

// ---------------------------------------------------------------------------
// calculateScore
// ---------------------------------------------------------------------------

describe('calculateScore', () => {
  it('returns base score of 5 for a fresh repo with no activity', () => {
    const rs = makeRepoScore();
    expect(calculateScore(rs)).toBe(5);
  });

  describe('logarithmic merge bonus', () => {
    it.each([
      [1, 7], // log2(2)*2 = 2 → 5+2 = 7
      [2, 8], // log2(3)*2 ≈ 3.17 → round(3.17) = 3 → 5+3 = 8
      [3, 9], // log2(4)*2 = 4 → 5+4 = 9
      [4, 10], // log2(5)*2 ≈ 4.64 → round(4.64) = 5 → 5+5 = 10
      [20, 10], // log2(21)*2 ≈ 8.77 → capped at 5 → 5+5 = 10
      [100, 10], // huge count still caps at +5 → 10
    ])('with %i merged PRs returns %i', (mergedPRCount, expected) => {
      const rs = makeRepoScore({ mergedPRCount });
      expect(calculateScore(rs)).toBe(expected);
    });

    it('gives no bonus for zero merges', () => {
      const rs = makeRepoScore({ mergedPRCount: 0 });
      expect(calculateScore(rs)).toBe(5);
    });
  });

  describe('closed without merge penalty', () => {
    it.each([
      [1, 4], // 5 - 1 = 4
      [2, 3], // 5 - 2 = 3
      [3, 2], // 5 - 3 = 2
      [5, 2], // capped at -3 → 5 - 3 = 2
      [10, 2], // still capped at -3
    ])('with %i closed PRs returns %i', (closedWithoutMergeCount, expected) => {
      const rs = makeRepoScore({ closedWithoutMergeCount });
      expect(calculateScore(rs)).toBe(expected);
    });
  });

  describe('recency bonus', () => {
    it('adds +1 when lastMergedAt is within 90 days', () => {
      const rs = makeRepoScore({ lastMergedAt: daysAgo(30) });
      expect(calculateScore(rs)).toBe(6); // 5 + 1
    });

    it('adds +1 when lastMergedAt is exactly 90 days ago', () => {
      const rs = makeRepoScore({ lastMergedAt: daysAgo(90) });
      expect(calculateScore(rs)).toBe(6); // 5 + 1 (boundary: <= 90)
    });

    it('gives no bonus when lastMergedAt is older than 90 days', () => {
      const rs = makeRepoScore({ lastMergedAt: daysAgo(91) });
      expect(calculateScore(rs)).toBe(5);
    });

    it('gives no bonus when lastMergedAt is not set', () => {
      const rs = makeRepoScore({ lastMergedAt: undefined });
      expect(calculateScore(rs)).toBe(5);
    });

    it('warns and skips recency bonus for invalid lastMergedAt date', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const rs = makeRepoScore({ lastMergedAt: 'not-a-date' });
      expect(calculateScore(rs)).toBe(5);
      expect(warnSpy).toHaveBeenCalledWith('scoring', expect.stringContaining('not-a-date'));
      warnSpy.mockRestore();
    });
  });

  describe('signal bonuses and penalties', () => {
    it('adds +1 for responsive repos', () => {
      const rs = makeRepoScore({ signals: { isResponsive: true } });
      expect(calculateScore(rs)).toBe(6);
    });

    it('subtracts -2 for hostile repos', () => {
      const rs = makeRepoScore({ signals: { hasHostileComments: true } });
      expect(calculateScore(rs)).toBe(3); // 5 - 2
    });

    it('applies both responsive and hostile signals', () => {
      const rs = makeRepoScore({
        signals: { isResponsive: true, hasHostileComments: true },
      });
      expect(calculateScore(rs)).toBe(4); // 5 + 1 - 2
    });
  });

  describe('clamping', () => {
    it('never returns below 1', () => {
      const rs = makeRepoScore({
        closedWithoutMergeCount: 10, // -3 (capped)
        signals: { hasHostileComments: true }, // -2
        // 5 - 3 - 2 = 0 → clamped to 1
      });
      expect(calculateScore(rs)).toBe(1);
    });

    it('never returns above 10', () => {
      const rs = makeRepoScore({
        mergedPRCount: 100, // +5 (capped)
        lastMergedAt: daysAgo(0), // +1
        signals: { isResponsive: true }, // +1
        // 5 + 5 + 1 + 1 = 12 → clamped to 10
      });
      expect(calculateScore(rs)).toBe(10);
    });
  });

  describe('combined scenarios', () => {
    it('handles merges + closures + signals together', () => {
      const rs = makeRepoScore({
        mergedPRCount: 3, // +4
        closedWithoutMergeCount: 1, // -1
        lastMergedAt: daysAgo(10), // +1
        signals: { isResponsive: true }, // +1
        // 5 + 4 - 1 + 1 + 1 = 10
      });
      expect(calculateScore(rs)).toBe(10);
    });
  });
});

// ---------------------------------------------------------------------------
// getRepoScore
// ---------------------------------------------------------------------------

describe('getRepoScore', () => {
  it('returns undefined for unknown repos', () => {
    const state = makeAgentState({ repoScores: {} });
    expect(getRepoScore(state, 'owner/unknown')).toBeUndefined();
  });

  it('returns the score for a known repo', () => {
    const rs = makeRepoScore({ repo: 'owner/repo' });
    const state = makeAgentState({ repoScores: { 'owner/repo': rs } });
    expect(getRepoScore(state, 'owner/repo')).toEqual(rs);
  });
});

// ---------------------------------------------------------------------------
// updateRepoScore
// ---------------------------------------------------------------------------

describe('updateRepoScore', () => {
  it('creates a default score if repo is new', () => {
    const state = makeAgentState({ repoScores: {} });
    updateRepoScore(state, 'owner/new-repo', { mergedPRCount: 2 });
    const rs = state.repoScores['owner/new-repo'];
    expect(rs).toBeDefined();
    expect(rs.repo).toBe('owner/new-repo');
    expect(rs.mergedPRCount).toBe(2);
  });

  it('recalculates score after update', () => {
    const state = makeAgentState({ repoScores: {} });
    updateRepoScore(state, 'owner/repo', { mergedPRCount: 1 });
    expect(state.repoScores['owner/repo'].score).toBe(7); // 5 + 2
  });

  it('preserves existing fields when updating partial data', () => {
    const state = makeAgentState({ repoScores: {} });
    updateRepoScore(state, 'owner/repo', { mergedPRCount: 3 });
    updateRepoScore(state, 'owner/repo', { closedWithoutMergeCount: 1 });
    const rs = state.repoScores['owner/repo'];
    expect(rs.mergedPRCount).toBe(3);
    expect(rs.closedWithoutMergeCount).toBe(1);
  });

  it('merges signal updates without overwriting other signals', () => {
    const state = makeAgentState({ repoScores: {} });
    updateRepoScore(state, 'owner/repo', { signals: { isResponsive: true } });
    updateRepoScore(state, 'owner/repo', { signals: { hasHostileComments: true } });
    const signals = state.repoScores['owner/repo'].signals;
    expect(signals.isResponsive).toBe(true);
    expect(signals.hasHostileComments).toBe(true);
  });

  it('updates lastEvaluatedAt timestamp', () => {
    const state = makeAgentState({ repoScores: {} });
    const before = new Date().toISOString();
    updateRepoScore(state, 'owner/repo', { mergedPRCount: 1 });
    const rs = state.repoScores['owner/repo'];
    expect(rs.lastEvaluatedAt >= before).toBe(true);
  });

  it('updates optional fields like stargazersCount and language', () => {
    const state = makeAgentState({ repoScores: {} });
    updateRepoScore(state, 'owner/repo', { stargazersCount: 500, language: 'TypeScript' });
    const rs = state.repoScores['owner/repo'];
    expect(rs.stargazersCount).toBe(500);
    expect(rs.language).toBe('TypeScript');
  });

  it('updates avgResponseDays', () => {
    const state = makeAgentState({ repoScores: {} });
    updateRepoScore(state, 'owner/repo', { avgResponseDays: 2.5 });
    expect(state.repoScores['owner/repo'].avgResponseDays).toBe(2.5);
  });

  it('updates lastMergedAt', () => {
    const state = makeAgentState({ repoScores: {} });
    const ts = '2025-06-01T00:00:00Z';
    updateRepoScore(state, 'owner/repo', { lastMergedAt: ts });
    expect(state.repoScores['owner/repo'].lastMergedAt).toBe(ts);
  });

  it('preserves all fields on empty update', () => {
    const state = makeAgentState({ repoScores: {} });
    updateRepoScore(state, 'owner/repo', { mergedPRCount: 3 });
    const before = { ...state.repoScores['owner/repo'] };
    updateRepoScore(state, 'owner/repo', {});
    const after = state.repoScores['owner/repo'];
    expect(after.mergedPRCount).toBe(before.mergedPRCount);
    expect(after.closedWithoutMergeCount).toBe(before.closedWithoutMergeCount);
    expect(after.score).toBe(before.score);
  });
});

// ---------------------------------------------------------------------------
// incrementMergedCount
// ---------------------------------------------------------------------------

describe('incrementMergedCount', () => {
  it('increments from 0 for a new repo', () => {
    const state = makeAgentState({ repoScores: {} });
    incrementMergedCount(state, 'owner/repo');
    expect(state.repoScores['owner/repo'].mergedPRCount).toBe(1);
  });

  it('increments from an existing count', () => {
    const state = makeAgentState({
      repoScores: { 'owner/repo': makeRepoScore({ mergedPRCount: 3 }) },
    });
    incrementMergedCount(state, 'owner/repo');
    expect(state.repoScores['owner/repo'].mergedPRCount).toBe(4);
  });

  it('sets lastMergedAt to current time', () => {
    const state = makeAgentState({ repoScores: {} });
    const before = Date.now();
    incrementMergedCount(state, 'owner/repo');
    const lastMergedAt = new Date(state.repoScores['owner/repo'].lastMergedAt!).getTime();
    expect(lastMergedAt).toBeGreaterThanOrEqual(before);
  });

  it('recalculates score after incrementing', () => {
    const state = makeAgentState({ repoScores: {} });
    incrementMergedCount(state, 'owner/repo');
    // 1 merge → +2 bonus, + recency bonus +1 = 5 + 2 + 1 = 8
    expect(state.repoScores['owner/repo'].score).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// incrementClosedCount
// ---------------------------------------------------------------------------

describe('incrementClosedCount', () => {
  it('increments from 0 for a new repo', () => {
    const state = makeAgentState({ repoScores: {} });
    incrementClosedCount(state, 'owner/repo');
    expect(state.repoScores['owner/repo'].closedWithoutMergeCount).toBe(1);
  });

  it('increments from an existing count', () => {
    const state = makeAgentState({
      repoScores: { 'owner/repo': makeRepoScore({ closedWithoutMergeCount: 2 }) },
    });
    incrementClosedCount(state, 'owner/repo');
    expect(state.repoScores['owner/repo'].closedWithoutMergeCount).toBe(3);
  });

  it('recalculates score with penalty', () => {
    const state = makeAgentState({ repoScores: {} });
    incrementClosedCount(state, 'owner/repo');
    expect(state.repoScores['owner/repo'].score).toBe(4); // 5 - 1
  });
});

// ---------------------------------------------------------------------------
// markRepoHostile
// ---------------------------------------------------------------------------

describe('markRepoHostile', () => {
  it('sets hasHostileComments signal', () => {
    const state = makeAgentState({ repoScores: {} });
    markRepoHostile(state, 'owner/repo');
    expect(state.repoScores['owner/repo'].signals.hasHostileComments).toBe(true);
  });

  it('applies -2 penalty to score', () => {
    const state = makeAgentState({ repoScores: {} });
    markRepoHostile(state, 'owner/repo');
    expect(state.repoScores['owner/repo'].score).toBe(3); // 5 - 2
  });

  it('creates a score record if repo is new', () => {
    const state = makeAgentState({ repoScores: {} });
    markRepoHostile(state, 'owner/new-repo');
    expect(state.repoScores['owner/new-repo']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// getReposWithMergedPRs
// ---------------------------------------------------------------------------

describe('getReposWithMergedPRs', () => {
  it('returns empty array when no repos have merges', () => {
    const state = makeAgentState({ repoScores: {} });
    expect(getReposWithMergedPRs(state)).toEqual([]);
  });

  it('returns only repos with merged PRs', () => {
    const state = makeAgentState({
      repoScores: {
        'a/one': makeRepoScore({ repo: 'a/one', mergedPRCount: 3 }),
        'b/two': makeRepoScore({ repo: 'b/two', mergedPRCount: 0 }),
        'c/three': makeRepoScore({ repo: 'c/three', mergedPRCount: 1 }),
      },
    });
    expect(getReposWithMergedPRs(state)).toEqual(['a/one', 'c/three']);
  });

  it('sorts by merged count descending', () => {
    const state = makeAgentState({
      repoScores: {
        'a/low': makeRepoScore({ repo: 'a/low', mergedPRCount: 1 }),
        'b/high': makeRepoScore({ repo: 'b/high', mergedPRCount: 10 }),
        'c/mid': makeRepoScore({ repo: 'c/mid', mergedPRCount: 5 }),
      },
    });
    expect(getReposWithMergedPRs(state)).toEqual(['b/high', 'c/mid', 'a/low']);
  });
});

// ---------------------------------------------------------------------------
// getReposWithOpenPRs
// ---------------------------------------------------------------------------

describe('getReposWithOpenPRs', () => {
  it('returns empty array when no repos match', () => {
    const state = makeAgentState({ repoScores: {} });
    expect(getReposWithOpenPRs(state)).toEqual([]);
  });

  it('returns repos with no merge or closure outcomes', () => {
    const state = makeAgentState({
      repoScores: {
        'a/open': makeRepoScore({ repo: 'a/open', mergedPRCount: 0, closedWithoutMergeCount: 0 }),
        'b/merged': makeRepoScore({ repo: 'b/merged', mergedPRCount: 1 }),
        'c/closed': makeRepoScore({ repo: 'c/closed', closedWithoutMergeCount: 1 }),
      },
    });
    expect(getReposWithOpenPRs(state)).toEqual(['a/open']);
  });

  it('sorts by score descending', () => {
    const state = makeAgentState({
      repoScores: {
        'a/low': makeRepoScore({ repo: 'a/low', score: 3 }),
        'b/high': makeRepoScore({ repo: 'b/high', score: 8 }),
      },
    });
    expect(getReposWithOpenPRs(state)).toEqual(['b/high', 'a/low']);
  });
});

// ---------------------------------------------------------------------------
// getHighScoringRepos
// ---------------------------------------------------------------------------

describe('getHighScoringRepos', () => {
  it('returns repos at or above the threshold', () => {
    const state = makeAgentState({
      config: { minRepoScoreThreshold: 6 },
      repoScores: {
        'a/high': makeRepoScore({ repo: 'a/high', score: 8 }),
        'b/exact': makeRepoScore({ repo: 'b/exact', score: 6 }),
        'c/low': makeRepoScore({ repo: 'c/low', score: 3 }),
      },
    });
    expect(getHighScoringRepos(state)).toEqual(['a/high', 'b/exact']);
  });

  it('uses custom minScore parameter over config', () => {
    const state = makeAgentState({
      config: { minRepoScoreThreshold: 2 },
      repoScores: {
        'a/repo': makeRepoScore({ repo: 'a/repo', score: 7 }),
        'b/repo': makeRepoScore({ repo: 'b/repo', score: 4 }),
      },
    });
    expect(getHighScoringRepos(state, 5)).toEqual(['a/repo']);
  });

  it('sorts by score descending', () => {
    const state = makeAgentState({
      config: { minRepoScoreThreshold: 1 },
      repoScores: {
        'a/mid': makeRepoScore({ repo: 'a/mid', score: 5 }),
        'b/high': makeRepoScore({ repo: 'b/high', score: 9 }),
        'c/low': makeRepoScore({ repo: 'c/low', score: 2 }),
      },
    });
    expect(getHighScoringRepos(state)).toEqual(['b/high', 'a/mid', 'c/low']);
  });

  it('returns empty when no repos meet threshold', () => {
    const state = makeAgentState({
      config: { minRepoScoreThreshold: 9 },
      repoScores: {
        'a/repo': makeRepoScore({ repo: 'a/repo', score: 5 }),
      },
    });
    expect(getHighScoringRepos(state)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getLowScoringRepos
// ---------------------------------------------------------------------------

describe('getLowScoringRepos', () => {
  it('returns repos at or below the threshold', () => {
    const state = makeAgentState({
      config: { minRepoScoreThreshold: 4 },
      repoScores: {
        'a/low': makeRepoScore({ repo: 'a/low', score: 2 }),
        'b/at': makeRepoScore({ repo: 'b/at', score: 4 }),
        'c/high': makeRepoScore({ repo: 'c/high', score: 8 }),
      },
    });
    expect(getLowScoringRepos(state)).toEqual(['a/low', 'b/at']);
  });

  it('uses custom maxScore parameter over config', () => {
    const state = makeAgentState({
      config: { minRepoScoreThreshold: 8 },
      repoScores: {
        'a/repo': makeRepoScore({ repo: 'a/repo', score: 3 }),
        'b/repo': makeRepoScore({ repo: 'b/repo', score: 6 }),
      },
    });
    expect(getLowScoringRepos(state, 5)).toEqual(['a/repo']);
  });

  it('sorts by score ascending', () => {
    const state = makeAgentState({
      config: { minRepoScoreThreshold: 10 },
      repoScores: {
        'a/mid': makeRepoScore({ repo: 'a/mid', score: 5 }),
        'b/low': makeRepoScore({ repo: 'b/low', score: 1 }),
        'c/lower': makeRepoScore({ repo: 'c/lower', score: 3 }),
      },
    });
    expect(getLowScoringRepos(state)).toEqual(['b/low', 'c/lower', 'a/mid']);
  });

  it('includes scores just under 30 days old', () => {
    // Use 29 days to avoid CI timing races at the exact boundary
    const state = makeAgentState({
      config: { minRepoScoreThreshold: 10 },
      repoScores: {
        'a/boundary': makeRepoScore({ repo: 'a/boundary', score: 2, lastEvaluatedAt: daysAgo(29) }),
      },
    });
    expect(getLowScoringRepos(state)).toEqual(['a/boundary']);
  });

  it('excludes stale scores older than 30 days', () => {
    const state = makeAgentState({
      config: { minRepoScoreThreshold: 10 },
      repoScores: {
        'a/stale': makeRepoScore({ repo: 'a/stale', score: 2, lastEvaluatedAt: daysAgo(31) }),
        'b/fresh': makeRepoScore({ repo: 'b/fresh', score: 3, lastEvaluatedAt: daysAgo(0) }),
      },
    });
    expect(getLowScoringRepos(state)).toEqual(['b/fresh']);
  });

  it('warns and excludes repos with invalid lastEvaluatedAt', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const state = makeAgentState({
      config: { minRepoScoreThreshold: 10 },
      repoScores: {
        'a/bad': makeRepoScore({ repo: 'a/bad', score: 2, lastEvaluatedAt: 'invalid-date' }),
        'b/good': makeRepoScore({ repo: 'b/good', score: 3 }),
      },
    });
    expect(getLowScoringRepos(state)).toEqual(['b/good']);
    expect(warnSpy).toHaveBeenCalledWith('scoring', expect.stringContaining('invalid-date'));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

describe('getStats', () => {
  it('returns zeroed stats for empty state', () => {
    const state = makeAgentState({ repoScores: {} });
    const stats = getStats(state);
    expect(stats).toEqual({
      mergedPRs: 0,
      closedPRs: 0,
      activeIssues: 0,
      trustedProjects: 0,
      mergeRate: '0.0%',
      totalTracked: 0,
      needsResponse: 0,
    });
  });

  it('aggregates merged and closed counts', () => {
    const state = makeAgentState({
      repoScores: {
        'a/repo': makeRepoScore({ repo: 'a/repo', mergedPRCount: 5, closedWithoutMergeCount: 2, stargazersCount: 100 }),
        'b/repo': makeRepoScore({ repo: 'b/repo', mergedPRCount: 3, closedWithoutMergeCount: 1, stargazersCount: 200 }),
      },
    });
    const stats = getStats(state);
    expect(stats.mergedPRs).toBe(8);
    expect(stats.closedPRs).toBe(3);
    expect(stats.totalTracked).toBe(2);
  });

  it('calculates merge rate correctly', () => {
    const state = makeAgentState({
      repoScores: {
        'a/repo': makeRepoScore({ repo: 'a/repo', mergedPRCount: 3, closedWithoutMergeCount: 1, stargazersCount: 100 }),
      },
    });
    const stats = getStats(state);
    expect(stats.mergeRate).toBe('75.0%');
  });

  it('reports 0.0% merge rate when no completed PRs', () => {
    const state = makeAgentState({
      repoScores: {
        'a/repo': makeRepoScore({ repo: 'a/repo', mergedPRCount: 0, closedWithoutMergeCount: 0, stargazersCount: 100 }),
      },
    });
    expect(getStats(state).mergeRate).toBe('0.0%');
  });

  it('reports 100.0% merge rate when all PRs merged', () => {
    const state = makeAgentState({
      repoScores: {
        'a/repo': makeRepoScore({ repo: 'a/repo', mergedPRCount: 5, closedWithoutMergeCount: 0, stargazersCount: 100 }),
      },
    });
    expect(getStats(state).mergeRate).toBe('100.0%');
  });

  it('counts trusted projects from config', () => {
    const state = makeAgentState({
      config: { trustedProjects: ['a/one', 'b/two', 'c/three'] },
    });
    expect(getStats(state).trustedProjects).toBe(3);
  });

  it('excludes repos below minStars threshold', () => {
    const state = makeAgentState({
      config: { minStars: 50 },
      repoScores: {
        'a/popular': makeRepoScore({ repo: 'a/popular', mergedPRCount: 5, stargazersCount: 100 }),
        'b/small': makeRepoScore({ repo: 'b/small', mergedPRCount: 3, stargazersCount: 10 }),
        'c/unknown': makeRepoScore({ repo: 'c/unknown', mergedPRCount: 2 }), // no stargazersCount → excluded
      },
    });
    const stats = getStats(state);
    expect(stats.mergedPRs).toBe(5);
    expect(stats.totalTracked).toBe(1);
  });

  it('always returns 0 for activeIssues and needsResponse (v2)', () => {
    const state = makeAgentState({
      repoScores: {
        'a/repo': makeRepoScore({ repo: 'a/repo', mergedPRCount: 10, stargazersCount: 100 }),
      },
    });
    const stats = getStats(state);
    expect(stats.activeIssues).toBe(0);
    expect(stats.needsResponse).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reconcilePRCounts
// ---------------------------------------------------------------------------

describe('reconcilePRCounts', () => {
  it('bumps mergedPRCount when stored array has more PRs than counter', () => {
    const state = makeAgentState({
      repoScores: {
        'owner/repo': makeRepoScore({ repo: 'owner/repo', mergedPRCount: 2 }),
      },
    });
    const mergedPRs = [
      { url: 'https://github.com/owner/repo/pull/1', title: 'PR 1', mergedAt: '2025-01-01T00:00:00Z' },
      { url: 'https://github.com/owner/repo/pull/2', title: 'PR 2', mergedAt: '2025-01-02T00:00:00Z' },
      { url: 'https://github.com/owner/repo/pull/3', title: 'PR 3', mergedAt: '2025-01-03T00:00:00Z' },
      { url: 'https://github.com/owner/repo/pull/4', title: 'PR 4', mergedAt: '2025-01-04T00:00:00Z' },
    ];
    const updated = reconcilePRCounts(state, mergedPRs, []);
    expect(updated).toBe(true);
    expect(state.repoScores['owner/repo'].mergedPRCount).toBe(4);
  });

  it('does not decrease mergedPRCount when counter is higher', () => {
    const state = makeAgentState({
      repoScores: {
        'owner/repo': makeRepoScore({ repo: 'owner/repo', mergedPRCount: 5 }),
      },
    });
    const mergedPRs = [
      { url: 'https://github.com/owner/repo/pull/1', title: 'PR 1', mergedAt: '2025-01-01T00:00:00Z' },
    ];
    const updated = reconcilePRCounts(state, mergedPRs, []);
    expect(updated).toBe(false);
    expect(state.repoScores['owner/repo'].mergedPRCount).toBe(5);
  });

  it('bumps closedWithoutMergeCount when stored array has more', () => {
    const state = makeAgentState({
      repoScores: {
        'owner/repo': makeRepoScore({ repo: 'owner/repo', closedWithoutMergeCount: 1 }),
      },
    });
    const closedPRs = [
      { url: 'https://github.com/owner/repo/pull/10', title: 'Closed 1', closedAt: '2025-02-01T00:00:00Z' },
      { url: 'https://github.com/owner/repo/pull/11', title: 'Closed 2', closedAt: '2025-02-02T00:00:00Z' },
      { url: 'https://github.com/owner/repo/pull/12', title: 'Closed 3', closedAt: '2025-02-03T00:00:00Z' },
    ];
    const updated = reconcilePRCounts(state, [], closedPRs);
    expect(updated).toBe(true);
    expect(state.repoScores['owner/repo'].closedWithoutMergeCount).toBe(3);
  });

  it('creates repoScore entry for repos not yet tracked', () => {
    const state = makeAgentState({ repoScores: {} });
    const mergedPRs = [{ url: 'https://github.com/new/repo/pull/1', title: 'PR 1', mergedAt: '2025-01-01T00:00:00Z' }];
    const updated = reconcilePRCounts(state, mergedPRs, []);
    expect(updated).toBe(true);
    expect(state.repoScores['new/repo']).toBeDefined();
    expect(state.repoScores['new/repo'].mergedPRCount).toBe(1);
  });

  it('handles multiple repos across both arrays', () => {
    const state = makeAgentState({
      repoScores: {
        'a/repo': makeRepoScore({ repo: 'a/repo', mergedPRCount: 1, closedWithoutMergeCount: 0 }),
        'b/repo': makeRepoScore({ repo: 'b/repo', mergedPRCount: 0, closedWithoutMergeCount: 1 }),
      },
    });
    const mergedPRs = [
      { url: 'https://github.com/a/repo/pull/1', title: 'A1', mergedAt: '2025-01-01T00:00:00Z' },
      { url: 'https://github.com/a/repo/pull/2', title: 'A2', mergedAt: '2025-01-02T00:00:00Z' },
      { url: 'https://github.com/b/repo/pull/3', title: 'B1', mergedAt: '2025-01-03T00:00:00Z' },
    ];
    const closedPRs = [
      { url: 'https://github.com/b/repo/pull/4', title: 'B2', closedAt: '2025-02-01T00:00:00Z' },
      { url: 'https://github.com/b/repo/pull/5', title: 'B3', closedAt: '2025-02-02T00:00:00Z' },
    ];
    const updated = reconcilePRCounts(state, mergedPRs, closedPRs);
    expect(updated).toBe(true);
    expect(state.repoScores['a/repo'].mergedPRCount).toBe(2);
    expect(state.repoScores['b/repo'].mergedPRCount).toBe(1);
    expect(state.repoScores['b/repo'].closedWithoutMergeCount).toBe(2);
  });

  it('returns false when counts already match', () => {
    const state = makeAgentState({
      repoScores: {
        'owner/repo': makeRepoScore({ repo: 'owner/repo', mergedPRCount: 2, closedWithoutMergeCount: 1 }),
      },
    });
    const mergedPRs = [
      { url: 'https://github.com/owner/repo/pull/1', title: 'PR 1', mergedAt: '2025-01-01T00:00:00Z' },
      { url: 'https://github.com/owner/repo/pull/2', title: 'PR 2', mergedAt: '2025-01-02T00:00:00Z' },
    ];
    const closedPRs = [
      { url: 'https://github.com/owner/repo/pull/3', title: 'Closed 1', closedAt: '2025-02-01T00:00:00Z' },
    ];
    const updated = reconcilePRCounts(state, mergedPRs, closedPRs);
    expect(updated).toBe(false);
  });

  it('skips PRs with invalid URLs', () => {
    const state = makeAgentState({ repoScores: {} });
    const mergedPRs = [
      { url: 'not-a-github-url', title: 'Bad', mergedAt: '2025-01-01T00:00:00Z' },
      { url: 'https://github.com/valid/repo/pull/1', title: 'Good', mergedAt: '2025-01-01T00:00:00Z' },
    ];
    const updated = reconcilePRCounts(state, mergedPRs, []);
    expect(updated).toBe(true);
    expect(state.repoScores['valid/repo'].mergedPRCount).toBe(1);
    expect(Object.keys(state.repoScores)).toHaveLength(1);
  });

  it('returns false for empty arrays', () => {
    const state = makeAgentState({ repoScores: {} });
    const updated = reconcilePRCounts(state, [], []);
    expect(updated).toBe(false);
  });
});
