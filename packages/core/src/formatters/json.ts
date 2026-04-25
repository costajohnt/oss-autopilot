/**
 * JSON output formatter for CLI --json mode
 * Provides structured output that can be consumed by scripts and plugins
 */

import { z, type ZodType } from 'zod';
import type { FetchedPR, DailyDigest, AgentState, RepoGroup, CommentedIssue, ShelvedPRRef } from '../core/types.js';
import type { ContributionStats } from '../core/stats.js';
import type { PRCheckFailure } from '../core/pr-monitor.js';
import type {
  SearchPriority,
  CapacityAssessment,
  ActionableIssue,
  ActionableIssueType,
  CompactActionableIssue,
  ActionMenuItem,
  ActionMenu,
} from '../core/types.js';
import type { CIFormatterDiagnosis, FormatterDetectionResult } from '../core/formatter-detection.js';

// Re-export the daily aggregation types from their canonical home in core/types.
// External consumers and downstream tests have historically imported them from
// here; the re-exports keep that surface stable while removing the cross-layer
// dependency in core/ (#1117).
export type {
  CapacityAssessment,
  ActionableIssue,
  ActionableIssueType,
  CompactActionableIssue,
  ActionMenuItem,
  ActionMenu,
};

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'VALIDATION'
  | 'CONFIGURATION'
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'STATE_CORRUPTED'
  | 'CONCURRENCY'
  | 'UNKNOWN';

export interface JsonOutput<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: ErrorCode;
  timestamp: string;
}

// CapacityAssessment, ActionableIssue, ActionableIssueType,
// CompactActionableIssue, ActionMenuItem, and ActionMenu are now defined in
// `../core/types.ts` and re-exported above. Their definitions used to live
// here, but core/ already produces these values in daily-aggregations.ts —
// keeping the canonical type next to its producer (#1117).

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

/**
 * Phase tags for non-fatal warnings emitted during a `daily` run.
 * See `DailyWarning` and issue #1042 for the rationale — keeping this a
 * fixed union so downstream consumers can switch on it without drift.
 */
export type DailyWarningPhase =
  | 'fetch'
  | 'repo-scores'
  | 'analytics'
  | 'scout-sync'
  | 'partition'
  | 'dismiss-filter'
  | 'gist-checkpoint';

/**
 * A single non-fatal failure surfaced from the `daily` pipeline. Unlike
 * `PRCheckFailure` (which is scoped to per-PR fetch errors), this covers
 * ancillary fetches that previously demoted to a log-only `warn()` — repo
 * metadata, monthly analytics, scout sync, Gist checkpoint, etc.
 */
export interface DailyWarning {
  phase: DailyWarningPhase;
  operation: string;
  message: string;
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
  /**
   * Non-fatal warnings from ancillary pipeline phases (repo metadata,
   * analytics, scout sync, Gist checkpoint, etc.). Always an array — empty
   * on clean runs. See #1042.
   */
  warnings: DailyWarning[];
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
  /**
   * Non-fatal warnings from ancillary pipeline phases — full list retained so
   * downstream consumers (dashboard, MCP) can surface degradation even under
   * the `--compact` payload. See #1042.
   */
  warnings: DailyWarning[];
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
    warnings: output.warnings,
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

export const StatusOutputSchema = z.object({
  stats: z.object({
    mergedPRs: z.number().int().nonnegative(),
    closedPRs: z.number().int().nonnegative(),
    activeIssues: z.number().int().nonnegative(),
    trustedProjects: z.number().int().nonnegative(),
    mergeRate: z.string(),
    needsResponse: z.number().int().nonnegative(),
  }),
  lastRunAt: z.string(),
  offline: z.boolean().optional(),
  lastUpdated: z.string().optional(),
});

export type StatusOutput = z.infer<typeof StatusOutputSchema>;

export interface SearchOutput {
  candidates: Array<{
    issue: {
      repo: string;
      repoUrl: string;
      number: number;
      title: string;
      url: string;
      labels: string[];
    };
    recommendation: 'approve' | 'skip' | 'needs_review';
    reasonsToApprove: string[];
    reasonsToSkip: string[];
    searchPriority: SearchPriority;
    /** 0-100 scale composite viability score. Sanitized on the boundary (#1043): out-of-contract values are coerced to 0 and logged. */
    viabilityScore: number;
    /**
     * Letter grade (A/B/C/F) computed from the autopilot-tracked repoScore.
     * Scout's `search` does not emit per-candidate projectHealth, so scout-side
     * signals are treated as unknown; unscored repos grade 'F'. See #1043.
     */
    grade: {
      letter: 'A' | 'B' | 'C' | 'F';
      reason: string;
    };
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
  skippedIssuesPath?: string;
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
  /**
   * Set when the dashboard launch or refresh failed (assets missing, port
   * conflict, spawn error, etc.). The dashboard is always attempted, so JSON
   * consumers — which previously saw only a missing `dashboardUrl` — now have
   * a structured signal to surface or recover from the failure.
   */
  dashboardError?: string;
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
    dashboardError: output.dashboardError,
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
  score?: number;
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
  pruneResult?: {
    removedCount: number;
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
  /** Success-likelihood grade (#858): predicts whether a PR will merge. */
  grade: {
    letter: 'A' | 'B' | 'C' | 'F';
    reason: string;
  };
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
export function jsonError(message: string, errorCode?: ErrorCode): JsonOutput<never> {
  return {
    success: false,
    error: message,
    errorCode,
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
export function outputJsonError(message: string, errorCode?: ErrorCode): void {
  console.log(JSON.stringify(jsonError(message, errorCode), null, 2));
}

/**
 * Validate `data` against a Zod schema and wrap the result in the standard
 * JSON output envelope (#1105 long-term ask from #965).
 *
 * Throws a contract-drift `Error` if `data` doesn't match the schema. The
 * error's message lists the failing field paths so a developer can find the
 * drift quickly. Use this at the `--json` boundary of every CLI command —
 * whenever the producer adds, renames, or drops a field that doesn't match
 * the schema, the test harness fails immediately rather than silently
 * shipping a contract break to consumers (plugin layer, MCP server,
 * downstream scripts).
 *
 * @example
 *   import { formatJson, StatusOutputSchema } from '../formatters/json.js';
 *   const envelope = formatJson(StatusOutputSchema, await runStatus());
 *   console.log(JSON.stringify(envelope, null, 2));
 */
export function formatJson<T>(schema: ZodType<T>, data: unknown): JsonOutput<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`--json contract drift: command output does not match its declared schema. ${issues}`);
  }
  return jsonSuccess(result.data);
}

/**
 * `outputJson(data)` plus Zod validation. Same throwing semantics as
 * {@link formatJson}; the validated envelope is what gets printed.
 */
export function outputJsonValidated<T>(schema: ZodType<T>, data: unknown): void {
  console.log(JSON.stringify(formatJson(schema, data), null, 2));
}
