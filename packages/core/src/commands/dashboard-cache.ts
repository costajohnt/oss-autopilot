/**
 * DashboardCache — the dashboard server's cached-response state.
 *
 * Extracted from dashboard-server.ts (#1457). Owns the cached digest,
 * commented issues, partialFailures, built JSON payload, issue-list mtime
 * and the last background-refresh error, plus buildDashboardJson (the
 * payload builder the cache exists to memoize). The HTTP handlers consume
 * it as a collaborator; nothing here touches req/res.
 */

import * as fs from 'node:fs';
import { getStateManager, applyStatusOverrides, classifyAttentionBucket } from '../core/index.js';
import { errorMessage } from '../core/errors.js';
import { warn } from '../core/logger.js';
import {
  computePRsByRepo,
  computeTopRepos,
  getMonthlyData,
  buildDashboardStats,
  reconcileShelvePartition,
  storedToMergedPRs,
  storedToClosedPRs,
  type DashboardJsonData,
} from './dashboard-data.js';
import { detectIssueList } from './startup.js';
import { parseIssueList, type ParseIssueListOutput } from './parse-list.js';
import {
  isBelowMinStars,
  type DailyDigest,
  type AgentState,
  type CommentedIssue,
  type CommentedIssueWithResponse,
  type MergedPR,
  type ClosedPR,
  type RepoMetadataEntry,
} from '../core/types.js';

const MODULE = 'dashboard-server';

/**
 * Read and parse the vetted issue list file (non-fatal on failure).
 *
 * @param failures - Optional collector (#1448): a read/parse failure pushes a
 *   label so the SPA's partialFailures banner shows the panel is degraded
 *   rather than silently empty. "No list detected" is not a failure and
 *   pushes nothing.
 */
function readVettedIssues(failures?: string[]): ParseIssueListOutput | null {
  try {
    const info = detectIssueList();
    if (!info) return null;
    const content = fs.readFileSync(info.path, 'utf8');
    return parseIssueList(content);
  } catch (error) {
    warn(MODULE, `Failed to read vetted issue list: ${errorMessage(error)}`);
    failures?.push('read vetted issue list');
    return null;
  }
}

/**
 * Get the mtime of the vetted issue list file in ms, or null if unknown.
 * Used to detect external edits and invalidate the cached dashboard payload.
 */
