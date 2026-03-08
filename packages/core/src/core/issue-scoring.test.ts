import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateRepoQualityBonus, calculateViabilityScore, type ViabilityScoreParams } from './issue-scoring.js';

describe('calculateRepoQualityBonus', () => {
  it('returns 0 for low star/fork counts', () => {
    expect(calculateRepoQualityBonus(0, 0)).toBe(0);
    expect(calculateRepoQualityBonus(49, 49)).toBe(0);
  });

  it('returns +3 for 50-499 stars', () => {
    expect(calculateRepoQualityBonus(50, 0)).toBe(3);
    expect(calculateRepoQualityBonus(499, 0)).toBe(3);
  });

  it('returns +5 for 500-4999 stars', () => {
    expect(calculateRepoQualityBonus(500, 0)).toBe(5);
    expect(calculateRepoQualityBonus(4999, 0)).toBe(5);
  });

  it('returns +8 for 5000+ stars', () => {
    expect(calculateRepoQualityBonus(5000, 0)).toBe(8);
    expect(calculateRepoQualityBonus(100000, 0)).toBe(8);
  });

  it('returns +2 for 50-499 forks', () => {
    expect(calculateRepoQualityBonus(0, 50)).toBe(2);
    expect(calculateRepoQualityBonus(0, 499)).toBe(2);
  });

  it('returns +4 for 500+ forks', () => {
    expect(calculateRepoQualityBonus(0, 500)).toBe(4);
    expect(calculateRepoQualityBonus(0, 10000)).toBe(4);
  });

  it('combines star and fork bonuses (max 12)', () => {
    expect(calculateRepoQualityBonus(5000, 500)).toBe(12);
  });

  it('handles mid-tier combinations', () => {
    expect(calculateRepoQualityBonus(500, 50)).toBe(7); // 5 + 2
    expect(calculateRepoQualityBonus(50, 500)).toBe(7); // 3 + 4
  });
});

