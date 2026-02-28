/**
 * Dashboard data fetching and aggregation.
 * Handles GitHub API calls, PR grouping, stats computation, and monthly chart data.
 * Separates data concerns from template generation and command orchestration.
 */

import { getStateManager, PRMonitor, IssueConversationMonitor } from '../core/index.js';
import { toShelvedPRRef } from './daily.js';
import type { DailyDigest, AgentState, ClosedPR, MergedPR, CommentedIssue } from '../core/types.js';

export interface DashboardFetchResult {
  digest: DailyDigest;
  commentedIssues: CommentedIssue[];
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

  const [{ prs, failures }, recentlyClosedPRs, recentlyMergedPRs, mergedResult, closedResult, fetchedIssues] =
    await Promise.all([
      prMonitor.fetchUserOpenPRs(),
      prMonitor.fetchRecentlyClosedPRs().catch((err): ClosedPR[] => {
        console.error(`Warning: Failed to fetch recently closed PRs: ${err instanceof Error ? err.message : err}`);
        return [];
      }),
      prMonitor.fetchRecentlyMergedPRs().catch((err): MergedPR[] => {
        console.error(`Warning: Failed to fetch recently merged PRs: ${err instanceof Error ? err.message : err}`);
        return [];
      }),
      prMonitor.fetchUserMergedPRCounts(),
      prMonitor.fetchUserClosedPRCounts(),
      issueMonitor.fetchCommentedIssues().catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('No GitHub username configured')) {
          console.error(`[DASHBOARD] Issue conversation tracking requires setup: ${msg}`);
        } else {
          console.error(`[DASHBOARD] Issue conversation fetch failed: ${msg}`);
        }
        return {
          issues: [] as CommentedIssue[],
          failures: [{ issueUrl: 'N/A', error: `Issue conversation fetch failed: ${msg}` }],
        };
      }),
    ]);

  const commentedIssues = fetchedIssues.issues;
  if (fetchedIssues.failures.length > 0) {
    console.error(`[DASHBOARD] ${fetchedIssues.failures.length} issue conversation check(s) failed`);
  }

  if (failures.length > 0) {
    console.error(`Warning: ${failures.length} PR fetch(es) failed`);
  }

  // Store monthly chart data (opened/merged/closed) so charts have data
  const { monthlyCounts, monthlyOpenedCounts: openedFromMerged } = mergedResult;
  const { monthlyCounts: monthlyClosedCounts, monthlyOpenedCounts: openedFromClosed } = closedResult;

  try {
    stateManager.setMonthlyMergedCounts(monthlyCounts);
  } catch (error) {
    console.error('[DASHBOARD] Failed to store monthly merged counts:', error instanceof Error ? error.message : error);
  }
  try {
    stateManager.setMonthlyClosedCounts(monthlyClosedCounts);
  } catch (error) {
    console.error('[DASHBOARD] Failed to store monthly closed counts:', error instanceof Error ? error.message : error);
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
    stateManager.setMonthlyOpenedCounts(combinedOpenedCounts);
  } catch (error) {
    console.error('[DASHBOARD] Failed to store monthly opened counts:', error instanceof Error ? error.message : error);
  }

  const digest = prMonitor.generateDigest(prs, recentlyClosedPRs, recentlyMergedPRs);

  // Apply shelve partitioning for display (auto-unshelve only runs in daily check)
  // Dormant PRs are treated as shelved for display purposes
  const shelvedUrls = new Set(stateManager.getState().config.shelvedPRUrls || []);
  const freshShelved = prs.filter((pr) => shelvedUrls.has(pr.url) || pr.status === 'dormant');
  digest.shelvedPRs = freshShelved.map(toShelvedPRRef);
  digest.autoUnshelvedPRs = [];
  digest.summary.totalActivePRs = prs.length - freshShelved.length;

  stateManager.setLastDigest(digest);
  stateManager.save();
  console.error(`Refreshed: ${prs.length} PRs fetched`);

  return { digest, commentedIssues };
}

/**
 * Compute PRs grouped by repository from a digest and state.
 * Used for chart data in both JSON and HTML output.
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

  // Add merged/closed counts from repo scores (historical data)
  for (const [repo, score] of Object.entries(state.repoScores || {})) {
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
