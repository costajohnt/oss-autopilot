/**
 * JSON output formatter for CLI --json mode
 * Provides structured output that can be consumed by scripts and plugins
 */

import { z, type ZodType } from 'zod';
import type { AttentionSummary } from '../core/pr-attention.js';
import type {
  FetchedPR,
  DailyDigest,
  AgentState,
  RepoGroup,
  CommentedIssue,
  ShelvedPRRef,
  SearchPriority,
  CapacityAssessment,
  ActionableIssue,
  ActionableIssueType,
  CompactActionableIssue,
  ActionMenuItem,
  ActionMenu,
} from '../core/types.js';
import type { ContributionStats } from '../core/stats.js';
import type { PRCheckFailure } from '../core/pr-monitor.js';
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
  | 'gist-checkpoint'
  | 'gist-staleness'
  | 'state-load';

/**
 * A single non-fatal failure surfaced from the `daily` pipeline. Unlike
 * `PRCheckFailure` (which is scoped to per-PR fetch errors), this covers
 * ancillary fetches that previously demoted to a log-only `warn()` — repo
 * metadata, monthly analytics, scout sync, Gist checkpoint, etc.
 *
 * `timestamp` and `details` are optional structured extensions added in
 * #1193 so staleness warnings can carry `lastSuccessfulRefresh` /
 * `detectedAt` without bespoke schemas. Existing producers don't need to
 * supply them.
 */
export interface DailyWarning {
  phase: DailyWarningPhase;
  operation: string;
  message: string;
  timestamp?: string;
  details?: Record<string, unknown>;
}

/**
 * Build a warning entry from a {@link StalenessInfo} marker (#1193).
 * Co-located with `DailyWarning` so every command (`daily`, `status`,
 * `comments`) builds the same shape from the same source.
 */
export interface StalenessLike {
  source: string;
  reason: string;
  lastSuccessfulRefresh: string | null;
  detectedAt: string;
}
export function buildStalenessWarning(info: StalenessLike): DailyWarning {
  return {
    phase: 'gist-staleness',
    operation: 'state refresh',
    message: `Operating on ${info.source} state — Gist refresh failed: ${info.reason}`,
    timestamp: info.detectedAt,
    details: {
      source: info.source,
      lastSuccessfulRefresh: info.lastSuccessfulRefresh,
    },
  };
}

export interface DailyOutput {
  digest: DailyDigestCompact;
  capacity: CapacityAssessment;
  summary: string; // Pre-formatted markdown for Claude to display verbatim
  briefSummary: string; // One-liner for action-first flow
  actionableIssues: CompactActionableIssue[]; // Structured list referencing PRs by URL
  /** Unified attention-bucket counts (#1352) — same classifier the dashboard stamps per-PR. */
  attention: AttentionSummary;
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
  /**
   * Periodic contribution-strategy snapshot (#1270). Populated when the
   * cadence trigger fires AND the user has crossed the merge floor. The
   * `/oss` action menu renders this inline ahead of the action options;
   * absent or null on runs where the gate stays silent.
   */
  strategySummary?: import('../core/strategy.js').StrategyResult | null;
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
  /** Unified attention-bucket counts (#1352), retained under --compact. */
  attention: AttentionSummary;
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
  /** Periodic strategy snapshot, threaded through compact mode for parity. See {@link DailyOutput.strategySummary}. */
  strategySummary?: import('../core/strategy.js').StrategyResult | null;
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
    attention: output.attention,
    actionMenu: output.actionMenu,
    commentedIssues: output.commentedIssues,
    failureCount: output.failures.length,
    warnings: output.warnings,
    strategySummary: output.strategySummary,
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

// DailyWarning schema lives here (rather than further down with the rest of
// the daily schemas) so StatusOutputSchema below can reference it directly
// without `z.lazy()`. The runtime shape is shared across daily / status /
// comments warnings — see `DailyWarning` interface above.
const DailyWarningPhaseSchema = z.enum([
  'fetch',
  'repo-scores',
  'analytics',
  'scout-sync',
  'partition',
  'dismiss-filter',
  'gist-checkpoint',
  'gist-staleness',
  'state-load',
]);

const DailyWarningSchema = z.object({
  phase: DailyWarningPhaseSchema,
  operation: z.string(),
  message: z.string(),
  timestamp: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

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
  warnings: z.array(DailyWarningSchema).optional(),
});

export type StatusOutput = z.infer<typeof StatusOutputSchema>;

// ── Daily output schemas (#1146) ─────────────────────────────────────
//
// FetchedPR / CommentedIssue / PRCheckFailure are large heterogeneous shapes
// whose state-schema counterparts already use `z.any()` / pass-through
// validation. We mirror that here — strict on the wrapper (so drift in
// top-level keys / category arrays surfaces immediately) and tolerant on the
// opaque payload entries.

const FetchedPRPassthroughSchema = z.record(z.string(), z.unknown());
const CommentedIssuePassthroughSchema = z.record(z.string(), z.unknown());
const PRCheckFailurePassthroughSchema = z.record(z.string(), z.unknown());

const ShelvedPRRefStrictSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  repo: z.string(),
  daysSinceActivity: z.number(),
  status: z.string(),
});

const RecentClosedPRSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  closedAt: z.string(),
});

const RecentMergedPRSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  mergedAt: z.string(),
});

const DailyDigestSummarySchemaStrict = z.object({
  totalActivePRs: z.number(),
  totalNeedingAttention: z.number(),
  totalMergedAllTime: z.number(),
  mergeRate: z.number(),
});

const DailyDigestCompactSchema = z.object({
  generatedAt: z.string(),
  openPRs: z.array(FetchedPRPassthroughSchema),
  needsAddressingPRs: z.array(z.string()),
  waitingOnMaintainerPRs: z.array(z.string()),
  recentlyClosedPRs: z.array(RecentClosedPRSchema),
  recentlyMergedPRs: z.array(RecentMergedPRSchema),
  shelvedPRs: z.array(ShelvedPRRefStrictSchema),
  autoUnshelvedPRs: z.array(ShelvedPRRefStrictSchema),
  summary: DailyDigestSummarySchemaStrict,
});

const CapacityAssessmentSchema = z.object({
  hasCapacity: z.boolean(),
  activePRCount: z.number().int().nonnegative(),
  maxActivePRs: z.number().int().nonnegative(),
  shelvedPRCount: z.number().int().nonnegative(),
  criticalIssueCount: z.number().int().nonnegative(),
  reason: z.string(),
});

const ActionableIssueTypeSchema = z.enum([
  'ci_failing',
  'merge_conflict',
  'needs_response',
  'needs_changes',
  'incomplete_checklist',
]);

const CompactActionableIssueSchema = z.object({
  type: ActionableIssueTypeSchema,
  prUrl: z.string(),
  label: z.string(),
  isNewContribution: z.boolean(),
});

const ActionMenuItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  capacityWarning: z.string().optional(),
});

const ActionMenuSchema = z.object({
  items: z.array(ActionMenuItemSchema),
  context: z.object({
    hasActionableIssues: z.boolean(),
    actionableCount: z.number().int().nonnegative(),
    hasCapacity: z.boolean(),
    hasIssueResponses: z.boolean(),
    issueResponseCount: z.number().int().nonnegative(),
  }),
});

const CompactRepoGroupSchema = z.object({
  repo: z.string(),
  prUrls: z.array(z.string()),
});

// DailyWarning schemas were hoisted above StatusOutputSchema (#1193) so the
// status output can reference them without `z.lazy()`.