describe('calculateViabilityScore', () => {
  /** Base params: fresh issue, no bonuses or penalties. */
  function makeParams(overrides: Partial<ViabilityScoreParams> = {}): ViabilityScoreParams {
    return {
      repoScore: null,
      hasExistingPR: false,
      isClaimed: false,
      clearRequirements: false,
      hasContributionGuidelines: false,
      issueUpdatedAt: new Date().toISOString(), // fresh — within 14 days
      closedWithoutMergeCount: 0,
      mergedPRCount: 0,
      orgHasMergedPRs: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-07-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // makeParams defaults issueUpdatedAt to "now" (fake time), so freshness bonus (+15) is always included.
  // Tests below only override issueUpdatedAt when testing freshness or staleness specifically.

  it('returns base score of 50 with no modifiers', () => {
    const score = calculateViabilityScore(makeParams());
    expect(score).toBe(65); // 50 base + 15 freshness
  });

  it('adds repo score contribution (up to +20)', () => {
    const score = calculateViabilityScore(makeParams({ repoScore: 10 }));
    expect(score).toBe(85); // 50 + 20 (repo) + 15 (fresh)
  });

  it('adds repo quality bonus', () => {
    const score = calculateViabilityScore(makeParams({ repoQualityBonus: 12 }));
    expect(score).toBe(77); // 50 + 12 (quality) + 15 (fresh)
  });

  it('adds +15 for merged PR count', () => {
    const score = calculateViabilityScore(makeParams({ mergedPRCount: 3 }));
    expect(score).toBe(80); // 50 + 15 (merged) + 15 (fresh)
  });

  it('adds +15 for clear requirements', () => {
    const score = calculateViabilityScore(makeParams({ clearRequirements: true }));
    expect(score).toBe(80); // 50 + 15 (clarity) + 15 (fresh)
  });

  it('adds +10 for contribution guidelines', () => {
    const score = calculateViabilityScore(makeParams({ hasContributionGuidelines: true }));
    expect(score).toBe(75); // 50 + 10 (guidelines) + 15 (fresh)
  });

  it('adds +5 for org affinity', () => {
    const score = calculateViabilityScore(makeParams({ orgHasMergedPRs: true }));
    expect(score).toBe(70); // 50 + 5 (org) + 15 (fresh)
  });

  it('adds +5 for preferred category match', () => {
    const score = calculateViabilityScore(makeParams({ matchesPreferredCategory: true }));
    expect(score).toBe(70); // 50 + 5 (category) + 15 (fresh)
  });

  it('does not add category bonus when false', () => {
    const score = calculateViabilityScore(makeParams({ matchesPreferredCategory: false }));
    expect(score).toBe(65); // 50 + 15 (fresh) — no category bonus
  });

  it('does not add category bonus when undefined', () => {
    const score = calculateViabilityScore(makeParams({}));
    expect(score).toBe(65); // 50 + 15 (fresh) — no category bonus
  });

  it('subtracts -30 for existing PR', () => {
    const score = calculateViabilityScore(makeParams({ hasExistingPR: true }));
    expect(score).toBe(35); // 50 - 30 (existing PR) + 15 (fresh)
  });

  it('subtracts -20 for claimed issue', () => {
    const score = calculateViabilityScore(makeParams({ isClaimed: true }));
    expect(score).toBe(45); // 50 - 20 (claimed) + 15 (fresh)
  });

  it('subtracts -15 for closed-without-merge with no merges', () => {
    const score = calculateViabilityScore(makeParams({ closedWithoutMergeCount: 2, mergedPRCount: 0 }));
    expect(score).toBe(50); // 50 - 15 (closed) + 15 (fresh)
  });

  it('does NOT penalize closed-without-merge when there are merges', () => {
    const score = calculateViabilityScore(makeParams({ closedWithoutMergeCount: 2, mergedPRCount: 1 }));
    expect(score).toBe(80); // 50 + 15 (merged PR bonus) + 15 (fresh)
  });

  describe('freshness bonus', () => {
    it('gives +15 for issues updated within 14 days', () => {
      const score = calculateViabilityScore(makeParams({ issueUpdatedAt: '2025-06-28T00:00:00Z' })); // 3 days ago
      expect(score).toBe(65); // 50 + 15
    });

    it('gives partial bonus for issues updated 15-30 days ago', () => {
      const score = calculateViabilityScore(makeParams({ issueUpdatedAt: '2025-06-09T00:00:00Z' })); // 22 days ago
      // 50 base + Math.round(15 * (1 - (22 - 14) / 16)) = 50 + Math.round(7.5) = 58
      expect(score).toBe(58);
    });

    it('gives 0 freshness bonus for issues older than 30 days', () => {
      const score = calculateViabilityScore(makeParams({ issueUpdatedAt: '2025-05-01T00:00:00Z' })); // 61 days ago
      expect(score).toBe(50); // base only
    });
  });

  it('clamps to 0 minimum', () => {
    const score = calculateViabilityScore(
      makeParams({
        hasExistingPR: true, // -30
        isClaimed: true, // -20
        closedWithoutMergeCount: 5, // -15
        issueUpdatedAt: '2025-01-01T00:00:00Z', // stale, no freshness
      }),
    );
    expect(score).toBe(0); // 50 - 30 - 20 - 15 = -15 → clamped to 0
  });

  it('clamps to 100 maximum', () => {
    const score = calculateViabilityScore(
      makeParams({
        repoScore: 10, // +20
        repoQualityBonus: 12, // +12
        mergedPRCount: 5, // +15
        clearRequirements: true, // +15
        hasContributionGuidelines: true, // +10
        orgHasMergedPRs: true, // +5
        matchesPreferredCategory: true, // +5
        // +15 freshness from makeParams default
      }),
    );
    // 50 + 20 + 12 + 15 + 15 + 10 + 5 + 5 + 15 = 147 → clamped to 100
    expect(score).toBe(100);
  });
});
