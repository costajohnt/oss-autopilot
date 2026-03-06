/**
 * Core types for the Open Source Contribution Agent
 */

/**
 * Lifecycle of a discovered issue through the contribution pipeline.
 * - `candidate` — Discovered but not yet claimed
 * - `claimed` — Contributor has claimed the issue (e.g., commented "I'll work on this")
 * - `in_progress` — Work is underway locally
 * - `pr_submitted` — A PR has been opened for this issue
 */
export type IssueStatus = 'candidate' | 'claimed' | 'in_progress' | 'pr_submitted';

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

/** Return type for PRMonitor.getCIStatus(). */
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

/** Input options for `PRMonitor.determineStatus()`. */
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
export type WaitReason = 'pending_review' | 'pending_merge' | 'changes_addressed' | 'ci_blocked';

/** How stale is the PR based on days since activity. Orthogonal to status. */
export type StalenessTier = 'active' | 'approaching_dormant' | 'dormant';

/**
 * Top-level classification of a PR's state. Only two values:
 * - `needs_addressing` — Contributor's turn. See `actionReason` for what to do.
 * - `waiting_on_maintainer` — Maintainer's turn. See `waitReason` for why.
 *
 * Staleness (active/approaching_dormant/dormant) is tracked separately in `stalenessTier`.
 */
export type FetchedPRStatus = 'needs_addressing' | 'waiting_on_maintainer';

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
export interface FetchedPR {
  // Identity
  id: number;
  url: string;
  repo: string; // "owner/repo"
  number: number;
  title: string;

  /** Computed by `PRMonitor.determineStatus()` based on the fields below. */
  status: FetchedPRStatus;
  /** Granular reason for needs_addressing status. Undefined when waiting_on_maintainer. */
  actionReason?: ActionReason;
  /** Granular reason for waiting_on_maintainer status. Undefined when needs_addressing. */
  waitReason?: WaitReason;
  /** How stale the PR is based on activity age. Independent of status — a PR can be both needs_addressing and dormant. */
  stalenessTier: StalenessTier;

  /** Human-readable status label for consistent display (#79). E.g., "[CI Failing]", "[Needs Response]". */
  displayLabel: string;
  /** Brief description of what's happening (#79). E.g., "3 checks failed", "@maintainer commented". */
  displayDescription: string;

  // Timestamps
  createdAt: string;
  updatedAt: string;

  /** Calendar days since the most recent activity (comment, commit, review). */
  daysSinceActivity: number;

  // CI and merge status
  ciStatus: CIStatus;
  /** Names of failing CI checks. Useful for distinguishing real CI failures from validation bots. */
  failingCheckNames: string[];
  /** Failing checks with category classification (#81). Separates actionable failures from fork limitations and auth gates. */
  classifiedChecks: ClassifiedCheck[];
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

/**
 * Lightweight reference used in {@link DailyDigest} for shelved and auto-unshelved PRs.
 * Contains only the fields needed for display, avoiding duplication of the full
 * {@link FetchedPR} objects already present in `openPRs` and the status-specific arrays.
 */
export interface ShelvedPRRef {
  number: number;
  url: string;
  title: string;
  repo: string;
  daysSinceActivity: number;
  status: FetchedPRStatus;
}
/** An issue tracked through the contribution pipeline from discovery to PR submission. */
export interface TrackedIssue {
  // Identity
  id: number;
  url: string;
  repo: string; // "owner/repo"
  number: number;
  title: string;

  status: IssueStatus;

  labels: string[];
  createdAt: string;
  updatedAt: string;

  /** Whether the issue has been through the vetting process (checking for existing PRs, activity, etc.). */
  vetted: boolean;
  vettingResult?: IssueVettingResult;
}

/**
 * Result of vetting an issue for contribution suitability.
 * An issue passes vetting when all checks are true (no existing PR, not claimed, etc.).
 */
export interface IssueVettingResult {
  passedAllChecks: boolean;
  checks: {
    noExistingPR: boolean;
    notClaimed: boolean;
    projectActive: boolean;
    clearRequirements: boolean;
    contributionGuidelinesFound: boolean;
  };
  contributionGuidelines?: ContributionGuidelines;
  /** Free-text observations from the vetting process (e.g., "Issue has 3 linked PRs, all closed"). */
  notes: string[];
}

/**
 * Structured representation of a project's contribution guidelines,
 * extracted from CONTRIBUTING.md or similar files during issue vetting.
 */
export interface ContributionGuidelines {
  // From CONTRIBUTING.md
  branchNamingConvention?: string;
  commitMessageFormat?: string;
  prTitleFormat?: string;
  requiredChecks?: string[];