// Mirrors {@link StrategyResult} in core/strategy.ts. Kept passthrough on the
// inner objects so additive shape changes there don't break Zod validation
// before the schema catches up — drift on required keys still fails.
export const StrategyResultSchema = z
  .object({
    profile: z
      .object({
        style: z.enum(['maintainer', 'explorer', 'specialist', 'generalist']),
        totalPRs: z.number().int().nonnegative(),
        mergedCount: z.number().int().nonnegative(),
        mergeRate: z.number(),
        primaryLanguages: z.array(z.string()),
        favoriteRepos: z.array(z.string()),
      })
      .passthrough(),
    capacity: z
      .object({
        openPRCount: z.number().int().nonnegative(),
        dormantPRCount: z.number().int().nonnegative(),
        dormantRepoCount: z.number().int().nonnegative(),
        overExtended: z.boolean(),
        suggestedAction: z.union([
          z.literal('open_more'),
          z.literal('follow_up_dormant'),
          z.literal('wait_on_maintainers'),
          z.null(),
        ]),
      })
      .passthrough(),
    patterns: z
      .object({
        // Closed set on the six required PR-type buckets — drift on any
        // of these breaks the snapshot rendering. `.passthrough()` allows
        // additive growth (e.g., a future 'security' bucket) without a
        // schema bump, but a typo on `features` → `feauters` fails here.
        prTypeDistribution: z
          .object({
            docs: z.number(),
            fixes: z.number(),
            features: z.number(),
            refactors: z.number(),
            tests: z.number(),
            other: z.number(),
          })
          .passthrough(),
        trajectoryDirection: z.enum(['growing', 'steady', 'declining']),
        averagePRSize: z.number(),
      })
      .passthrough(),
    recommendations: z
      .object({
        languages: z.array(z.string()),
        repos: z.array(z.string()),
        issueTypes: z.array(z.string()),
        avoidPatterns: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * On-demand strategy snapshot output (#1243 step 4). Wraps the same
 * `StrategyResult` shape consumed by the daily auto-display, but is
 * always available — the cadence gate only governs the auto-display,
 * not direct CLI/MCP calls. `strategy` is null when the minimum-data
 * gate fails (fewer than `STRATEGY_MIN_PRS` merged PRs); `message`
 * carries the human-readable explanation in that case.
 */
export const StrategyOutputSchema = z.object({
  strategy: StrategyResultSchema.nullable(),
  message: z.string().optional(),
});
export type StrategyCommandOutput = z.infer<typeof StrategyOutputSchema>;

export const AttentionSummarySchema = z.object({
  needsAttention: z.number().int().nonnegative(),
  stuckCI: z.number().int().nonnegative(),
  dormantFollowup: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
});

export const DailyOutputSchema = z.object({
  digest: DailyDigestCompactSchema,
  capacity: CapacityAssessmentSchema,
  summary: z.string(),
  briefSummary: z.string(),
  actionableIssues: z.array(CompactActionableIssueSchema),
  attention: AttentionSummarySchema,
  actionMenu: ActionMenuSchema,
  commentedIssues: z.array(CommentedIssuePassthroughSchema),
  repoGroups: z.array(CompactRepoGroupSchema),
  failures: z.array(PRCheckFailurePassthroughSchema),
  warnings: z.array(DailyWarningSchema),
  strategySummary: StrategyResultSchema.nullable().optional(),
});

export const CompactDailyOutputSchema = z.object({
  digest: DailyDigestCompactSchema,
  capacity: CapacityAssessmentSchema,
  briefSummary: z.string(),
  actionableIssues: z.array(CompactActionableIssueSchema),
  attention: AttentionSummarySchema,
  actionMenu: ActionMenuSchema,
  commentedIssues: z.array(CommentedIssuePassthroughSchema),
  failureCount: z.number().int().nonnegative(),
  warnings: z.array(DailyWarningSchema),
  strategySummary: StrategyResultSchema.nullable().optional(),
});

// ── Search output schema (#1147) ─────────────────────────────────────

const SearchPrioritySchema = z.enum(['merged_pr', 'preferred_org', 'starred', 'normal']);

/**
 * Schema for the compact linked-PR annotation surfaced on candidate
 * outputs (#97 / scout 0.9.0). Mirrors {@link CandidateLinkedPR}.
 */
const CandidateLinkedPRSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed', 'merged']),
  url: z.string(),
  updatedAt: z.string().optional(),
  isStalled: z.boolean(),
});

const SearchCandidateSchema = z.object({
  issue: z.object({
    repo: z.string(),
    repoUrl: z.string(),
    number: z.number().int(),
    title: z.string(),
    url: z.string(),
    labels: z.array(z.string()),
  }),
  recommendation: z.enum(['approve', 'skip', 'needs_review']),
  reasonsToApprove: z.array(z.string()),
  reasonsToSkip: z.array(z.string()),
  searchPriority: SearchPrioritySchema,
  viabilityScore: z.number(),
  grade: z.object({
    letter: z.enum(['A', 'B', 'C', 'F']),
    reason: z.string(),
  }),
  repoScore: z
    .object({
      score: z.number(),
      mergedPRCount: z.number().int().nonnegative(),
      closedWithoutMergeCount: z.number().int().nonnegative(),
      isResponsive: z.boolean(),
      lastMergedAt: z.string().optional(),
    })
    .optional(),
  linkedPR: CandidateLinkedPRSchema.optional(),
  /**
   * Personalization sort-tier signal threaded up from oss-scout (#1244).
   * Present only when local strategy data biased the search and this
   * candidate matched. `boostReasons` is the human-readable explanation
   * (e.g. `"repo affinity: vercel/next.js"`, `"language match: TypeScript"`).
   */
  boostScore: z.number().optional(),
  boostReasons: z.array(z.string()).optional(),
});

export const SearchOutputSchema = z.object({
  candidates: z.array(SearchCandidateSchema),
  excludedRepos: z.array(z.string()),
  aiPolicyBlocklist: z.array(z.string()),
  hiddenOwnPRCount: z.number().int().nonnegative(),
  rateLimitWarning: z.string().optional(),
});

// ── Features output schema (scout 0.9.0 #97/#98/#99) ─────────────────
//
// `SearchCandidateSchema` augmented with the horizon literal that scout
// stamps in features mode. Reusing the search candidate keeps the two
// envelopes structurally identical apart from the bucket annotation.
const FeaturesHorizonSchema = z.enum(['quick-win', 'bigger-bet']);
const FeaturesCandidateSchema = SearchCandidateSchema.extend({
  horizon: FeaturesHorizonSchema,
});

export const FeaturesOutputSchema = z.object({
  quickWins: z.array(FeaturesCandidateSchema),
  biggerBets: z.array(FeaturesCandidateSchema),
  anchorRepos: z.array(z.string()),
  message: z.string().nullable(),
  rateLimitWarning: z.string().optional(),
});

// ── Doctor / skip-add / list-move-tier output schemas (#1148) ────────

const DoctorCheckSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'warning', 'error']),
  message: z.string(),
  remediation: z.string().optional(),
});

