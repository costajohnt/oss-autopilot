/**
 * Dashboard-specific type definitions.
 *
 * These types are duplicated from @oss-autopilot/core to keep the frontend
 * bundle clean — no Node.js dependencies or server-side code gets pulled in.
 */

// -- Enums and union types --

/** Computed status for a FetchedPR, determined by PRMonitor.determineStatus(). */
export type FetchedPRStatus =
  | 'needs_response'
  | 'failing_ci'
  | 'ci_blocked'
  | 'ci_not_running'
  | 'merge_conflict'
  | 'needs_rebase'
  | 'missing_required_files'
  | 'incomplete_checklist'
  | 'needs_changes'
  | 'changes_addressed'
  | 'waiting'
  | 'waiting_on_maintainer'
  | 'healthy'
  | 'approaching_dormant'
  | 'dormant';

/** CI pipeline status for a PR's latest commit. */
export type CIStatus = 'passing' | 'failing' | 'pending' | 'unknown';

/** GitHub's pull request review decision. */
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'unknown';

/**
 * Classification of a CI check failure.
 * - actionable: Real test/build failure the contributor should fix
 * - fork_limitation: Failure due to fork permissions (e.g., Vercel deploy)
 * - auth_gate: Authorization/approval gate, not a real failure
 * - infrastructure: Runner timeout, dependency install failure, transient infra issue
 */
export type CIFailureCategory = 'actionable' | 'fork_limitation' | 'auth_gate' | 'infrastructure';

/**
 * Hints about what a maintainer is asking for in their review comments.
 */
export type MaintainerActionHint =
  | 'demo_requested'
  | 'tests_requested'
  | 'changes_requested'
  | 'docs_requested'
  | 'rebase_requested';

/** Status of a user's comment thread on a GitHub issue. */
export type IssueConversationStatus = 'new_response' | 'waiting' | 'acknowledged';

// -- Interfaces --

/** A CI check with its failure classification. */
export interface ClassifiedCheck {
  name: string;
  category: CIFailureCategory;
  conclusion?: string;
}

/**
 * Lightweight reference for shelved PRs.
 * Contains only the fields needed for display.
 */
export interface ShelvedPRRef {
  number: number;
  url: string;
  title: string;
  repo: string;
  daysSinceActivity: number;
  status: FetchedPRStatus;
}

/**
 * Ephemeral PR data fetched fresh from GitHub on each run.
 * This is the primary data type for dashboard PR display.
 */
export interface FetchedPR {
  // Identity
  id: number;
  url: string;
  repo: string;
  number: number;
  title: string;

  /** Computed status. */
  status: FetchedPRStatus;

  /** Human-readable status label. E.g., "[CI Failing]", "[Needs Response]". */
  displayLabel: string;
  /** Brief description of what's happening. E.g., "3 checks failed". */
  displayDescription: string;

  // Timestamps
  createdAt: string;
  updatedAt: string;

  /** Calendar days since the most recent activity. */
  daysSinceActivity: number;

  // CI and merge status
  ciStatus: CIStatus;
  failingCheckNames: string[];
  classifiedChecks: ClassifiedCheck[];
  hasMergeConflict: boolean;
  reviewDecision: ReviewDecision;

  // Branch freshness
  commitsBehindUpstream?: number;
  headRefName?: string;
  baseRefName?: string;

  localRepoPath?: string;

  missingRequiredFiles?: string[];

  hasUnrespondedComment: boolean;
  lastMaintainerComment?: {
    author: string;
    body: string;
    createdAt: string;
  };

  latestCommitDate?: string;

  hasIncompleteChecklist: boolean;
  checklistStats?: {
    checked: number;
    total: number;
  };

  maintainerActionHints: MaintainerActionHint[];
}

// -- Dashboard stats --

export interface DashboardStats {
  activePRs: number;
  shelvedPRs: number;
  mergedPRs: number;
  closedPRs: number;
  mergeRate: string;
}

// -- Issue conversation types --

/** Base fields shared by all issue conversation states. */
interface CommentedIssueBase {
  repo: string;
  number: number;
  title: string;
  url: string;
  userLastCommentedAt: string;
  labels: string[];
  daysSinceUserComment: number;
}

/** Issue where someone responded after the user's last comment. */
export interface CommentedIssueWithResponse extends CommentedIssueBase {
  status: 'new_response';
  lastResponseAuthor: string;
  lastResponseBody: string;
  lastResponseAt: string;
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

// -- Recently merged/closed PR types --

/** Minimal record of a PR that was merged, used in the daily digest. */
export interface MergedPR {
  url: string;
  repo: string;
  number: number;
  title: string;
  mergedAt: string;
}

/** Minimal record of a PR that was closed without merge. */
export interface ClosedPR {
  url: string;
  repo: string;
  number: number;
  title: string;
  closedAt: string;
  closedBy?: string;
}

// -- Dashboard API response --

/** The shape of the GET /api/data response from the dashboard server. */
export interface DashboardData {
  stats: DashboardStats;
  prsByRepo: Record<string, { active: number; merged: number; closed: number }>;
  topRepos: Array<{ repo: string; active: number; merged: number; closed: number }>;
  monthlyMerged: Record<string, number>;
  monthlyOpened: Record<string, number>;
  monthlyClosed: Record<string, number>;
  activePRs: FetchedPR[];
  shelvedPRUrls: string[];
  recentlyMergedPRs: MergedPR[];
  recentlyClosedPRs: ClosedPR[];
  autoUnshelvedPRs: ShelvedPRRef[];
  commentedIssues: CommentedIssue[];
  issueResponses: CommentedIssueWithResponse[];
}

// -- Action types (for POST /api/action) --

/** Actions a user can take from the dashboard. */
export type ActionType = 'shelve' | 'unshelve' | 'snooze' | 'unsnooze';

/** Request body for POST /api/action. */
export interface ActionRequest {
  action: ActionType;
  url: string;
  reason?: string;
  days?: number;
}