  // Testing requirements
  testFramework?: string;
  testCoverageRequired?: boolean;
  /** Expected test file naming pattern (e.g., `"*.test.ts"`, `"*_spec.rb"`). */
  testFileNaming?: string;

  // Code style
  linter?: string;
  formatter?: string;
  styleGuideUrl?: string;

  // Process
  /** How to claim an issue (e.g., "Comment on the issue before starting work"). */
  issueClaimProcess?: string;
  reviewProcess?: string;
  claRequired?: boolean;

  /** Raw CONTRIBUTING.md content for reference when structured fields are insufficient. */
  rawContent?: string;
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
  /** True if the health check itself failed (e.g., API error). */
  checkFailed?: boolean;
  failureReason?: string;
}

/**
 * Quality score for a repository, used to prioritize issue search results.
 * Score is on a 1-10 scale: base 5, logarithmic merge bonus (max +5: 1->+2, 2->+3, 3->+4, 5+->+5),
 * -1 per closed-without-merge (max -3), +1 if lastMergedAt is set and within 90 days,
 * +1 if responsive, -2 if hostile.
 * Repos below `AgentConfig.minRepoScoreThreshold` are deprioritized.
 */
export interface RepoScore {
  repo: string;
  /** Overall score from 1 (avoid) to 10 (excellent track record). */
  score: number;
  /** Number of the contributor's PRs that were merged in this repo. */
  mergedPRCount: number;
  /** Number of the contributor's PRs closed without merge (indicates friction). */
  closedWithoutMergeCount: number;
  /** Average days for maintainers to respond; null if no data. */
  avgResponseDays: number | null;
  lastMergedAt?: string;
  lastEvaluatedAt: string;
  /** Qualitative signals about the repo's maintainer culture. */
  signals: RepoSignals;
  /** GitHub star count, fetched during daily check for dashboard filtering. */
  stargazersCount?: number;
}

/** Full set of qualitative signals about a repo's maintainer culture. */
export interface RepoSignals {
  hasActiveMaintainers: boolean;
  isResponsive: boolean;
  hasHostileComments: boolean;
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
}

/**
 * Event types recorded in the {@link AgentState} audit log.
 * - `pr_tracked` — A new PR was added to tracking
 * - `pr_merged` — A tracked PR was merged
 * - `pr_closed` — A tracked PR was closed without merge
 * - `pr_dormant` — A PR crossed the dormant threshold
 * - `daily_check` — A daily digest run completed
 * - `comment_posted` — The agent posted a comment on a PR
 */
export type StateEventType = 'pr_tracked' | 'pr_merged' | 'pr_closed' | 'pr_dormant' | 'daily_check' | 'comment_posted';

/** An entry in the state audit log. Events are append-only and used for history tracking. */
export interface StateEvent {
  id: string;
  type: StateEventType;
  /** ISO 8601 timestamp of when the event occurred. */
  at: string;
  /** Event-specific payload (e.g., `{ repo: "owner/repo", number: 42 }` for PR events). */
  data: Record<string, unknown>;
}

/** Minimal record of a PR that was closed without being merged, used in the daily digest. */
export interface ClosedPR {
  url: string;
  repo: string; // "owner/repo"
  number: number;
  title: string;
  closedAt: string;
  closedBy?: string;
}

/** Minimal record of a PR that was merged, used in the daily digest. */
export interface MergedPR {
  url: string;
  repo: string; // "owner/repo"
  number: number;
  title: string;
  mergedAt: string;
}

/**
 * The daily report produced by `PRMonitor.generateDigest()`.
 * Contains all open PRs fetched fresh from GitHub, categorized by status,
 * plus recently closed PRs and summary statistics. This is persisted in
 * `AgentState.lastDigest` so the HTML dashboard can render it.
 */
export interface DailyDigest {
  generatedAt: string;

  /** All open PRs authored by the user, fetched from GitHub Search API. */
  openPRs: FetchedPR[];

