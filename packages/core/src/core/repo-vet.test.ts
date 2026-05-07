/**
 * Tests for `computeRepoVet` (#1242).
 *
 * Pin the weighted scoring, sub-factor thresholds, and verdict cutoffs.
 * Pure-fixture tests — no network. The interpretive recommendation
 * paragraph belongs to the agent prompt and is not under test here.
 */

import { describe, it, expect } from 'vitest';
import { computeRepoVet, type RepoVetInput } from './repo-vet.js';

function input(overrides: Partial<RepoVetInput> = {}): RepoVetInput {
  return {
    stars: 1500,
    forks: 200,
    openIssues: 30,
    watchers: 50,
    isArchived: false,
    lastPushed: new Date().toISOString(),
    createdAt: new Date('2020-01-01').toISOString(),
    commitsLast30Days: 30,
    prMergeTimesDays: [2, 3, 1, 4, 2],
    mergedCount90Days: 50,
    openedCount90Days: 60,
    lastCommitISO: new Date().toISOString(),
    contributorsLast90d: 8,
    lastReleaseISO: new Date(Date.now() - 30 * 86400000).toISOString(),
    hasContributing: true,
    hasIssueTemplates: true,
    hasPRTemplate: true,
    hasCodeOfConduct: true,
    ...overrides,
  };
}

describe('computeRepoVet — verdicts', () => {
  it('rates a healthy repo as recommended', () => {
    const result = computeRepoVet(input());
    expect(result.rubricVerdict).toBe('recommended');
    expect(result.rubricScore).toBeGreaterThanOrEqual(7.5);
  });

  it('marks an archived repo as avoid regardless of other metrics', () => {
    const result = computeRepoVet(input({ isArchived: true }));
    expect(result.rubricVerdict).toBe('avoid');
  });

  it('marks a repo with no commits in 60+ days as avoid (red flag)', () => {
    const oldCommit = new Date(Date.now() - 90 * 86400000).toISOString();
    const result = computeRepoVet(input({ lastCommitISO: oldCommit }));
    expect(result.rubricVerdict).toBe('avoid');
  });

  it('marks a repo with PRs but zero merges in 90 days as avoid (red flag)', () => {
    const result = computeRepoVet(input({ openedCount90Days: 20, mergedCount90Days: 0 }));
    expect(result.rubricVerdict).toBe('avoid');
  });

  it('rates a struggling-but-not-flagged repo as proceed_with_caution', () => {
    // No red flags but middling sub-scores: borderline merge rate,
    // weak guidelines coverage.
    const result = computeRepoVet(
      input({
        commitsLast30Days: 15,
        prMergeTimesDays: [4, 6, 5],
        mergedCount90Days: 18,
        openedCount90Days: 28,
        hasContributing: false,
        hasIssueTemplates: false,
      }),
    );
    expect(result.rubricVerdict).toBe('proceed_with_caution');
    expect(result.rubricScore).toBeGreaterThanOrEqual(5);
    expect(result.rubricScore).toBeLessThan(7.5);
  });
});

describe('computeRepoVet — pr-merge-time stats', () => {
  it('reports avg and median from supplied durations', () => {
    const result = computeRepoVet(input({ prMergeTimesDays: [1, 3, 5, 7, 9] }));
    expect(result.prMergeTime.avgDays).toBe(5);
    expect(result.prMergeTime.medianDays).toBe(5);
    expect(result.prMergeTime.sampleSize).toBe(5);
    expect(result.prMergeTime.sourceWindowDays).toBe(90);
  });

  it('returns null avg/median when no PRs in the sample', () => {
    const result = computeRepoVet(input({ prMergeTimesDays: [] }));
    expect(result.prMergeTime.avgDays).toBeNull();
    expect(result.prMergeTime.medianDays).toBeNull();
    expect(result.prMergeTime.sampleSize).toBe(0);
  });

  it('computes median as the average of two middle values for even-length samples', () => {
    const result = computeRepoVet(input({ prMergeTimesDays: [1, 2, 3, 10] }));
    expect(result.prMergeTime.medianDays).toBe(2.5);
  });
});

describe('computeRepoVet — merge rate', () => {
  it('reports raw counts and percent', () => {
    const result = computeRepoVet(input({ mergedCount90Days: 70, openedCount90Days: 100 }));
    expect(result.mergeRate.merged).toBe(70);
    expect(result.mergeRate.opened).toBe(100);
    expect(result.mergeRate.percent).toBe(70);
  });

  it('returns null percent when no PRs were opened', () => {
    const result = computeRepoVet(input({ mergedCount90Days: 0, openedCount90Days: 0 }));
    // openedCount=0 also clears the red-flag check (which only fires on
    // opened>0 AND merged=0).
    expect(result.mergeRate.percent).toBeNull();
  });
});

describe('computeRepoVet — community health', () => {
  it('echoes the four flags into the result verbatim', () => {
    const result = computeRepoVet(
      input({
        hasContributing: true,
        hasIssueTemplates: false,
        hasPRTemplate: true,
        hasCodeOfConduct: false,
      }),
    );
    expect(result.communityHealth).toEqual({
      contributing: true,
      issueTemplates: false,
      prTemplate: true,
      codeOfConduct: false,
    });
  });
});

describe('computeRepoVet — rubric score weighting', () => {
  it('places the score on a 1-10 scale with normalization', () => {
    const result = computeRepoVet(input());
    expect(result.rubricScore).toBeGreaterThanOrEqual(0);
    expect(result.rubricScore).toBeLessThanOrEqual(10);
  });

  it('drops the activity sub-score on archived repos to zero', () => {
    // Compare archived vs non-archived with otherwise identical inputs.
    // Archived hits the red-flag path so verdict is avoid; the score
    // itself should still be lower than the non-archived case.
    const live = computeRepoVet(input());
    const archived = computeRepoVet(input({ isArchived: true }));
    expect(archived.rubricScore).toBeLessThan(live.rubricScore);
  });
});
