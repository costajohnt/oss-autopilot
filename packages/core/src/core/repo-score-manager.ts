/**
 * Repository scoring logic for the OSS Contribution Agent.
 * Functions that operate on AgentState for scoring, querying,
 * and computing aggregate statistics. Mutation functions modify
 * the passed state object in place; query functions are pure.
 */

import { AgentState, RepoScore, RepoScoreUpdate, StoredMergedPR, StoredClosedPR, isBelowMinStars } from './types.js';
import { debug, warn } from './logger.js';
import { parseGitHubUrl } from './utils.js';

const MODULE = 'scoring';

/** Repo scores older than this are considered stale and excluded from low-scoring lists. */
const SCORE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Create a default repo score for a new repository.
 */
function createDefaultRepoScore(repo: string): RepoScore {
  return {
    repo,
    score: 5, // Base score
    mergedPRCount: 0,
    closedWithoutMergeCount: 0,
    avgResponseDays: null,
    lastEvaluatedAt: new Date().toISOString(),
    signals: {
      hasActiveMaintainers: true, // Assume positive by default
      isResponsive: false,
      hasHostileComments: false,
    },
  };
}

/**
 * Calculate the score based on the repo's metrics.
 * Base 5, logarithmic merge bonus (max +5), -1 per closed without merge (max -3),
 * +1 if recently merged (within 90 days), +1 if responsive, -2 if hostile. Clamp 1-10.
 */
export function calculateScore(repoScore: RepoScore): number {
  let score = 5; // Base score

  // Logarithmic merge bonus (max +5): 1→+2, 2→+3, 3→+4, 4+→+5
  if (repoScore.mergedPRCount > 0) {
    const mergedBonus = Math.min(Math.round(Math.log2(repoScore.mergedPRCount + 1) * 2), 5);
    score += mergedBonus;
  }

  // -1 per closed without merge (max -3)
  const closedPenalty = Math.min(repoScore.closedWithoutMergeCount, 3);
  score -= closedPenalty;

  // +1 if lastMergedAt is set and within 90 days (recency)
  if (repoScore.lastMergedAt) {
    const lastMergedDate = new Date(repoScore.lastMergedAt);
    if (isNaN(lastMergedDate.getTime())) {
      warn(
        MODULE,
        `Invalid lastMergedAt date for ${repoScore.repo}: "${repoScore.lastMergedAt}". Skipping recency bonus.`,
      );
    } else {
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysSince = Math.floor((Date.now() - lastMergedDate.getTime()) / msPerDay);
      if (daysSince <= 90) {
        score += 1;
      }
    }
  }

  // +1 if responsive
  if (repoScore.signals.isResponsive) {
    score += 1;
  }

  // -2 if hostile
  if (repoScore.signals.hasHostileComments) {
    score -= 2;
  }

  // Clamp to 1-10
  return Math.max(1, Math.min(10, score));
}

/**
 * Get the score record for a repository.
 */
export function getRepoScore(state: Readonly<AgentState>, repo: string): Readonly<RepoScore> | undefined {
  return state.repoScores[repo];
}

/**
 * Update a repository's score with partial updates. If the repo has no existing score,
 * a default score record is created first (base score 5). After applying updates, the
 * numeric score is recalculated.
 */
export function updateRepoScore(state: AgentState, repo: string, updates: RepoScoreUpdate): void {
  if (!state.repoScores[repo]) {
    state.repoScores[repo] = createDefaultRepoScore(repo);
  }

  const repoScore = state.repoScores[repo];

  // Apply explicit field updates (skip undefined values to preserve existing data)
  if (updates.mergedPRCount !== undefined) repoScore.mergedPRCount = updates.mergedPRCount;
  if (updates.closedWithoutMergeCount !== undefined)
    repoScore.closedWithoutMergeCount = updates.closedWithoutMergeCount;
  if (updates.avgResponseDays !== undefined) repoScore.avgResponseDays = updates.avgResponseDays;
  if (updates.lastMergedAt !== undefined) repoScore.lastMergedAt = updates.lastMergedAt;
  if (updates.stargazersCount !== undefined) repoScore.stargazersCount = updates.stargazersCount;
  if (updates.language !== undefined) repoScore.language = updates.language;
  if (updates.signals) {
    repoScore.signals = { ...repoScore.signals, ...updates.signals };
  }

  // Recalculate score
  repoScore.score = calculateScore(repoScore);
  repoScore.lastEvaluatedAt = new Date().toISOString();

  debug(MODULE, `Updated repo score for ${repo}: ${repoScore.score}/10`);
}

/**
 * Increment the merged PR count for a repository and recalculate its score.
 */
export function incrementMergedCount(state: AgentState, repo: string): void {
  const newCount = (state.repoScores[repo]?.mergedPRCount ?? 0) + 1;
  updateRepoScore(state, repo, {
    mergedPRCount: newCount,
    lastMergedAt: new Date().toISOString(),
  });
}

/**
 * Increment the closed-without-merge count for a repository and recalculate its score.
 */
export function incrementClosedCount(state: AgentState, repo: string): void {
  const newCount = (state.repoScores[repo]?.closedWithoutMergeCount ?? 0) + 1;
  updateRepoScore(state, repo, { closedWithoutMergeCount: newCount });
}

/**
 * Mark a repository as having hostile maintainer comments and recalculate its score.
 * This applies a -2 penalty to the score. Creates a default score record if needed.
 */
export function markRepoHostile(state: AgentState, repo: string): void {
  updateRepoScore(state, repo, { signals: { hasHostileComments: true } });
}

