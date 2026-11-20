/**
 * The daily run's recently closed and recently merged PR lists (#1928).
 * Split out of daily.ts so a failed or partial list is recorded in one place:
 * both land in `warnings[]`, and a merged list that may be missing entries is
 * named as a reason to distrust "no successor PR exists" (Phase 3.6).
 */

import type { ClosedPR, MergedPR, PRMonitor } from '../core/index.js';
import type { DailyWarning } from '../formatters/json.js';
import { recordWarning } from './daily-warnings.js';

const TRUNCATED_OPERATION = 'fetch recent PRs (truncated)';

export interface RecentPRLists {
  recentlyClosedPRs: ClosedPR[];
  recentlyMergedPRs: MergedPR[];
  /** `recentlyMergedPRs` is the [] fallback of a failed fetch, not an empty result (Phases 3.6 and 3.7). */
  recentlyMergedFetchFailed: boolean;
  /** Why a merged PR could be missing from `recentlyMergedPRs`; empty when the list is whole. */
  successorGapReasons: string[];
}

/** The `[]` fallback of a failed list fetch, or undefined when it succeeded. */
async function fetchOrWarn<T>(
  fetch: Promise<T[]>,
  operation: string,
  warnings: DailyWarning[],
): Promise<T[] | undefined> {
  try {
    return await fetch;
  } catch (error) {
    recordWarning(warnings, 'fetch', operation, error);
    return undefined;
  }
}

/**
 * Fetch both lists in parallel. Neither failure is fatal: a failed fetch is
 * a warning and an empty list. A partial list (page cap reached, or GitHub
 * flagged the search incomplete) is kept and reported as a warning; for the
 * merged list it is also a successor gap, like a failed fetch.
 */
export async function fetchRecentPRLists(
  prMonitor: Pick<PRMonitor, 'fetchRecentlyClosedPRs' | 'fetchRecentlyMergedPRs'>,
  warnings: DailyWarning[],
): Promise<RecentPRLists> {
  const closedTruncations: string[] = [];
  const mergedTruncations: string[] = [];
  const [closed, merged] = await Promise.all([
    fetchOrWarn(prMonitor.fetchRecentlyClosedPRs(7, closedTruncations), 'fetch recently closed PRs', warnings),
    fetchOrWarn(prMonitor.fetchRecentlyMergedPRs(7, mergedTruncations), 'fetch recently merged PRs', warnings),
  ]);
  for (const message of [closedTruncations, mergedTruncations].flat()) {
    warnings.push({ message, phase: 'fetch', operation: TRUNCATED_OPERATION });
  }

  const successorGapReasons: string[] = [];
  if (merged === undefined) successorGapReasons.push('the recently-merged fetch failed');
  if (mergedTruncations.length > 0) successorGapReasons.push('the recently-merged search was truncated');
  return {
    successorGapReasons,
    recentlyClosedPRs: closed ?? [],
    recentlyMergedPRs: merged ?? [],
    recentlyMergedFetchFailed: merged === undefined,
  };
}
