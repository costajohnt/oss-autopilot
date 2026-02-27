/**
 * JSON output formatter for CLI --json mode
 * Provides structured output that can be consumed by scripts and plugins
 */

import type { FetchedPR, DailyDigest, AgentState, RepoGroup, CommentedIssue, ShelvedPRRef } from '../core/types.js';
import type { PRCheckFailure } from '../core/pr-monitor.js';
import type { SearchPriority } from '../core/issue-discovery.js';

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
}

/**
 * Compact version of ActionableIssue for JSON output.
 * References the PR by number instead of embedding the full object,
 * since the full PR is already available in digest.openPRs.
 */
export interface CompactActionableIssue {
  type: ActionableIssueType;
  prNumber: number;
  label: string;
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
 * Full PR objects live only in `openPRs`. Category arrays contain PR numbers
 * that reference into `openPRs`, reducing JSON payload size by ~60-70%.
 * Consumers look up full PR details via: openPRs.find(pr => pr.number === n)
 */
export interface DailyDigestCompact {
  generatedAt: string;

  /** All open PRs authored by the user — the single source of truth for full PR objects. */
  openPRs: FetchedPR[];

  // Category arrays: PR numbers referencing openPRs (each is a subset filtered by status)
  prsNeedingResponse: number[];
  ciFailingPRs: number[];
  ciBlockedPRs: number[];
  ciNotRunningPRs: number[];
  mergeConflictPRs: number[];
  needsRebasePRs: number[];
  missingRequiredFilesPRs: number[];
  incompleteChecklistPRs: number[];
  needsChangesPRs: number[];
  changesAddressedPRs: number[];
  waitingOnMaintainerPRs: number[];
  approachingDormant: number[];
  dormantPRs: number[];
  healthyPRs: number[];

  recentlyClosedPRs: DailyDigest['recentlyClosedPRs'];
  recentlyMergedPRs: DailyDigest['recentlyMergedPRs'];
  shelvedPRs: ShelvedPRRef[];
  autoUnshelvedPRs: ShelvedPRRef[];

  summary: DailyDigest['summary'];
}

/**
 * Compact repo group for JSON output (#287).
 * Uses PR numbers instead of full objects; look up in digest.openPRs.
 */
export interface CompactRepoGroup {
  repo: string;
  prNumbers: number[];
}

export interface DailyOutput {
  digest: DailyDigestCompact;
  updates: unknown[]; // Legacy field, always empty in v2
  capacity: CapacityAssessment;
  summary: string; // Pre-formatted markdown for Claude to display verbatim
  briefSummary: string; // One-liner for action-first flow
  actionableIssues: CompactActionableIssue[]; // Structured list referencing PRs by number
  actionMenu: ActionMenu; // Pre-computed action menu for Step 3
  commentedIssues: CommentedIssue[]; // Issues user commented on with conversation state
  repoGroups: CompactRepoGroup[]; // PRs grouped by repo for safe parallel dispatch (#80)
  failures: PRCheckFailure[]; // PRs that failed to fetch (e.g., rate limits, network errors)
}

/**
 * Convert a full DailyDigest to the compact format for JSON output (#287).
 * Category arrays become PR number arrays; full objects stay only in openPRs.
 */
export function deduplicateDigest(digest: DailyDigest): DailyDigestCompact {
  const toNumbers = (prs: FetchedPR[]): number[] => prs.map((pr) => pr.number);

  return {
    generatedAt: digest.generatedAt,
    openPRs: digest.openPRs,
    prsNeedingResponse: toNumbers(digest.prsNeedingResponse),
    ciFailingPRs: toNumbers(digest.ciFailingPRs),
    ciBlockedPRs: toNumbers(digest.ciBlockedPRs),
    ciNotRunningPRs: toNumbers(digest.ciNotRunningPRs),
    mergeConflictPRs: toNumbers(digest.mergeConflictPRs),
    needsRebasePRs: toNumbers(digest.needsRebasePRs),
    missingRequiredFilesPRs: toNumbers(digest.missingRequiredFilesPRs),
    incompleteChecklistPRs: toNumbers(digest.incompleteChecklistPRs),
    needsChangesPRs: toNumbers(digest.needsChangesPRs),
    changesAddressedPRs: toNumbers(digest.changesAddressedPRs),
    waitingOnMaintainerPRs: toNumbers(digest.waitingOnMaintainerPRs),
    approachingDormant: toNumbers(digest.approachingDormant),
    dormantPRs: toNumbers(digest.dormantPRs),
    healthyPRs: toNumbers(digest.healthyPRs),
    recentlyClosedPRs: digest.recentlyClosedPRs,
    recentlyMergedPRs: digest.recentlyMergedPRs,
    shelvedPRs: digest.shelvedPRs,
    autoUnshelvedPRs: digest.autoUnshelvedPRs,
    summary: digest.summary,
  };
}

/**
 * Convert ActionableIssue[] to CompactActionableIssue[] for JSON output (#287).
 * Replaces the full PR object with just the PR number.
 */
export function compactActionableIssues(issues: ActionableIssue[]): CompactActionableIssue[] {
  return issues.map((issue) => ({
    type: issue.type,
    prNumber: issue.pr.number,
    label: issue.label,
  }));
}

/**
 * Convert RepoGroup[] to CompactRepoGroup[] for JSON output (#287).
 * Replaces full PR arrays with PR number arrays.
 */
export function compactRepoGroups(groups: RepoGroup[]): CompactRepoGroup[] {
  return groups.map((group) => ({
    repo: group.repo,
    prNumbers: group.prs.map((pr) => pr.number),
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
 * 3. Success: { version, setupComplete: true, daily, dashboardPath?, issueList? }
 */
export interface StartupOutput {
  version: string;
  setupComplete: boolean;
  authError?: string;
  daily?: DailyOutput;
  dashboardPath?: string;
  issueList?: IssueListInfo;
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
