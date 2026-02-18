/**
 * JSON output formatter for CLI --json mode
 * Provides structured output that can be consumed by scripts and plugins
 */

import type { TrackedPR, FetchedPR, DailyDigest, AgentState, RepoGroup } from '../core/types.js';
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
  criticalIssueCount: number;
  reason: string;
}

export type ActionableIssueType = 'ci_failing' | 'merge_conflict' | 'needs_response' | 'needs_changes' | 'incomplete_checklist' | 'approaching_dormant';

export interface ActionableIssue {
  type: ActionableIssueType;
  pr: FetchedPR;
  label: string; // e.g., "[CI Failing]"
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
  /** Ordered list of menu items. The orchestration may insert issue-list items after `address_all` (index 1) or at the start (index 0) when no actionable issues exist. */
  items: ActionMenuItem[];
  /** Context flags for the orchestration layer to decide on issue-list options. */
  context: {
    hasActionableIssues: boolean;
    actionableCount: number;
    hasCapacity: boolean;
  };
}

export interface DailyOutput {
  digest: DailyDigest;
  updates: unknown[]; // Legacy field, always empty in v2
  capacity: CapacityAssessment;
  summary: string; // Pre-formatted markdown for Claude to display verbatim
  briefSummary: string; // One-liner for action-first flow
  actionableIssues: ActionableIssue[]; // Structured list for AskUserQuestion
  actionMenu: ActionMenu; // Pre-computed action menu for Step 3
  repoGroups: RepoGroup[]; // PRs grouped by repo for safe parallel dispatch (#80)
  failures: PRCheckFailure[]; // PRs that failed to fetch (e.g., rate limits, network errors)
}

export interface StatusOutput {
  stats: {
    activePRs: number;
    dormantPRs: number;
    mergedPRs: number;
    closedPRs: number;
    activeIssues: number;
    trustedProjects: number;
    mergeRate: string;
    needsResponse: number;
  };
  activePRs: TrackedPR[];
  dormantPRs: TrackedPR[];
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
  pr: TrackedPR;
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
