/**
 * Zod schemas for all types persisted in state.json.
 *
 * This file is the single source of truth for persisted type shapes.
 * Types are inferred via `z.infer<>` at the bottom of this file and
 * re-exported through types.ts.
 *
 * Schemas are defined bottom-up (leaf types first, composites last).
 * Unknown keys are stripped by default (Zod 4 behavior).
 */
import { z } from 'zod';
import type { FetchedPR } from './types.js';

// ── 1. Enum / union schemas ───────────────────────────────────────────

export const IssueStatusSchema = z.enum(['candidate', 'claimed', 'in_progress', 'pr_submitted']);

export const FetchedPRStatusSchema = z.enum(['needs_addressing', 'waiting_on_maintainer']);

export const ProjectCategorySchema = z.enum([
  'nonprofit',
  'devtools',
  'infrastructure',
  'web-frameworks',
  'data-ml',
  'education',
]);

export const IssueScopeSchema = z.enum(['beginner', 'intermediate', 'advanced']);

export const DiffToolSchema = z.enum(['inline', 'sourcetree', 'vscode', 'custom']);

// ── 2. Leaf schemas ──────────────────────────────────────────────────

export const RepoSignalsSchema = z.object({
  hasActiveMaintainers: z.boolean(),
  isResponsive: z.boolean(),
  hasHostileComments: z.boolean(),
});

export const RepoScoreSchema = z.object({
  repo: z.string(),
  score: z.number(),
  mergedPRCount: z.number(),
  closedWithoutMergeCount: z.number(),
  avgResponseDays: z.number().nullable(),
  lastMergedAt: z.string().optional(),
  lastEvaluatedAt: z.string(),
  signals: RepoSignalsSchema,
  stargazersCount: z.number().optional(),
  language: z.string().nullable().optional(),
});

export const StoredMergedPRSchema = z.object({
  url: z.string(),
  title: z.string(),
  mergedAt: z.string(),
  /**
   * When the PR was opened (#1461). Optional: entries persisted before the
   * outcome ledger existed don't carry it. Sourced from the Search API's
   * `created_at` at merge-detection time — zero extra API calls.
   */
  openedAt: z.string().optional(),
  /**
   * Earliest maintainer (non-bot, non-contributor) comment or review on the
   * PR (#1461). Best-effort: only derivable when the PR was enriched while
   * open (looked up from the previous run's persisted digest at detection
   * time), so it is absent for PRs that merged before ever appearing in an
   * enriched run.
   */
  firstMaintainerResponseAt: z.string().optional(),
  /** When the raw review-comment bundle for this PR was last fetched (#867). */
  // ISO-8601 datetime guards against `markPRCommentsFetched(url, "garbage")`
  // poisoning state through the stamping API (#1209 L4).
  commentsFetchedAt: z.string().datetime().optional(),
  /** When the host last ran LLM extraction over this PR's comment bundle (#867). */
  learningsExtractedAt: z.string().datetime().optional(),
});

export const StoredClosedPRSchema = z.object({
  url: z.string(),
  title: z.string(),
  closedAt: z.string(),
  /** When the PR was opened (#1461). See StoredMergedPRSchema.openedAt. */
  openedAt: z.string().optional(),
  /**
   * Earliest maintainer response (#1461). See
   * StoredMergedPRSchema.firstMaintainerResponseAt.
   */
  firstMaintainerResponseAt: z.string().optional(),
  /** When the raw review-comment bundle for this PR was last fetched (#867). */
  // ISO-8601 datetime guards against `markPRCommentsFetched(url, "garbage")`
  // poisoning state through the stamping API (#1209 L4).
  commentsFetchedAt: z.string().datetime().optional(),
  /** When the host last ran LLM extraction over this PR's comment bundle (#867). */
  learningsExtractedAt: z.string().datetime().optional(),
});

export const AnalyzedIssueConversationSchema = z.object({
  url: z.string(),
  repo: z.string(),
  analyzedAt: z.string(),
});

/**
 * One entry in a PR's follow-up history (#1277). Tier matches the
 * cadence labels in `skills/pr-etiquette/SKILL.md` (light_check_in
 * for 7-13 days, direct_check_in for 14-29 days, final_check_in for
 * 30+ days). The `draftPath` is optional so an entry recorded from a
 * direct `gh pr comment` (no draft) still validates.
 */
export const FollowUpEntrySchema = z.object({
  tier: z.enum(['light_check_in', 'direct_check_in', 'final_check_in']),
  timestamp: z.string().datetime(),
  draftPath: z.string().optional(),
});
export type FollowUpEntry = z.infer<typeof FollowUpEntrySchema>;

