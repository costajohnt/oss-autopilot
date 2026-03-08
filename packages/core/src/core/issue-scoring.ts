/**
 * Issue Scoring — pure functions for computing viability scores and quality bonuses.
 *
 * Extracted from issue-discovery.ts (#356) to isolate scoring logic.
 */

import { daysBetween } from './utils.js';

/**
 * Calculate a quality bonus based on repo star and fork counts (#98).
 * Stars: <50 → 0, 50-499 → +3, 500-4999 → +5, 5000+ → +8
 * Forks: 50+ → +2, 500+ → +4
 * Natural max is 12 (8 stars + 4 forks).
 */
export function calculateRepoQualityBonus(stargazersCount: number, forksCount: number): number {
  let bonus = 0;

  // Star tiers
  if (stargazersCount >= 5000) bonus += 8;
  else if (stargazersCount >= 500) bonus += 5;
  else if (stargazersCount >= 50) bonus += 3;

  // Fork tiers
  if (forksCount >= 500) bonus += 4;
  else if (forksCount >= 50) bonus += 2;

  return bonus;
}

export interface ViabilityScoreParams {
  repoScore: number | null;
  hasExistingPR: boolean;
  isClaimed: boolean;
  clearRequirements: boolean;
  hasContributionGuidelines: boolean;
  issueUpdatedAt: string;
  closedWithoutMergeCount: number;
  mergedPRCount: number;
  orgHasMergedPRs: boolean;
  repoQualityBonus?: number;
  /** True when the repo matches one of the user's preferred project categories. */
  matchesPreferredCategory?: boolean;
}

/**
 * Calculate viability score for an issue (0-100 scale)
 * Scoring:
 * - Base: 50 points
 * - +repoScore*2 (up to +20 for score of 10)
 * - +repoQualityBonus (up to +12 for established repos, from star/fork counts) (#98)
 * - +15 for merged PR in this repo (direct proven relationship) (#99)
 * - +15 for clear requirements (clarity)
 * - +15 for freshness (recently updated)
 * - +10 for contribution guidelines
 * - +5 for org affinity (merged PRs in same org)
 * - +5 for category preference (matches user's project categories)
 * - -30 if existing PR
 * - -20 if claimed
 * - -15 if closed-without-merge history with no merges
 */
export function calculateViabilityScore(params: ViabilityScoreParams): number {
  let score = 50; // Base score

  // Add repo score contribution (up to +20)
  if (params.repoScore !== null) {
    score += params.repoScore * 2;
  }

  // Repo quality bonus from star/fork counts (#98, up to +12)
  score += params.repoQualityBonus ?? 0;

  // Merged PR bonus (+15) — direct proven relationship with this repo (#99)
  if (params.mergedPRCount > 0) {
    score += 15;
  }

  // Clarity bonus (+15)
  if (params.clearRequirements) {
    score += 15;
  }

  // Freshness bonus (+15 for issues updated within last 14 days)
  const updatedAt = new Date(params.issueUpdatedAt);
  const daysSinceUpdate = daysBetween(updatedAt);
  if (daysSinceUpdate <= 14) {
    score += 15;
  } else if (daysSinceUpdate <= 30) {
    // Partial bonus for 15-30 days
    score += Math.round(15 * (1 - (daysSinceUpdate - 14) / 16));
  }

  // Contribution guidelines bonus (+10)
  if (params.hasContributionGuidelines) {
    score += 10;
  }

  // Org affinity bonus (+5) — user has merged PRs in another repo under same org
  if (params.orgHasMergedPRs) {
    score += 5;
  }

  // Category preference bonus (+5) — repo matches user's preferred project categories
  if (params.matchesPreferredCategory) {
    score += 5;
  }

  // Penalty for existing PR (-30)
  if (params.hasExistingPR) {
    score -= 30;
  }

  // Penalty for claimed issue (-20)
  if (params.isClaimed) {
    score -= 20;
  }

  // Penalty for closed-without-merge history with no successful merges (-15)
  if (params.closedWithoutMergeCount > 0 && params.mergedPRCount === 0) {
    score -= 15;
  }

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}