export const DoctorOutputSchema = z.object({
  checks: z.array(DoctorCheckSchema),
  summary: z.object({
    ok: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
});

export const SkipAddOutputSchema = z.object({
  added: z.boolean(),
  alreadyPresent: z.boolean(),
  url: z.string(),
  path: z.string(),
  date: z.string().optional(),
});

export const ListMoveTierOutputSchema = z.object({
  moved: z.boolean(),
  filePath: z.string(),
  url: z.string(),
  toTier: z.enum(['pursue', 'maybe', 'skip']),
  fromTier: z.string().optional(),
  count: z.number().int().nonnegative(),
  // #1355: not-found now throws before reaching the success envelope, so the
  // only reachable no-op reason is the idempotent one. Pinned so a new quiet
  // no-op path trips the #1105 runtime validator instead of shipping silently.
  reason: z.literal('already in target tier').optional(),
});

// list-mark-done (#1299): mirrors {@link MarkDoneOutput} from the command
// module. Strict shape — additional keys must be added here AND in the
// command output, otherwise the validator's `parse()` rejects the response
// before it reaches consumers.
export const ListMarkDoneOutputSchema = z.object({
  marked: z.boolean(),
  filePath: z.string(),
  url: z.string(),
  repoHeadingStruck: z.boolean(),
  remainingUnderRepo: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

// verify-issue (#1353, #1354): mirrors {@link IssueVerification} from
// core/issue-verification.ts. Strict shape — additional keys must be added
// here AND in the module output, otherwise the validator rejects the
// response before it reaches consumers.
export const VerifyIssueOutputSchema = z.object({
  url: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  stateReason: z.enum(['completed', 'not_planned', 'reopened', 'duplicate']).nullable(),
  closedAt: z.string().nullable(),
  assignees: z.array(z.string()),
  linkedPRs: z.array(
    z.object({
      number: z.number().int().positive(),
      url: z.string(),
      title: z.string(),
      state: z.enum(['open', 'closed', 'merged']),
      isDraft: z.boolean(),
      author: z.string().nullable(),
      isOwn: z.boolean(),
      linkType: z.enum(['closing', 'cross-referenced']),
      updatedAt: z.string().nullable(),
    }),
  ),
  verdict: z.enum(['closed', 'own-open-pr', 'taken', 'at-risk', 'available']),
  verdictReason: z.string(),
  userLogin: z.string(),
});

// ── #1155: Zod coverage for remaining CLI commands ───────────────────

export const PostOutputSchema = z.object({
  commentUrl: z.string(),
  url: z.string(),
});

export const ClaimOutputSchema = z.object({
  commentUrl: z.string(),
  issueUrl: z.string(),
  // Post-mutation Gist checkpoint failure (#1370). Optional: absent on clean runs.
  gistSyncWarning: z.string().optional(),
});

export const InitOutputSchema = z.object({
  username: z.string(),
  message: z.string(),
});

// ── #1190: plugin → CLI contract ─────────────────────────────────────
//
// Pinned shape lets the plugin's session-start hook verify that the bundled
// CLI exposes the subcommands the markdown layer expects. Bumping
// `schemaVersion` is a breaking change to that contract.
export const ManifestOutputSchema = z.object({
  schemaVersion: z.literal(1),
  cliVersion: z.string().regex(/^\d+\.\d+\.\d+/),
  commands: z.array(
    z.object({
      name: z.string(),
      localOnly: z.boolean(),
    }),
  ),
});

export const CheckSetupOutputSchema = z.object({
  setupComplete: z.boolean(),
  username: z.string(),
});

const SetupSetOutputSchema = z.object({
  success: z.literal(true),
  settings: z.record(z.string(), z.string()),
  warnings: z.array(z.string()).optional(),
});

const SetupCompleteOutputSchema = z.object({
  setupComplete: z.literal(true),
  config: z.object({
    githubUsername: z.string(),
    maxActivePRs: z.number(),
    dormantThresholdDays: z.number(),
    approachingDormantDays: z.number(),
    languages: z.array(z.string()),
    labels: z.array(z.string()),
    projectCategories: z.array(z.string()),
    preferredOrgs: z.array(z.string()),
    scope: z.array(z.string()),
    persistence: z.enum(['local', 'gist']),
  }),
});

const SetupRequiredOutputSchema = z.object({
  setupRequired: z.literal(true),
  prompts: z.array(
    z.object({
      setting: z.string(),
      prompt: z.string(),
      current: z.union([z.string(), z.number(), z.array(z.string()), z.null()]),
      required: z.boolean().optional(),
      default: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
      type: z.string().optional(),
    }),
  ),
});

export const SetupOutputSchema = z.union([SetupSetOutputSchema, SetupCompleteOutputSchema, SetupRequiredOutputSchema]);

const ConfigKeyDefSchema = z.object({}).passthrough();

const ConfigGetOutputSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

const ConfigSetOutputSchema = z.object({
  success: z.literal(true),
  key: z.string(),
  value: z.string(),
});

const ConfigListKeysOutputSchema = z.object({
  keys: z.array(ConfigKeyDefSchema),
});

export const ConfigCommandOutputSchema = z.union([
  ConfigGetOutputSchema,
  ConfigSetOutputSchema,
  ConfigListKeysOutputSchema,
]);

export const MoveOutputSchema = z.object({
  url: z.string(),
  target: z.enum(['attention', 'waiting', 'shelved', 'auto']),
  description: z.string(),
  // Post-mutation Gist checkpoint failure (#1370). Optional: absent on clean runs.
  gistSyncWarning: z.string().optional(),
});

export const PRTemplateOutputSchema = z.object({
  template: z.string().nullable(),
  source: z.string().nullable(),
  error: z.string().optional(),
});

/**
 * Output of the `repo-vet` CLI command (#1271, follow-up to #1242).
 *
 * Validates the full nested shape so a refactor that drops or
 * mis-types one of these fields trips `outputJsonValidated` rather
 * than silently shipping a broken envelope (#1245 contract pattern,
 * matching `ComplianceScoreOutputSchema` below).
 */
const RepoVetMetaSchema = z.object({
  stars: z.number(),
  forks: z.number(),
  openIssues: z.number(),
  watchers: z.number(),
  isArchived: z.boolean(),
  lastPushed: z.string(),
  createdAt: z.string(),
});
export const RepoVetOutputSchema = z.object({
  repoSlug: z.string(),
  fetchedAt: z.string(),
  repoMeta: RepoVetMetaSchema,
  prMergeTime: z.object({
    avgDays: z.number().nullable(),
    medianDays: z.number().nullable(),
    sampleSize: z.number().int().nonnegative(),
    sourceWindowDays: z.literal(90),
  }),
  mergeRate: z.object({
    merged: z.number().int().nonnegative(),
    opened: z.number().int().nonnegative(),
    percent: z.number().nullable(),
    windowDays: z.literal(90),
  }),
  maintainerActivity: z.object({
    lastCommitISO: z.string().nullable(),
    contributorsLast90d: z.number().int().nonnegative(),
    lastReleaseISO: z.string().nullable(),
    /**
     * True when the release listing failed for a non-404 reason (5xx,
     * network), so a `null` lastReleaseISO means "could not determine"
     * rather than "confirmed no releases". The release-list analogue of
     * `communityHealth.incomplete` (#1373).
     */
    releasesIncomplete: z.boolean().optional(),
  }),
  communityHealth: z.object({
    contributing: z.boolean(),
    issueTemplates: z.boolean(),
    prTemplate: z.boolean(),
    codeOfConduct: z.boolean(),
    /**
     * True when at least one community-health probe failed for a non-404
     * reason (auth, rate-limit, 5xx). The boolean flags above stay
     * `false` for unprobed paths in that case, so consumers should treat
     * the false flags as "could not determine" rather than "confirmed
     * absent" when this is set.
     */
    incomplete: z.boolean().optional(),
  }),
  rubricScore: z.number(),
  rubricVerdict: z.enum(['recommended', 'proceed_with_caution', 'avoid']),
});
/**
 * The CLI wrapper renames the core function's `repo` metadata object to
 * `repoMeta` so the top-level slug doesn't collide with it. The TS type
 * is derived from the Zod schema so any drift between schema and type
 * fails at compile time.
 */
export type RepoVetOutput = z.infer<typeof RepoVetOutputSchema>;

const ComplianceCheckSchema = z.object({
  status: z.enum(['pass', 'warn', 'fail']),
  weight: z.number(),
  detail: z.string(),
});

export const ComplianceScoreOutputSchema = z.object({
  pr: z.object({
    repo: z.string(),
    number: z.number().int().nonnegative(),
    title: z.string(),
    url: z.string(),
  }),
  score: z.number().int().min(0).max(100),
  rating: z.enum(['ready', 'minor', 'fix_first', 'significant_work']),
  emoji: z.enum(['🌟', '✅', '⚠️', '❌']),
  checks: z.object({
    issueReference: ComplianceCheckSchema,
    description: ComplianceCheckSchema,
    focusedChanges: ComplianceCheckSchema,
    tests: ComplianceCheckSchema,
    title: ComplianceCheckSchema,
    branch: ComplianceCheckSchema,
  }),
});
export type ComplianceScoreOutput = z.infer<typeof ComplianceScoreOutputSchema>;

const ParsedIssueItemSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  tier: z.string(),
  url: z.string(),
  score: z.number().optional(),
});

export const ParseIssueListOutputSchema = z.object({
  available: z.array(ParsedIssueItemSchema),
  completed: z.array(ParsedIssueItemSchema),
  availableCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
});

const NewFileInfoSchema = z.object({
  path: z.string(),
  referencedBy: z.array(z.string()),
  isIntegrated: z.boolean(),
  suggestedEntryPoints: z.array(z.string()).optional(),
});

export const CheckIntegrationOutputSchema = z.object({
  newFiles: z.array(NewFileInfoSchema),
  unreferencedCount: z.number().int().nonnegative(),
});

const FormatterNameSchema = z.enum([
  'prettier',
  'eslint',
  'biome',
  'black',
  'ruff',
  'rustfmt',
  'gofmt',
  'clang-format',
  'rubocop',
]);

const DetectedFormatterSchema = z.object({
  name: FormatterNameSchema,
  configPath: z.string(),
  fixCommand: z.string(),
  checkCommand: z.string(),
  supportsFileArgs: z.boolean(),
});

const CIFormatterDiagnosisSchema = z.object({
  isFormattingFailure: z.boolean(),
  formatter: FormatterNameSchema.optional(),
  fixCommand: z.string().optional(),
  evidence: z.array(z.string()),
});

export const DetectFormattersOutputSchema = z.object({
  formatters: z.array(DetectedFormatterSchema),
  packageJsonScripts: z.array(z.object({ name: z.string(), command: z.string() })),
  repoPath: z.string(),
  ciDiagnosis: CIFormatterDiagnosisSchema.optional(),
});

const LocalRepoInfoSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  currentBranch: z.string().nullable(),
});

