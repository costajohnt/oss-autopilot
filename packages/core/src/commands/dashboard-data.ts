/**
 * Dashboard data fetching and aggregation.
 * Handles GitHub API calls, PR grouping, stats computation, and monthly chart data.
 * Consumed by the dashboard HTTP server (dashboard-server.ts) for the SPA API.
 */

import { getStateManager, PRMonitor, IssueConversationMonitor, getOctokit } from '../core/index.js';
import { errorMessage, isRateLimitOrAuthError } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { emptyPRCountsResult, fetchMergedPRsSince, fetchClosedPRsSince } from '../core/github-stats.js';
import { parseGitHubUrl } from '../core/urls.js';
import {
  isBelowMinStars,
  type DailyDigest,
  type AgentState,
  type ClosedPR,
  type MergedPR,
  type StoredMergedPR,
  type StoredClosedPR,
  type CommentedIssue,
  type CommentedIssueWithResponse,
  type FetchedPR,
  type ShelvedPRRef,
  type RepoMetadataEntry,
} from '../core/types.js';
import type { ParseIssueListOutput } from '../formatters/json.js';
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

/**
 * Shape of the JSON payload served by `GET /api/data` from the dashboard
 * HTTP server. Single source of truth (#965) — imported by
 * dashboard-server.ts, which previously redeclared this interface inline
 * and so silently drifted whenever this module changed shape.
 */
export interface DashboardJsonData {
  stats: DashboardStats;
  prsByRepo: Record<string, { active: number; merged: number; closed: number }>;
  topRepos: Array<{ repo: string; active: number; merged: number; closed: number }>;
  monthlyMerged: Record<string, number>;
  monthlyOpened: Record<string, number>;
  monthlyClosed: Record<string, number>;
  activePRs: FetchedPR[];
  shelvedPRUrls: string[];
  recentlyMergedPRs: MergedPR[];
  recentlyClosedPRs: ClosedPR[];
  autoUnshelvedPRs: ShelvedPRRef[];
  commentedIssues: CommentedIssue[];
  issueResponses: CommentedIssueWithResponse[];
  allMergedPRs: MergedPR[];
  allClosedPRs: ClosedPR[];
  repoMetadata: Record<string, RepoMetadataEntry>;
  vettedIssues?: ParseIssueListOutput | null;
  offline?: boolean;
  lastUpdated?: string;
  /**
   * Labels of sub-fetches that degraded to empty fallbacks during this data
   * build. Non-empty means one or more background calls failed and the
   * corresponding sections of the response are approximations (stale or
   * zero'd) rather than authoritative. The SPA surfaces this as a banner
   * so users know the dashboard is showing partial data. See #1035.
   */
  partialFailures?: string[];
}

/** Action types the dashboard can request via POST /api/action. */
export type DashboardActionType = 'move' | 'dismiss_issue_response';

