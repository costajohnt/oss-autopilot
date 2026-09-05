/**
 * Core types for the Open Source Contribution Agent
 */

import {
  AgentConfigSchema,
  AgentStateSchema,
  ProjectCategorySchema,
  IssueScopeSchema,
  DiffToolSchema,
} from './state-schema.js';

import type {
  FetchedPRStatus,
  RepoSignals,
  TrackedIssue,
  IssueVettingResult,
  IssueScope,
  DiffTool,
  AgentConfig,
  AgentState,
} from './state-schema.js';

// ── Re-exports: persisted types backed by Zod schemas ────────────────
// These types are inferred from Zod schemas in state-schema.ts.
// Changing the schema automatically updates the type everywhere.
export type {
  IssueStatus,
  FetchedPRStatus,
  ProjectCategory,
  IssueScope,
  DiffTool,
  RepoSignals,
  RepoScore,
  StoredMergedPR,
  StoredClosedPR,
  AnalyzedIssueConversation,
  ContributionGuidelines,
  IssueVettingResult,
  TrackedIssue,
  ShelvedPRRef,
  StatusOverride,
  AgentConfig,
  LocalRepoCache,
  ClosedPR,
  MergedPR,
  DailyDigest,
  AgentState,
  SearchSeenEntry,
  SearchRotation,
} from './state-schema.js';

// ── Ephemeral types (never persisted, hand-written) ──────────────────

/** CI pipeline status for a PR's latest commit. */
export type CIStatus = 'passing' | 'failing' | 'pending' | 'unknown';

/**
 * Classification of a CI check failure (#81).
 * - `actionable` — Real test/build failure the contributor should fix
 * - `fork_limitation` — Failure due to fork permissions (e.g., Vercel deploy, Netlify)
 * - `auth_gate` — Authorization/approval gate, not a real failure
 * - `infrastructure` — Runner timeout, dependency install failure, or other transient infra issue
 */
export type CIFailureCategory = 'actionable' | 'fork_limitation' | 'auth_gate' | 'infrastructure';

/** A CI check with its failure classification (#81). */
export interface ClassifiedCheck {
  name: string;
  category: CIFailureCategory;
  conclusion?: string;
}

/**
 * Mutually exclusive overall-CI categories produced by
 * {@link categorizeCIStatus} (#1272). The 5-row truth table that lived
 * as prose in `agents/pr-health-checker.md` — extracted so any consumer
 * (the agent, the dashboard, future MCP surfaces) reads one typed field
 * instead of re-deriving the table.
 *
 * - `all_passing` — every reported check is green
 * - `failing` — at least one actionable failure (real test/lint/build
 *   issue), OR ciStatus reported failing without per-check detail (the
 *   honest answer when the legacy combined-status endpoint can't tell
 *   us what failed)
 * - `fork_limitation` — failures exist but ALL of them are
 *   `fork_limitation` / `auth_gate` (Vercel preview, internal CI) — purely
 *   informational
 * - `blocked` — checks are pending (awaiting trigger / completion), OR
 *   non-actionable failures include `infrastructure` (cancelled /
 *   timed-out runner — re-running often resolves)
 * - `not_running` — no checks reported
 */
export type CIStatusCategory = 'all_passing' | 'failing' | 'fork_limitation' | 'blocked' | 'not_running';

/**
 * Suggested action for the {@link CIStatusCategorization}. Hint, not
 * enforcement — the consuming agent may still escalate or skip based on
 * other PR context.
 */
export type CIStatusAction = 'none' | 'investigate' | 'request_rerun' | 'check_workflows' | 'informational';

/**
 * Aggregate CI status produced by {@link categorizeCIStatus} (#1272).
 * Derived from `ciStatus + failingCheckNames + classifiedChecks` —
 * exposed on {@link FetchedPR} so agents read a single field instead
 * of re-implementing the truth table.
 */
export interface CIStatusCategorization {
  category: CIStatusCategory;
  /** Short human-readable summary suitable for inline display. */
  summary: string;
  /** Suggested next action (hint, not enforcement). */
  action: CIStatusAction;
}

/** CI status result returned by getCIStatus(). */
export interface CIStatusResult {
  status: CIStatus;
  failingCheckNames: string[];
  failingCheckConclusions: Map<string, string>;
}

/**
 * PRs grouped by repository (#80).
 * Used to prevent parallel git state corruption when multiple PRs exist in the same repo.
 */
export interface RepoGroup {
  repo: string;
  prs: FetchedPR[];
}

/** GitHub's pull request review decision (from the reviewDecision GraphQL field). */
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'unknown';

