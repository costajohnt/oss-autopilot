/**
 * Barrel export for all command functions and their output types.
 * Used by @oss-autopilot/mcp to import command functions directly.
 *
 * @example
 * ```typescript
 * import { runDaily, runSearch, runStatus } from '@oss-autopilot/core/commands';
 *
 * const digest = await runDaily();
 * const issues = await runSearch({ maxResults: 10 });
 * const stats = await runStatus({});
 * ```
 */

// ── Primary Commands ────────────────────────────────────────────────────────

/** Fetch all open PRs, compute digest, and return structured daily output. Requires GITHUB_TOKEN. */
export { runDaily } from './daily.js';
/** Like runDaily but returns the full (non-deduplicated) result for text-mode display. */
export { runDailyForDisplay } from './daily.js';
/** Lower-level daily check that accepts a token directly. Used by startup orchestration. */
export { executeDailyCheck } from './daily.js';
/** Combined startup: auth check, setup check, daily fetch, dashboard launch, version detection. */
export { runStartup } from './startup.js';
/** Return contribution statistics (merge rate, PR counts, repo breakdown) from local state. */
export { runStatus } from './status.js';
/** On-demand strategy snapshot via the typed `computeStrategy` core function (#1243 step 4). */
export { runStrategy } from './strategy.js';
/** Search GitHub for contributable issues using multi-strategy discovery. */
export { runSearch, MAX_SEARCH_RESULTS } from './search.js';
/** Surface feature-scoped opportunities in repos with 3+ merged PRs (scout 0.9.0). */
export { runFeatures, MAX_FEATURES_RESULTS } from './features.js';
/** Vet a single GitHub issue for claimability (open, unassigned, no linked PRs, repo health). */
export { runVet } from './vet.js';
/** Deterministic availability check: state/stateReason + linked-PR classification (#1353, #1354). */
export { runVerifyIssue, type VerifyIssueOptions } from './verify-issue.js';
/** Re-vet all available issues in a curated issue list for freshness. */
export { runVetList } from './vet-list.js';

// ── PR Management ───────────────────────────────────────────────────────────

/** Fetch PR metadata from GitHub (informational; nothing is persisted). */
export { runTrack } from './track.js';
/** Score a PR against opensource.guide best practices via the typed core function (#1245). */
export { runComplianceScore } from './compliance-score.js';
/** Compute repo health rubric (1–10 score + verdict) via the typed core function (#1271, follow-up to #1242). */
export { runRepoVet } from './repo-vet.js';
/** Temporarily hide a PR from the daily digest. */
export { runShelve } from './shelve.js';
/** Restore a shelved PR to the daily digest. */
export { runUnshelve } from './shelve.js';
/** Move a PR between states: attention, waiting, shelved, auto. */
export { runMove } from './move.js';
/** Dismiss issue reply notifications (auto-resurfaces on new activity). */
export { runDismiss } from './dismiss.js';
/** Restore a dismissed issue to notifications. */
export { runUndismiss } from './dismiss.js';
// ── Issue & Comment Management ──────────────────────────────────────────────

/** Fetch comments for tracked issues/PRs. */
export { runComments } from './comments.js';
/** Post a comment to a GitHub issue or PR. */
export { runPost } from './comments.js';
/** Post a claim comment on a GitHub issue. */
export { runClaim } from './comments.js';

// ── Configuration & Setup ───────────────────────────────────────────────────

/** Read or write user configuration (githubUsername, languages, labels, etc). */
export { runConfig } from './config.js';
/** Initialize with a GitHub username and import open PRs. */
export { runInit } from './init.js';
/** Interactive first-run setup wizard. */
export { runSetup } from './setup.js';
/** Check whether setup has been completed. */
export { runCheckSetup } from './setup.js';

// ── Per-Repo Guidelines (#867) ──────────────────────────────────────────────

/** List repos with stored guidelines (empty in local mode). */
export { runGuidelinesList } from './guidelines.js';
/** Read the guidelines file for a repo. */
export { runGuidelinesView } from './guidelines.js';
/** Persist a guidelines file for a repo (overwrites on subsequent calls). */
export { runGuidelinesStore } from './guidelines.js';
/** Tombstone a guidelines file so subsequent reads return null. */
export { runGuidelinesReset } from './guidelines.js';
/** Fetch raw PR comment bundles for the host's extract-learnings prompt. */
export { runFetchCorpus } from './guidelines.js';

