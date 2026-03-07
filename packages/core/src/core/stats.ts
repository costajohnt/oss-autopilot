/**
 * Contribution statistics computation.
 * Computes metrics from repo scores and PR data for shareable stats and badges.
 */

import type { RepoScore } from './types.js';

export interface ContributionStats {
  totalMerged: number;
  totalClosed: number;
  mergeRate: number;
  activePRs: number;
  reposContributed: number;
  topRepos: Array<{ repo: string; mergedCount: number }>;
}

const MAX_TOP_REPOS = 10;

export interface ComputeStatsInput {
  repoScores: Record<string, Pick<RepoScore, 'mergedPRCount' | 'closedWithoutMergeCount' | 'repo'>>;
  activePRCount: number;
}

/**
 * Compute contribution statistics from repo score data.
 * Pure function — no side effects, no API calls.
 */
export function computeContributionStats(input: ComputeStatsInput): ContributionStats {
  const { repoScores, activePRCount } = input;

  let totalMerged = 0;
  let totalClosed = 0;
  const repoEntries: Array<{ repo: string; mergedCount: number }> = [];

  for (const score of Object.values(repoScores)) {
    totalMerged += score.mergedPRCount;
    totalClosed += score.closedWithoutMergeCount;
    if (score.mergedPRCount > 0) {
      repoEntries.push({ repo: score.repo, mergedCount: score.mergedPRCount });
    }
  }

  const total = totalMerged + totalClosed;
  const mergeRate = total > 0 ? totalMerged / total : 0;

  repoEntries.sort((a, b) => b.mergedCount - a.mergedCount);

  return {
    totalMerged,
    totalClosed,
    mergeRate,
    activePRs: activePRCount,
    reposContributed: repoEntries.length,
    topRepos: repoEntries.slice(0, MAX_TOP_REPOS),
  };
}