export const LocalReposOutputSchema = z.object({
  repos: z.record(z.string(), LocalRepoInfoSchema),
  scanPaths: z.array(z.string()),
  cachedAt: z.string(),
  fromCache: z.boolean(),
});

/**
 * Compact summary of an issue's first linked PR, surfaced on candidate
 * outputs (#97 / scout 0.9.0). `isStalled` is `true` when the PR is open
 * and has not been updated for `STALLED_PR_THRESHOLD_DAYS` (default 30) —
 * a revive-opportunity signal callers can render or filter on.
 *
 * `state` mirrors autopilot's existing tri-state classifier (`'merged'` is
 * folded in from scout's `merged: true` boolean), not scout's raw enum.
 */
export interface CandidateLinkedPR {
  number: number;
  state: 'open' | 'closed' | 'merged';
  url: string;
  /** ISO timestamp of the PR's last update (when scout surfaces it). */
  updatedAt?: string;
  /** True when the PR is open AND `updatedAt` is more than 30 days old. */
  isStalled: boolean;
}

/**
 * One candidate row in `SearchOutput`/`FeaturesOutput`. Extracted so the
 * features command can reuse the exact contract `runSearch` already
 * publishes — keeping the two outputs structurally identical for everything
 * except the bucket-specific `horizon` annotation.
 */