/** Input options for `determineStatus()` (see status-determination.ts). */
export interface DetermineStatusInput {
  ciStatus: CIStatus;
  hasMergeConflict: boolean;
  hasUnrespondedComment: boolean;
  hasIncompleteChecklist: boolean;
  reviewDecision: ReviewDecision;
  daysSinceActivity: number;
  dormantThreshold: number;
  approachingThreshold: number;
  latestCommitDate?: string;
  /** GitHub login of the HEAD commit's author (from `repos.getCommit`). */
  latestCommitAuthor?: string;
  /** GitHub login of the PR contributor (configured username). */
  contributorUsername?: string;
  lastMaintainerCommentDate?: string;
  latestChangesRequestedDate?: string;
  /** True if at least one failing CI check is classified as 'actionable'. */
  hasActionableCIFailure?: boolean;
}

/** Result of `determineStatus()` — the PR's computed status classification. */
export interface DetermineStatusResult {
  status: FetchedPRStatus;
  actionReason?: ActionReason;
  waitReason?: WaitReason;
  stalenessTier: StalenessTier;
  /** All applicable action reasons, ordered by priority. */
  actionReasons?: ActionReason[];
}

/**
 * Granular reason why a PR needs addressing (contributor's turn).
 * Active values (produced by determineStatus): needs_response, needs_changes,
 * failing_ci, merge_conflict, incomplete_checklist.
 * Reserved (display mappings exist but detection not yet wired): ci_not_running,
 * needs_rebase, missing_required_files.
 */
export type ActionReason =
  | 'needs_response'
  | 'needs_changes'
  | 'failing_ci'
  | 'merge_conflict'
  | 'incomplete_checklist'
  | 'ci_not_running'
  | 'needs_rebase'
  | 'missing_required_files';

/** Granular reason why a PR is waiting on the maintainer. */
export type WaitReason = 'pending_review' | 'pending_merge' | 'changes_addressed' | 'ci_blocked' | 'stale_ci_failure';

/** How stale is the PR based on days since activity. Orthogonal to status. */
export type StalenessTier = 'active' | 'approaching_dormant' | 'dormant';

/**
 * Hints about what a maintainer is asking for in their review comments.
 * Extracted from comment text by keyword matching.
 */
export type MaintainerActionHint =
  | 'demo_requested' // See extractMaintainerActionHints() in pr-monitor.ts for full keyword list
  | 'tests_requested' // See extractMaintainerActionHints() in pr-monitor.ts for full keyword list
  | 'changes_requested' // Generic code changes (from review decision)
  | 'docs_requested' // See extractMaintainerActionHints() in pr-monitor.ts for full keyword list
  | 'rebase_requested'; // See extractMaintainerActionHints() in pr-monitor.ts for full keyword list

/**
 * Ephemeral PR data fetched fresh from GitHub on each run (v2 architecture).
 * This is never persisted in local state — it represents a point-in-time snapshot
 * of a PR's current condition.
 */
/** Unified attention bucket (#1352) — see core/pr-attention.ts for the classifier. */
export type AttentionBucket = 'needs_attention' | 'stuck_ci' | 'dormant_followup' | 'waiting';

export interface FetchedPR {
  // Identity
  id: number;
  url: string;
  repo: string; // "owner/repo"
  number: number;
  title: string;

  /** Computed by `determineStatus()` based on the fields below. */
  status: FetchedPRStatus;
  /** Granular reason for needs_addressing status. Undefined when waiting_on_maintainer. */
  actionReason?: ActionReason;
  /** Granular reason for waiting_on_maintainer status. Undefined when needs_addressing. */
  waitReason?: WaitReason;
  /** All applicable action reasons, ordered by priority. Primary reason is first. */
  actionReasons?: ActionReason[];
  /** How stale the PR is based on activity age. Independent of status — a PR can be both needs_addressing and dormant. */
  stalenessTier: StalenessTier;
  /** Unified attention bucket (#1352), computed by `classifyAttentionBucket()`
   * from status/ciStatus/reviewDecision/daysSinceActivity. Stamped by the
   * dashboard data path so the SPA renders the same taxonomy the CLI brief
   * counts. Optional: absent on payloads from older producers. */
  attentionBucket?: AttentionBucket;

  /** Human-readable status label for consistent display (#79). E.g., "[CI Failing]", "[Needs Response]". */
  displayLabel: string;
  /** Brief description of what's happening (#79). E.g., "3 checks failed", "@maintainer commented". */
  displayDescription: string;

