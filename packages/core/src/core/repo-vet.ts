/**
 * Repo health scoring (#1242).
 *
 * Extracted from `agents/repo-evaluator.md`'s in-prompt assembly logic
 * so the rubric weights, sub-factor thresholds, and verdict cutoffs
 * are deterministic, unit-testable, and tunable without editing
 * markdown. Same architectural shape as success-grade (#858),
 * compliance-score (#1245), and strategy (#1243).
 *
 * The function is pure — callers (the MCP tool, the CLI command)
 * supply pre-fetched repo signals so the score is reproducible
 * against fixture data and offline replays.
 *
 * Rubric reference: docs/repo-rubric.md.
 */

export interface RepoVetInput {
  /** Star count from the GitHub repo metadata. */
  stars: number;
  forks: number;
  openIssues: number;
  watchers: number;
  isArchived: boolean;
  /** ISO-8601 timestamp of the last push. */
  lastPushed: string;
  /** ISO-8601 timestamp of repo creation. */
  createdAt: string;
  /** Number of commits to the default branch in the last 30 days. */
  commitsLast30Days: number;
  /** Per-PR `createdAt → mergedAt` durations in days, for the last 90
   * days of merged PRs. Used to derive avg / median merge time. */
  prMergeTimesDays: number[];
  /** Count of merges in the last 90 days. */
  mergedCount90Days: number;
  /** Count of opened PRs in the last 90 days. Used for merge rate. */
  openedCount90Days: number;
  /** ISO-8601 timestamp of the most recent commit on the default branch. */
  lastCommitISO: string | null;
  /** Distinct authors who committed in the last 90 days. */
  contributorsLast90d: number;
  /** ISO-8601 timestamp of the most recent published release. */
  lastReleaseISO: string | null;
  hasContributing: boolean;
  hasIssueTemplates: boolean;
  hasPRTemplate: boolean;
  hasCodeOfConduct: boolean;
}

export type RepoVetVerdict = 'recommended' | 'proceed_with_caution' | 'avoid';

export interface RepoVetResult {
  repo: {
    stars: number;
    forks: number;
    openIssues: number;
    watchers: number;
    isArchived: boolean;
    lastPushed: string;
    createdAt: string;
  };
  prMergeTime: {
    avgDays: number | null;
    medianDays: number | null;
    sampleSize: number;
    sourceWindowDays: 90;
  };
  mergeRate: {
    merged: number;
    opened: number;
    percent: number | null;
    windowDays: 90;
  };
  maintainerActivity: {
    lastCommitISO: string | null;
    contributorsLast90d: number;
    lastReleaseISO: string | null;
  };
  communityHealth: {
    contributing: boolean;
    issueTemplates: boolean;
    prTemplate: boolean;
    codeOfConduct: boolean;
  };
  /** Weighted 1-10 score per docs/repo-rubric.md. */
  rubricScore: number;
  /** Top-line verdict derived from the score and red-flag overrides. */
  rubricVerdict: RepoVetVerdict;
}

const WEIGHTS = {
  activity: 0.25,
  prSpeed: 0.25,
  mergeRate: 0.2,
  guidelines: 0.1,
  stability: 0.05,
  /** Responsiveness (15%) is documented in the rubric but the input
   * shape doesn't surface it — `gh pr list --json` doesn't expose
   * "time to first review". Per the rubric note, omit it rather than
   * fabricate it. The remaining weights total 0.85 and are normalized
   * to a 10-point ceiling at the end. */
} as const;

const SUM_OF_AVAILABLE_WEIGHTS =
  WEIGHTS.activity + WEIGHTS.prSpeed + WEIGHTS.mergeRate + WEIGHTS.guidelines + WEIGHTS.stability;

const VERDICT_CUTOFFS = {
  recommended: 7.5,
  cautious: 5,
} as const;

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function activitySubScore(input: RepoVetInput): number {
  // 1.0 when commits/30d ≥ 30 (one per day), 0 when 0, linear in between.
  if (input.isArchived) return 0;
  return Math.min(1, input.commitsLast30Days / 30);
}

function prSpeedSubScore(input: RepoVetInput): number {
  // Rubric: avg PR merge time < 7 days = healthy. Linear: 0d → 1.0,
  // 14d+ → 0.0. Sample of zero merges = 0 score (no signal of speed).
  if (input.prMergeTimesDays.length === 0) return 0;
  const avg = input.prMergeTimesDays.reduce((sum, d) => sum + d, 0) / input.prMergeTimesDays.length;
  if (avg <= 0) return 1;
  if (avg >= 14) return 0;
  return Math.max(0, Math.min(1, (14 - avg) / 14));
}

function mergeRateSubScore(input: RepoVetInput): number {
  // Rubric: >70% merged in last 90 days. Linear: 100% → 1.0, 0% → 0.
  if (input.openedCount90Days === 0) return 0;
  const rate = input.mergedCount90Days / input.openedCount90Days;
  return Math.max(0, Math.min(1, rate));
}

