/**
 * Ledger upkeep the daily run does before it rewrites per-repo counts. Kept
 * out of daily.ts so ledger rules live in one small place.
 */

import type { Octokit } from '@octokit/rest';
import { firstMaintainerResponseFromDigest, lastReviewStateFromDigest } from '../core/daily-logic.js';
import { fetchMergedPRsSince, MERGED_LEDGER_TRUNCATED_MESSAGE, type PRsSinceResult } from '../core/github-stats.js';
import type { getStateManager } from '../core/index.js';
import { errorMessage } from '../core/errors.js';
import { debug, warn } from '../core/logger.js';
import type { RepoMetadata } from '../core/pr-monitor.js';
import { findRepoTransfers } from '../core/repo-score-manager.js';
import type { DailyDigest, MergedPR, StoredMergedPR } from '../core/types.js';
import type { DailyWarning } from '../formatters/json.js';
import { recordWarning } from './daily-warnings.js';

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
 * Write the star counts and languages a repository read returned, then drop
 * what is stored about repositories whose PRs are never tracked (#1924):
 * those in `config.untrackedOrgs`, and those this read reported private.
 * The fetches no longer return either kind; this removes what earlier
 * versions stored, and what another machine's older copy brings back.
 *
 * Only an explicit `isPrivate: true` in `repoMetadata` counts as private. A
 * repository missing from the map (404, network error, aborted chunk, or the
 * whole fetch failing) or with no flag is left alone, so deleted, renamed and
 * transferred repositories keep their rows.
 */
export function applyRepoMetadata(
  stateManager: Pick<StateManagerLike, 'updateRepoScore' | 'evictExcludedRepos'>,
  repoMetadata: ReadonlyMap<string, RepoMetadata>,
  warnings: DailyWarning[],
): void {
  let failures = 0;
  const privateRepos: string[] = [];
  for (const [repo, { stars, language, isPrivate }] of repoMetadata) {
    if (isPrivate === true) {
      // Evicted below; writing its stars first would only recreate the entry.
      privateRepos.push(repo);
      continue;
    }
    try {
      stateManager.updateRepoScore(repo, { stargazersCount: stars, language });
    } catch (error) {
      failures++;
      warn(MODULE, `Failed to update metadata for ${repo}: ${errorMessage(error)}`);
    }
  }
  if (failures > 0) {
    warnings.push({
      phase: 'repo-scores',
      operation: 'update repo metadata',
      message: `${failures} of ${repoMetadata.size} metadata update(s) failed. This may indicate corrupted state.`,
    });
    warn(MODULE, `[METADATA_UPDATES_FAILED] ${failures} of ${repoMetadata.size} metadata update(s) failed.`);
  }

  const evicted = stateManager.evictExcludedRepos(privateRepos);
  if (evicted.untrackedOrgRows + evicted.privateRows + evicted.repos > 0) {
    warn(
      MODULE,
      `Removed PRs that are never tracked: ${evicted.untrackedOrgRows} ledger row(s) in untracked organisations, ` +
        `${evicted.privateRows} in private repositories, ${evicted.repos} repo score(s).`,
    );
  }
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

  // A ledger larger than the public total is expected while rows GitHub no
  // longer lists (or private ones not yet evicted) remain; each such row can
  // mask one missing public PR until it is gone.
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