export interface SearchCandidate {
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
  /**
   * First linked PR on the issue, when scout surfaced one. Optional —
   * absent when no linked PR exists. `isStalled` flags revive
   * opportunities (open PR + no updates for 30+ days, scout 0.9.0 #97).
   */
  linkedPR?: CandidateLinkedPR;
}

export interface SearchOutput {
  candidates: SearchCandidate[];
  excludedRepos: string[];
  /** Repos with known anti-AI contribution policies, filtered from search results (#108). */
  aiPolicyBlocklist: string[];
  /** Candidates dropped because the authenticated user already has an open PR
   * linked to the issue (#1354). Surfaced as a count so the filter is visible. */
  hiddenOwnPRCount: number;
  /** Present when rate limits affected the search — either low pre-flight quota or mid-search rate limit hits (#100). */
  rateLimitWarning?: string;
}

/** Horizon classification stamped on each features-mode candidate. */
export type FeaturesHorizon = 'quick-win' | 'bigger-bet';

/** A `SearchCandidate` augmented with its features-mode horizon. */
export type FeaturesCandidate = SearchCandidate & {
  horizon: FeaturesHorizon;
};

export interface FeaturesOutput {
  /** "Quick-win" bucket: feature-scoped issues without strong commitment markers (no milestone, no roadmap, no bigger-bet labels). */
  quickWins: FeaturesCandidate[];
  /** "Bigger-bet" bucket: feature-scoped issues that carry maintainer-commitment signals (milestone, roadmap, bigger-bet label). */
  biggerBets: FeaturesCandidate[];
  /** Repos that qualified as anchors for this run (3+ merged PRs, configurable). Empty when the user has no anchor repos yet. */
  anchorRepos: string[];
  /** Human-friendly explainer shown when neither bucket has results (no anchors, or anchors but no open feature opportunities). `null` on success. */
  message: string | null;
  /** Present when rate limits affected the search. Mirrors `SearchOutput.rateLimitWarning`. */
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
  /**
   * Status of the dashboard SPA build that ran (or didn't) before this
   * startup invocation (#1293). Populated by the workflow shell via
   * `OSS_DASHBOARD_BUILD_STATUS`; absent when the CLI is invoked outside
   * the plugin workflow:
   * - `'fresh'` — built artifact was up-to-date, no rebuild attempted.
   * - `'rebuilt'` — rebuild ran and succeeded.
   * - `'failed'` — rebuild ran and failed; `dashboardUrl` may serve stale
   *    or missing assets until the build is fixed.
   * - `'missing-pnpm'` — rebuild was needed but pnpm (required for the
   *    workspace dependency) was unavailable.
   */
  dashboardBuildStatus?: 'fresh' | 'rebuilt' | 'failed' | 'missing-pnpm';
  /**
   * Last few lines of the dashboard build log when `dashboardBuildStatus`
   * is `'failed'` or `'missing-pnpm'`. Surfaced by the workflow as a
   * one-line warning so the user sees what broke without leaving `/oss`.
   */
  dashboardBuildErrorTail?: string;
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

/**
 * Status of a re-vetted issue from the curated list (#764).
 *
 * `has_stalled_pr` (scout 0.9.0 #97) distinguishes open-but-stalled linked
 * PRs from cleanly-claimed `has_pr` issues — the issue is still actionable
 * as a revive opportunity rather than something to drop.
 */
export type VetListItemStatus = 'still_available' | 'claimed' | 'closed' | 'has_pr' | 'has_stalled_pr' | 'error';

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
    /** Open linked PRs that haven't been touched in 30+ days (scout 0.9.0 #97). Surfaced as revive opportunities, not auto-dropped. */
    hasStalledPR: number;
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
  /**
   * Result of scout's anti-LLM policy scan over CONTRIBUTING.md /
   * CODE_OF_CONDUCT.md / README.md (#979). When `matched` is true the issue
   * should be skipped — the project explicitly disallows AI-generated
   * contributions.
   */
  antiLLMPolicy?: {
    matched: boolean;
    matchedKeywords: string[];
    sourceFile: string | null;
  };
  /**
   * Classification of the issue's first linked PR (#978). `'none'` when
   * no linked PR exists. The other buckets distinguish whether the user
   * already has work in flight vs. a competing contributor.
   */
  linkedPRClassification?:
    | 'none'
    | 'user_open'
    | 'user_closed'
    | 'user_merged'
    | 'other_open'
    | 'other_closed'
    | 'other_merged';
  /**
   * Compact linked-PR summary (#97 / scout 0.9.0). Present when the issue
   * has a linked PR; absent otherwise. `isStalled` flags open PRs that
   * haven't been touched in 30+ days as revive opportunities.
   */
  linkedPR?: CandidateLinkedPR;
  /**
   * Optional SLM pre-triage classification (#1122). Populated when the
   * user has set `slmTriageModel` and a local Ollama instance answered
   * within the timeout. `null` otherwise.
   */
  slmTriage?: {
    decision: 'pursue' | 'investigate' | 'skip';
    confidence: 'high' | 'medium' | 'low';
    reasons: string[];
    modelVersion: string;
  } | null;
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
  /** Non-fatal warnings (e.g. stale-cache fallback, #1193). Always present; empty on clean runs. */
  warnings?: DailyWarning[];
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
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
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
