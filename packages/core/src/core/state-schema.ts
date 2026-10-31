/**
 * Zod schemas for all types persisted in state.json.
 *
 * This file is the single source of truth for persisted type shapes.
 * Types are inferred via `z.infer<>` at the bottom of this file and
 * re-exported through types.ts.
 *
 * Schemas are defined bottom-up (leaf types first, composites last).
 * Unknown keys are stripped by default (Zod 4 behavior), EXCEPT on the schemas
 * marked `.passthrough()` (#1831): see the note above AgentStateSchema.
 */
import { z } from 'zod';
import { CLOSE_REASONS, SELF_CLOSE_REASONS } from './close-reason.js';

/**
 * An enum that also accepts values it does not know (#1831): a newer release
 * may add a value, and a strict enum would make this release reject the whole
 * state. Known values keep editor completion; read sites must handle others.
 */
function openEnum<const T extends readonly string[]>(_values: T) {
  return z.custom<T[number] | (string & {})>((v) => typeof v === 'string');
}

/** Drops the `[k: string]: unknown` index signature `.passthrough()` adds to an inferred type. */
type KnownKeys<T> = { [K in keyof T as string extends K ? never : K]: T[K] };
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

export const RepoScoreSchema = z
  .object({
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
  })
  .passthrough();

/**
 * What the tool predicted about an issue when it was vetted (#1824). Recorded
 * by `vet` / `vet-list` keyed by issue URL, then copied onto the outcome
 * ledger entry of the PR that closes that issue, so outcomes can be compared
 * against the prediction that picked them (calibration).
 */
export const PickSnapshotSchema = z
  .object({
    issueUrl: z.string(),
    /** Success-likelihood grade (1-10) from issue-grading. */
    grade: z.number(),
    recommendation: z.string(),
    stargazersCount: z.number().optional(),
    /** `list`: the curated list's `**Tier (N/10)**` score, imported by ledger-backfill. */
    source: openEnum(['vet', 'vet-list', 'list'] as const),
    /** When the vet ran. Absent for `list` picks: the list does not record vet dates reliably. */
    capturedAt: z.string().optional(),
    // Issue traits at vet time, for the eval's trait cuts. Older snapshots lack them.
    labels: z.array(z.string()).optional(),
    /** Raw GitHub author association of the issue author; the eval buckets it. */
    issueAuthorAssociation: openEnum([
      'OWNER',
      'MEMBER',
      'COLLABORATOR',
      'CONTRIBUTOR',
      'FIRST_TIMER',
      'FIRST_TIME_CONTRIBUTOR',
      'MANNEQUIN',
      'NONE',
    ] as const).optional(),
    issueAuthorIsBot: z.boolean().optional(),
    /** Open, non-draft PRs by others that close the issue or are in its repo. */
    competingPRs: z.number().optional(),
    /** The user had no merged PR in the repo yet. */
    firstInRepo: z.boolean().optional(),
    commentCount: z.number().optional(),
  })
  .passthrough();

/**
 * Outcome-ledger fields added by #1824, shared by merged and closed entries.
 * All optional: entries written before #1824 have none of them.
 */
const LedgerPredictionFields = {
  /** Issue the PR closes, parsed from a closing keyword in the PR body. */
  issueUrl: z.string().optional(),
  /** The vet-time prediction for `issueUrl`, when one was recorded. */
  pick: PickSnapshotSchema.optional(),
  /** Review decision from the last digest that saw the PR open. */
  lastReviewDecision: z.string().optional(),
  /** CI status from the last digest that saw the PR open. */
  lastCiStatus: z.string().optional(),
  /** When ledger-backfill got GitHub's answer for this PR; later runs skip it. */
  backfilledAt: z.string().optional(),
};

export const StoredMergedPRSchema = z
  .object({
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
     * Earliest maintainer (non-bot, non-author) comment or review on the
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
    ...LedgerPredictionFields,
  })
  .passthrough();

export const StoredClosedPRSchema = z
  .object({
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
    ...LedgerPredictionFields,
    /** Why it closed unmerged (#1824), set by ledger-backfill. */
    closeReason: openEnum(CLOSE_REASONS).optional(),
    /** For `self-closed`: superseded, no traction, after feedback, or no response (#1824). */
    selfCloseReason: openEnum(SELF_CLOSE_REASONS).optional(),
  })
  .passthrough();

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

