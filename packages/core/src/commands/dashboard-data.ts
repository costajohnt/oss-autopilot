/**
 * Dashboard data fetching and aggregation.
 * Handles GitHub API calls, PR grouping, stats computation, and monthly chart data.
 * Consumed by the dashboard HTTP server (dashboard-server.ts) for the SPA API.
 */

import { getStateManager, PRMonitor, IssueConversationMonitor, getOctokit } from '../core/index.js';
import { errorMessage, isRateLimitOrAuthError } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { emptyPRCountsResult, fetchMergedPRsSince, fetchClosedPRsSince } from '../core/github-stats.js';
import { parseGitHubUrl } from '../core/utils.js';
import {
  isBelowMinStars,
  type DailyDigest,
  type AgentState,
  type ClosedPR,
  type MergedPR,
  type StoredMergedPR,
  type StoredClosedPR,
  type CommentedIssue,
} from '../core/types.js';
import { toShelvedPRRef, buildStarFilter } from './daily.js';

const MODULE = 'dashboard-data';

export interface DashboardStats {
  activePRs: number;
  shelvedPRs: number;
  mergedPRs: number;
  closedPRs: number;
  mergeRate: string;
  availableIssues?: number;
}

export function buildDashboardStats(
  digest: DailyDigest,
  state: Readonly<AgentState>,
  storedMergedCount?: number,
  storedClosedCount?: number,
): DashboardStats {
  const summary = digest.summary || {
    totalActivePRs: 0,
    totalMergedAllTime: 0,
    mergeRate: 0,
    totalNeedingAttention: 0,
  };
  const minStars = state.config.minStars ?? 50;
  // Merged: use the higher of stored count vs repoScores aggregate to avoid regressions
  // when the stored list hasn't caught up yet (initial fetch caps at 300 PRs)
  const mergedPRs =
    storedMergedCount !== undefined
      ? Math.max(storedMergedCount, summary.totalMergedAllTime)
      : summary.totalMergedAllTime;
  // Closed: same anti-regression strategy — use the higher of stored count vs repoScores aggregate
  const aggregateClosedCount = Object.values(state.repoScores || {}).reduce(
    (sum, s) => sum + (isBelowMinStars(s.stargazersCount, minStars) ? 0 : s.closedWithoutMergeCount || 0),
    0,
  );
  const closedPRs =
    storedClosedCount !== undefined ? Math.max(storedClosedCount, aggregateClosedCount) : aggregateClosedCount;
  return {
    activePRs: summary.totalActivePRs,
    shelvedPRs: (digest.shelvedPRs || []).length,
    mergedPRs,
    closedPRs,
    mergeRate: `${(summary.mergeRate ?? 0).toFixed(1)}%`,
  };
}

/**
 * Merge fresh API counts into existing stored counts.
 * Months present in the fresh data are updated; months only in the existing data are preserved.
 * This prevents historical data loss when the API returns incomplete results
 * (e.g. due to pagination limits or transient failures).
 */
export function mergeMonthlyCounts(
  existing: Record<string, number>,
  fresh: Record<string, number>,
): Record<string, number> {
  const merged = { ...existing };
  for (const [month, count] of Object.entries(fresh)) {
    merged[month] = count;
  }
  return merged;
}

/**
 * Persist monthly chart analytics (merged, closed, opened) to state.
 * Each metric is isolated so partial failures don't produce inconsistent state.
 * Fresh API results are merged into existing data so historical months are preserved.
 * Skips updating when fresh data is empty to avoid wiping chart data on transient API failures.
 */