// ── State Persistence ────────────────────────────────────────────────────────

/** Show current persistence mode, Gist ID, and sync status. */
export { runStateShow } from './state-cmd.js';
/** Force push state to the backing Gist (no-op in local mode). */
export { runStateSync } from './state-cmd.js';
/** Disconnect from Gist persistence and switch to local-only mode. */
export { runStateUnlink } from './state-cmd.js';

// ── Utilities ───────────────────────────────────────────────────────────────

/** Parse a curated markdown issue list file into structured issue items. */
export { runParseList, pruneIssueList } from './parse-list.js';
/** Move an issue between Pursue / Maybe / Skip sections of a curated list (#1107). */
export {
  runListMoveTier,
  moveIssueToTier,
  type Tier,
  type ListMoveTierOptions,
  type ListMoveTierOutput,
} from './list-move-tier.js';
/** Mark an issue line in a curated list as done with strikethrough + Done sub-bullet (#1299). */
export {
  runMarkIssueListItemDone,
  markIssueAsDone,
  type MarkDoneOptions,
  type MarkDoneOutput,
} from './list-mark-done.js';
/** Daily merge-loop reconciliation — auto-mark curated-list entries whose PR merged (#1463). */
export { reconcileMergedPRsWithList, findListEntryUrlByPrUrl } from './merge-loop.js';
/** Check if new files are properly referenced/integrated. */
export { runCheckIntegration } from './check-integration.js';
/** System-health diagnostic — verifies tokens, bundle, state, scout, rate limit. */
export { runDoctor, type DoctorCheck, type DoctorCheckStatus, type DoctorOutput } from './doctor.js';
/** Detect formatters/linters configured in a local repository (#703). */
export { runDetectFormatters } from './detect-formatters.js';
/** Scan for locally cloned repos. */
export { runLocalRepos } from './local-repos.js';

// ── Dashboard Data Contract ─────────────────────────────────────────────────
// Single source of truth for the types the dashboard SPA consumes.
// Imported by @oss-autopilot/dashboard to prevent drift (#965, #998).

export type { DashboardJsonData, DashboardStats, DashboardActionType, ActionRequest } from './dashboard-data.js';

// ── Output Types ────────────────────────────────────────────────────────────
// All commands return JsonOutput<T> where T is the command-specific type below.

export type { ErrorCode } from '../formatters/json.js';
export type {
  DailyOutput,
  SearchOutput,
  SearchCandidate,
  CandidateLinkedPR,
  FeaturesOutput,
  FeaturesCandidate,
  FeaturesHorizon,
  StartupOutput,
  StatusOutput,
  TrackOutput,
} from '../formatters/json.js';
export type {
  VetOutput,
  CommentsOutput,
  PostOutput,
  ClaimOutput,
  VetListOutput,
  VetListItemStatus,
} from '../formatters/json.js';
export type {
  ConfigOutput,
  DetectFormattersOutput,
  ParseIssueListOutput,
  ParsedIssueItem,
  CheckIntegrationOutput,
  LocalReposOutput,
} from '../formatters/json.js';
export type { ShelveOutput, UnshelveOutput } from './shelve.js';
export type { MoveOutput, MoveTarget } from './move.js';
export type {
  GuidelinesListOutput,
  GuidelinesViewOutput,
  GuidelinesStoreOutput,
  GuidelinesResetOutput,
  FetchCorpusOutput,
} from './guidelines.js';
export type { DismissOutput, UndismissOutput } from './dismiss.js';
export type { InitOutput } from './init.js';
export type { ConfigSetOutput, ConfigCommandOutput } from './config.js';
export type {
  SetupSetOutput,
  SetupCompleteOutput,
  SetupRequiredOutput,
  SetupOutput,
  CheckSetupOutput,
} from './setup.js';
export type { DailyCheckResult } from './daily.js';
export type { StateShowOutput, StateSyncOutput, StateUnlinkOutput, InvalidUrlEntry } from './state-cmd.js';
