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
  type DailyDigest,
  type FetchedPR,
  type ShelvedPRRef,
  type MergedPR,
  type ClosedPR,
  type CommentedIssue,
  type CommentedIssueWithResponse,
  type PRCheckFailure,
  type RepoGroup,
  type AgentState,
  type StarFilter,
} from '../core/index.js';
import { errorMessage, isRateLimitOrAuthError } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { emptyPRCountsResult } from '../core/github-stats.js';
import { updateMonthlyAnalytics } from './dashboard-data.js';
import {
  deduplicateDigest,
  compactActionableIssues,
  compactRepoGroups,
  type DailyOutput,
  type CapacityAssessment,
  type ActionableIssue,
  type ActionMenu,
} from '../formatters/json.js';

const MODULE = 'daily';

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

/**
 * Build a star filter from state for use in fetchUserPRCounts.
 * Returns undefined if no star data is available (first run).
 *
 * @param state - Current agent state (read-only)
 * @returns Star filter with minimum threshold and known counts, or undefined on first run
 */
export function buildStarFilter(state: Readonly<AgentState>): StarFilter | undefined {
  const minStars = state.config.minStars ?? 50;
  const knownStarCounts = new Map<string, number>();
  for (const [repo, score] of Object.entries(state.repoScores)) {
    if (score.stargazersCount !== undefined) {
      knownStarCounts.set(repo, score.stargazersCount);
    }
  }
  // Only filter if we have some star data to work with
  if (knownStarCounts.size === 0) return undefined;
  return { minStars, knownStarCounts };
}

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
  actionMenu: ActionMenu;
  commentedIssues: CommentedIssue[];
  repoGroups: RepoGroup[];
  failures: PRCheckFailure[];
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
async function fetchPRData(prMonitor: PRMonitor, token: string): Promise<FetchedPRData> {
  // Fetch all open PRs fresh from GitHub
  const { prs, failures } = await prMonitor.fetchUserOpenPRs();

  // Log any failures (but continue with successful checks)
  if (failures.length > 0) {
    warn(MODULE, `${failures.length} PR fetch(es) failed`);
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
    ],
  );

  const commentedIssues = issueConversationResult.issues;
  if (issueConversationResult.failures.length > 0) {
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
      if (mergedCountFailures === mergedCounts.size && mergedCounts.size > 0) {
        warn(MODULE, `[ALL_MERGED_COUNT_UPDATES_FAILED] All ${mergedCounts.size} merged count update(s) failed.`);
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
      if (closedCountFailures === closedCounts.size && closedCounts.size > 0) {
        warn(MODULE, `[ALL_CLOSED_COUNT_UPDATES_FAILED] All ${closedCounts.size} closed count update(s) failed.`);
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
      if (signalUpdateFailures === repoSignals.size && repoSignals.size > 0) {
        warn(
          MODULE,
          `[ALL_SIGNAL_UPDATES_FAILED] All ${repoSignals.size} signal update(s) failed. This may indicate corrupted state.`,
        );
      }
    });
  } catch (error) {
    warn(MODULE, `Failed to persist repo score updates: ${errorMessage(error)}`);
  }

  // Fetch metadata (stars + language) for all scored repos — async, so outside the batch above
  const allRepos = Object.keys(stateManager.getState().repoScores);
  let repoMetadata: Map<string, { stars: number; language: string | null }>;
  try {
    repoMetadata = await prMonitor.fetchRepoMetadata(allRepos);
  } catch (error) {
    if (isRateLimitOrAuthError(error)) throw error;
    warn(MODULE, `Failed to fetch repo metadata: ${errorMessage(error)}`);
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
      if (metadataUpdateFailures === repoMetadata.size && repoMetadata.size > 0) {
        warn(MODULE, `[ALL_METADATA_UPDATES_FAILED] All ${repoMetadata.size} metadata update(s) failed.`);
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
      if (trustSyncFailures === mergedCounts.size && mergedCounts.size > 0) {
        warn(
          MODULE,
          `[ALL_TRUST_SYNCS_FAILED] All ${mergedCounts.size} trusted project sync(s) failed. This may indicate corrupted state.`,
        );
      }
    });
  } catch (error) {
    warn(MODULE, `Failed to persist metadata/trust updates: ${errorMessage(error)}`);
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
): PartitionedPRs {
  const stateManager = getStateManager();

  // Apply dashboard/CLI status overrides before partitioning.
  // This ensures PRs reclassified in the dashboard (e.g., "Need Attention" → "Waiting")
  // are respected by the CLI pipeline.
  const overriddenPRs = applyStatusOverrides(prs, stateManager.getState());

  // Partition PRs into active vs shelved, auto-unshelving when maintainers engage
  const shelvedPRs: ShelvedPRRef[] = [];
  const autoUnshelvedPRs: ShelvedPRRef[] = [];
  const activePRs: FetchedPR[] = [];

  // Wrap mutations in batch: unshelvePR calls + setLastDigest produce a single save.
  // Outer try-catch: save failure should not crash the daily check (in-memory mutations still apply).
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

      // Generate digest from override-applied PRs so status categories are correct.
      // Note: digest.openPRs contains ALL fetched PRs (including shelved).
      // We override summary fields below to reflect active-only counts.
      const digest = prMonitor.generateDigest(overriddenPRs, recentlyClosedPRs, recentlyMergedPRs);

      // Attach shelve info to digest
      digest.shelvedPRs = shelvedPRs;
      digest.autoUnshelvedPRs = autoUnshelvedPRs;
      digest.summary.totalActivePRs = activePRs.length;

      // Store digest in state so dashboard can render it
      stateManager.setLastDigest(digest);
    });
  } catch (error) {
    warn(MODULE, `Failed to persist partition state: ${errorMessage(error)}`);
  }

  // Digest was created inside batch — reconstruct from state
  const digest = stateManager.getState().lastDigest!;

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
              warn(MODULE, `Failed to persist auto-undismiss for ${issue.url}: ${errorMessage(error)}`);
            }
            return true;
          }
        }
        // Still dismissed (last response is at or before dismiss timestamp)
        return false;
      });
    });
  } catch (error) {
    warn(MODULE, `Failed to persist auto-undismiss state: ${errorMessage(error)}`);
  }

  const issueResponses = filteredCommentedIssues.filter(
    (i): i is CommentedIssueWithResponse => i.status === 'new_response',
  );
  const summary = formatSummary(digest, capacity, issueResponses);

  // Auto-undismiss mutations are auto-saved by undismissIssue()
  const actionableIssues = collectActionableIssues(activePRs, previousLastDigestAt);
  digest.summary.totalNeedingAttention = actionableIssues.length;
  const briefSummary = formatBriefSummary(digest, actionableIssues.length, issueResponses.length);
  const actionMenu = computeActionMenu(actionableIssues, capacity, filteredCommentedIssues);
  const repoGroups = groupPRsByRepo(activePRs);

  return {
    digest,
    capacity,
    summary,
    briefSummary,
    actionableIssues,
    actionMenu,
    commentedIssues: filteredCommentedIssues,
    repoGroups,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a full DailyCheckResult to the compact DailyOutput for JSON serialization (#287).
 * Deduplicates PR objects: category arrays become PR URL references,
 * full objects live only in digest.openPRs. Reduces JSON payload size ~60-70%.
 */
function toDailyOutput(result: DailyCheckResult): DailyOutput {
  return {
    digest: deduplicateDigest(result.digest),
    capacity: result.capacity,
    summary: result.summary,
    briefSummary: result.briefSummary,
    actionableIssues: compactActionableIssues(result.actionableIssues),
    actionMenu: result.actionMenu,
    commentedIssues: result.commentedIssues,
    repoGroups: compactRepoGroups(result.repoGroups),
    failures: result.failures,
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
  } = await fetchPRData(prMonitor, token);

  // Phase 2: Update repo scores (signals, star counts, trust sync)
  await updateRepoScores(prMonitor, prs, mergedCounts, closedCounts);

  // Phase 3: Persist monthly analytics and store merged/closed PR history.
  // try-catch: analytics are supplementary — save failure should not crash the daily check.
  try {
    getStateManager().batch(() => {
      updateMonthlyAnalytics(prs, monthlyCounts, monthlyClosedCounts, openedFromMerged, openedFromClosed);

      // Store recently merged/closed PRs in the persistent arrays.
      // This ensures the mergedPRs/closedPRs ledger is populated even when
      // the dashboard is never opened (which has its own fetch path).
      // addMergedPRs/addClosedPRs deduplicate by URL, so overlaps are safe.
      if (recentlyMergedPRs.length > 0) {
        getStateManager().addMergedPRs(
          recentlyMergedPRs.map((pr) => ({ url: pr.url, title: pr.title, mergedAt: pr.mergedAt })),
        );
      }
      if (recentlyClosedPRs.length > 0) {
        getStateManager().addClosedPRs(
          recentlyClosedPRs.map((pr) => ({ url: pr.url, title: pr.title, closedAt: pr.closedAt })),
        );
      }
    });
  } catch (error) {
    warn(MODULE, `Failed to persist monthly analytics: ${errorMessage(error)}`);
  }

  // Capture lastDigestAt BEFORE Phase 4 overwrites it with the current run's timestamp.
  // Used by collectActionableIssues to determine which PRs are "new" (created since last digest).
  const previousLastDigestAt = getStateManager().getState().lastDigestAt;

  // Phase 4: Partition PRs, generate and save digest
  const { activePRs, shelvedPRs, digest } = partitionPRs(prMonitor, prs, recentlyClosedPRs, recentlyMergedPRs);

  // Phase 5: Build structured output (capacity, dismiss filter, action menu)
  const result = generateDigestOutput(digest, activePRs, shelvedPRs, commentedIssues, failures, previousLastDigestAt);

  // Checkpoint: push state to Gist if in Gist mode
  try {
    await getStateManager().checkpoint();
  } catch (err) {
    warn(MODULE, `Gist checkpoint failed: ${errorMessage(err)}`);
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
