/**
 * JSON output formatter for CLI --json mode
 * Provides structured output that can be consumed by scripts and plugins
 */

import type { FetchedPR, DailyDigest, AgentState, RepoGroup, CommentedIssue, ShelvedPRRef } from '../core/types.js';
import type { ContributionStats } from '../core/stats.js';
import type { PRCheckFailure } from '../core/pr-monitor.js';
import type { SearchPriority } from '../core/types.js';
import type { CIFormatterDiagnosis, FormatterDetectionResult } from '../core/formatter-detection.js';

export interface JsonOutput<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface CapacityAssessment {
  hasCapacity: boolean;
  activePRCount: number;
  maxActivePRs: number;
  shelvedPRCount: number;
  criticalIssueCount: number;
  reason: string;
}

export type ActionableIssueType =
  | 'ci_failing'
  | 'merge_conflict'
  | 'needs_response'
  | 'needs_changes'
  | 'incomplete_checklist';

export interface ActionableIssue {
  type: ActionableIssueType;
  pr: FetchedPR;
  label: string; // e.g., "[CI Failing]"
  /** True if the PR was created after the last daily digest (first time seen). */
  isNewContribution: boolean;
}

/**
 * Compact version of ActionableIssue for JSON output.
 * References the PR by URL instead of embedding the full object,
 * since the full PR is already available in digest.openPRs.
 * Uses URL (globally unique) instead of number to avoid cross-repo collisions.
 */
export interface CompactActionableIssue {
  type: ActionableIssueType;
  prUrl: string;
  label: string;
  /** True if the PR was created after the last daily digest (first time seen). */
  isNewContribution: boolean;
}

/**
 * A single action menu item pre-computed by the CLI.
 * The orchestration layer can use these directly in AskUserQuestion prompts.
 */
export interface ActionMenuItem {
  /** Stable identifier for routing (e.g., "address_all", "search", "done"). */
  key: string;
  /** Display text for the option (e.g., "Work through all 3 issues (Recommended)"). */
  label: string;
  /** Explanation shown below the label. */
  description: string;
  /** Present when the action would exceed the user's PR capacity limit (#765). */
  capacityWarning?: string;
}

/**
 * Pre-computed action menu for the orchestration layer.
 * Contains the menu items the CLI can determine from PR data and capacity,
 * plus context flags so the orchestration can insert issue-list options.
 */
export interface ActionMenu {
  /** Ordered list of menu items. The orchestration may insert issue-list items after the CLI-generated items (address_all, issue_replies) or at the start when none exist. */
  items: ActionMenuItem[];
  /** Context flags for the orchestration layer to decide on issue-list options. */
  context: {
    hasActionableIssues: boolean;
    actionableCount: number;
    hasCapacity: boolean;
    hasIssueResponses: boolean;
    issueResponseCount: number;
  };
}

/**
 * Deduplicated daily digest for JSON output (#287).
 *
 * Full PR objects live only in `openPRs`. Category arrays contain PR URLs
 * that reference into `openPRs`, reducing JSON payload size by ~60-70%.
 * Uses URLs (globally unique) instead of numbers to avoid cross-repo collisions.
 * Consumers look up full PR details via: openPRs.find(pr => pr.url === url)
 */
export interface DailyDigestCompact {
  generatedAt: string;

  /** All open PRs authored by the user — the single source of truth for full PR objects. */
  openPRs: FetchedPR[];

  // Category arrays: PR URLs referencing openPRs (each is a subset filtered by status)
  needsAddressingPRs: string[];
  waitingOnMaintainerPRs: string[];

  recentlyClosedPRs: DailyDigest['recentlyClosedPRs'];
  recentlyMergedPRs: DailyDigest['recentlyMergedPRs'];
  shelvedPRs: ShelvedPRRef[];
  autoUnshelvedPRs: ShelvedPRRef[];

  summary: DailyDigest['summary'];
}

/**
 * Compact repo group for JSON output (#287).
 * Uses PR URLs instead of full objects; look up in digest.openPRs.
 * Uses URLs (globally unique) instead of numbers to avoid cross-repo collisions.
 */
export interface CompactRepoGroup {
  repo: string;
  prUrls: string[];
}

export interface DailyOutput {
  digest: DailyDigestCompact;
  capacity: CapacityAssessment;
  summary: string; // Pre-formatted markdown for Claude to display verbatim
  briefSummary: string; // One-liner for action-first flow
  actionableIssues: CompactActionableIssue[]; // Structured list referencing PRs by URL
  actionMenu: ActionMenu; // Pre-computed action menu for Action Menu section
  commentedIssues: CommentedIssue[]; // Issues user commented on with conversation state
  repoGroups: CompactRepoGroup[]; // PRs grouped by repo for safe parallel dispatch (#80)
  failures: PRCheckFailure[]; // PRs that failed to fetch (e.g., rate limits, network errors)
}