/**
 * Pause-point snapshot for resumable workflows (#1280). When the user
 * picks "Done for now" inside `draft-first-workflow.md`,
 * `work-through-issues.md`, or `pre-commit-review.md`, the workflow
 * records its position here. The next `/oss` run consults this state
 * and offers "Resume / Restart / Discard" instead of restarting from
 * the beginning.
 *
 * `stepData` is intentionally typed as `Record<string, unknown>` so
 * each workflow can persist whatever per-step context it needs to
 * resume cleanly (compliance-gap skip list, last review pass count,
 * etc.) without forcing a tagged-union schema in shared state.
 */
export const WorkflowStateSchema = z.object({
  workflowName: z.enum(['draft-first', 'work-through-issues', 'pre-commit-review']),
  currentStep: z.string(),
  branchName: z.string().optional(),
  issueContext: z
    .object({
      title: z.string(),
      url: z.string(),
    })
    .optional(),
  completedSteps: z.array(z.string()).default([]),
  stepData: z.record(z.string(), z.unknown()).default({}),
  lastUpdatedAt: z.string().datetime(),
});
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

// ── 3. Contribution schemas ──────────────────────────────────────────

export const ContributionGuidelinesSchema = z.object({
  branchNamingConvention: z.string().optional(),
  commitMessageFormat: z.string().optional(),
  prTitleFormat: z.string().optional(),
  requiredChecks: z.array(z.string()).optional(),

  testFramework: z.string().optional(),
  testCoverageRequired: z.boolean().optional(),
  testFileNaming: z.string().optional(),

  linter: z.string().optional(),
  formatter: z.string().optional(),
  styleGuideUrl: z.string().optional(),

  issueClaimProcess: z.string().optional(),
  reviewProcess: z.string().optional(),
  claRequired: z.boolean().optional(),

  rawContent: z.string().optional(),
});

export const IssueVettingResultSchema = z.object({
  passedAllChecks: z.boolean(),
  checks: z.object({
    noExistingPR: z.boolean(),
    notClaimed: z.boolean(),
    projectActive: z.boolean(),
    clearRequirements: z.boolean(),
    contributionGuidelinesFound: z.boolean(),
  }),
  contributionGuidelines: ContributionGuidelinesSchema.optional(),
  notes: z.array(z.string()),
});

export const TrackedIssueSchema = z.object({
  id: z.number(),
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),

  status: IssueStatusSchema,

  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),

  vetted: z.boolean(),
  vettingResult: IssueVettingResultSchema.optional(),
});

// ── 4. PR reference schemas ──────────────────────────────────────────

export const ShelvedPRRefSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  repo: z.string(),
  daysSinceActivity: z.number(),
  status: FetchedPRStatusSchema,
});

export const StatusOverrideSchema = z.object({
  status: FetchedPRStatusSchema,
  setAt: z.string(),
  lastActivityAt: z.string(),
});

// ── 5. Config schema ─────────────────────────────────────────────────

