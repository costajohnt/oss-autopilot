/**
 * Daily check command
 * Fetches all open PRs fresh from GitHub (v2: no PR-level state tracking),
 * generates a digest, and updates repo scores and analytics in local state.
 *
 * Domain logic lives in src/core/daily-logic.ts; this file is a thin
 * orchestration layer that wires up the phases and handles I/O.
 */

import {
  getStateManager,
  PRMonitor,
  IssueConversationMonitor,
  requireGitHubToken,
  CRITICAL_STATUSES,
  applyStatusOverrides,
  computeRepoSignals,
  groupPRsByRepo,
  assessCapacity,
  collectActionableIssues,
  computeActionMenu,
  toShelvedPRRef,
  formatBriefSummary,
  formatSummary,
  summarizeAttentionBuckets,
  type AttentionSummary,
  type DailyDigest,
  type FetchedPR,
  type ShelvedPRRef,
  type MergedPR,
  type ClosedPR,
  type CommentedIssue,
  type CommentedIssueWithResponse,
  type PRCheckFailure,
  type RepoGroup,
} from '../core/index.js';
import { errorMessage, isRateLimitOrAuthError } from '../core/errors.js';
import { wrapUntrustedContent } from '../core/untrusted-content.js';
import { computeStrategy, shouldComputeStrategy, type StrategyResult } from '../core/strategy.js';
import { warn } from '../core/logger.js';
import { emptyPRCountsResult } from '../core/github-stats.js';
import { updateMonthlyAnalytics } from './dashboard-data.js';
import {
  deduplicateDigest,
  compactActionableIssues,
  compactRepoGroups,
  buildStalenessWarning,
  type DailyOutput,
  type DailyWarning,
  type DailyWarningPhase,
  type CapacityAssessment,
  type ActionableIssue,
  type ActionMenu,
} from '../formatters/json.js';

const MODULE = 'daily';

/**
 * Record a non-fatal failure: push a structured entry into the run's warnings
 * collector AND emit the existing log line. Consumers (dashboard, MCP, tests)
 * inspect `DailyOutput.warnings` so a partial run is visible beyond log noise.
 * See #1042.
 */
function recordWarning(
  warnings: DailyWarning[],
  phase: DailyWarningPhase,
  operation: string,
  err: unknown,
  humanMessage?: string,
): void {
  const message = humanMessage ?? errorMessage(err);
  warnings.push({ phase, operation, message });
  warn(MODULE, `${operation}: ${message}`);
}

/**
 * Variant of `nonFatalCatch` that also records a structured warning. Returns
 * the fallback value on error (same semantics as `nonFatalCatch`) AND pushes
 * an entry into the collector so the failure shows up in `DailyOutput.warnings`.
 */
function nonFatalCatchWithWarning<T>(opts: {
  warnings: DailyWarning[];
  phase: DailyWarningPhase;
  operation: string;
  fallback: T;
}): (err: unknown) => T {
  return (err: unknown): T => {
    recordWarning(opts.warnings, opts.phase, opts.operation, err);
    return opts.fallback;
  };
}

// Re-export domain functions so existing consumers (tests, dashboard, startup)
// can continue importing from './daily.js' without changes.
export {
  applyStatusOverrides,
  computeRepoSignals,
  groupPRsByRepo,
  assessCapacity,
  collectActionableIssues,
  computeActionMenu,
  toShelvedPRRef,
  formatBriefSummary,
  formatSummary,
  printDigest,
  CRITICAL_STATUSES,
} from '../core/index.js';

// buildStarFilter moved to core/daily-logic.ts so the dashboard layer can
// reuse it without crossing the commands → sibling-command boundary
// (#1208 M7). Re-exported here for backward compatibility with anyone
// importing from this module.
import { buildStarFilter, firstMaintainerResponseFromDigest } from '../core/daily-logic.js';
export { buildStarFilter };

/**
 * Internal result of the daily check, using full (non-deduplicated) types.
 * Consumed by printDigest() (text mode) and converted to DailyOutput (JSON mode)
 * via toDailyOutput() which deduplicates PR objects.
 */
export interface DailyCheckResult {
  digest: DailyDigest;
  capacity: CapacityAssessment;
  summary: string;
  briefSummary: string;
  actionableIssues: ActionableIssue[];
  /** Unified attention-bucket counts over active PRs (#1352). */
  attention: AttentionSummary;
  actionMenu: ActionMenu;
  commentedIssues: CommentedIssue[];
  repoGroups: RepoGroup[];
  failures: PRCheckFailure[];
  /** Non-fatal warnings from ancillary pipeline phases — see #1042. */
  warnings: DailyWarning[];
  /**
   * Periodic strategy snapshot (#1270). Set when the cadence trigger
   * fires AND the user has crossed `STRATEGY_MIN_PRS`. The action-menu
   * renderer in `commands/oss.md` reads this; absent or null on runs
   * where the gate stays silent.
   */
  strategySummary?: StrategyResult | null;
}

