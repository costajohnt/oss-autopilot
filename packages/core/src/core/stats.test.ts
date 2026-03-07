/**
 * Tests for contribution stats computation
 */

import { describe, it, expect } from 'vitest';
import { computeContributionStats } from './stats.js';

describe('computeContributionStats', () => {
  it('should compute basic stats from repo scores', () => {
    const result = computeContributionStats({
      repoScores: {
        'owner/repo-a': { repo: 'owner/repo-a', mergedPRCount: 5, closedWithoutMergeCount: 1 },
        'owner/repo-b': { repo: 'owner/repo-b', mergedPRCount: 3, closedWithoutMergeCount: 0 },
      },
      activePRCount: 2,
    });

    expect(result.totalMerged).toBe(8);
    expect(result.totalClosed).toBe(1);
    expect(result.mergeRate).toBeCloseTo(8 / 9, 5); // ~0.889
    expect(result.activePRs).toBe(2);
    expect(result.reposContributed).toBe(2);
  });

  it('should handle zero merged PRs', () => {
    const result = computeContributionStats({
      repoScores: {
        'owner/repo-a': { repo: 'owner/repo-a', mergedPRCount: 0, closedWithoutMergeCount: 0 },
      },
      activePRCount: 0,
    });

    expect(result.totalMerged).toBe(0);
    expect(result.totalClosed).toBe(0);
    expect(result.mergeRate).toBe(0);
    expect(result.activePRs).toBe(0);
    expect(result.reposContributed).toBe(0);
  });

  it('should sort topRepos by merged count descending', () => {
    const result = computeContributionStats({
      repoScores: {
        'owner/repo-a': { repo: 'owner/repo-a', mergedPRCount: 2, closedWithoutMergeCount: 0 },
        'owner/repo-b': { repo: 'owner/repo-b', mergedPRCount: 10, closedWithoutMergeCount: 0 },
        'owner/repo-c': { repo: 'owner/repo-c', mergedPRCount: 5, closedWithoutMergeCount: 0 },
      },
      activePRCount: 0,
    });

    expect(result.topRepos[0]).toEqual({ repo: 'owner/repo-b', mergedCount: 10 });
    expect(result.topRepos[1]).toEqual({ repo: 'owner/repo-c', mergedCount: 5 });
    expect(result.topRepos[2]).toEqual({ repo: 'owner/repo-a', mergedCount: 2 });
  });

  it('should limit topRepos to 10', () => {
    const repoScores: Record<string, { repo: string; mergedPRCount: number; closedWithoutMergeCount: number }> = {};
    for (let i = 0; i < 15; i++) {
      const repo = `owner/repo-${i}`;
      repoScores[repo] = { repo, mergedPRCount: i + 1, closedWithoutMergeCount: 0 };
    }

    const result = computeContributionStats({ repoScores, activePRCount: 0 });

    expect(result.topRepos).toHaveLength(10);
    // Should contain the top 10 by mergedCount (repos 5-14, i.e., mergedCount 6-15)
    expect(result.topRepos[0].mergedCount).toBe(15);
    expect(result.topRepos[9].mergedCount).toBe(6);
  });

  it('should only count repos with mergedPRCount > 0 in reposContributed', () => {
    const result = computeContributionStats({
      repoScores: {
        'owner/repo-a': { repo: 'owner/repo-a', mergedPRCount: 3, closedWithoutMergeCount: 0 },
        'owner/repo-b': { repo: 'owner/repo-b', mergedPRCount: 0, closedWithoutMergeCount: 2 },
        'owner/repo-c': { repo: 'owner/repo-c', mergedPRCount: 0, closedWithoutMergeCount: 0 },
      },
      activePRCount: 0,
    });

    expect(result.reposContributed).toBe(1);
    expect(result.topRepos).toHaveLength(1);
    expect(result.topRepos[0].repo).toBe('owner/repo-a');
  });
});