export const AgentConfigSchema = z.object({
  setupComplete: z.boolean().default(false),
  setupCompletedAt: z.string().optional(),

  persistence: z.enum(['local', 'gist']).default('local'),

  maxActivePRs: z.number().default(10),
  dormantThresholdDays: z.number().default(30),
  approachingDormantDays: z.number().default(25),
  maxIssueAgeDays: z.number().default(90),

  languages: z.array(z.string()).default(['typescript', 'javascript']),
  labels: z.array(z.string()).default(['good first issue', 'help wanted']),
  scope: z.array(IssueScopeSchema).optional(),
  excludeRepos: z.array(z.string()).default([]),
  excludeOrgs: z.array(z.string()).optional(),

  trustedProjects: z.array(z.string()).default([]),

  githubUsername: z.string().default(''),

  minRepoScoreThreshold: z.number().default(4),

  starredRepos: z.array(z.string()).default([]),
  starredReposLastFetched: z.string().optional(),

  squashByDefault: z.union([z.boolean(), z.literal('ask')]).default(true),

  localRepoScanPaths: z.array(z.string()).optional(),

  minStars: z.number().default(50),

  includeDocIssues: z.boolean().default(true),

  aiPolicyBlocklist: z.array(z.string()).default(['matplotlib/matplotlib']),

  shelvedPRUrls: z.array(z.string()).default([]),

  dismissedIssues: z.record(z.string(), z.string()).default({}),

  statusOverrides: z.record(z.string(), StatusOverrideSchema).optional(),

  issueListPath: z.string().optional(),

  skippedIssuesPath: z.string().optional(),

  projectCategories: z.array(ProjectCategorySchema).default([]),

  preferredOrgs: z.array(z.string()).default([]),

  diffTool: DiffToolSchema.default('inline'),
  diffToolCustomCommand: z.string().optional(),

  /**
   * Opt-in gate for the auto-format-before-push hook (#1045). Default false:
   * the hook does nothing on every push unless the user explicitly enables it.
   */
  autoFormatBeforePush: z.boolean().default(false),

  /**
   * Threshold (in minutes) for the SessionStart PR health one-liner (#1255).
   * The cached digest only refreshes when the user runs `/oss`; SessionStart
   * fires every session. Without a freshness gate the line drifts arbitrarily
   * stale between runs. When the cache is older than this many minutes (and
   * not yet 7 days old, which keeps the existing catch-up nudge), the line is
   * suppressed entirely. Default 30 minutes.
   */
  healthCheckFreshnessMinutes: z.number().int().positive().default(30),

  /**
   * Convergence cap for the multi-agent review loop in
   * `workflows/dispatch-review.md` (#1275). When unset, the workflow
   * falls back to per-mode defaults (5 for diff, 3 for plan). Lower
   * values shorten the loop at the cost of skipping later iterations
   * if findings persist; higher values give the loop more chances to
   * converge before bailing. Optional — leave unset to use the
   * defaults.
   */
  reviewMaxPasses: z.number().int().positive().optional(),

  /**
   * Optional Ollama model for SLM pre-triage during issue vetting (#1122).
   * Empty disables the feature. Recommended: `gemma4:e4b` (default for
   * capable hardware), `gemma4:e2b` or `qwen3:1.7b` for low-RAM machines.
   * Threaded through to scout via the bridge in `scout-bridge.ts`.
   */
  slmTriageModel: z.string().default(''),

  /**
   * Optional Ollama HTTP host override. Defaults to `http://127.0.0.1:11434`
   * when empty. Useful when Ollama runs on a different machine on the
   * local network.
   */
  slmTriageHost: z.string().default(''),
});

// ── 6. Cache schemas ─────────────────────────────────────────────────

export const LocalRepoCacheSchema = z.object({
  repos: z.record(
    z.string(),
    z.object({
      path: z.string(),
      exists: z.boolean(),
      currentBranch: z.string().nullable(),
    }),
  ),
  scanPaths: z.array(z.string()),
  cachedAt: z.string(),
});

// ── 7. Digest schemas ────────────────────────────────────────────────

export const ClosedPRSchema = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  closedAt: z.string(),
  closedBy: z.string().optional(),
  /**
   * When the PR was opened (#1461). Carried from the Search API's
   * `created_at` so close detection can persist it into the outcome ledger.
   * Optional: digests persisted by older producers don't have it.
   */
  openedAt: z.string().optional(),
});

export const MergedPRSchema = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  mergedAt: z.string(),
  /**
   * When the PR was opened (#1461). Carried from the Search API's
   * `created_at` so merge detection can persist it into the outcome ledger.
   * Optional: digests persisted by older producers don't have it.
   */
  openedAt: z.string().optional(),
});

export const DailyDigestSummarySchema = z.object({
  totalActivePRs: z.number(),
  totalNeedingAttention: z.number(),
  totalMergedAllTime: z.number(),
  mergeRate: z.number(),
});

/**
 * Minimal FetchedPR validation for persisted digest arrays (#1456). The
 * persisted digest is rendered by the dashboard from cold start (before any
 * refresh), so the fields it dereferences must be guaranteed present. Only
 * the identity/status core is pinned — required on every real `FetchedPR`
 * since the type's introduction — and `.passthrough()` keeps the dozens of
 * volatile enrichment fields (CI, review, staleness) from rejecting digests
 * persisted by older or newer producers.
 */
export const FetchedPRSchema = z
  .object({
    url: z.string(),
    repo: z.string(),
    number: z.number(),
    status: FetchedPRStatusSchema,
  })
  .passthrough();

/**
 * The digest arrays hold full `FetchedPR` objects at runtime; validation is
 * intentionally limited to the identity/status core above (everything else
 * is ephemeral enrichment that older/newer producers legitimately differ
 * on), so the inferred type is widened back to `FetchedPR[]` for consumers.
 * The cast is sound in both directions: every real `FetchedPR` satisfies the
 * core schema, and `.passthrough()` preserves the enrichment fields on parse
 * output. This mirrors the pre-#1456 `z.array(z.any())` static contract
 * while actually validating the fields the dashboard dereferences.
 */
const FetchedPRArraySchema = z.array(FetchedPRSchema) as unknown as z.ZodType<FetchedPR[]>;