/** Body shape for POST /api/action — single source for both server validation and SPA client (#998). */
export interface ActionRequest {
  action: DashboardActionType;
  url: string;
  /** Target state for move action. */
  target?: 'attention' | 'waiting' | 'shelved' | 'auto';
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
 *
 * Anti-regression guard (#1035): when the fresh count for a given month is
 * smaller than the already-stored count for that month, we keep the larger
 * value. This matters when the fresh fetch was capped (pagination limits,
 * 1000-result Search API ceiling, or partial failures) and would otherwise
 * silently overwrite authoritative historical data with a partial window.
 * The trade-off: a month that genuinely shrinks (e.g., user deleted a merged
 * PR reference remotely) cannot be decremented via this path — but that is
 * a rare case, and the alternative is silent decay of historical analytics.
 */
export function mergeMonthlyCounts(
  existing: Record<string, number>,
  fresh: Record<string, number>,
): Record<string, number> {
  const merged = { ...existing };
  for (const [month, count] of Object.entries(fresh)) {
    const current = merged[month];
    merged[month] = current === undefined ? count : Math.max(current, count);
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
  /**
   * Labels of non-critical sub-fetches that degraded to empty fallbacks
   * during this run. Empty array means every fetch succeeded. Non-empty
   * means one or more slices of the returned data are approximations —
   * callers surface this to the user so "0 recently merged" does not look
   * authoritative when it is actually "fetch failed, fell back to empty".
   * See #1035.
   */
  partialFailures: string[];
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

  // Track which non-critical sub-fetches degraded to fallbacks so the SPA
  // can surface a "partial data" banner instead of silently showing zeros.
  // Rate-limit / auth errors still rethrow via isRateLimitOrAuthError —
  // those abort the whole run, not a partial surface.
  const partialFailures: string[] = [];
  const trackingCatch = <T>(label: string, fallback: T) => {
    return (err: unknown): T => {
      if (isRateLimitOrAuthError(err)) throw err;
      partialFailures.push(label);
      warn(MODULE, `Failed to ${label}: ${errorMessage(err)}`);
      return fallback;
    };
  };

  const [
    { prs, failures, warnings: fetchWarnings },
    recentlyClosedPRs,
    recentlyMergedPRs,
    mergedResult,
    closedResult,
    fetchedIssues,
    newMergedPRs,
    newClosedPRs,
  ] = await Promise.all([
    prMonitor.fetchUserOpenPRs(),
    prMonitor.fetchRecentlyClosedPRs().catch(trackingCatch('fetch recently closed PRs', [] as ClosedPR[])),
    prMonitor.fetchRecentlyMergedPRs().catch(trackingCatch('fetch recently merged PRs', [] as MergedPR[])),
    prMonitor
      .fetchUserMergedPRCounts(starFilter)
      .catch(trackingCatch('fetch merged PR counts', emptyPRCountsResult<{ count: number; lastMergedAt: string }>())),
    prMonitor
      .fetchUserClosedPRCounts(starFilter)
      .catch(trackingCatch('fetch closed PR counts', emptyPRCountsResult<number>())),
    // Issue conversation fetch has custom messaging based on the error content, so it keeps its bespoke catch.
    issueMonitor.fetchCommentedIssues().catch((error) => {
      if (isRateLimitOrAuthError(error)) throw error;
      const msg = errorMessage(error);
      if (msg.includes('No GitHub username configured')) {
        warn(MODULE, `Issue conversation tracking requires setup: ${msg}`);
      } else {
        warn(MODULE, `Issue conversation fetch failed: ${msg}`);
        partialFailures.push('fetch issue conversations');
      }
      return {
        issues: [] as CommentedIssue[],
        failures: [{ issueUrl: 'N/A', error: `Issue conversation fetch failed: ${msg}` }],
      };
    }),
    fetchMergedPRsSince(octokit, config, watermark).catch(
      trackingCatch('fetch merged PRs for storage', [] as StoredMergedPR[]),
    ),
    fetchClosedPRsSince(octokit, config, closedWatermark).catch(
      trackingCatch('fetch closed PRs for storage', [] as StoredClosedPR[]),
    ),
  ]);

  const commentedIssues = fetchedIssues.issues;
  if (fetchedIssues.failures.length > 0) {
    warn(MODULE, `${fetchedIssues.failures.length} issue conversation check(s) failed`);
  }

  if (failures.length > 0) {
    warn(MODULE, `${failures.length} PR fetch(es) failed`);
  }

  // Surface search-API truncation warnings (#1057 M25) into the dashboard's
  // partialFailures banner so a user with >1000 open PRs sees the "partial
  // view" signal in the SPA rather than silently seeing an incomplete list.
  if (fetchWarnings) {
    for (const message of fetchWarnings) {
      partialFailures.push(message);
      warn(MODULE, message);
    }
  }

  // Wrap all state mutations in a batch for a single disk write.
  // try-catch: save errors should not crash the dashboard data fetch.
  try {
    stateManager.batch(() => {
      // Store new merged PRs incrementally (dedupes by URL)
      try {
        const { dropped } = stateManager.addMergedPRs(newMergedPRs);
        if (dropped > 0) {
          partialFailures.push(`Dropped ${dropped} merged PR(s) with invalid URLs before persistence`);
        }
      } catch (error) {
        warn(MODULE, `Failed to store merged PRs: ${errorMessage(error)}`);
      }

      // Store new closed PRs incrementally (dedupes by URL)
      try {
        const { dropped } = stateManager.addClosedPRs(newClosedPRs);
        if (dropped > 0) {
          partialFailures.push(`Dropped ${dropped} closed PR(s) with invalid URLs before persistence`);
        }
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

  return { digest, commentedIssues, allMergedPRs, allClosedPRs, partialFailures };
}

/**
 * Convert a stored-shape PR array (StoredMergedPR[] or StoredClosedPR[]) to
 * its display-shape equivalent (MergedPR[] / ClosedPR[]) by deriving `repo`
 * and `number` from the URL. Skips entries whose URL cannot be parsed.
 * Shared by storedToMergedPRs and storedToClosedPRs (#959).
 */
function storedToPRs<
  S extends { url: string; title: string } & Record<DateField, string>,
  R extends { url: string; repo: string; number: number; title: string } & Record<DateField, string>,
  DateField extends string,
>(stored: readonly S[], dateField: DateField, label: string): R[] {
  const results: R[] = [];
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
      [dateField]: pr[dateField],
    } as unknown as R);
  }
  if (skipped > 0) {
    warn(MODULE, `Skipped ${skipped} stored ${label} PR(s) with unparseable URLs`);
  }
  return results;
}

/**
 * Convert StoredMergedPR[] to MergedPR[] by deriving repo and number from URL.
 * Skips entries with unparseable URLs.
 */
export function storedToMergedPRs(stored: StoredMergedPR[]): MergedPR[] {
  return storedToPRs<StoredMergedPR, MergedPR, 'mergedAt'>(stored, 'mergedAt', 'merged');
}

/**
 * Convert StoredClosedPR[] to ClosedPR[] by deriving repo and number from URL.
 * Skips entries with unparseable URLs.
 */
export function storedToClosedPRs(stored: StoredClosedPR[]): ClosedPR[] {
  return storedToPRs<StoredClosedPR, ClosedPR, 'closedAt'>(stored, 'closedAt', 'closed');
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