// ---------------------------------------------------------------------------
// Phase result types
// ---------------------------------------------------------------------------

interface FetchedPRData {
  prs: FetchedPR[];
  failures: PRCheckFailure[];
  mergedCounts: Map<string, { count: number; lastMergedAt: string | null }>;
  closedCounts: Map<string, number>;
  monthlyCounts: Record<string, number>;
  monthlyClosedCounts: Record<string, number>;
  openedFromMerged: Record<string, number>;
  openedFromClosed: Record<string, number>;
  recentlyClosedPRs: ClosedPR[];
  recentlyMergedPRs: MergedPR[];
  commentedIssues: CommentedIssue[];
}

interface PartitionedPRs {
  activePRs: FetchedPR[];
  shelvedPRs: ShelvedPRRef[];
  autoUnshelvedPRs: ShelvedPRRef[];
  digest: DailyDigest;
}

// ---------------------------------------------------------------------------
// Phase functions
// ---------------------------------------------------------------------------

/**
 * Phase 1: Fetch all PR data from GitHub.
 * Retrieves open PRs, merged/closed counts, recently closed/merged PRs, and
 * issue conversation data — all in parallel where possible.
 */
async function fetchPRData(prMonitor: PRMonitor, token: string, warnings: DailyWarning[]): Promise<FetchedPRData> {
  // Fetch all open PRs fresh from GitHub
  const fetchResult = await prMonitor.fetchUserOpenPRs();
  const { prs, failures } = fetchResult;

  // Log any failures (but continue with successful checks)
  if (failures.length > 0) {
    // Per-PR detail lives in `result.failures`; record a rollup warning so
    // consumers that only read `warnings[]` still see the degradation signal.
    warnings.push({
      phase: 'fetch',
      operation: 'fetch open PRs',
      message: `${failures.length} PR fetch(es) failed`,
    });
    warn(MODULE, `${failures.length} PR fetch(es) failed`);
  }

  // Surface search-API truncation warnings (#1057 M25) so daily consumers
  // see the partial-view signal in their `warnings` array rather than only
  // in server logs.
  if (fetchResult.warnings) {
    for (const message of fetchResult.warnings) {
      warnings.push({
        phase: 'fetch',
        operation: 'fetch open PRs (truncated)',
        message,
      });
    }
  }

  // Build star filter from cached repoScores so low-star repos are excluded
  // from merged/closed histograms (#576). Repos with no cached star data pass through.
  const state = getStateManager().getState();
  const starFilter = buildStarFilter(state);

  // Fetch merged PR counts, closed PR counts, recently closed PRs, recently merged PRs, and commented issues in parallel
  // All stats fetches are non-critical (cosmetic/scoring), so isolate their failure
  const issueMonitor = new IssueConversationMonitor(token);
  const [mergedResult, closedResult, recentlyClosedPRs, recentlyMergedPRs, issueConversationResult] = await Promise.all(
    [
      prMonitor.fetchUserMergedPRCounts(starFilter).catch(
        nonFatalCatchWithWarning({
          warnings,
          phase: 'fetch',
          operation: 'fetch merged PR counts',
          fallback: emptyPRCountsResult<{ count: number; lastMergedAt: string }>(),
        }),
      ),
      prMonitor.fetchUserClosedPRCounts(starFilter).catch(
        nonFatalCatchWithWarning({
          warnings,
          phase: 'fetch',
          operation: 'fetch closed PR counts',
          fallback: emptyPRCountsResult<number>(),
        }),
      ),
      prMonitor.fetchRecentlyClosedPRs().catch(
        nonFatalCatchWithWarning({
          warnings,
          phase: 'fetch',
          operation: 'fetch recently closed PRs',
          fallback: [] as ClosedPR[],
        }),
      ),
      prMonitor.fetchRecentlyMergedPRs().catch(
        nonFatalCatchWithWarning({
          warnings,
          phase: 'fetch',
          operation: 'fetch recently merged PRs',
          fallback: [] as MergedPR[],
        }),
      ),
      // Issue conversation fetch has custom messaging based on the error content, so it keeps its bespoke catch.
      issueMonitor.fetchCommentedIssues().catch((error) => {
        if (isRateLimitOrAuthError(error)) throw error;
        const msg = errorMessage(error);
        const needsSetup = msg.includes('No GitHub username configured');
        const humanMessage = needsSetup
          ? `Issue conversation tracking requires setup: ${msg}`
          : `Issue conversation fetch failed: ${msg}`;
        recordWarning(warnings, 'fetch', 'fetch commented issues', error, humanMessage);
        return {
          issues: [] as CommentedIssue[],
          failures: [{ issueUrl: 'N/A', error: `Issue conversation fetch failed: ${msg}` }],
        };
      }),
    ],
  );

  const commentedIssues = issueConversationResult.issues;
  if (issueConversationResult.failures.length > 0) {
    warnings.push({
      phase: 'fetch',
      operation: 'fetch commented issues',
      message: `${issueConversationResult.failures.length} issue conversation check(s) failed`,
    });
    warn(MODULE, `${issueConversationResult.failures.length} issue conversation check(s) failed`);
  }

  const { repos: mergedCounts, monthlyCounts, monthlyOpenedCounts: openedFromMerged } = mergedResult;
  const {
    repos: closedCounts,
    monthlyCounts: monthlyClosedCounts,
    monthlyOpenedCounts: openedFromClosed,
  } = closedResult;

  return {
    prs,
    failures,
    mergedCounts,
    closedCounts,
    monthlyCounts,
    monthlyClosedCounts,
    openedFromMerged,
    openedFromClosed,
    recentlyClosedPRs,
    recentlyMergedPRs,
    commentedIssues,
  };
}