export function updateMonthlyAnalytics(
  prs: Array<{ createdAt?: string }>,
  monthlyCounts: Record<string, number>,
  monthlyClosedCounts: Record<string, number>,
  openedFromMerged: Record<string, number>,
  openedFromClosed: Record<string, number>,
): void {
  const stateManager = getStateManager();
  const state = stateManager.getState();

  try {
    if (Object.keys(monthlyCounts).length > 0) {
      stateManager.setMonthlyMergedCounts(mergeMonthlyCounts(state.monthlyMergedCounts || {}, monthlyCounts));
    }
  } catch (error) {
    warn(MODULE, `Failed to store monthly merged counts: ${errorMessage(error)}`);
  }
  try {
    if (Object.keys(monthlyClosedCounts).length > 0) {
      stateManager.setMonthlyClosedCounts(mergeMonthlyCounts(state.monthlyClosedCounts || {}, monthlyClosedCounts));
    }
  } catch (error) {
    warn(MODULE, `Failed to store monthly closed counts: ${errorMessage(error)}`);
  }
  try {
    const combinedOpenedCounts: Record<string, number> = { ...openedFromMerged };
    for (const [month, count] of Object.entries(openedFromClosed)) {
      combinedOpenedCounts[month] = (combinedOpenedCounts[month] || 0) + count;
    }
    for (const pr of prs) {
      if (pr.createdAt) {
        const month = pr.createdAt.slice(0, 7);
        combinedOpenedCounts[month] = (combinedOpenedCounts[month] || 0) + 1;
      }
    }
    if (Object.keys(combinedOpenedCounts).length > 0) {
      stateManager.setMonthlyOpenedCounts(mergeMonthlyCounts(state.monthlyOpenedCounts || {}, combinedOpenedCounts));
    }
  } catch (error) {
    warn(MODULE, `Failed to store monthly opened counts: ${errorMessage(error)}`);
  }
}

export interface DashboardFetchResult {
  digest: DailyDigest;
  commentedIssues: CommentedIssue[];
  allMergedPRs: MergedPR[];
  allClosedPRs: ClosedPR[];
}

/**
 * Fetch fresh dashboard data from GitHub.
 * Returns the digest and commented issues, updating state as a side effect.
 * Throws if the fetch fails entirely (caller should fall back to cached data).
 */