export function getIssueListMtimeMs(): number | null {
  try {
    const info = detectIssueList();
    if (!info) return null;
    return fs.statSync(info.path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Build the JSON payload that the SPA expects from GET /api/data.
 *
 * Exported for unit testing of response-shape concerns that the full
 * handler harness can't reach (it bakes a stale cachedDigest at server
 * start-up, so tests that need a specific digest should call this directly).
 */
export function buildDashboardJson(
  digest: DailyDigest,
  state: Readonly<AgentState>,
  commentedIssues: CommentedIssue[],
  allMergedPRs?: MergedPR[],
  allClosedPRs?: ClosedPR[],
  partialFailures?: string[],
): DashboardJsonData {
  // Collect build-local failures (#1448) alongside the caller-provided ones
  // so degradations detected during THIS build (vetted-list read failure,
  // status-override application failure) reach the SPA's partialFailures
  // banner instead of living only in stderr.
  const buildFailures: string[] = [...(partialFailures ?? [])];
  // Apply status overrides ONCE, before the shelve partition is derived, so
  // the dashboard partitions on the same post-override status the CLI
  // partitions on (#1416). This also covers overrides set AFTER the digest
  // was cached (a dashboard move stores an override; the action path rebuilds
  // from the cached digest). Work on a copy — the caller's cached digest must
  // not accumulate per-request derivations.
  const overriddenDigest: DailyDigest = {
    ...digest,
    openPRs: applyStatusOverrides(digest.openPRs || [], state, buildFailures),
    summary: { ...digest.summary },
  };
  // Re-derive the shelve partition from the CURRENT state before reading it.
  // The POST /api/action path rebuilds with a cached digest whose shelvedPRs
  // predates the shelve/unshelve, so without this the SPA action appears to do
  // nothing until the next full /api/refresh.
  reconcileShelvePartition(overriddenDigest, state);
  const prsByRepo = computePRsByRepo(overriddenDigest, state);
  const topRepos = computeTopRepos(prsByRepo);
  const { monthlyMerged, monthlyOpened, monthlyClosed } = getMonthlyData(state);
  // Derive from state if not provided (e.g. initial load from cached state)
  const mergedPRs = allMergedPRs ?? storedToMergedPRs(getStateManager().getMergedPRs());
  const closedPRs = allClosedPRs ?? storedToClosedPRs(getStateManager().getClosedPRs());
  // Filter out PRs from repos below the minStars threshold
  const minStars = state.config.minStars ?? 50;
  const repoScores = state.repoScores || {};
  const isAboveMinStars = (pr: { repo: string }): boolean =>
    !isBelowMinStars(repoScores[pr.repo]?.stargazersCount, minStars);
  const filteredMergedPRs = mergedPRs.filter(isAboveMinStars);
  const filteredClosedPRs = closedPRs.filter(isAboveMinStars);
  const stats = buildDashboardStats(overriddenDigest, state, filteredMergedPRs.length, filteredClosedPRs.length);
  const dismissedIssues = state.config.dismissedIssues || {};
  const issueResponses = commentedIssues.filter(
    (i): i is CommentedIssueWithResponse => i.status === 'new_response' && !(i.url in dismissedIssues),
  );

  // Build repo metadata map from repoScores — omit repos without stars or language to avoid empty entries
  const repoMetadata: Record<string, RepoMetadataEntry> = {};
  for (const [repo, score] of Object.entries(repoScores)) {
    if (score.stargazersCount !== undefined || score.language !== undefined) {
      repoMetadata[repo] = { stars: score.stargazersCount, language: score.language };
    }
  }

  // A vetted-list read failure reaches the SPA banner via buildFailures
  // instead of leaving the panel silently empty (#1448).
  const vettedIssues = readVettedIssues(buildFailures);
  if (vettedIssues) {
    stats.availableIssues = vettedIssues.availableCount;
  }

  return {
    stats,
    prsByRepo,
    topRepos: topRepos.map(([repo, data]) => ({ repo, ...data })),
    monthlyMerged,
    monthlyOpened,
    monthlyClosed,
    // #1352: stamp the unified attention bucket so the SPA renders the same
    // taxonomy the CLI brief counts (single classifier, no second opinion).
    // Overrides were already applied when overriddenDigest was built — a
    // second application here would be a no-op but obscures the single
    // apply-then-partition ordering (#1416).
    activePRs: (overriddenDigest.openPRs || []).map((pr) => ({
      ...pr,
      attentionBucket: classifyAttentionBucket(pr),
    })),
    // Source of truth is digest.shelvedPRs (union of explicitly-shelved URLs
    // and dormant-non-addressing PRs auto-shelved for display). Returning
    // only state.config.shelvedPRUrls would under-count and desync from
    // stats.shelvedPRs, which is already derived from digest.shelvedPRs. (#981)
    shelvedPRUrls: (overriddenDigest.shelvedPRs || []).map((ref) => ref.url),
    recentlyMergedPRs: overriddenDigest.recentlyMergedPRs || [],
    recentlyClosedPRs: overriddenDigest.recentlyClosedPRs || [],
    autoUnshelvedPRs: overriddenDigest.autoUnshelvedPRs || [],
    commentedIssues,
    issueResponses,
    allMergedPRs: filteredMergedPRs,
    allClosedPRs: filteredClosedPRs,
    repoMetadata,
    vettedIssues,
    // Dedup: the fetch path already applies status overrides into the cached
    // partialFailures, and the rebuild applies them again above — the same
    // failing override must not appear (and be counted) twice (#1448).
    partialFailures: buildFailures.length > 0 ? [...new Set(buildFailures)] : undefined,
  };
}

/** The slice of DashboardFetchResult the cache adopts after a full refresh. */
export interface DashboardFetchSnapshot {
  digest: DailyDigest;
  commentedIssues: CommentedIssue[];
  partialFailures: string[];
}

export class DashboardCache {
  // Start immediately with state.json data (written by the daily check that
  // precedes this server launch). A background GitHub fetch refreshes the
  // cache after the port is bound, so the startup poller sees us in time.
  private cachedDigest: DailyDigest;
  private cachedCommentedIssues: CommentedIssue[] = [];
  // Persist the last-known partialFailures across rebuild requests (#1035).
  // Cleared only when a fresh fetchDashboardData returns zero failures;
  // re-threaded into every buildDashboardJson call so the SPA banner does
  // not disappear when /api/data rebuilds after a state change or after a
  // POST /api/action completes.
  private cachedPartialFailures: string[] | undefined = undefined;
  private cachedJsonData!: DashboardJsonData;
  private cachedIssueListMtimeMs: number | null;
  // Tracks the last background-refresh failure so /api/data can surface
  // staleness to the SPA via the X-Dashboard-Stale header (#1205). Cleared
  // when a refresh succeeds. Without this, token expiry / GitHub outage
  // produces silent stale data hours old with no client-visible signal.
  lastBackgroundRefreshError: string | null = null;

  constructor(
    initialDigest: DailyDigest,
    /** Decorates a partialFailures payload with the gist-sync lifecycle's
     * warnings/banners (GistSyncCoordinator.withPendingGistWarnings) on
     * every rebuild — injected so the two lifecycles stay uncoupled. */
    private readonly mergeWarnings: (failures: string[] | undefined) => string[] | undefined,
  ) {
    this.cachedDigest = initialDigest;
    this.cachedIssueListMtimeMs = getIssueListMtimeMs();
  }

  get digest(): DailyDigest {
    return this.cachedDigest;
  }

  get jsonData(): DashboardJsonData {
    return this.cachedJsonData;
  }

  get issueListMtimeMs(): number | null {
    return this.cachedIssueListMtimeMs;
  }

  /** Adopt a full fetchDashboardData result: replace the digest and
   * commented issues unconditionally, and update the persistent banner
   * signal — clear on a clean refresh, set when one or more sub-fetches
   * degraded. See #1035. */
  adoptFetchResult(result: DashboardFetchSnapshot): void {
    this.cachedDigest = result.digest;
    this.cachedCommentedIssues = result.commentedIssues;
    this.cachedPartialFailures = result.partialFailures.length > 0 ? result.partialFailures : undefined;
  }

  /** A gist pull wholesale-replaces state, and the pulled state.lastDigest
   * may be NEWER than this server's long-lived cachedDigest (another machine
   * ran its daily check). Adopt it when its generatedAt is strictly newer so
   * cross-machine results appear without a manual full refresh (#1446
   * item 6). Unparsable timestamps compare as NaN and never adopt —
   * conservative: keep what we have. */
  adoptNewerPulledDigest(pulled: DailyDigest | undefined): void {
    if (!pulled) return;
    if (Date.parse(pulled.generatedAt) > Date.parse(this.cachedDigest.generatedAt)) {
      this.cachedDigest = pulled;
    }
  }

  /** Rebuild the cached JSON payload from the cached digest + the given
   * state, then stamp the issue-list mtime the payload reflects. Throws
   * when buildDashboardJson does — on failure neither the payload nor the
   * mtime is updated, so the next request retries the rebuild. `issueListMtimeMs`
   * lets GET /api/data stamp the value it compared against (#924); the other
   * call sites re-stat after the build. */
  rebuild(
    state: Readonly<AgentState>,
    allMergedPRs?: MergedPR[],
    allClosedPRs?: ClosedPR[],
    issueListMtimeMs?: number | null,
  ): void {
    this.cachedJsonData = buildDashboardJson(
      this.cachedDigest,
      state,
      this.cachedCommentedIssues,
      allMergedPRs,
      allClosedPRs,
      this.mergeWarnings(this.cachedPartialFailures),
    );
    this.cachedIssueListMtimeMs = issueListMtimeMs !== undefined ? issueListMtimeMs : getIssueListMtimeMs();
  }
}