/**
 * Phase 2: Update repo scores in local state.
 * Applies stale repo reset, updates merged/closed counts, computes and stores
 * repo signals from open PR data, refreshes star counts, and syncs trusted projects.
 */
async function updateRepoScores(
  prMonitor: PRMonitor,
  prs: FetchedPR[],
  mergedCounts: Map<string, { count: number; lastMergedAt: string | null }>,
  closedCounts: Map<string, number>,
  warnings: DailyWarning[],
): Promise<void> {
  const stateManager = getStateManager();

  // Batch all synchronous score mutations for a single disk write.
  // Per-repo try-catch: a single corrupted repo should not prevent updates to others.
  // Outer try-catch: save failure should not crash the daily check (in-memory mutations still apply).
  try {
    stateManager.batch(() => {
      // Reset stale repos first (so excluded/removed repos get zeroed).
      // Guard: if the API returned zero results but we have existing repos with merged PRs,
      // skip the reset to avoid wiping scores due to transient API failures.
      const existingReposWithMerges = Object.values(stateManager.getState().repoScores).filter(
        (s) => s.mergedPRCount > 0,
      );
      if (mergedCounts.size === 0 && existingReposWithMerges.length > 0) {
        warn(
          MODULE,
          `Skipping stale repo reset: API returned 0 merged PR results but state has ${existingReposWithMerges.length} repo(s) with merges. Possible API issue.`,
        );
      } else {
        for (const score of Object.values(stateManager.getState().repoScores)) {
          if (!mergedCounts.has(score.repo)) {
            stateManager.updateRepoScore(score.repo, { mergedPRCount: 0 });
          }
        }
      }

      // Update merged/closed counts
      let mergedCountFailures = 0;
      for (const [repo, { count, lastMergedAt }] of mergedCounts) {
        try {
          stateManager.updateRepoScore(repo, { mergedPRCount: count, lastMergedAt: lastMergedAt || undefined });
        } catch (error) {
          mergedCountFailures++;
          warn(MODULE, `Failed to update merged count for ${repo}: ${errorMessage(error)}`);
        }
      }
      if (mergedCountFailures > 0) {
        // Partial or total failure (#1448): the batch outer-catch sees nothing
        // because the batch itself succeeded, but individual mutations inside
        // threw. The affected repos' scores are silently stale — surface it as
        // a warning distinct from the outer catch.
        warnings.push({
          phase: 'repo-scores',
          operation: 'update merged counts',
          message: `${mergedCountFailures} of ${mergedCounts.size} merged count update(s) failed. This may indicate corrupted state.`,
        });
        warn(
          MODULE,
          `[MERGED_COUNT_UPDATES_FAILED] ${mergedCountFailures} of ${mergedCounts.size} merged count update(s) failed.`,
        );
      }

      // Populate closedWithoutMergeCount in repo scores.
      const existingReposWithClosed = Object.values(stateManager.getState().repoScores).filter(
        (s) => (s.closedWithoutMergeCount || 0) > 0,
      );
      if (closedCounts.size === 0 && existingReposWithClosed.length > 0) {
        warn(
          MODULE,
          `API returned 0 closed PR results but state has ${existingReposWithClosed.length} repo(s) with closed PRs. Possible transient API issue.`,
        );
      }
      let closedCountFailures = 0;
      for (const [repo, count] of closedCounts) {
        try {
          stateManager.updateRepoScore(repo, { closedWithoutMergeCount: count });
        } catch (error) {
          closedCountFailures++;
          warn(MODULE, `Failed to update closed count for ${repo}: ${errorMessage(error)}`);
        }
      }
      if (closedCountFailures > 0) {
        warnings.push({
          phase: 'repo-scores',
          operation: 'update closed counts',
          message: `${closedCountFailures} of ${closedCounts.size} closed count update(s) failed. This may indicate corrupted state.`,
        });
        warn(
          MODULE,
          `[CLOSED_COUNT_UPDATES_FAILED] ${closedCountFailures} of ${closedCounts.size} closed count update(s) failed.`,
        );
      }

      // Update repo signals from observed open PR data
      const repoSignals = computeRepoSignals(prs);
      let signalUpdateFailures = 0;
      for (const [repo, signals] of repoSignals) {
        try {
          stateManager.updateRepoScore(repo, { signals });
        } catch (error) {
          signalUpdateFailures++;
          warn(MODULE, `Failed to update signals for ${repo}: ${errorMessage(error)}`);
        }
      }
      if (signalUpdateFailures > 0) {
        warnings.push({
          phase: 'repo-scores',
          operation: 'update repo signals',
          message: `${signalUpdateFailures} of ${repoSignals.size} signal update(s) failed. This may indicate corrupted state.`,
        });
        warn(
          MODULE,
          `[SIGNAL_UPDATES_FAILED] ${signalUpdateFailures} of ${repoSignals.size} signal update(s) failed. This may indicate corrupted state.`,
        );
      }
    });
  } catch (error) {
    recordWarning(warnings, 'repo-scores', 'persist repo score updates', error);
  }

  // Fetch metadata (stars + language) for all scored repos — async, so outside the batch above
  const allRepos = Object.keys(stateManager.getState().repoScores);
  let repoMetadata: Map<string, { stars: number; language: string | null }>;
  try {
    repoMetadata = await prMonitor.fetchRepoMetadata(allRepos);
  } catch (error) {
    if (isRateLimitOrAuthError(error)) throw error;
    recordWarning(warnings, 'repo-scores', 'fetch repo metadata', error);
    warn(
      MODULE,
      'Repos without cached metadata will be excluded from dashboard stats and metadata badges until fetched on the next successful run.',
    );
    repoMetadata = new Map();
  }
  // Batch metadata + trust sync mutations for a single disk write
  try {
    stateManager.batch(() => {
      let metadataUpdateFailures = 0;
      for (const [repo, { stars, language }] of repoMetadata) {
        try {
          stateManager.updateRepoScore(repo, { stargazersCount: stars, language });
        } catch (error) {
          metadataUpdateFailures++;
          warn(MODULE, `Failed to update metadata for ${repo}: ${errorMessage(error)}`);
        }
      }
      if (metadataUpdateFailures > 0) {
        warnings.push({
          phase: 'repo-scores',
          operation: 'update repo metadata',
          message: `${metadataUpdateFailures} of ${repoMetadata.size} metadata update(s) failed. This may indicate corrupted state.`,
        });
        warn(
          MODULE,
          `[METADATA_UPDATES_FAILED] ${metadataUpdateFailures} of ${repoMetadata.size} metadata update(s) failed.`,
        );
      }

      // Auto-sync trustedProjects from repos with merged PRs
      let trustSyncFailures = 0;
      for (const [repo] of mergedCounts) {
        try {
          stateManager.addTrustedProject(repo);
        } catch (error) {
          trustSyncFailures++;
          warn(MODULE, `Failed to sync trusted project ${repo}: ${errorMessage(error)}`);
        }
      }
      if (trustSyncFailures > 0) {
        warnings.push({
          phase: 'repo-scores',
          operation: 'sync trusted projects',
          message: `${trustSyncFailures} of ${mergedCounts.size} trusted project sync(s) failed. This may indicate corrupted state.`,
        });
        warn(
          MODULE,
          `[TRUST_SYNCS_FAILED] ${trustSyncFailures} of ${mergedCounts.size} trusted project sync(s) failed. This may indicate corrupted state.`,
        );
      }
    });
  } catch (error) {
    recordWarning(warnings, 'repo-scores', 'persist metadata/trust updates', error);
  }
}

