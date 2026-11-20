/**
 * Ledger upkeep the daily run does before it rewrites per-repo counts. Kept
 * out of daily.ts so ledger rules live in one small place.
 */

import type { Octokit } from '@octokit/rest';
import { firstMaintainerResponseFromDigest, lastReviewStateFromDigest } from '../core/daily-logic.js';
import { fetchMergedPRsSince, MERGED_LEDGER_TRUNCATED_MESSAGE, type PRsSinceResult } from '../core/github-stats.js';
import type { getStateManager } from '../core/index.js';
import { debug, warn } from '../core/logger.js';
import { findRepoTransfers } from '../core/repo-score-manager.js';
import type { DailyDigest, MergedPR, StoredMergedPR } from '../core/types.js';
import type { DailyWarning } from '../formatters/json.js';
import { recordWarning } from './daily-warnings.js';

const MODULE = 'daily';

type StateManagerLike = ReturnType<typeof getStateManager>;
type LedgerStateManager = Pick<
  StateManagerLike,
  'getMergedPRs' | 'getClosedPRs' | 'renameRepo' | 'evictClosedPRs' | 'evictUntrackedOrgPRs'
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
 * 3. Drop merged and closed rows, and the repoScores entries, of repositories
 *    in `config.untrackedOrgs` (#1924). The fetches no longer return them;
 *    this removes what earlier versions stored, and what another machine's
 *    older copy brings back.
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
  const untracked = stateManager.evictUntrackedOrgPRs();
  if (untracked > 0) warn(MODULE, `Removed ${untracked} ledger PR(s) in untracked organisations.`);
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

/** This run's merged-ledger gap fetch; undefined when the fetch failed. */
export type MergedLedgerGap = PRsSinceResult<StoredMergedPR> | undefined;

const GAP_FETCH_OPERATION = 'fetch merged PRs for the ledger';

/**
 * Fetch every merged PR since the ledger's newest entry (#1924). The recent
 * list daily shows covers seven days, so after a longer pause it alone left
 * the merges in between out of the ledger for good. Must run before anything
 * in this run adds to the merged ledger: the watermark is read here.
 *
 * A failed or truncated fetch is recorded in `warnings`, and
 * {@link storeMergedLedger} then stores nothing, so the next run asks for the
 * same range again. Until a run stores them, today's merges are not in the
 * ledger, so the "extract learnings" nudge, which counts ledger rows of
 * recent merges, is also held back for them.
 */
export async function fetchMergedLedgerGap(
  octokit: Octokit,
  stateManager: Pick<StateManagerLike, 'getState' | 'getMergedPRWatermark'>,
  warnings: DailyWarning[],
): Promise<MergedLedgerGap> {
  const { config } = stateManager.getState();
  const watermark = stateManager.getMergedPRWatermark();
  let gap: MergedLedgerGap;
  try {
    gap = await fetchMergedPRsSince(octokit, config, watermark);
  } catch (error) {
    recordWarning(warnings, 'fetch', GAP_FETCH_OPERATION, error);
  }
  if (gap?.truncated) {
    warnings.push({ phase: 'fetch', operation: GAP_FETCH_OPERATION, message: MERGED_LEDGER_TRUNCATED_MESSAGE });
  }
  return gap;
}

/**
 * Add this run's merges to the merged ledger: the gap since its newest entry
 * plus the recent list (which can also fill an older hole inside its window).
 *
 * Nothing is stored unless the gap was fetched whole. The ledger's newest
 * entry is the next run's starting point, so a recent row stored without the
 * rows before it would move that point past merges nobody fetched.
 *
 * Then compares the ledger with GitHub's all-time merged count. A hole older
 * than the newest entry is invisible to the gap fetch; the count is the one
 * signal that shows it, and `ledger-backfill` is what fills it. The count
 * search and the ledger fetch share one scope (externalPRScope: public, not
 * the user's own, no untracked organisations), so the two are comparable;
 * when that scope cannot be put in a query the count is undefined and the
 * check is skipped.
 */
export function storeMergedLedger(
  stateManager: Pick<StateManagerLike, 'addMergedPRs' | 'getMergedPRs'>,
  input: {
    gap: MergedLedgerGap;
    recentlyMergedPRs: ReadonlyArray<MergedPR>;
    /** Previous run's digest: best-effort first-response and review state for the new rows (#1461). */
    previousDigest: DailyDigest | undefined;
    /** GitHub's all-time merged count from the count search; undefined when unknown. */
    allTimeCount: number | undefined;
    warnings: DailyWarning[];
  },
): void {
  const { gap, previousDigest } = input;
  if (!gap || gap.truncated) return;

  const rows = [...input.recentlyMergedPRs, ...gap.prs].map((pr) => ({
    url: pr.url,
    title: pr.title,
    mergedAt: pr.mergedAt,
    openedAt: pr.openedAt,
    firstMaintainerResponseAt: firstMaintainerResponseFromDigest(previousDigest, pr.url),
    issueUrl: pr.issueUrl,
    ...lastReviewStateFromDigest(previousDigest, pr.url),
  }));
  if (rows.length > 0) stateManager.addMergedPRs(rows);

  const stored = stateManager.getMergedPRs().length;
  const missing = (input.allTimeCount ?? 0) - stored;
  if (missing > 0) {
    input.warnings.push({
      phase: 'analytics',
      operation: 'check merged-PR ledger',
      message:
        `The merged-PR ledger holds ${stored} of the ${input.allTimeCount} merged PRs GitHub reports ` +
        `(${missing} missing). Run \`ledger-backfill\` to fetch them.`,
    });
  }
}