  // Timestamps
  createdAt: string;
  updatedAt: string;

  /**
   * Earliest maintainer (non-bot, non-contributor) comment or review on this
   * PR (#1461). Computed by fetchPRDetails from the comment/review timeline
   * it already fetches. Persisted with the digest's openPRs so merge/close
   * detection can recover it for the outcome ledger after the PR leaves the
   * open set. Undefined when no maintainer has responded yet.
   */
  firstMaintainerResponseAt?: string;

  /** Calendar days since the most recent activity (comment, commit, review). */
  daysSinceActivity: number;

  // CI and merge status
  ciStatus: CIStatus;
  /** Names of failing CI checks. Useful for distinguishing real CI failures from validation bots. */
  failingCheckNames: string[];
  /** Failing checks with category classification (#81). Separates actionable failures from fork limitations and auth gates. */
  classifiedChecks: ClassifiedCheck[];
  /**
   * Aggregate 5-state CI categorization (#1272). Derived from `ciStatus`,
   * `failingCheckNames`, and `classifiedChecks` via `categorizeCIStatus()`
   * — agents read this directly instead of re-deriving the truth table.
   * Always populated on a fresh fetch (v2 architecture has no cached
   * `FetchedPR` to migrate); pr-monitor's `fetchPRDetails` sets it on
   * every PR before construction.
   */
  ciCategorization: CIStatusCategorization;
  hasMergeConflict: boolean;
  reviewDecision: ReviewDecision;

  // Branch freshness
  /** How many commits the PR branch is behind the base branch. */
  commitsBehindUpstream?: number;
  headRefName?: string;
  /** Target branch name (e.g., "main", "master"). */
  baseRefName?: string;

  /** Absolute path to local clone, if the repo is cloned on this machine. */
  localRepoPath?: string;

  /** Required files the PR is missing (e.g., `["changeset", "CLA"]`). */
  missingRequiredFiles?: string[];

  /** True when a maintainer commented after the contributor's last comment or commit. */
  hasUnrespondedComment: boolean;
  lastMaintainerComment?: {
    author: string;
    body: string;
    createdAt: string;
  };

  /** ISO timestamp of the latest commit. Used to determine if changes were pushed after review feedback. */
  latestCommitDate?: string;

  /** True when the PR body contains unchecked required checkboxes. */
  hasIncompleteChecklist: boolean;
  checklistStats?: {
    checked: number;
    total: number;
  };

  /** Hints extracted from maintainer comments about what actions they are requesting. */
  maintainerActionHints: MaintainerActionHint[];
}

/** Health snapshot of a GitHub repository, used to determine if a project is worth contributing to. */
export interface ProjectHealth {
  repo: string;
  lastCommitAt: string;
  daysSinceLastCommit: number;
  openIssuesCount: number;
  /** Average number of days for maintainers to respond to issues. */
  avgIssueResponseDays: number;
  ciStatus: 'passing' | 'failing' | 'unknown';
  /** Whether the project is considered active based on recent commit history. */
  isActive: boolean;
  /** GitHub star count, used for repo quality scoring (#98). */
  stargazersCount?: number;
  /** GitHub fork count, used for repo quality scoring (#98). */
  forksCount?: number;
  /** Primary programming language as reported by GitHub. */
  language?: string | null;
  /** True if the health check itself failed (e.g., API error). */
  checkFailed?: boolean;
  failureReason?: string;
}

/** Signals computed from observed open PR data, suitable for merging into RepoScore.signals. */
export type ComputedRepoSignals = Pick<RepoSignals, 'isResponsive' | 'hasActiveMaintainers'>;

/**
 * Subset of RepoScore fields that callers may update via `updateRepoScore()`.
 * Excludes `score` (always derived), `repo` (immutable key), and `lastEvaluatedAt` (auto-set).
 * The `signals` field accepts a partial update — only provided fields are merged.
 */
export interface RepoScoreUpdate {
  mergedPRCount?: number;
  closedWithoutMergeCount?: number;
  avgResponseDays?: number | null;
  lastMergedAt?: string;
  signals?: Partial<RepoSignals>;
  stargazersCount?: number;
  /** Primary programming language of the repo. */
  language?: string | null;
}

/** Repo metadata entry used in dashboard API responses. Shared between server and SPA. */
export interface RepoMetadataEntry {
  /** Star count, derived from RepoScore.stargazersCount. */
  stars?: number;
  language?: string | null;
}

/** Filter for excluding repos below a minimum star count from PR count queries. */
export interface StarFilter {
  minStars: number;
  knownStarCounts: ReadonlyMap<string, number>;
}

