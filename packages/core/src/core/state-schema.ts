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

export const StateEventTypeSchema = z.enum([
  'pr_tracked',
  'pr_merged',
  'pr_closed',
  'pr_dormant',
  'daily_check',
  'comment_posted',
]);

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

export const StateEventSchema = z.object({
  id: z.string(),
  type: StateEventTypeSchema,
  at: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export const StoredMergedPRSchema = z.object({
  url: z.string(),
  title: z.string(),
  mergedAt: z.string(),
});

export const StoredClosedPRSchema = z.object({
  url: z.string(),
  title: z.string(),
  closedAt: z.string(),
});

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

  scoreThreshold: z.number().int().min(1).max(10).default(6),

  starredRepos: z.array(z.string()).default([]),
  starredReposLastFetched: z.string().optional(),

  showHealthCheck: z.boolean().optional(),

  squashByDefault: z.union([z.boolean(), z.literal('ask')]).default(true),

  localRepoScanPaths: z.array(z.string()).optional(),

  minStars: z.number().default(50),

  includeDocIssues: z.boolean().default(true),

  aiPolicyBlocklist: z.array(z.string()).default(['matplotlib/matplotlib']),

  shelvedPRUrls: z.array(z.string()).default([]),

  dismissedIssues: z.record(z.string(), z.string()).default({}),

  statusOverrides: z.record(z.string(), StatusOverrideSchema).optional(),

  issueListPath: z.string().optional(),

  projectCategories: z.array(ProjectCategorySchema).default([]),

  preferredOrgs: z.array(z.string()).default([]),
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
});

export const MergedPRSchema = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  mergedAt: z.string(),
});

export const DailyDigestSummarySchema = z.object({
  totalActivePRs: z.number(),
  totalNeedingAttention: z.number(),
  totalMergedAllTime: z.number(),
  mergeRate: z.number(),
});

export const DailyDigestSchema = z.object({
  generatedAt: z.string(),

  // FetchedPR arrays — ephemeral, regenerated each run. Validated loosely.
  openPRs: z.array(z.any()),
  needsAddressingPRs: z.array(z.any()),
  waitingOnMaintainerPRs: z.array(z.any()),

  recentlyClosedPRs: z.array(ClosedPRSchema),
  recentlyMergedPRs: z.array(MergedPRSchema),

  shelvedPRs: z.array(ShelvedPRRefSchema),
  autoUnshelvedPRs: z.array(ShelvedPRRefSchema),

  summary: DailyDigestSummarySchema,
});

// ── 8. Root schema ───────────────────────────────────────────────────

export const AgentStateSchema = z.object({
  version: z.literal(2),

  repoScores: z.record(z.string(), RepoScoreSchema).default({}),

  config: AgentConfigSchema.default(() => AgentConfigSchema.parse({})),

  events: z.array(StateEventSchema).default([]),

  lastRunAt: z.string().default(() => new Date().toISOString()),

  lastDigestAt: z.string().optional(),

  lastDigest: DailyDigestSchema.optional(),

  monthlyMergedCounts: z.record(z.string(), z.number()).optional(),
  monthlyClosedCounts: z.record(z.string(), z.number()).optional(),
  monthlyOpenedCounts: z.record(z.string(), z.number()).optional(),
  dailyActivityCounts: z.record(z.string(), z.number()).optional(),

  localRepoCache: LocalRepoCacheSchema.optional(),

  mergedPRs: z.array(StoredMergedPRSchema).optional(),
  closedPRs: z.array(StoredClosedPRSchema).optional(),

  activeIssues: z.array(TrackedIssueSchema).default([]),
});

// ── Inferred types ───────────────────────────────────────────────────

export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export type FetchedPRStatus = z.infer<typeof FetchedPRStatusSchema>;
export type ProjectCategory = z.infer<typeof ProjectCategorySchema>;
export type IssueScope = z.infer<typeof IssueScopeSchema>;
export type StateEventType = z.infer<typeof StateEventTypeSchema>;

export type RepoSignals = z.infer<typeof RepoSignalsSchema>;
export type RepoScore = z.infer<typeof RepoScoreSchema>;
export type StateEvent = z.infer<typeof StateEventSchema>;
export type StoredMergedPR = z.infer<typeof StoredMergedPRSchema>;
export type StoredClosedPR = z.infer<typeof StoredClosedPRSchema>;

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