export async function fetchDashboardData(token: string): Promise<DashboardFetchResult> {
  const stateManager = getStateManager();
  const prMonitor = new PRMonitor(token);
  const issueMonitor = new IssueConversationMonitor(token);
  const octokit = getOctokit(token);
  const config = stateManager.getState().config;

  // Build star filter from cached repoScores (#576)
  const starFilter = buildStarFilter(stateManager.getState());

  // Get watermarks for incremental PR fetch
  const watermark = stateManager.getMergedPRWatermark();
  const closedWatermark = stateManager.getClosedPRWatermark();

  const [
    { prs, failures },
    recentlyClosedPRs,
    recentlyMergedPRs,
    mergedResult,
    closedResult,
    fetchedIssues,
    newMergedPRs,
    newClosedPRs,
  ] = await Promise.all([
    prMonitor.fetchUserOpenPRs(),
    prMonitor.fetchRecentlyClosedPRs().catch((err): ClosedPR[] => {
      if (isRateLimitOrAuthError(err)) throw err;
      warn(MODULE, `Failed to fetch recently closed PRs: ${errorMessage(err)}`);
      return [];
    }),
    prMonitor.fetchRecentlyMergedPRs().catch((err): MergedPR[] => {
      if (isRateLimitOrAuthError(err)) throw err;
      warn(MODULE, `Failed to fetch recently merged PRs: ${errorMessage(err)}`);
      return [];
    }),
    prMonitor.fetchUserMergedPRCounts(starFilter).catch((err) => {
      if (isRateLimitOrAuthError(err)) throw err;
      warn(MODULE, `Failed to fetch merged PR counts: ${errorMessage(err)}`);
      return emptyPRCountsResult<{ count: number; lastMergedAt: string }>();
    }),
    prMonitor.fetchUserClosedPRCounts(starFilter).catch((err) => {
      if (isRateLimitOrAuthError(err)) throw err;
      warn(MODULE, `Failed to fetch closed PR counts: ${errorMessage(err)}`);
      return emptyPRCountsResult<number>();
    }),
    issueMonitor.fetchCommentedIssues().catch((error) => {
      if (isRateLimitOrAuthError(error)) throw error;
      const msg = errorMessage(error);
      if (msg.includes('No GitHub username configured')) {
        warn(MODULE, `Issue conversation tracking requires setup: ${msg}`);
      } else {
        warn(MODULE, `Issue conversation fetch failed: ${msg}`);
      }
      return {
        issues: [] as CommentedIssue[],
        failures: [{ issueUrl: 'N/A', error: `Issue conversation fetch failed: ${msg}` }],
      };
    }),
    fetchMergedPRsSince(octokit, config, watermark).catch((err): StoredMergedPR[] => {
      if (isRateLimitOrAuthError(err)) throw err;
      warn(MODULE, `Failed to fetch merged PRs for storage: ${errorMessage(err)}`);
      return [];
    }),
    fetchClosedPRsSince(octokit, config, closedWatermark).catch((err): StoredClosedPR[] => {
      if (isRateLimitOrAuthError(err)) throw err;
      warn(MODULE, `Failed to fetch closed PRs for storage: ${errorMessage(err)}`);
      return [];
    }),
  ]);

  const commentedIssues = fetchedIssues.issues;
  if (fetchedIssues.failures.length > 0) {
    warn(MODULE, `${fetchedIssues.failures.length} issue conversation check(s) failed`);
  }

  if (failures.length > 0) {
    warn(MODULE, `${failures.length} PR fetch(es) failed`);
  }

  // Wrap all state mutations in a batch for a single disk write.
  // try-catch: save errors should not crash the dashboard data fetch.
  try {
    stateManager.batch(() => {
      // Store new merged PRs incrementally (dedupes by URL)
      try {
        stateManager.addMergedPRs(newMergedPRs);
      } catch (error) {
        warn(MODULE, `Failed to store merged PRs: ${errorMessage(error)}`);
      }

      // Store new closed PRs incrementally (dedupes by URL)
      try {
        stateManager.addClosedPRs(newClosedPRs);
      } catch (error) {
        warn(MODULE, `Failed to store closed PRs: ${errorMessage(error)}`);
      }

      // Store monthly chart data (opened/merged/closed) so charts have data
      const { monthlyCounts, monthlyOpenedCounts: openedFromMerged } = mergedResult;
      const { monthlyCounts: monthlyClosedCounts, monthlyOpenedCounts: openedFromClosed } = closedResult;
      updateMonthlyAnalytics(prs, monthlyCounts, monthlyClosedCounts, openedFromMerged, openedFromClosed);

      const digest = prMonitor.generateDigest(prs, recentlyClosedPRs, recentlyMergedPRs);

      // Apply shelve partitioning for display (auto-unshelve only runs in daily check)
      // Dormant PRs are treated as shelved unless they need addressing
      const shelvedUrls = new Set(stateManager.getState().config.shelvedPRUrls || []);
      const freshShelved = prs.filter(
        (pr) => shelvedUrls.has(pr.url) || (pr.stalenessTier === 'dormant' && pr.status !== 'needs_addressing'),
      );
      digest.shelvedPRs = freshShelved.map(toShelvedPRRef);
      digest.autoUnshelvedPRs = [];
      digest.summary.totalActivePRs = prs.length - freshShelved.length;

      stateManager.setLastDigest(digest);
    });
  } catch (error) {
    warn(MODULE, `Failed to persist dashboard state: ${errorMessage(error)}`);
  }
  warn(MODULE, `Refreshed: ${prs.length} PRs fetched`);

  // Convert stored PRs to full types (derive repo/number from URL) — read-only, outside batch
  const allMergedPRs = storedToMergedPRs(stateManager.getMergedPRs());
  const allClosedPRs = storedToClosedPRs(stateManager.getClosedPRs());
  const digest = stateManager.getState().lastDigest;
  if (!digest) {
    throw new Error('Dashboard data fetch failed: digest was not generated');
  }

  return { digest, commentedIssues, allMergedPRs, allClosedPRs };
}