/**
 * Compact version of DailyOutput for reduced JSON payload size (#763).
 * Omits `summary` (pre-rendered markdown ~8KB that duplicates structured fields),
 * `repoGroups` (derivable from digest.openPRs), and full `failures` array.
 * Retains `commentedIssues` because downstream workflows (review-issue-replies.md,
 * action-menu.md) consume it directly.
 * Includes `failureCount` so consumers can detect partial fetch failures without
 * carrying the full error payload.
 */
export interface CompactDailyOutput {
  digest: DailyDigestCompact;
  capacity: CapacityAssessment;
  briefSummary: string;
  actionableIssues: CompactActionableIssue[];
  actionMenu: ActionMenu;
  commentedIssues: CommentedIssue[];
  /** Number of PRs that failed to fetch. Non-zero indicates partial results. */
  failureCount: number;
}

/**
 * Strip a full DailyOutput down to the compact subset (#763).
 * Omits summary, repoGroups, and full failures array. Retains a failureCount
 * so consumers can detect partial fetch failures.
 */
export function toCompactDailyOutput(output: DailyOutput): CompactDailyOutput {
  return {
    digest: output.digest,
    capacity: output.capacity,
    briefSummary: output.briefSummary,
    actionableIssues: output.actionableIssues,
    actionMenu: output.actionMenu,
    commentedIssues: output.commentedIssues,
    failureCount: output.failures.length,
  };
}

/**
 * Convert a full DailyDigest to the compact format for JSON output (#287).
 * Category arrays become PR URL arrays; full objects stay only in openPRs.
 * Uses URLs (globally unique) instead of numbers to avoid cross-repo collisions.
 */
export function deduplicateDigest(digest: DailyDigest): DailyDigestCompact {
  const toUrls = (prs: FetchedPR[]): string[] => prs.map((pr) => pr.url);

  return {
    generatedAt: digest.generatedAt,
    openPRs: digest.openPRs,
    needsAddressingPRs: toUrls(digest.needsAddressingPRs),
    waitingOnMaintainerPRs: toUrls(digest.waitingOnMaintainerPRs),
    recentlyClosedPRs: digest.recentlyClosedPRs,
    recentlyMergedPRs: digest.recentlyMergedPRs,
    shelvedPRs: digest.shelvedPRs,
    autoUnshelvedPRs: digest.autoUnshelvedPRs,
    summary: digest.summary,
  };
}

/**
 * Convert ActionableIssue[] to CompactActionableIssue[] for JSON output (#287).
 * Replaces the full PR object with just the PR URL (globally unique).
 */
export function compactActionableIssues(issues: ActionableIssue[]): CompactActionableIssue[] {
  return issues.map((issue) => ({
    type: issue.type,
    prUrl: issue.pr.url,
    label: issue.label,
    isNewContribution: issue.isNewContribution,
  }));
}

/**
 * Convert RepoGroup[] to CompactRepoGroup[] for JSON output (#287).
 * Replaces full PR arrays with PR URL arrays.
 */
export function compactRepoGroups(groups: RepoGroup[]): CompactRepoGroup[] {
  return groups.map((group) => ({
    repo: group.repo,
    prUrls: group.prs.map((pr) => pr.url),
  }));
}

export interface StatusOutput {
  stats: {
    mergedPRs: number;
    closedPRs: number;
    activeIssues: number;
    trustedProjects: number;
    mergeRate: string;
    needsResponse: number;
  };
  lastRunAt: string;
  offline?: boolean;
  lastUpdated?: string;
}

export interface SearchOutput {
  candidates: Array<{
    issue: {
      repo: string;
      number: number;
      title: string;
      url: string;
      labels: string[];
    };
    recommendation: 'approve' | 'skip' | 'needs_review';
    reasonsToApprove: string[];
    reasonsToSkip: string[];
    searchPriority: SearchPriority;
    /** 0-100 scale composite viability score */
    viabilityScore: number;
    repoScore?: {
      /** 1-10 scale repository quality score */
      score: number;
      mergedPRCount: number;
      closedWithoutMergeCount: number;
      isResponsive: boolean;
      lastMergedAt?: string;
    };
  }>;
  excludedRepos: string[];
  /** Repos with known anti-AI contribution policies, filtered from search results (#108). */
  aiPolicyBlocklist: string[];
  /** Present when rate limits affected the search — either low pre-flight quota or mid-search rate limit hits (#100). */
  rateLimitWarning?: string;
}

export interface TrackOutput {
  pr: {
    repo: string;
    number: number;
    title: string;
    url: string;
  };
}

export interface ConfigOutput {
  config: AgentState['config'];
}

/** Info about a detected issue list file */
export interface IssueListInfo {
  path: string;
  source: 'configured' | 'auto-detected';
  availableCount: number;
  completedCount: number;
}

/**
 * Output of the startup command (combines auth, setup, daily, dashboard, issue list).
 *
 * Three valid shapes:
 * 1. Setup incomplete: { version, setupComplete: false }
 * 2. Auth failure: { version, setupComplete: true, authError: "..." }
 * 3. Success: { version, setupComplete: true, daily, dashboardUrl?, issueList? }
 */