  /** PRs where the contributor needs to take action. Subset of openPRs where status === 'needs_addressing'. */
  needsAddressingPRs: FetchedPR[];
  /** PRs waiting on the maintainer. Subset of openPRs where status === 'waiting_on_maintainer'. */
  waitingOnMaintainerPRs: FetchedPR[];

  /** PRs closed without merge in the last 7 days. Surfaced to alert the contributor. */
  recentlyClosedPRs: ClosedPR[];

  /** PRs merged in the last 7 days. Surfaced as wins in the dashboard. */
  recentlyMergedPRs: MergedPR[];

  /**
   * PRs manually shelved by the user (excluded from capacity and actionable issues).
   * Stored as lightweight references — full data is available in `openPRs`.
   */
  shelvedPRs: ShelvedPRRef[];
  /**
   * PRs that were auto-unshelved this run because a maintainer engaged.
   * Stored as lightweight references — full data is available in `openPRs`.
   */
  autoUnshelvedPRs: ShelvedPRRef[];

  summary: {
    totalActivePRs: number;
    /** Count of PRs requiring contributor action (response, CI fix, conflict resolution, etc.). */
    totalNeedingAttention: number;
    /** Lifetime merged PR count across all repos, derived from RepoScore data. */
    totalMergedAllTime: number;
    /** Percentage of all-time PRs that were merged (merged / (merged + closed)). */
    mergeRate: number;
  };
}

/**
 * Root state object persisted to `~/.oss-autopilot/state.json`.
 *
 * In v2 (current), PRs are fetched fresh from GitHub on each run via the Search API.
 * The primary runtime data lives in `lastDigest` and `repoScores`.
 */
export interface AgentState {
  /** Schema version. `2` = v2 fresh-fetch architecture. Used by `StateManager` for migrations. */
  version: number;

  /** Per-repo quality scores keyed by `"owner/repo"`. Used to prioritize issue search results. */
  repoScores: Record<string, RepoScore>;

  config: AgentConfig;

  /** Append-only audit log of significant events (PR merged, daily check, etc.). */
  events: StateEvent[];

  /** ISO timestamp of the last CLI invocation. */
  lastRunAt: string;
  /** ISO timestamp of the last daily digest generation. */
  lastDigestAt?: string;

  /** Cached daily digest so the HTML dashboard can render without re-fetching from GitHub. */
  lastDigest?: DailyDigest;

  /** Monthly merged PR counts keyed by `"YYYY-MM"`. Powers the contribution timeline chart. */
  monthlyMergedCounts?: Record<string, number>;

  /** Monthly closed (without merge) PR counts keyed by `"YYYY-MM"`. Powers the timeline and success rate charts. */
  monthlyClosedCounts?: Record<string, number>;

  /** Monthly opened PR counts keyed by `"YYYY-MM"`. Combines PRs opened across merged+closed+open sets. */
  monthlyOpenedCounts?: Record<string, number>;

  /** Daily activity counts keyed by `"YYYY-MM-DD"`. Powers the activity heatmap chart. */
  dailyActivityCounts?: Record<string, number>;

  /** Cached local repo scan results (#84). Avoids re-scanning the filesystem every session. */
  localRepoCache?: LocalRepoCache;

  activeIssues: TrackedIssue[];
}

/** Cached results from scanning the filesystem for local git clones (#84). */
export interface LocalRepoCache {
  /** Map of "owner/repo" -> local repo info */
  repos: Record<string, { path: string; exists: boolean; currentBranch: string | null }>;
  /** Directories that were scanned */
  scanPaths: string[];
  /** ISO 8601 timestamp of when the scan was performed */
  cachedAt: string;
}

/** Metadata for a snoozed PR's CI failure. */
export interface SnoozeInfo {
  reason: string;
  snoozedAt: string;
  expiresAt: string;
}

/** Filter for excluding repos below a minimum star count from PR count queries. */
export interface StarFilter {
  minStars: number;
  knownStarCounts: ReadonlyMap<string, number>;
}

/** Manual status override for a PR, set via dashboard or CLI. Auto-clears when new activity is detected. */
export interface StatusOverride {
  status: FetchedPRStatus;
  setAt: string;
  /** PR's updatedAt at the time the override was set. Used to detect new activity for auto-clear. */
  lastActivityAt: string;
}

/** User-configurable settings, populated via `/setup-oss` and stored in {@link AgentState}. */
export interface AgentConfig {
  /** False until the user completes initial setup via `/setup-oss`. */
  setupComplete: boolean;
  setupCompletedAt?: string;

