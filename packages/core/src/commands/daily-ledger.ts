/**
 * Ledger upkeep the daily run does before it rewrites per-repo counts. Kept
 * out of daily.ts so ledger rules live in one small place.
 */

import type { getStateManager } from '../core/index.js';
import { findRepoTransfers } from '../core/repo-score-manager.js';

type LedgerStateManager = Pick<
  ReturnType<typeof getStateManager>,
  'getMergedPRs' | 'getClosedPRs' | 'renameRepo' | 'evictClosedPRs'
>;

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