export interface StartupOutput {
  version: string;
  setupComplete: boolean;
  /** True when username was auto-detected on first run (zero-config). */
  autoDetected?: boolean;
  authError?: string;
  daily?: DailyOutput;
  /** URL of the interactive SPA dashboard server, when running (e.g., "http://localhost:3000") */
  dashboardUrl?: string;
  issueList?: IssueListInfo;
}

/**
 * Compact version of StartupOutput for reduced JSON payload (#763).
 * Derived from StartupOutput with CompactDailyOutput substituted for DailyOutput.
 * Using Omit ensures new fields added to StartupOutput are automatically included.
 */
export type CompactStartupOutput = Omit<StartupOutput, 'daily'> & {
  daily?: CompactDailyOutput;
};

/**
 * Convert a full StartupOutput to the compact format (#763).
 * Uses destructuring to auto-forward any new fields added to StartupOutput.
 */
export function toCompactStartupOutput(output: StartupOutput): CompactStartupOutput {
  const { daily, ...rest } = output;
  return {
    ...rest,
    daily: daily ? toCompactDailyOutput(daily) : undefined,
    dashboardUrl: output.dashboardUrl,
    issueList: output.issueList,
  };
}

/** A single parsed issue from a markdown list (#82) */
export interface ParsedIssueItem {
  repo: string;
  number: number;
  title: string;
  tier: string;
  url: string;
}

/** Output of the parse-issue-list command (#82) */
export interface ParseIssueListOutput {
  available: ParsedIssueItem[];
  completed: ParsedIssueItem[];
  availableCount: number;
  completedCount: number;
}

/** Info about a new file's integration status (#83) */
export interface NewFileInfo {
  path: string;
  referencedBy: string[];
  isIntegrated: boolean;
  suggestedEntryPoints?: string[];
}

/** Output of the check-integration command (#83) */
export interface CheckIntegrationOutput {
  newFiles: NewFileInfo[];
  unreferencedCount: number;
}

/** Status of a re-vetted issue from the curated list (#764). */
export type VetListItemStatus = 'still_available' | 'claimed' | 'closed' | 'has_pr' | 'error';

/** Output of the vet-list command (#764). */
export interface VetListOutput {
  results: Array<
    VetOutput & {
      listStatus: VetListItemStatus;
      errorMessage?: string;
    }
  >;
  summary: {
    total: number;
    stillAvailable: number;
    claimed: number;
    closed: number;
    hasPR: number;
    errors: number;
  };
}

/** Output of the vet command */
export interface VetOutput {
  issue: {
    repo: string;
    number: number;
    title: string;
    url: string;
    labels: string[];
  };
  recommendation: 'approve' | 'skip' | 'needs_review';
  reasonsToApprove: string[];
  reasonsToSkip: string[];
  projectHealth: unknown;
  vettingResult: unknown;
}

/** Output of the comments command */
export interface CommentsOutput {
  pr: {
    title: string;
    state: string;
    mergeable: boolean | null;
    head: string;
    base: string;
    url: string;
  };
  reviews: Array<{
    user: string | undefined;
    state: string;
    body: string | null;
    submittedAt: string | null;
  }>;
  reviewComments: Array<{
    user: string | undefined;
    body: string;
    path: string;
    createdAt: string;
  }>;
  issueComments: Array<{
    user: string | undefined;
    body: string | undefined;
    createdAt: string;
  }>;
  summary: {
    reviewCount: number;
    inlineCommentCount: number;
    discussionCommentCount: number;
  };
}

/** Output of the post command */
export interface PostOutput {
  commentUrl: string;
  url: string;
}

/** Output of the claim command */
export interface ClaimOutput {
  commentUrl: string;
  issueUrl: string;
}

/** Info about a local git clone (#84) */
export interface LocalRepoInfo {
  path: string;
  exists: boolean;
  currentBranch: string | null;
}

/** Output of the local-repos command (#84) */
export interface LocalReposOutput {
  repos: Record<string, LocalRepoInfo>;
  scanPaths: string[];
  cachedAt: string;
  fromCache: boolean;
}

/** Output of the detect-formatters command. Extends FormatterDetectionResult with optional CI diagnosis. */
export interface DetectFormattersOutput extends FormatterDetectionResult {
  ciDiagnosis?: CIFormatterDiagnosis;
}

/** Output of the stats command */
export interface StatsOutput extends ContributionStats {
  mergeRateFormatted: string;
  username: string;
}

/**
 * Wrap data in a standard JSON output envelope
 */
export function jsonSuccess<T>(data: T): JsonOutput<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create an error JSON output
 */
export function jsonError(message: string): JsonOutput<never> {
  return {
    success: false,
    error: message,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Output JSON to stdout
 */
export function outputJson<T>(data: T): void {
  console.log(JSON.stringify(jsonSuccess(data), null, 2));
}

/**
 * Output error JSON to stdout (sets success: false)
 */
export function outputJsonError(message: string): void {
  console.log(JSON.stringify(jsonError(message), null, 2));
}
