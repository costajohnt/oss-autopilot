/**
 * Barrel export for all command functions and their output types.
 * Used by @oss-autopilot/mcp to import command functions directly.
 */

// Command functions
export { runDaily, runDailyForDisplay, executeDailyCheck } from './daily.js';
export { runStatus } from './status.js';
export { runSearch } from './search.js';
export { runVet } from './vet.js';
export { runTrack, runUntrack } from './track.js';
export { runRead } from './read.js';
export { runComments, runPost, runClaim } from './comments.js';
export { runConfig } from './config.js';
export { runInit } from './init.js';
export { runSetup, runCheckSetup } from './setup.js';
export { runShelve, runUnshelve } from './shelve.js';
export { runDismiss, runUndismiss } from './dismiss.js';
export { runSnooze, runUnsnooze } from './snooze.js';
export { runStartup } from './startup.js';
export { runParseList } from './parse-list.js';
export { runCheckIntegration } from './check-integration.js';
export { runLocalRepos } from './local-repos.js';

// Output types (re-exported from formatters/json.ts and command files)
export type { DailyOutput, SearchOutput, StartupOutput, StatusOutput, TrackOutput } from '../formatters/json.js';
export type { VetOutput, CommentsOutput, PostOutput, ClaimOutput } from '../formatters/json.js';
export type {
  ConfigOutput,
  ParseIssueListOutput,
  CheckIntegrationOutput,
  LocalReposOutput,
} from '../formatters/json.js';
export type { ReadOutput } from './read.js';
export type { ShelveOutput, UnshelveOutput } from './shelve.js';
export type { DismissOutput, UndismissOutput } from './dismiss.js';
export type { SnoozeOutput, UnsnoozeOutput } from './snooze.js';
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