/**
 * Phase 4: Partition PRs into active vs shelved buckets.
 * Auto-unshelves PRs where maintainers have engaged, generates the digest,
 * and persists state.
 */
function partitionPRs(
  prMonitor: PRMonitor,
  prs: FetchedPR[],
  recentlyClosedPRs: ClosedPR[],
  recentlyMergedPRs: MergedPR[],
  warnings: DailyWarning[],
): PartitionedPRs {
  const stateManager = getStateManager();

  // Apply dashboard/CLI status overrides before partitioning.
  // This ensures PRs reclassified in the dashboard (e.g., "Need Attention" → "Waiting")
  // are respected by the CLI pipeline.
  // Override-application failures (#1448) mean a PR silently shows its
  // un-overridden status — record each into the run's warnings[].
  const overrideFailures: string[] = [];
  const overriddenPRs = applyStatusOverrides(prs, stateManager.getState(), overrideFailures);
  for (const failure of overrideFailures) {
    recordWarning(warnings, 'partition', 'apply status override', null, failure);
  }

  // Partition PRs into active vs shelved, auto-unshelving when maintainers engage
  const shelvedPRs: ShelvedPRRef[] = [];
  const autoUnshelvedPRs: ShelvedPRRef[] = [];
  const activePRs: FetchedPR[] = [];

  // Wrap mutations in batch: unshelvePR calls + setLastDigest produce a single save.
  // Outer try-catch: save failure should not crash the daily check (in-memory mutations still apply).
  let digest: DailyDigest | undefined;
  try {
    stateManager.batch(() => {
      for (const pr of overriddenPRs) {
        if (stateManager.isPRShelved(pr.url)) {
          if (CRITICAL_STATUSES.has(pr.status)) {
            stateManager.unshelvePR(pr.url);
            autoUnshelvedPRs.push(toShelvedPRRef(pr));
            activePRs.push(pr);
          } else {
            shelvedPRs.push(toShelvedPRRef(pr));
          }
        } else if (pr.stalenessTier === 'dormant' && !CRITICAL_STATUSES.has(pr.status)) {
          // Dormant PRs are auto-shelved unless they need addressing
          // (e.g. maintainer commented on a stale PR — it should resurface)
          shelvedPRs.push(toShelvedPRRef(pr));
        } else {
          activePRs.push(pr);
        }
      }

      // Generate the in-memory digest from override-applied PRs so daily's own
      // status categories (needsAddressing/waiting partitions, counts, JSON
      // output) reflect dashboard/CLI reclassifications.
      // Note: digest.openPRs contains ALL fetched PRs (including shelved).
      // We override summary fields below to reflect active-only counts.
      digest = prMonitor.generateDigest(overriddenPRs, recentlyClosedPRs, recentlyMergedPRs);

      // Attach shelve info to digest
      digest.shelvedPRs = shelvedPRs;
      digest.autoUnshelvedPRs = autoUnshelvedPRs;
      digest.summary.totalActivePRs = activePRs.length;

      // The PERSISTED digest keeps RAW statuses (#1445): it seeds the
      // dashboard server's cached rebuild source, and applyStatusOverrides
      // can only apply overrides, never un-apply baked ones — persisting the
      // override-applied digest would make CLEARING an override (move
      // target=auto) a silent no-op whenever the dashboard's background
      // refresh fails. Mirrors the raw-digest contract in dashboard-data.ts
      // (which also attaches override-derived shelve info to a raw digest).
      const rawDigest = prMonitor.generateDigest(prs, recentlyClosedPRs, recentlyMergedPRs);
      rawDigest.shelvedPRs = shelvedPRs;
      rawDigest.autoUnshelvedPRs = autoUnshelvedPRs;
      rawDigest.summary.totalActivePRs = activePRs.length;
      stateManager.setLastDigest(rawDigest);
    });
  } catch (error) {
    recordWarning(warnings, 'partition', 'persist partition state', error);
  }

  // If digest generation threw inside the batch, fall back to the persisted
  // digest (mirrors the previous read-back-from-state behavior). The
  // recordWarning call above already flagged the run as degraded.
  if (digest === undefined) {
    const persisted = stateManager.getState().lastDigest;
    if (!persisted) {
      // First-ever run with no persisted digest to fall back to: fail loudly
      // with the recorded reason instead of letting Phase 5 die on an
      // unrelated TypeError at `digest.summary` (#1456). Fabricating an
      // empty digest here would silently report "no PRs" — dishonest.
      const recorded = warnings.find((w) => w.phase === 'partition');
      throw new Error(
        `Daily digest generation failed and no previously persisted digest exists to fall back to` +
          (recorded ? `: ${recorded.message}` : '.'),
      );
    }
    return { activePRs, shelvedPRs, autoUnshelvedPRs, digest: persisted };
  }
  return { activePRs, shelvedPRs, autoUnshelvedPRs, digest };
}