export const AgentConfigSchema = z
  .object({
    setupComplete: z.boolean().default(false),
    setupCompletedAt: z.string().optional(),

    persistence: z.enum(['local', 'gist']).default('local'),

    maxActivePRs: z.number().default(10),
    /**
     * Per-repo open-PR caps (core/repo-cap.ts). Discovery leaves out a repo
     * once the user has this many open PRs there; the cold cap applies while
     * none of their PRs in the repo have merged (first PRs merge less often).
     * The warm cap is off by default so it never blocks repos that merge.
     * 0 disables either.
     */
    maxOpenPRsPerRepo: z.number().int().min(0).default(0),
    maxOpenPRsColdRepo: z.number().int().min(0).default(1),
    dormantThresholdDays: z.number().default(30),
    approachingDormantDays: z.number().default(25),
    maxIssueAgeDays: z.number().default(90),
    // Skip the broad discovery phase once this many candidates from NEW repos are
    // found (0 disables — broad always runs). Affinity/starred-repo candidates do
    // not count, so the broad phase still surfaces repos you haven't touched.
    skipBroadWhenSufficientResults: z.number().min(0).default(8),

    languages: z.array(z.string()).default(['typescript', 'javascript']),
    labels: z.array(z.string()).default(['good first issue', 'help wanted']),
    scope: z.array(IssueScopeSchema).optional(),
    excludeRepos: z.array(z.string()).default([]),
    excludeOrgs: z.array(z.string()).optional(),
    /**
     * Orgs whose PRs are left out of PR tracking (open, recently closed and
     * recently merged lists), e.g. an employer's public repos. Unlike
     * `excludeOrgs`, which only affects discovery (#591).
     */
    untrackedOrgs: z.array(z.string()).default([]),

    /**
     * Repos (owner/repo) to softly downrank in discovery results (#1464).
     * Milder than `excludeRepos`' hard filter: scout pushes matches below
     * equally-recommended candidates but does not remove them, and a strong
     * affinity boost can still outweigh the penalty (scout #168).
     * Threaded to scout via `scout-bridge.ts`.
     */
    avoidRepos: z.array(z.string()).default([]),

    /**
     * Issue label types (e.g. "bug", "good first issue") to softly boost in
     * discovery ranking, matched case-insensitively against issue labels
     * (scout #168 / #1464). Does not filter results or change viability
     * scores. Threaded to scout via `scout-bridge.ts`.
     */
    boostIssueTypes: z.array(z.string()).default([]),

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
     * Extract per-repo learnings from freshly merged PRs automatically at
     * `/oss` startup and in `/oss-overnight` (#1696). When false, `daily`
     * offers the extraction as an `extract_learnings` action-menu item instead.
     */
    autoExtractLearnings: z.boolean().default(true),

    /**
     * No effect since the hook was removed in #1642; kept for state-file
     * compatibility.
     */
    autoFormatBeforePush: z.boolean().default(false),

    /**
     * No effect since the hook was removed in #1642; kept for state-file
     * compatibility.
     */
    trustOwnRepoWrites: z.boolean().default(false),

    /**
     * No effect since the hook was removed in #1642; kept for state-file
     * compatibility.
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
  })
  // Passthrough (#1831): a newer release's config fields survive this
  // version's load/save. Retired fields must be dropped explicitly instead.
  .passthrough()
  .transform(({ snoozedPRs: _retired, ...config }) => config);

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
  /** Issue the PR closes, parsed from the PR body (#1824). */
  issueUrl: z.string().optional(),
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
  /** Issue the PR closes, parsed from the PR body (#1824). */
  issueUrl: z.string().optional(),
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

/**
 * The status partitions are filters of openPRs (PRMonitor.generateDigest), so
 * the persisted state stores them empty (state-prune.ts) and they are
 * re-derived here on load. Each open PR is persisted once.
 */
function derivePartitions(raw: unknown): unknown {
  const openPRs = (raw as { openPRs?: unknown } | null)?.openPRs;
  // No open PRs: nothing to derive; keep what is stored (legacy digests).
  if (!Array.isArray(openPRs) || openPRs.length === 0) return raw;
  return {
    ...(raw as object),
    needsAddressingPRs: openPRs.filter((pr: { status?: unknown }) => pr?.status === 'needs_addressing'),
    waitingOnMaintainerPRs: openPRs.filter((pr: { status?: unknown }) => pr?.status === 'waiting_on_maintainer'),
  };
}

const DailyDigestObjectSchema = z.object({
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

export const DailyDigestSchema = z.preprocess(derivePartitions, DailyDigestObjectSchema);

// ── 8. Root schema ───────────────────────────────────────────────────

/**
 * One entry in the search seen-set (#1528). Records that an issue URL was
 * surfaced by a recent `search` so the next search can rotate past it instead
 * of returning the same candidates every time. oss-scout's `search()` excludes
 * URLs whose `lastSeenAt` is within its rotation TTL (default 7 days); this is
 * the durable backing store that lets that exclusion survive between separate
 * `/oss` invocations (autopilot runs scout in `persistence: 'provided'` mode,
 * so scout persists nothing itself). Deliberately lean — only the two fields
 * scout's rotation reads — so the state file stays small.
 */
export const SearchSeenEntrySchema = z.object({
  url: z.string(),
  lastSeenAt: z.string(),
});

/**
 * One branch an overnight agent prepared locally (#1574). Never pushed by the
 * run; `overnight push-prep` (#1698) may later stage it under `prep/*` on the
 * user's fork and fills in `pushedRef`, `pushedAt` and `compareUrl`.
 */
export const OvernightPreparedSchema = z
  .object({
    url: z.string(),
    branch: z.string(),
    worktree: z.string().optional(),
    note: z.string().optional(),
    recordedAt: z.string(),
    /** Branch name on the fork (`prep/<branch>`), set by `overnight push-prep`. */
    pushedRef: z.string().optional(),
    pushedAt: z.string().optional(),
    /** `<fork>/compare/<pr-head>...prep/<branch>`; absent when the PR head could not be read. */
    compareUrl: z.string().optional(),
    /** Why the last `overnight push-prep` did not push this branch; cleared once it is pushed. */
    pushProblem: z.string().optional(),
  })
  .passthrough();

/** The latest overnight run (#1574); `startup` surfaces its freshness. */
/**
 * One list issue the overnight run tried to implement (#1715). Kept across
 * runs so a blocked issue is not retried every night; cleared when the
 * issue leaves the list.
 */
export const OvernightImplementAttemptSchema = z
  .object({
    url: z.string(),
    attemptedAt: z.string(),
    outcome: z.enum(['prepared', 'blocked']),
    note: z.string().optional(),
  })
  .passthrough();

export const OvernightRecordSchema = z
  .object({
    runAt: z.string(),
    reportPath: z.string(),
    prepareCount: z.number().int().nonnegative(),
    judgmentCount: z.number().int().nonnegative(),
    prepared: z.array(OvernightPreparedSchema).default([]),
    /** The one curated-list issue picked for implementation this run, if any (#1715). */
    implementUrl: z.string().optional(),
    implementAttempts: z.array(OvernightImplementAttemptSchema).optional(),
  })
  .passthrough();

/**
 * Mirrors oss-scout's `searchRotation`: the broad-phase language cursor, the
 * repo-window cursors of the capped phases, and the round-robin strategy
 * cursor (oss-scout 1.7.0). List every cursor so it gets its default;
 * passthrough (#1831) keeps a cursor added by a newer bundled scout instead of
 * resetting it to 0 on this release's next save.
 */
export const SearchRotationSchema = z
  .object({
    languageOffset: z.number().int().nonnegative().default(0),
    phase0Offset: z.number().int().nonnegative().default(0),
    starredOffset: z.number().int().nonnegative().default(0),
    maintainedOffset: z.number().int().nonnegative().default(0),
    strategyOffset: z.number().int().nonnegative().default(0),
    lastRotatedAt: z.string().optional(),
  })
  .passthrough();

/**
 * Forward compatibility (#1831). The state Gist is shared by clients on
 * different releases, and a strict parse let an older client drop a newer
 * release's fields on its next save. Schemas for data that is written once and
 * kept (root, config, repoScores, the outcome ledger and pick snapshots,
 * lastOvernight, searchRotation) are `.passthrough()`; schemas regenerated on
 * every run (lastDigest) or rarely extended still strip. Persisted enums that
 * grow (closeReason, pick source) accept unknown strings via {@link openEnum}.
 * Inferred types drop the passthrough index signature ({@link KnownKeys}) so a
 * misspelled key still fails to compile.
 */
export const AgentStateSchema = z
  .object({
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

    /**
     * Durable search seen-set for result rotation (#1528). Issue URLs surfaced
     * by recent searches, with the timestamp they were last surfaced. Fed into
     * oss-scout as `savedResults` so its rotation excludes recently-surfaced
     * issues, and updated after each search. Culled past the rotation window so
     * it cannot grow without bound.
     */
    searchSeen: z.array(SearchSeenEntrySchema).default([]),

    /**
     * Vet-time predictions keyed by issue URL (#1824), newest last. Joined onto
     * outcome-ledger entries at merge/close detection. Capped at
     * MAX_PICK_SNAPSHOTS so it cannot grow without bound.
     */
    pickSnapshots: z.array(PickSnapshotSchema).default([]),

    /** Latest overnight run (#1574). Absent until the first `overnight`. */
    lastOvernight: OvernightRecordSchema.optional(),
    /**
     * Broad-phase language rotation cursor (#1630), oss-scout's `searchRotation`.
     * Scout advances it after every search whose broad phase ran; autopilot runs
     * scout in persistence:'provided', so the advanced cursor is written back
     * here and fed into the next scout state. Absent until the first search.
     */
    searchRotation: SearchRotationSchema.optional(),
  })
  .passthrough();

// ── Inferred types ───────────────────────────────────────────────────

export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export type FetchedPRStatus = z.infer<typeof FetchedPRStatusSchema>;
export type ProjectCategory = z.infer<typeof ProjectCategorySchema>;
export type IssueScope = z.infer<typeof IssueScopeSchema>;
export type DiffTool = z.infer<typeof DiffToolSchema>;
export type SearchSeenEntry = z.infer<typeof SearchSeenEntrySchema>;
export type PickSnapshot = KnownKeys<z.infer<typeof PickSnapshotSchema>>;
export type OvernightPrepared = KnownKeys<z.infer<typeof OvernightPreparedSchema>>;
export type OvernightRecord = KnownKeys<z.infer<typeof OvernightRecordSchema>>;
export type OvernightImplementAttempt = KnownKeys<z.infer<typeof OvernightImplementAttemptSchema>>;
export type SearchRotation = KnownKeys<z.infer<typeof SearchRotationSchema>>;
export type RepoSignals = z.infer<typeof RepoSignalsSchema>;
export type RepoScore = KnownKeys<z.infer<typeof RepoScoreSchema>>;
export type StoredMergedPR = KnownKeys<z.infer<typeof StoredMergedPRSchema>>;
export type StoredClosedPR = KnownKeys<z.infer<typeof StoredClosedPRSchema>>;
export type AnalyzedIssueConversation = z.infer<typeof AnalyzedIssueConversationSchema>;

export type ContributionGuidelines = z.infer<typeof ContributionGuidelinesSchema>;
export type IssueVettingResult = z.infer<typeof IssueVettingResultSchema>;
export type TrackedIssue = z.infer<typeof TrackedIssueSchema>;

export type ShelvedPRRef = z.infer<typeof ShelvedPRRefSchema>;
export type StatusOverride = z.infer<typeof StatusOverrideSchema>;

export type AgentConfig = KnownKeys<z.infer<typeof AgentConfigSchema>>;

export type LocalRepoCache = z.infer<typeof LocalRepoCacheSchema>;

export type ClosedPR = z.infer<typeof ClosedPRSchema>;
export type MergedPR = z.infer<typeof MergedPRSchema>;
export type DailyDigestSummary = z.infer<typeof DailyDigestSummarySchema>;
export type DailyDigest = z.infer<typeof DailyDigestSchema>;

type RawAgentState = z.infer<typeof AgentStateSchema>;
export type AgentState = Omit<
  KnownKeys<RawAgentState>,
  'config' | 'repoScores' | 'mergedPRs' | 'closedPRs' | 'pickSnapshots' | 'lastOvernight' | 'searchRotation'
> & {
  config: AgentConfig;
  repoScores: Record<string, RepoScore>;
  mergedPRs?: StoredMergedPR[];
  closedPRs?: StoredClosedPR[];
  pickSnapshots: PickSnapshot[];
  lastOvernight?: OvernightRecord;
  searchRotation?: SearchRotation;
};

/** Top-level state keys this release does not know, i.e. written by another (usually newer) release (#1831). */
export function unknownStateKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const known = new Set(Object.keys(AgentStateSchema.shape));
  return Object.keys(raw).filter((k) => !known.has(k));
}

/** Warning tail for state written by a newer release (#1831), shared by the Gist and local loaders. */
export const NEWER_WRITER_HINT =
  'was written by a different oss-autopilot release (usually a newer one); this version keeps those fields ' +
  'but cannot use them. If you are not on the latest release, update with `claude plugin update oss-autopilot@oss-autopilot` and restart Claude Code.';
