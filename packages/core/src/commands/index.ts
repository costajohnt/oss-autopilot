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
/** Search GitHub for contributable issues using multi-strategy discovery. */
export { runSearch } from './search.js';
/** Vet a single GitHub issue for claimability (open, unassigned, no linked PRs, repo health). */
export { runVet } from './vet.js';

// ── PR Management ───────────────────────────────────────────────────────────

/** Add a PR to tracking state. */
export { runTrack } from './track.js';
/** Remove a PR from tracking state. */
export { runUntrack } from './track.js';
/** Mark PR comments as read. */
export { runRead } from './read.js';
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
/** Check if new files are properly referenced/integrated. */
export { runCheckIntegration } from './check-integration.js';
/** Detect formatters/linters configured in a local repository (#703). */
export { runDetectFormatters } from './detect-formatters.js';
/** Scan for locally cloned repos. */
export { runLocalRepos } from './local-repos.js';

// ── Output Types ────────────────────────────────────────────────────────────
// All commands return JsonOutput<T> where T is the command-specific type below.

export type { ErrorCode } from '../formatters/json.js';
export type { DailyOutput, SearchOutput, StartupOutput, StatusOutput, TrackOutput } from '../formatters/json.js';
export type { VetOutput, CommentsOutput, PostOutput, ClaimOutput } from '../formatters/json.js';
export type {
  ConfigOutput,
  DetectFormattersOutput,
  ParseIssueListOutput,
  ParsedIssueItem,
  CheckIntegrationOutput,
  LocalReposOutput,
} from '../formatters/json.js';
export type { ReadOutput } from './read.js';
export type { ShelveOutput, UnshelveOutput } from './shelve.js';
export type { MoveOutput, MoveTarget } from './move.js';
export type { DismissOutput, UndismissOutput } from './dismiss.js';
export type { UntrackOutput } from './track.js';
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
export type { StateShowOutput, StateSyncOutput, StateUnlinkOutput } from './state-cmd.js';