/**
 * Get repositories where the user has at least one merged PR, sorted by merged count descending.
 */
export function getReposWithMergedPRs(state: Readonly<AgentState>): string[] {
  return Object.values(state.repoScores)
    .filter((rs) => rs.mergedPRCount > 0)
    .sort((a, b) => b.mergedPRCount - a.mergedPRCount)
    .map((rs) => rs.repo);
}

/**
 * Get repositories with a score record but no merge or closure outcomes yet
 * (typically repos with only open PRs), sorted by score descending.
 */
export function getReposWithOpenPRs(state: Readonly<AgentState>): string[] {
  return Object.values(state.repoScores)
    .filter((rs) => rs.mergedPRCount === 0 && rs.closedWithoutMergeCount === 0)
    .sort((a, b) => b.score - a.score)
    .map((rs) => rs.repo);
}

/**
 * Get repositories with a score at or above the given threshold, sorted highest first.
 */
export function getHighScoringRepos(state: Readonly<AgentState>, minScore?: number): string[] {
  const threshold = minScore ?? state.config.minRepoScoreThreshold;
  return Object.values(state.repoScores)
    .filter((rs) => rs.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((rs) => rs.repo);
}

/**
 * Get repositories with a score at or below the given threshold, sorted lowest first.
 */
export function getLowScoringRepos(state: Readonly<AgentState>, maxScore?: number): string[] {
  const threshold = maxScore ?? state.config.minRepoScoreThreshold;
  const now = Date.now();
  return Object.values(state.repoScores)
    .filter((rs) => {
      if (rs.score > threshold) return false;
      // Stale scores (>30 days) should not permanently block repos (#487)
      const age = now - new Date(rs.lastEvaluatedAt).getTime();
      if (!Number.isFinite(age)) {
        warn(MODULE, `Invalid lastEvaluatedAt for repo ${rs.repo}: "${rs.lastEvaluatedAt}", treating as stale`);
        return false;
      }
      return age <= SCORE_TTL_MS;
    })
    .sort((a, b) => a.score - b.score)
    .map((rs) => rs.repo);
}

/**
 * Aggregate statistics returned by {@link getStats}.
 */
export interface Stats {
  /** Total merged PRs across scored repositories (above minStars threshold). */
  mergedPRs: number;
  /** Total PRs closed without merge across scored repositories (above minStars threshold). */
  closedPRs: number;
  /** Number of active issues. Always 0 in v2 (sourced from fresh fetch instead). */
  activeIssues: number;
  /** Number of trusted projects. */
  trustedProjects: number;
  /** Merge success rate as a percentage string (e.g. "75.0%"). */
  mergeRate: string;
  /** Number of scored repositories (above minStars threshold). */
  totalTracked: number;
  /** Number of PRs needing a response. Always 0 in v2 (sourced from fresh fetch instead). */
  needsResponse: number;
}

/**
 * Count PRs per repo from an array of stored PR records.
 * Skips entries with unparseable URLs.
 */
function countByRepo(prs: ReadonlyArray<{ url: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pr of prs) {
    const parsed = parseGitHubUrl(pr.url);
    if (!parsed) {
      warn(MODULE, `Skipping PR with unparseable URL during reconciliation: "${pr.url}"`);
      continue;
    }
    const repo = `${parsed.owner}/${parsed.repo}`;
    counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return counts;
}

/**
 * Reconcile repoScores merged/closed counts with the stored PR arrays.
 * Counts PRs per repo from the arrays and bumps repoScores counters when
 * the array count is higher (never decreases). Returns true if any updates were made.
 */
export function reconcilePRCounts(
  state: AgentState,
  mergedPRs: StoredMergedPR[],
  closedPRs: StoredClosedPR[],
): boolean {
  const mergedUpdated = reconcileField(state, countByRepo(mergedPRs), 'mergedPRCount');
  const closedUpdated = reconcileField(state, countByRepo(closedPRs), 'closedWithoutMergeCount');
  return mergedUpdated || closedUpdated;
}

/**
 * Reconcile a single counter field across all repos.
 * Returns true if any repo's counter was bumped.
 */
function reconcileField(
  state: AgentState,
  countsByRepo: Map<string, number>,
  field: 'mergedPRCount' | 'closedWithoutMergeCount',
): boolean {
  let updated = false;
  for (const [repo, arrayCount] of countsByRepo) {
    const current = state.repoScores[repo]?.[field] ?? 0;
    if (arrayCount > current) {
      debug(MODULE, `Reconciling ${repo} ${field}: ${current} → ${arrayCount}`);
      updateRepoScore(state, repo, { [field]: arrayCount });
      updated = true;
    }
  }
  return updated;
}

/**
 * Compute aggregate statistics from the current state.
 */
export function getStats(state: Readonly<AgentState>): Stats {
  let totalMerged = 0;
  let totalClosed = 0;
  let totalTracked = 0;

  for (const score of Object.values(state.repoScores)) {
    if (isBelowMinStars(score.stargazersCount, state.config.minStars ?? 50)) continue;
    totalTracked++;
    totalMerged += score.mergedPRCount;
    totalClosed += score.closedWithoutMergeCount;
  }

  const completed = totalMerged + totalClosed;
  const mergeRate = completed > 0 ? (totalMerged / completed) * 100 : 0;

  return {
    mergedPRs: totalMerged,
    closedPRs: totalClosed,
    activeIssues: 0,
    trustedProjects: state.config.trustedProjects.length,
    mergeRate: mergeRate.toFixed(1) + '%',
    totalTracked,
    needsResponse: 0,
  };
}