function guidelinesSubScore(input: RepoVetInput): number {
  // Each of the four community-health flags contributes equally.
  let score = 0;
  if (input.hasContributing) score += 0.4;
  if (input.hasIssueTemplates) score += 0.25;
  if (input.hasPRTemplate) score += 0.25;
  if (input.hasCodeOfConduct) score += 0.1;
  return Math.min(1, score);
}

function stabilitySubScore(input: RepoVetInput): number {
  // Rubric: not archived, regular releases. Half-credit for not-archived,
  // half for a release within the last 6 months.
  if (input.isArchived) return 0;
  let score = 0.5;
  if (input.lastReleaseISO) {
    const since = Date.now() - new Date(input.lastReleaseISO).getTime();
    const sixMonths = 1000 * 60 * 60 * 24 * 30 * 6;
    if (since <= sixMonths) score += 0.5;
  }
  return score;
}

/**
 * Hard red-flag overrides — when one fires, verdict drops to `avoid`
 * regardless of the weighted score. Sourced verbatim from the rubric.
 */
function hasRedFlags(input: RepoVetInput): boolean {
  if (input.isArchived) return true;
  if (input.lastCommitISO) {
    const sinceCommit = Date.now() - new Date(input.lastCommitISO).getTime();
    const sixtyDays = 60 * 24 * 60 * 60 * 1000;
    if (sinceCommit > sixtyDays) return true;
  }
  if (input.openedCount90Days > 0 && input.mergedCount90Days === 0) return true;
  return false;
}

function deriveVerdict(score: number, redFlags: boolean): RepoVetVerdict {
  if (redFlags) return 'avoid';
  if (score >= VERDICT_CUTOFFS.recommended) return 'recommended';
  if (score >= VERDICT_CUTOFFS.cautious) return 'proceed_with_caution';
  return 'avoid';
}

/**
 * Compute repo-health metrics and an overall rubric score from
 * pre-fetched signals (#1242). Pure function — no I/O, no global state.
 */
export function computeRepoVet(input: RepoVetInput): RepoVetResult {
  const subScores = {
    activity: activitySubScore(input),
    prSpeed: prSpeedSubScore(input),
    mergeRate: mergeRateSubScore(input),
    guidelines: guidelinesSubScore(input),
    stability: stabilitySubScore(input),
  };

  // Weighted average normalized to the 10-point ceiling.
  const weightedSum =
    subScores.activity * WEIGHTS.activity +
    subScores.prSpeed * WEIGHTS.prSpeed +
    subScores.mergeRate * WEIGHTS.mergeRate +
    subScores.guidelines * WEIGHTS.guidelines +
    subScores.stability * WEIGHTS.stability;
  const rubricScore = Math.round((weightedSum / SUM_OF_AVAILABLE_WEIGHTS) * 100) / 10;

  const sampleSize = input.prMergeTimesDays.length;
  const avgDays = sampleSize === 0 ? null : input.prMergeTimesDays.reduce((s, d) => s + d, 0) / sampleSize;
  const medianDays = sampleSize === 0 ? null : median(input.prMergeTimesDays);

  // Cap at 100. A repo clearing a backlog can have mergedCount > openedCount
  // because PRs opened before the window can merge inside it — without the
  // cap, the surfaced text would read "Merge rate (90d): 160% (8/5)" which
  // looks like a tool bug. The score itself is fine (mergeRateSubScore
  // clamps separately); this just keeps the display sensible.
  const mergeRatePercent =
    input.openedCount90Days === 0 ? null : Math.min(100, (input.mergedCount90Days / input.openedCount90Days) * 100);

  const verdict = deriveVerdict(rubricScore, hasRedFlags(input));

  return {
    repo: {
      stars: input.stars,
      forks: input.forks,
      openIssues: input.openIssues,
      watchers: input.watchers,
      isArchived: input.isArchived,
      lastPushed: input.lastPushed,
      createdAt: input.createdAt,
    },
    prMergeTime: { avgDays, medianDays, sampleSize, sourceWindowDays: 90 },
    mergeRate: {
      merged: input.mergedCount90Days,
      opened: input.openedCount90Days,
      percent: mergeRatePercent,
      windowDays: 90,
    },
    maintainerActivity: {
      lastCommitISO: input.lastCommitISO,
      contributorsLast90d: input.contributorsLast90d,
      lastReleaseISO: input.lastReleaseISO,
    },
    communityHealth: {
      contributing: input.hasContributing,
      issueTemplates: input.hasIssueTemplates,
      prTemplate: input.hasPRTemplate,
      codeOfConduct: input.hasCodeOfConduct,
    },
    rubricScore,
    rubricVerdict: verdict,
  };
}