export const DailyDigestSchema = z.object({
  generatedAt: z.string(),

  // FetchedPR arrays — ephemeral, regenerated each run. Validated for the
  // identity/status core the dashboard dereferences; loose on the rest.
  openPRs: FetchedPRArraySchema,
  needsAddressingPRs: FetchedPRArraySchema,
  waitingOnMaintainerPRs: FetchedPRArraySchema,

  recentlyClosedPRs: z.array(ClosedPRSchema),
  recentlyMergedPRs: z.array(MergedPRSchema),

  shelvedPRs: z.array(ShelvedPRRefSchema),
  autoUnshelvedPRs: z.array(ShelvedPRRefSchema),

  summary: DailyDigestSummarySchema,
});

// ── 8. Root schema ───────────────────────────────────────────────────

export const AgentStateSchema = z.object({
  version: z.literal(4),
  gistId: z.string().optional(),

  repoScores: z.record(z.string(), RepoScoreSchema).default({}),

  config: AgentConfigSchema.default(() => AgentConfigSchema.parse({})),

  lastRunAt: z.string().default(() => new Date().toISOString()),

  lastDigestAt: z.string().optional(),

  /**
   * ISO timestamp of the most recent {@link computeStrategy} invocation
   * embedded in a daily run output (#1270). The cadence gate in
   * `daily.ts` consults this — strategy snapshots fire every 30 days OR
   * when 5+ PRs have merged since the last snapshot, whichever comes
   * first. Below {@link STRATEGY_MIN_PRS} merged PRs the gate stays
   * silent regardless of cadence.
   */
  lastStrategyAt: z.string().optional(),

  lastDigest: DailyDigestSchema.optional(),

  monthlyMergedCounts: z.record(z.string(), z.number()).optional(),
  monthlyClosedCounts: z.record(z.string(), z.number()).optional(),
  monthlyOpenedCounts: z.record(z.string(), z.number()).optional(),

  localRepoCache: LocalRepoCacheSchema.optional(),

  mergedPRs: z.array(StoredMergedPRSchema).optional(),
  closedPRs: z.array(StoredClosedPRSchema).optional(),

  analyzedIssueConversations: z.array(AnalyzedIssueConversationSchema).optional(),

  activeIssues: z.array(TrackedIssueSchema).default([]),

  /**
   * Per-PR follow-up history (#1277). Keyed by PR URL. Each entry
   * records a tier-bucketed follow-up that the user drafted (and
   * presumably posted via `draft-review-post`). The dormant-pr
   * workflow reads this before drafting to enforce the
   * one-follow-up-per-timeframe rule documented in
   * `skills/pr-etiquette/SKILL.md`.
   */
  prFollowUpHistory: z.record(z.string(), z.array(FollowUpEntrySchema)).optional(),

  /**
   * Pause-point snapshot for resumable workflows (#1280). Set when
   * the user picks "Done for now" mid-workflow; cleared when the
   * workflow completes or the user explicitly discards. The router
   * reads this on every `/oss` invocation and offers Resume /
   * Restart / Discard when present.
   */
  workflowState: WorkflowStateSchema.optional(),
});

// ── Inferred types ───────────────────────────────────────────────────

export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export type FetchedPRStatus = z.infer<typeof FetchedPRStatusSchema>;
export type ProjectCategory = z.infer<typeof ProjectCategorySchema>;
export type IssueScope = z.infer<typeof IssueScopeSchema>;
export type DiffTool = z.infer<typeof DiffToolSchema>;
export type RepoSignals = z.infer<typeof RepoSignalsSchema>;
export type RepoScore = z.infer<typeof RepoScoreSchema>;
export type StoredMergedPR = z.infer<typeof StoredMergedPRSchema>;
export type StoredClosedPR = z.infer<typeof StoredClosedPRSchema>;
export type AnalyzedIssueConversation = z.infer<typeof AnalyzedIssueConversationSchema>;

export type ContributionGuidelines = z.infer<typeof ContributionGuidelinesSchema>;
export type IssueVettingResult = z.infer<typeof IssueVettingResultSchema>;
export type TrackedIssue = z.infer<typeof TrackedIssueSchema>;

export type ShelvedPRRef = z.infer<typeof ShelvedPRRefSchema>;
export type StatusOverride = z.infer<typeof StatusOverrideSchema>;

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export type LocalRepoCache = z.infer<typeof LocalRepoCacheSchema>;

export type ClosedPR = z.infer<typeof ClosedPRSchema>;
export type MergedPR = z.infer<typeof MergedPRSchema>;
export type DailyDigestSummary = z.infer<typeof DailyDigestSummarySchema>;
export type DailyDigest = z.infer<typeof DailyDigestSchema>;

export type AgentState = z.infer<typeof AgentStateSchema>;