/**
 * Phase 5: Build the structured output for the daily command.
 * Assesses capacity, filters dismissed issues, computes actionable items,
 * and assembles the action menu.
 */
function generateDigestOutput(
  digest: DailyDigest,
  activePRs: FetchedPR[],
  shelvedPRs: ShelvedPRRef[],
  commentedIssues: CommentedIssue[],
  failures: PRCheckFailure[],
  warnings: DailyWarning[],
  previousLastDigestAt?: string,
): DailyCheckResult {
  const stateManager = getStateManager();

  // Assess capacity from active PRs only (shelved PRs excluded)
  const capacity = assessCapacity(activePRs, stateManager.getState().config.maxActivePRs, shelvedPRs.length);

  // Filter dismissed issues: suppress if dismissed after last response, resurface + auto-undismiss if new activity.
  // Batch: undismissIssue calls trigger autoSave — batch produces a single disk write for all auto-undismisses.
  let filteredCommentedIssues: typeof commentedIssues = [];
  try {
    stateManager.batch(() => {
      filteredCommentedIssues = commentedIssues.filter((issue) => {
        const dismissedAt = stateManager.getIssueDismissedAt(issue.url);
        if (!dismissedAt) return true; // Not dismissed — include
        if (issue.status === 'new_response') {
          const responseTime = new Date(issue.lastResponseAt).getTime();
          const dismissTime = new Date(dismissedAt).getTime();
          if (isNaN(responseTime) || isNaN(dismissTime)) {
            // Invalid timestamp — fail open (include issue to be safe) without
            // permanently removing dismiss record (may be a transient data issue)
            warn(MODULE, `Invalid timestamp in dismiss check for ${issue.url}, including issue`);
            return true;
          }
          if (responseTime > dismissTime) {
            // New activity after dismiss — auto-undismiss and resurface
            warn(
              MODULE,
              `Auto-undismissing issue ${issue.url}: new response at ${issue.lastResponseAt} after dismiss at ${dismissedAt}`,
            );
            try {
              stateManager.undismissIssue(issue.url);
            } catch (error) {
              recordWarning(warnings, 'dismiss-filter', `persist auto-undismiss for ${issue.url}`, error);
            }
            return true;
          }
        }
        // Still dismissed (last response is at or before dismiss timestamp)
        return false;
      });
    });
  } catch (error) {
    recordWarning(warnings, 'dismiss-filter', 'persist auto-undismiss state', error);
  }

  const issueResponses = filteredCommentedIssues.filter(
    (i): i is CommentedIssueWithResponse => i.status === 'new_response',
  );
  const summary = formatSummary(digest, capacity, issueResponses);

  // Auto-undismiss mutations are auto-saved by undismissIssue()
  const actionableIssues = collectActionableIssues(activePRs, previousLastDigestAt);
  digest.summary.totalNeedingAttention = actionableIssues.length;
  // #1352: one classifier for all attention surfaces — the dashboard stamps
  // the same buckets per-PR, so the headline counts cannot diverge.
  const attention = summarizeAttentionBuckets(activePRs);
  const briefSummary = formatBriefSummary(digest, actionableIssues.length, issueResponses.length, attention);
  const actionMenu = computeActionMenu(actionableIssues, capacity, filteredCommentedIssues, attention);
  const repoGroups = groupPRsByRepo(activePRs);

  // Periodic strategy snapshot (#1270 Step 2). Cadence-gated to fire every
  // 30 days OR after 5+ PRs merge since the last snapshot, whichever comes
  // first. Below STRATEGY_MIN_PRS the gate stays silent. Compute failures
  // are non-fatal — the daily run continues and the snapshot is omitted.
  let strategySummary: StrategyResult | null | undefined;
  try {
    const state = stateManager.getState();
    const nowIso = new Date().toISOString();
    if (shouldComputeStrategy(state, nowIso)) {
      strategySummary = computeStrategy(state);
      if (strategySummary) {
        stateManager.setLastStrategyAt(nowIso);
      }
    }
  } catch (error) {
    recordWarning(warnings, 'analytics', 'compute strategy snapshot', error);
  }

  return {
    digest,
    capacity,
    summary,
    briefSummary,
    actionableIssues,
    attention,
    actionMenu,
    commentedIssues: filteredCommentedIssues,
    repoGroups,
    failures,
    warnings,
    strategySummary,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fence the GitHub-sourced comment excerpts in a CommentedIssue for
 * agent-facing JSON (#1372). This happens HERE — not in
 * `issue-conversation.ts` — because the producer's objects also feed the
 * dashboard SPA and the CLI text renderers (`daily-render.ts`), which must
 * not display raw fence tags, and the producer's internal classification
 * (acknowledgment / @mention matching) string-matches on raw bodies.
 *
 * `userLastCommentBody` is fenced too: it is the user's own comment, but
 * repo maintainers can edit any comment in their repos, so it is still
 * GitHub-controlled text by the time we re-fetch it.
 */
function fenceCommentedIssue(issue: CommentedIssue): CommentedIssue {
  const label = `${issue.repo}#${issue.number}`;
  if (issue.status === 'new_response') {
    return {
      ...issue,
      userLastCommentBody: wrapUntrustedContent(issue.userLastCommentBody, label, { source: 'issue-comment' }),
      lastResponseBody: wrapUntrustedContent(issue.lastResponseBody, label, {
        author: issue.lastResponseAuthor,
        source: 'issue-comment',
      }),
    };
  }
  return {
    ...issue,
    userLastCommentBody: wrapUntrustedContent(issue.userLastCommentBody, label, { source: 'issue-comment' }),
  };
}

/**
 * Convert a full DailyCheckResult to the compact DailyOutput for JSON serialization (#287).
 * Deduplicates PR objects: category arrays become PR URL references,
 * full objects live only in digest.openPRs. Reduces JSON payload size ~60-70%.
 *
 * Exported for the `daily --json` contract test (#986), which pins this
 * shape transformation without spinning up the full fetch pipeline.
 */
export function toDailyOutput(result: DailyCheckResult): DailyOutput {
  return {
    digest: deduplicateDigest(result.digest),
    capacity: result.capacity,
    summary: result.summary,
    briefSummary: result.briefSummary,
    actionableIssues: compactActionableIssues(result.actionableIssues),
    attention: result.attention,
    actionMenu: result.actionMenu,
    commentedIssues: result.commentedIssues.map(fenceCommentedIssue),
    repoGroups: compactRepoGroups(result.repoGroups),
    failures: result.failures,
    warnings: result.warnings,
    strategySummary: result.strategySummary,
  };
}

/**
 * Core daily check logic, extracted for reuse by the startup command.
 * Fetches all open PRs, updates state, and returns structured output.
 *
 * Returns a deduplicated DailyOutput where category arrays contain PR URLs
 * instead of full objects (#287). Full PR objects are in digest.openPRs only.
 *
 * Orchestrates five named phases:
 *   1. fetchPRData        — fetch open PRs, merged/closed counts, issues
 *   2. updateRepoScores   — update signals, star counts, trust in state
 *   3. updateAnalytics    — store monthly chart data
 *   4. partitionPRs       — shelve/unshelve, generate digest
 *   5. generateDigestOutput — capacity, dismiss filter, action menu assembly
 *
 * @param token - GitHub personal access token
 * @returns Deduplicated daily output
 * @throws {ConfigurationError} If no GitHub username is configured in state
 */
export async function executeDailyCheck(token: string): Promise<DailyOutput> {
  const result = await executeDailyCheckInternal(token);
  return toDailyOutput(result);
}

/**
 * Internal daily check returning full (non-deduplicated) result.
 * Used by runDaily for text-mode output where full PR objects are needed.
 */
async function executeDailyCheckInternal(token: string): Promise<DailyCheckResult> {
  const prMonitor = new PRMonitor(token);
  // One collector shared by every phase — threaded through explicitly so the
  // callgraph documents which phases can produce non-fatal warnings. See #1042.
  const warnings: DailyWarning[] = [];

  // Surface gist-mode degradation in the machine-readable envelope (#1431):
  // a process whose config says `persistence: gist` but whose manager is
  // local-only (transient init fallback, or a localOnly entry point that
  // never bootstrapped) writes mutations that will not sync. Previously the
  // only signal was a stderr warn, invisible to --json consumers.
  const smForGistCheck = getStateManager();
  if (
    smForGistCheck.getState().config.persistence === 'gist' &&
    (!smForGistCheck.isGistMode() || smForGistCheck.isGistDegraded())
  ) {
    recordWarning(
      warnings,
      'gist-init',
      'Gist persistence degraded',
      new Error(
        'configured for Gist but running local-only in this process; mutations will not sync until Gist init succeeds',
      ),
    );
  }

  // Surface Gist staleness up-front so consumers see it even if Phase 1 fails (#1193).
  const staleness = getStateManager().getStateStaleness();
  if (staleness) {
    warnings.push(buildStalenessWarning(staleness));
  }

  // Surface a state-load recovery (corrupt state.json restored from backup or
  // replaced with fresh state) so it's machine-visible, not just stderr (#1371).
  const loadRecovery = getStateManager().getLoadRecovery();
  if (loadRecovery) {
    recordWarning(
      warnings,
      'state-load',
      'State file recovery',
      new Error(
        `${loadRecovery.reason}; recovered from ${loadRecovery.source}` +
          (loadRecovery.rejectedPath ? `; rejected file preserved at ${loadRecovery.rejectedPath}` : ''),
      ),
    );
  }

  // Phase 1: Fetch all PR data from GitHub
  const {
    prs,
    failures,
    mergedCounts,
    closedCounts,
    monthlyCounts,
    monthlyClosedCounts,
    openedFromMerged,
    openedFromClosed,
    recentlyClosedPRs,
    recentlyMergedPRs,
    commentedIssues,
  } = await fetchPRData(prMonitor, token, warnings);

  // Phase 2: Update repo scores (signals, star counts, trust sync)
  await updateRepoScores(prMonitor, prs, mergedCounts, closedCounts, warnings);

  // Phase 3: Persist monthly analytics and store merged/closed PR history.
  // try-catch: analytics are supplementary — save failure should not crash the daily check.
  try {
    // Previous run's digest — read BEFORE Phase 4 overwrites it. If a
    // just-merged/closed PR was open during a prior enriched run, its
    // openPRs entry carries firstMaintainerResponseAt for the ledger (#1461).
    const previousDigest = getStateManager().getState().lastDigest;
    getStateManager().batch(() => {
      const analyticsFailures = updateMonthlyAnalytics(
        prs,
        monthlyCounts,
        monthlyClosedCounts,
        openedFromMerged,
        openedFromClosed,
      );
      // Per-metric setter failures are caught inside updateMonthlyAnalytics
      // (one bad metric must not sink the others); surface each in the run's
      // warnings[] instead of dropping the returned labels (#1447).
      for (const failure of analyticsFailures) {
        recordWarning(warnings, 'analytics', failure, null, 'persist failed');
      }

      // Store recently merged/closed PRs in the persistent arrays.
      // This ensures the mergedPRs/closedPRs ledger is populated even when
      // the dashboard is never opened (which has its own fetch path).
      // addMergedPRs/addClosedPRs deduplicate by URL (re-seen entries upgrade
      // missing ledger fields in place), so overlaps are safe. openedAt comes
      // free from the search result; firstMaintainerResponseAt is best-effort
      // from the previous run's enriched digest — zero new API calls (#1461).
      if (recentlyMergedPRs.length > 0) {
        getStateManager().addMergedPRs(
          recentlyMergedPRs.map((pr) => ({
            url: pr.url,
            title: pr.title,
            mergedAt: pr.mergedAt,
            openedAt: pr.openedAt,
            firstMaintainerResponseAt: firstMaintainerResponseFromDigest(previousDigest, pr.url),
          })),
        );
      }
      if (recentlyClosedPRs.length > 0) {
        getStateManager().addClosedPRs(
          recentlyClosedPRs.map((pr) => ({
            url: pr.url,
            title: pr.title,
            closedAt: pr.closedAt,
            openedAt: pr.openedAt,
            firstMaintainerResponseAt: firstMaintainerResponseFromDigest(previousDigest, pr.url),
          })),
        );
      }
    });
  } catch (error) {
    recordWarning(warnings, 'analytics', 'persist monthly analytics', error);
  }

  // No scout pass here (#1458): the former Phase 3.5 fed recentlyMerged/ClosedPRs
  // to an oss-scout instance and called scout.checkpoint(). Both halves were dead:
  // scout's recordMergedPR/recordClosedPR deduplicate by URL against the ledger
  // that Phase 3 just wrote (buildScoutState maps state.mergedPRs/closedPRs into
  // the scout state), so they returned before touching any repo score; and under
  // persistence:'provided' checkpoint() has no gist store and no local store, so
  // it persisted nothing. Cross-tool sharing happens through buildScoutState
  // reading AgentState, not through pushing events at scout.

  // Capture lastDigestAt BEFORE Phase 4 overwrites it with the current run's timestamp.
  // Used by collectActionableIssues to determine which PRs are "new" (created since last digest).
  const previousLastDigestAt = getStateManager().getState().lastDigestAt;

  // Phase 4: Partition PRs, generate and save digest
  const { activePRs, shelvedPRs, digest } = partitionPRs(
    prMonitor,
    prs,
    recentlyClosedPRs,
    recentlyMergedPRs,
    warnings,
  );

  // Phase 5: Build structured output (capacity, dismiss filter, action menu)
  const result = generateDigestOutput(
    digest,
    activePRs,
    shelvedPRs,
    commentedIssues,
    failures,
    warnings,
    previousLastDigestAt,
  );

  // Checkpoint: push state to Gist if in Gist mode.
  // If getStateManagerAsync was not called before this command ran,
  // isGistMode() will be false and checkpoint is correctly skipped.
  // `warnings` is the same array referenced by `result`, so warnings
  // recorded here still reach the structured output.
  try {
    const sm = getStateManager();
    if (sm.isGistMode()) {
      // checkpoint() resolves false (no throw) when the push failed after
      // its retry — previously discarded, reporting clean success while
      // cross-machine state silently drifted (#1370).
      const pushed = await sm.checkpoint();
      if (!pushed) {
        recordWarning(
          warnings,
          'gist-checkpoint',
          'Gist checkpoint',
          new Error('push failed after retry; state not synced to Gist this run'),
        );
      }
    }
  } catch (err) {
    recordWarning(warnings, 'gist-checkpoint', 'Gist checkpoint', err);
  }

  return result;
}

/**
 * Run the daily PR check and return a deduplicated digest.
 *
 * Fetches all open PRs from GitHub, computes status for each,
 * updates repo scores, and assembles the action menu.
 *
 * @returns Deduplicated daily output with PR digest, capacity, and action menu
 * @throws {ConfigurationError} If no GitHub token is available
 *
 * @example
 * ```typescript
 * import { runDaily } from '@oss-autopilot/core/commands';
 *
 * const output = await runDaily();
 * console.log(output.briefSummary);
 * console.log(`${output.actionableIssues.length} issues need attention`);
 * ```
 */
export async function runDaily(): Promise<DailyOutput> {
  // Token is guaranteed by the preAction hook in cli.ts for non-LOCAL_ONLY_COMMANDS.
  const token = requireGitHubToken();
  return executeDailyCheck(token);
}

/**
 * Run the daily check and return the full (non-deduplicated) result.
 * Used by CLI text mode where printDigest() needs full PR objects.
 *
 * @returns Full daily check result with non-deduplicated PR objects
 * @throws {ConfigurationError} If no GitHub token is available
 */
export async function runDailyForDisplay(): Promise<DailyCheckResult> {
  const token = requireGitHubToken();
  return executeDailyCheckInternal(token);
}
