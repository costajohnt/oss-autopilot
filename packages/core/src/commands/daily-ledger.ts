/**
 * Ledger upkeep the daily run does before it rewrites per-repo counts. Kept
 * out of daily.ts so ledger rules live in one small place.
 */

import type { getStateManager } from '../core/index.js';
import { debug, warn } from '../core/logger.js';
import { findRepoTransfers } from '../core/repo-score-manager.js';

const MODULE = 'daily';

type StateManagerLike = ReturnType<typeof getStateManager>;
type LedgerStateManager = Pick<StateManagerLike, 'getMergedPRs' | 'getClosedPRs' | 'renameRepo' | 'evictClosedPRs'>;

/**
 * Bring the stored merged/closed ledgers in line with what GitHub reports now.
 * Must run before anything reads or writes repoScores in the same batch.
 *
 * 1. Re-key transferred/renamed repos, so the old name isn't zeroed and then
 *    re-bumped from stored PR URLs on the next load (which double counted its
 *    merges in getStats).
 * 2. Drop closed-ledger entries that were reopened (now in `openPRs`) or have
 *    since merged, so the count reconciliation that follows no longer raises
 *    `closedWithoutMergeCount` back to a ledger that still holds them (#1923).
 *    This runs every day, so state inflated before the fix heals on the next
 *    run, as does an entry another machine's older copy brought back.
 *
 * @param searchedPRs - every merged/closed PR the count searches returned
 * @param openPRs - the user's currently open PRs, as just fetched
 */
export function syncLedgersWithGitHub(
  stateManager: LedgerStateManager,
  searchedPRs: ReadonlyArray<{ url: string; title: string }>,
  openPRs: ReadonlyArray<{ url: string }>,
): void {
  const stored = [...stateManager.getMergedPRs(), ...stateManager.getClosedPRs()];
  for (const [from, to] of findRepoTransfers(stored, searchedPRs)) {
    stateManager.renameRepo(from, to);
  }
  stateManager.evictClosedPRs(openPRs.map((pr) => pr.url));
}

/**
 * Zero `closedWithoutMergeCount` for repos the closed-PR count search no
 * longer returns, mirroring the stale reset daily does for merged counts.
 * Without it, a repo whose closed PRs were all reopened or merged leaves the
 * search and keeps its last search-set count for good (#1923). The count
 * reconciliation that follows in the same batch raises each repo back to its
 * closed-ledger count, so only the surplus over the ledger is dropped.
 *
 * Skipped, like the merged reset, when the search returned nothing while state
 * has closed counts (possible transient API failure) or when it hit its
 * pagination cap (an absent repo may still have closed PRs).
 */
export function resetStaleClosedCounts(
  stateManager: Pick<StateManagerLike, 'getState' | 'updateRepoScore'>,
  closedCounts: ReadonlyMap<string, number>,
  wasSearchTruncated: boolean,
): void {
  const withClosed = Object.values(stateManager.getState().repoScores).filter(
    (score) => (score.closedWithoutMergeCount || 0) > 0,
  );
  if (closedCounts.size === 0 && withClosed.length > 0) {
    warn(
      MODULE,
      `Skipping stale closed count reset: API returned 0 closed PR results but state has ${withClosed.length} repo(s) with closed PRs. Possible transient API issue.`,
    );
    return;
  }
  if (wasSearchTruncated) {
    debug(MODULE, 'Skipping stale closed count reset: closed PR search was truncated.');
    return;
  }
  for (const score of withClosed) {
    if (!closedCounts.has(score.repo)) stateManager.updateRepoScore(score.repo, { closedWithoutMergeCount: 0 });
  }
}