/**
 * Check if a repo should be excluded based on its star count.
 * Returns true if the repo is below the threshold or has unknown star count.
 */
export function isBelowMinStars(stargazersCount: number | undefined, minStars: number): boolean {
  return stargazersCount === undefined || stargazersCount < minStars;
}

/** Status of a user's comment thread on a GitHub issue. */
export type IssueConversationStatus =
  | 'new_response' // Someone responded after user's last comment (check isFromMaintainer to distinguish maintainer vs community)
  | 'waiting' // Last non-bot commenter is not the user; no substantive (non-acknowledgment) response found
  | 'acknowledged'; // User was the last non-bot commenter; no action needed

/** Base fields shared by all issue conversation states. */
interface CommentedIssueBase {
  repo: string; // "owner/repo"
  number: number;
  title: string;
  url: string;
  userLastCommentedAt: string;
  /** User's most recent comment body, truncated to 200 chars (+ "..." suffix when truncated). #1290 */
  userLastCommentBody: string;
  labels: string[];
  daysSinceUserComment: number;
}

/** Issue where someone responded after the user's last comment. */
export interface CommentedIssueWithResponse extends CommentedIssueBase {
  status: 'new_response';
  lastResponseAuthor: string;
  lastResponseBody: string; // Truncated to 200 chars (+ "..." suffix when truncated)
  lastResponseAt: string;
  /**
   * True when the responder has OWNER, MEMBER, or COLLABORATOR author_association
   * on the repository (i.e., someone with repo-level permissions, not just a community user).
   */
  isFromMaintainer: boolean;
}

/** Issue where no substantive maintainer response was found. */
interface CommentedIssueWithoutResponse extends CommentedIssueBase {
  status: 'waiting' | 'acknowledged';
  lastResponseAuthor?: undefined;
  lastResponseBody?: undefined;
  lastResponseAt?: undefined;
}

/** A GitHub issue the user has commented on, with conversation state. */
export type CommentedIssue = CommentedIssueWithResponse | CommentedIssueWithoutResponse;

// ── Schema-derived constants ─────────────────────────────────────────

/** Default configuration applied to new state files. All fields can be overridden via `/setup-oss`. */
export const DEFAULT_CONFIG = AgentConfigSchema.parse({}) as AgentConfig;

/** Initial state written to `~/.oss-autopilot/state.json` on first run. Uses v4 architecture. */
export const INITIAL_STATE = AgentStateSchema.parse({ version: 4 }) as AgentState;

// ── Const arrays (derived from Zod schemas for runtime iteration) ────

export const PROJECT_CATEGORIES = ProjectCategorySchema.options;

export const ISSUE_SCOPES = IssueScopeSchema.options;

export const DIFF_TOOLS: readonly DiffTool[] = DiffToolSchema.options;

export const SCOPE_LABELS: Record<IssueScope, string[]> = {
  beginner: ['good first issue', 'help wanted', 'easy', 'up-for-grabs', 'first-timers-only', 'beginner'],
  intermediate: ['enhancement', 'feature', 'feature-request', 'contributions welcome'],
  advanced: ['proposal', 'RFC', 'accepted', 'design'],
};

// ── Issue discovery types (used by formatters and test utilities) ──

/** Priority tier for issue search results. Ordered: merged_pr > preferred_org > starred > normal. */
export type SearchPriority = 'merged_pr' | 'preferred_org' | 'starred' | 'normal';

export interface IssueCandidate {
  issue: TrackedIssue;
  vettingResult: IssueVettingResult;
  projectHealth: ProjectHealth;
  recommendation: 'approve' | 'skip' | 'needs_review';
  reasonsToSkip: string[];
  reasonsToApprove: string[];
  viabilityScore: number; // 0-100 scale
  searchPriority: SearchPriority; // Priority level for sorting
}

// ── Daily aggregation types (formerly in formatters/json.ts; relocated #1117) ──
// These describe domain data that core/daily-aggregations.ts produces. They
// previously sat in formatters/json.ts, which forced core/ to import from
// formatters/ — a cross-layer dependency we've now removed.

export interface CapacityAssessment {
  hasCapacity: boolean;
  activePRCount: number;
  maxActivePRs: number;
  shelvedPRCount: number;
  criticalIssueCount: number;
  reason: string;
}

export type ActionableIssueType =
  'ci_failing' | 'merge_conflict' | 'needs_response' | 'needs_changes' | 'incomplete_checklist';

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
 */
export interface ActionMenu {
  /** Ordered list of menu items. */
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