/**
 * Convert StoredMergedPR[] to MergedPR[] by deriving repo and number from URL.
 * Skips entries with unparseable URLs.
 */
export function storedToMergedPRs(stored: StoredMergedPR[]): MergedPR[] {
  const results: MergedPR[] = [];
  let skipped = 0;
  for (const pr of stored) {
    const parsed = parseGitHubUrl(pr.url);
    if (!parsed) {
      skipped++;
      continue;
    }
    results.push({
      url: pr.url,
      repo: `${parsed.owner}/${parsed.repo}`,
      number: parsed.number,
      title: pr.title,
      mergedAt: pr.mergedAt,
    });
  }
  if (skipped > 0) {
    warn(MODULE, `Skipped ${skipped} stored merged PR(s) with unparseable URLs`);
  }
  return results;
}

/**
 * Convert StoredClosedPR[] to ClosedPR[] by deriving repo and number from URL.
 * Skips entries with unparseable URLs.
 */
export function storedToClosedPRs(stored: StoredClosedPR[]): ClosedPR[] {
  const results: ClosedPR[] = [];
  let skipped = 0;
  for (const pr of stored) {
    const parsed = parseGitHubUrl(pr.url);
    if (!parsed) {
      skipped++;
      continue;
    }
    results.push({
      url: pr.url,
      repo: `${parsed.owner}/${parsed.repo}`,
      number: parsed.number,
      title: pr.title,
      closedAt: pr.closedAt,
    });
  }
  if (skipped > 0) {
    warn(MODULE, `Skipped ${skipped} stored closed PR(s) with unparseable URLs`);
  }
  return results;
}

/**
 * Compute PRs grouped by repository from a digest and state.
 * Used for chart data in the dashboard API.
 */
export function computePRsByRepo(
  digest: DailyDigest,
  state: Readonly<AgentState>,
): Record<string, { active: number; merged: number; closed: number }> {
  const prsByRepo: Record<string, { active: number; merged: number; closed: number }> = {};

  // Count active PRs by repo from digest
  for (const pr of digest.openPRs || []) {
    if (!prsByRepo[pr.repo]) prsByRepo[pr.repo] = { active: 0, merged: 0, closed: 0 };
    prsByRepo[pr.repo].active++;
  }

  // Add merged/closed counts from repo scores (historical data), filtering by minStars (#576)
  const minStars = state.config.minStars ?? 50;
  for (const [repo, score] of Object.entries(state.repoScores || {})) {
    if (isBelowMinStars(score.stargazersCount, minStars)) continue;
    if (!prsByRepo[repo]) prsByRepo[repo] = { active: 0, merged: 0, closed: 0 };
    prsByRepo[repo].merged = score.mergedPRCount;
    prsByRepo[repo].closed = score.closedWithoutMergeCount;
  }

  return prsByRepo;
}

/**
 * Compute the top repositories sorted by total PR count.
 */
export function computeTopRepos(
  prsByRepo: Record<string, { active: number; merged: number; closed: number }>,
  limit: number = 10,
): Array<[string, { active: number; merged: number; closed: number }]> {
  return Object.entries(prsByRepo)
    .sort((a, b) => b[1].merged + b[1].active + b[1].closed - (a[1].merged + a[1].active + a[1].closed))
    .slice(0, limit);
}

/**
 * Extract monthly activity data from state.
 */
export function getMonthlyData(state: Readonly<AgentState>): {
  monthlyMerged: Record<string, number>;
  monthlyClosed: Record<string, number>;
  monthlyOpened: Record<string, number>;
} {
  return {
    monthlyMerged: state.monthlyMergedCounts || {},
    monthlyClosed: state.monthlyClosedCounts || {},
    monthlyOpened: state.monthlyOpenedCounts || {},
  };
}
