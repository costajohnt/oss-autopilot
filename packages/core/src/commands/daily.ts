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
} from '../core/index.js';
import { errorMessage } from '../core/errors.js';
import { emptyPRCountsResult } from '../core/github-stats.js';
import {
  deduplicateDigest,
  compactActionableIssues,
  compactRepoGroups,
  type DailyOutput,
  type CapacityAssessment,
  type ActionableIssue,
  type ActionMenu,
} from '../formatters/json.js';

// Re-export domain functions so existing consumers (tests, dashboard, startup)
// can continue importing from './daily.js' without changes.
export {
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
    console.error(`Warning: ${failures.length} PR fetch(es) failed`);
  }

  // Fetch merged PR counts, closed PR counts, recently closed PRs, recently merged PRs, and commented issues in parallel
  // All stats fetches are non-critical (cosmetic/scoring), so isolate their failure
  const issueMonitor = new IssueConversationMonitor(token);
  const [mergedResult, closedResult, recentlyClosedPRs, recentlyMergedPRs, issueConversationResult] = await Promise.all(
    [
      prMonitor.fetchUserMergedPRCounts().catch((err) => {
        console.error(`Warning: Failed to fetch merged PR counts: ${errorMessage(err)}`);
        return emptyPRCountsResult<{ count: number; lastMergedAt: string }>();
      }),
      prMonitor.fetchUserClosedPRCounts().catch((err) => {
        console.error(`Warning: Failed to fetch closed PR counts: ${errorMessage(err)}`);
        return emptyPRCountsResult<number>();
      }),
      prMonitor.fetchRecentlyClosedPRs().catch((err): ClosedPR[] => {
        console.error(`Warning: Failed to fetch recently closed PRs: ${errorMessage(err)}`);
        return [];
      }),
      prMonitor.fetchRecentlyMergedPRs().catch((err): MergedPR[] => {
        console.error(`Warning: Failed to fetch recently merged PRs: ${errorMessage(err)}`);
        return [];
      }),
      issueMonitor.fetchCommentedIssues().catch((error) => {
        const msg = errorMessage(error);
        if (msg.includes('No GitHub username configured')) {
          console.error(`[DAILY] Issue conversation tracking requires setup: ${msg}`);
        } else {
          console.error(`[DAILY] Issue conversation fetch failed: ${msg}`);
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
    console.error(`[DAILY] ${issueConversationResult.failures.length} issue conversation check(s) failed`);
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

  // Reset stale repos first (so excluded/removed repos get zeroed).
  // Guard: if the API returned zero results but we have existing repos with merged PRs,
  // skip the reset to avoid wiping scores due to transient API failures.
  const existingReposWithMerges = Object.values(stateManager.getState().repoScores).filter((s) => s.mergedPRCount > 0);
  if (mergedCounts.size === 0 && existingReposWithMerges.length > 0) {
    console.error(
      `[DAILY] Skipping stale repo reset: API returned 0 merged PR results but state has ${existingReposWithMerges.length} repo(s) with merges. Possible API issue.`,
    );
  } else {
    for (const score of Object.values(stateManager.getState().repoScores)) {
      if (!mergedCounts.has(score.repo)) {
        stateManager.updateRepoScore(score.repo, { mergedPRCount: 0 });
      }
    }
  }

  // Update merged/closed counts with per-repo error isolation (matches signal/trust loops below)
  let mergedCountFailures = 0;
  for (const [repo, { count, lastMergedAt }] of mergedCounts) {
    try {
      stateManager.updateRepoScore(repo, { mergedPRCount: count, lastMergedAt: lastMergedAt || undefined });
    } catch (error) {
      mergedCountFailures++;
      console.error(`[DAILY] Failed to update merged count for ${repo}:`, errorMessage(error));
    }
  }
  if (mergedCountFailures === mergedCounts.size && mergedCounts.size > 0) {
    console.error(`[DAILY_ALL_MERGED_COUNT_UPDATES_FAILED] All ${mergedCounts.size} merged count update(s) failed.`);
  }

  // Populate closedWithoutMergeCount in repo scores.
  // Diagnostic: warn if API returned empty but we have known closed PRs (possible transient API failure).
  // Unlike merged counts above, there is no stale-reset loop for closed counts, so no skip is needed.
  const existingReposWithClosed = Object.values(stateManager.getState().repoScores).filter(
    (s) => (s.closedWithoutMergeCount || 0) > 0,
  );
  if (closedCounts.size === 0 && existingReposWithClosed.length > 0) {
    console.error(
      `[DAILY] Warning: API returned 0 closed PR results but state has ${existingReposWithClosed.length} repo(s) with closed PRs. Possible transient API issue.`,
    );
  }
  let closedCountFailures = 0;
  for (const [repo, count] of closedCounts) {
    try {
      stateManager.updateRepoScore(repo, { closedWithoutMergeCount: count });
    } catch (error) {
      closedCountFailures++;
      console.error(`[DAILY] Failed to update closed count for ${repo}:`, errorMessage(error));
    }
  }
  if (closedCountFailures === closedCounts.size && closedCounts.size > 0) {
    console.error(`[DAILY_ALL_CLOSED_COUNT_UPDATES_FAILED] All ${closedCounts.size} closed count update(s) failed.`);
  }

  // Update repo signals from observed open PR data (responsiveness, active maintainers).
  // Only repos with current open PRs get signal updates — repos with no open PRs
  // preserve their existing signals to avoid degrading scores when PRs are merged.
  // Per-repo try-catch: signal/trust syncing is secondary to the daily digest —
  // a single corrupted repo score should not prevent updates to other repos.
  const repoSignals = computeRepoSignals(prs);
  let signalUpdateFailures = 0;
  for (const [repo, signals] of repoSignals) {
    try {
      stateManager.updateRepoScore(repo, { signals });
    } catch (error) {
      signalUpdateFailures++;
      console.error(`[DAILY] Failed to update signals for ${repo}:`, errorMessage(error));
    }
  }
  if (signalUpdateFailures === repoSignals.size && repoSignals.size > 0) {
    console.error(
      `[DAILY_ALL_SIGNAL_UPDATES_FAILED] All ${repoSignals.size} signal update(s) failed. This may indicate corrupted state.`,
    );
  }

  // Fetch star counts for all scored repos (used by dashboard minStars filter, #216)
  const allRepos = Object.keys(stateManager.getState().repoScores);
  let starCounts: Map<string, number>;
  try {
    starCounts = await prMonitor.fetchRepoStarCounts(allRepos);
  } catch (error) {
    console.error('[DAILY] Failed to fetch repo star counts:', errorMessage(error));
    console.error(
      '[DAILY] Dashboard minStars filter will use cached star counts (or be skipped for repos without cached data).',
    );
    starCounts = new Map();
  }
  let starUpdateFailures = 0;
  for (const [repo, stars] of starCounts) {
    try {
      stateManager.updateRepoScore(repo, { stargazersCount: stars });
    } catch (error) {
      starUpdateFailures++;
      console.error(`[DAILY] Failed to update star count for ${repo}:`, errorMessage(error));
    }
  }
  if (starUpdateFailures === starCounts.size && starCounts.size > 0) {
    console.error(`[DAILY_ALL_STAR_COUNT_UPDATES_FAILED] All ${starCounts.size} star count update(s) failed.`);
  }

  // Auto-sync trustedProjects from repos with merged PRs
  let trustSyncFailures = 0;
  for (const [repo] of mergedCounts) {
    try {
      stateManager.addTrustedProject(repo);
    } catch (error) {
      trustSyncFailures++;
      console.error(`[DAILY] Failed to sync trusted project ${repo}:`, errorMessage(error));
    }
  }
  if (trustSyncFailures === mergedCounts.size && mergedCounts.size > 0) {
    console.error(
      `[DAILY_ALL_TRUST_SYNCS_FAILED] All ${mergedCounts.size} trusted project sync(s) failed. This may indicate corrupted state.`,
    );
  }
}

/**
 * Phase 3: Persist monthly chart analytics to state.
 * Stores merged, closed, and combined opened counts per month.
 * Each metric is isolated so partial failures don't produce inconsistent state.
 */
function updateAnalytics(
  prs: FetchedPR[],
  monthlyCounts: Record<string, number>,
  monthlyClosedCounts: Record<string, number>,
  openedFromMerged: Record<string, number>,
  openedFromClosed: Record<string, number>,
): void {
  const stateManager = getStateManager();

  // Store monthly chart data (non-critical — each metric isolated so partial failures don't leave inconsistent state).
  // Guard: skip overwriting when the data is empty to avoid wiping existing chart data on transient API failures.
  // An empty object means the fetch failed and fell back to emptyPRCountsResult(), so we preserve previous state.
  try {
    if (Object.keys(monthlyCounts).length > 0) {
      stateManager.setMonthlyMergedCounts(monthlyCounts);
    }
  } catch (error) {
    console.error('[DAILY] Failed to store monthly merged counts:', errorMessage(error));
  }

  try {
    if (Object.keys(monthlyClosedCounts).length > 0) {
      stateManager.setMonthlyClosedCounts(monthlyClosedCounts);
    }
  } catch (error) {
    console.error('[DAILY] Failed to store monthly closed counts:', errorMessage(error));
  }

  try {
    // Build combined monthly opened counts from merged + closed + currently-open PRs
    const combinedOpenedCounts: Record<string, number> = { ...openedFromMerged };
    for (const [month, count] of Object.entries(openedFromClosed)) {
      combinedOpenedCounts[month] = (combinedOpenedCounts[month] || 0) + count;
    }
    // Add currently-open PR creation dates
    for (const pr of prs) {
      if (pr.createdAt) {
        const month = pr.createdAt.slice(0, 7);
        combinedOpenedCounts[month] = (combinedOpenedCounts[month] || 0) + 1;
      }
    }
    if (Object.keys(combinedOpenedCounts).length > 0) {
      stateManager.setMonthlyOpenedCounts(combinedOpenedCounts);
    }
  } catch (error) {
    console.error('[DAILY] Failed to compute/store monthly opened counts:', errorMessage(error));
  }
}

/**
 * Phase 4: Expire snoozes and partition PRs into active vs shelved buckets.
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

  // Expire any snoozes that have passed their expiresAt timestamp.
  // Non-critical: corrupted snooze entries should not abort the daily check.
  try {
    const expiredSnoozes = stateManager.expireSnoozes();
    if (expiredSnoozes.length > 0) {
      console.error(`[DAILY] ${expiredSnoozes.length} snoozed PR(s) expired and will resurface:`);
      for (const url of expiredSnoozes) {
        console.error(`  - ${url}`);
      }
      stateManager.save();
    }
  } catch (error) {
    console.error('[DAILY] Failed to expire/persist snoozes:', errorMessage(error));
  }

  // Partition PRs into active vs shelved, auto-unshelving when maintainers engage
  const shelvedPRs: ShelvedPRRef[] = [];
  const autoUnshelvedPRs: ShelvedPRRef[] = [];
  const activePRs: FetchedPR[] = [];

  for (const pr of prs) {
    if (stateManager.isPRShelved(pr.url)) {
      if (CRITICAL_STATUSES.has(pr.status)) {
        stateManager.unshelvePR(pr.url);
        autoUnshelvedPRs.push(toShelvedPRRef(pr));
        activePRs.push(pr);
      } else {
        shelvedPRs.push(toShelvedPRRef(pr));
      }
    } else if (pr.status === 'dormant') {
      // Dormant PRs are auto-shelved (not persisted — they return when activity resumes)
      shelvedPRs.push(toShelvedPRRef(pr));
    } else {
      activePRs.push(pr);
    }
  }

  // Generate digest from fresh data.
  // Note: digest.openPRs contains ALL fetched PRs (including shelved).
  // We override summary fields below to reflect active-only counts.
  const digest = prMonitor.generateDigest(prs, recentlyClosedPRs, recentlyMergedPRs);

  // Attach shelve info to digest
  digest.shelvedPRs = shelvedPRs;
  digest.autoUnshelvedPRs = autoUnshelvedPRs;
  digest.summary.totalActivePRs = activePRs.length;

  // Store digest in state so dashboard can render it
  stateManager.setLastDigest(digest);

  // Save state (updates lastRunAt, lastDigest, and any auto-unshelve changes)
  stateManager.save();

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
): DailyCheckResult {
  const stateManager = getStateManager();

  // Assess capacity from active PRs only (shelved PRs excluded)
  const capacity = assessCapacity(activePRs, stateManager.getState().config.maxActivePRs, shelvedPRs.length);

  // Filter dismissed issues: suppress if dismissed after last response, resurface + auto-undismiss if new activity
  let hasAutoUndismissed = false;
  const filteredCommentedIssues = commentedIssues.filter((issue) => {
    const dismissedAt = stateManager.getIssueDismissedAt(issue.url);
    if (!dismissedAt) return true; // Not dismissed — include
    if (issue.status === 'new_response') {
      const responseTime = new Date(issue.lastResponseAt).getTime();
      const dismissTime = new Date(dismissedAt).getTime();
      if (isNaN(responseTime) || isNaN(dismissTime)) {
        // Invalid timestamp — fail open (include issue to be safe) without
        // permanently removing dismiss record (may be a transient data issue)
        console.error(`[DAILY] Invalid timestamp in dismiss check for ${issue.url}, including issue`);
        return true;
      }
      if (responseTime > dismissTime) {
        // New activity after dismiss — auto-undismiss and resurface
        console.error(
          `[DAILY] Auto-undismissing issue ${issue.url}: new response at ${issue.lastResponseAt} after dismiss at ${dismissedAt}`,
        );
        stateManager.undismissIssue(issue.url);
        hasAutoUndismissed = true;
        return true;
      }
    }
    // Still dismissed (last response is at or before dismiss timestamp)
    return false;
  });

  const issueResponses = filteredCommentedIssues.filter(
    (i): i is CommentedIssueWithResponse => i.status === 'new_response',
  );
  const summary = formatSummary(digest, capacity, issueResponses);
  const snoozedUrls = new Set(
    Object.keys(stateManager.getState().config.snoozedPRs ?? {}).filter((url) => stateManager.isSnoozed(url)),
  );
  // Filter dismissed PRs: suppress if dismissed after last activity, auto-undismiss if new activity (#416, #468)
  const nonDismissedPRs = activePRs.filter((pr) => {
    const dismissedAt = stateManager.getIssueDismissedAt(pr.url);
    if (!dismissedAt) return true; // Not dismissed — include
    const activityTime = new Date(pr.updatedAt).getTime();
    const dismissTime = new Date(dismissedAt).getTime();
    if (isNaN(activityTime) || isNaN(dismissTime)) {
      // Invalid timestamp — fail open (include PR to be safe) without
      // permanently removing dismiss record (may be a transient data issue)
      console.error(`[DAILY] Invalid timestamp in PR dismiss check for ${pr.url}, including PR`);
      return true;
    }
    if (activityTime > dismissTime) {
      // New activity after dismiss — auto-undismiss and resurface
      console.error(
        `[DAILY] Auto-undismissing PR ${pr.url}: new activity at ${pr.updatedAt} after dismiss at ${dismissedAt}`,
      );
      stateManager.undismissIssue(pr.url);
      hasAutoUndismissed = true;
      return true;
    }
    // Still dismissed (last activity is at or before dismiss timestamp)
    return false;
  });

  // Persist auto-undismiss state changes (issue + PR combined into one save)
  if (hasAutoUndismissed) {
    try {
      stateManager.save();
    } catch (error) {
      console.error('[DAILY] Failed to persist auto-undismissed state:', errorMessage(error));
    }
  }
  const actionableIssues = collectActionableIssues(nonDismissedPRs, snoozedUrls);
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
 *   4. partitionPRs       — expire snoozes, shelve/unshelve, generate digest
 *   5. generateDigestOutput — capacity, dismiss filter, action menu assembly
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

  // Phase 3: Persist monthly analytics
  updateAnalytics(prs, monthlyCounts, monthlyClosedCounts, openedFromMerged, openedFromClosed);

  // Phase 4: Expire snoozes, partition PRs, generate and save digest
  const { activePRs, shelvedPRs, digest } = partitionPRs(prMonitor, prs, recentlyClosedPRs, recentlyMergedPRs);

  // Phase 5: Build structured output (capacity, dismiss filter, action menu)
  return generateDigestOutput(digest, activePRs, shelvedPRs, commentedIssues, failures);
}

/**
 * Run the daily check and return deduplicated DailyOutput.
 * Errors propagate to the caller.
 */
export async function runDaily(): Promise<DailyOutput> {
  // Token is guaranteed by the preAction hook in cli.ts for non-LOCAL_ONLY_COMMANDS.
  const token = requireGitHubToken();
  return executeDailyCheck(token);
}

/**
 * Run the daily check and return the full (non-deduplicated) result.
 * Used by CLI text mode where printDigest() needs full PR objects.
 */
export async function runDailyForDisplay(): Promise<DailyCheckResult> {
  const token = requireGitHubToken();
  return executeDailyCheckInternal(token);
}