  // Limits
  maxActivePRs: number;
  /** Days of inactivity before a PR is marked `dormant`. Default 30. */
  dormantThresholdDays: number;
  /** Days of inactivity before a PR is marked `approaching_dormant`. Default 25. */
  approachingDormantDays: number;
  /** Issues older than this (by `updated_at`) are filtered from search results. Default 90. */
  maxIssueAgeDays: number;

  /** Programming languages to search for issues in (e.g., `["typescript", "javascript"]`). */
  languages: string[];
  /** GitHub labels to filter issues by (e.g., `["good first issue", "help wanted"]`). */
  labels: string[];
  /** Repos to exclude from search and stats, in `"owner/repo"` format. */
  excludeRepos: string[];
  /** Organizations to exclude from search and stats (case-insensitive match on owner segment). */
  excludeOrgs?: string[];

  /** Repos where the contributor has had PRs merged. Used for prioritization. */
  trustedProjects: string[];

  githubUsername: string;

  /** Minimum {@link RepoScore} to include a repo in search results. Default 4. */
  minRepoScoreThreshold: number;

  /** User's GitHub starred repos, fetched periodically for prioritized issue discovery. */
  starredRepos: string[];
  starredReposLastFetched?: string;

  /** Whether to show the health check notification on session start. Default true. */
  showHealthCheck?: boolean;

  /** Whether to squash commits before marking PR ready. `true` (default), `false`, or `"ask"`. */
  squashByDefault?: boolean | 'ask';

  /** Directories to scan for local git clones (#84). Falls back to default paths if not set. */
  localRepoScanPaths?: string[];

  /** Minimum GitHub star count for Phase 2 (general search) results. Default 50. Phases 0/1 are exempt. */
  minStars?: number;

  /** Whether to include documentation-only issues in search results. Default true. */
  includeDocIssues?: boolean;

  /** Repos known to have anti-AI contribution policies, in `"owner/repo"` format. Filtered from search results automatically. */
  aiPolicyBlocklist?: string[];

  /** PR URLs manually shelved by the user. Shelved PRs are excluded from capacity and actionable issues. Auto-unshelved when maintainers engage. */
  shelvedPRUrls?: string[];

  /** Issue/PR URLs dismissed by the user, mapped to ISO timestamp of when dismissed. Issues with new responses after the dismiss timestamp resurface automatically. Named dismissedIssues for state backward compatibility (#416). */
  dismissedIssues?: Record<string, string>;

  /** PR URLs with snoozed CI failures, mapped to snooze metadata. Snoozed PRs are excluded from actionable CI failure list until expiry. */
  snoozedPRs?: Record<string, SnoozeInfo>;

  /** Manual status overrides for PRs. Maps PR URL to override metadata. Auto-clears when the PR has new activity. */
  statusOverrides?: Record<string, StatusOverride>;
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

/** Default configuration applied to new state files. All fields can be overridden via `/setup-oss`. */
export const DEFAULT_CONFIG: AgentConfig = {
  setupComplete: false,
  maxActivePRs: 10,
  dormantThresholdDays: 30,
  approachingDormantDays: 25,
  maxIssueAgeDays: 90,
  languages: ['typescript', 'javascript'],
  labels: ['good first issue', 'help wanted'],
  excludeRepos: [],
  trustedProjects: [],
  githubUsername: '',
  minRepoScoreThreshold: 4,
  starredRepos: [],
  squashByDefault: true,
  minStars: 50,
  includeDocIssues: true,
  aiPolicyBlocklist: ['matplotlib/matplotlib'],
  shelvedPRUrls: [],
  dismissedIssues: {},
  snoozedPRs: {},
};

/** Initial state written to `~/.oss-autopilot/state.json` on first run. Uses v2 architecture. */
export const INITIAL_STATE: AgentState = {
  version: 2, // v2: Fresh GitHub fetching
  activeIssues: [],
  repoScores: {},
  config: DEFAULT_CONFIG,
  events: [],
  lastRunAt: new Date().toISOString(),
};

// -- Issue discovery types (shared across issue-discovery, issue-vetting, issue-scoring) --

export type SearchPriority = 'merged_pr' | 'starred' | 'normal';

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
