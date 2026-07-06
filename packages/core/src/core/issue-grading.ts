/**
 * Issue success-likelihood score (#858, rescaled to 1-10 per #249 follow-up).
 *
 * Predicts the probability that a contribution to a given repo will be
 * accepted and merged, using signals already collected during vetting.
 *
 * The score is on a 1-10 scale. Each signal lands in one of four bands —
 * 10 / 7 / 4 / 1 (best→worst) — graded independently; the overall score is
 * the worst of the three, and drops one band if any signal is unknown
 * (missing data is treated as a risk, not ignored). This matches the policy
 * previously described as prose in agents/issue-scout.md.
 */

import type { ProjectHealth } from '@oss-scout/core';

export interface GradeSignals {
  /** Average maintainer response time in days; null if unknown. */
  avgResponseDays: number | null;
  /** Fraction of recent PRs that merged (0–1); null if unknown. */
  mergeRate: number | null;
  /** Days since the most recent commit on the default branch; null if unknown. */
  daysSinceLastCommit: number | null;
}

export interface GradeResult {
  /** Success-likelihood score on a 1-10 scale (higher is better). */
  score: number;
  /** Short human-readable explanation of what drove the score. */
  reason: string;
}

type SignalScore = { score: number; detail: string };

// Band values, best→worst. A signal always resolves to one of these, so
// degradeOneStep can step down the ladder by index.
const BANDS: readonly number[] = [10, 7, 4, 1];

function worst(scores: SignalScore[]): SignalScore {
  return scores.reduce((acc, s) => (s.score < acc.score ? s : acc));
}

function degradeOneStep(score: number): number {
  const i = BANDS.indexOf(score);
  // Unrecognized score (shouldn't happen) is treated as already-worst.
  if (i === -1) return BANDS[BANDS.length - 1];
  return BANDS[Math.min(i + 1, BANDS.length - 1)];
}

/**
 * Coerce a candidate numeric signal to `number` if it's finite and in
 * the given range, otherwise `null`. Non-finite, NaN, and out-of-range
 * values are treated as unknown (and therefore trigger the degrade
 * rule) rather than silently producing bogus grades from garbage input.
 */
function sanitize(value: number | null | undefined, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function gradeResponsiveness(avgResponseDays: number): SignalScore {
  if (avgResponseDays < 3) return { score: 10, detail: `~${Math.round(avgResponseDays)}-day avg response` };
  if (avgResponseDays < 14) return { score: 7, detail: `${Math.round(avgResponseDays)}-day avg response` };
  if (avgResponseDays <= 60) return { score: 4, detail: `${Math.round(avgResponseDays)}-day avg response` };
  return { score: 1, detail: 'unresponsive maintainers' };
}

function gradeMergeRate(mergeRate: number): SignalScore {
  const pct = Math.round(mergeRate * 100);
  if (mergeRate > 0.7) return { score: 10, detail: `merges ${pct}% of PRs` };
  if (mergeRate >= 0.4) return { score: 7, detail: `merges ${pct}% of PRs` };
  if (mergeRate >= 0.1) return { score: 4, detail: `merges ${pct}% of PRs` };
  return { score: 1, detail: `merges ${pct}% of PRs` };
}

function gradeActivity(daysSinceLastCommit: number): SignalScore {
  if (daysSinceLastCommit < 7) return { score: 10, detail: 'commits in last week' };
  if (daysSinceLastCommit < 30) return { score: 7, detail: 'commits in last month' };
  if (daysSinceLastCommit < 90) return { score: 4, detail: 'commits in last 90 days' };
  return { score: 1, detail: `no commits in ${daysSinceLastCommit}+ days` };
}

/**
 * Build `GradeSignals` from a vet candidate's project health plus the
 * optional autopilot-tracked repo score.
 *
 * Notes on each signal:
 *
 * - `avgResponseDays` — `@oss-scout/core`'s `projectHealth.avgIssueResponseDays`
 *   is a hardcoded `0` placeholder (it doesn't yet make the additional API
 *   calls needed to compute a real value). We therefore prefer
 *   `repoScore.avgResponseDays`, which autopilot derives from its own PR
 *   tracking, and fall back to `null` (unknown) if neither source has a
 *   usable value.
 * - `mergeRate` — derived from repoScore counts. Requires a non-empty PR
 *   history; `0/0` is `null`, not `0`.
 * - `daysSinceLastCommit` — taken from scout's `projectHealth`, but only
 *   when scout's health check succeeded (`checkFailed` means scout filled
 *   in sentinels and shouldn't be trusted).
 */
export function deriveGradeSignals(params: {
  projectHealth: {
    avgIssueResponseDays: number | null;
    daysSinceLastCommit: number | null;
    checkFailed?: boolean;
  };
  repoScore: {
    mergedPRCount: number;
    closedWithoutMergeCount: number;
    avgResponseDays?: number | null;
  } | null;
}): GradeSignals {
  const { projectHealth, repoScore } = params;
  const healthTrusted = !projectHealth.checkFailed;

  const avgResponseDays =
    sanitize(repoScore?.avgResponseDays, 0, Number.MAX_SAFE_INTEGER) ??
    (healthTrusted ? sanitize(projectHealth.avgIssueResponseDays, 0.001, Number.MAX_SAFE_INTEGER) : null);

  const daysSinceLastCommit = healthTrusted
    ? sanitize(projectHealth.daysSinceLastCommit, 0, Number.MAX_SAFE_INTEGER)
    : null;

  let mergeRate: number | null = null;
  if (repoScore) {
    const merged = sanitize(repoScore.mergedPRCount, 0, Number.MAX_SAFE_INTEGER);
    const closed = sanitize(repoScore.closedWithoutMergeCount, 0, Number.MAX_SAFE_INTEGER);
    if (merged !== null && closed !== null) {
      const total = merged + closed;
      mergeRate = total === 0 ? null : merged / total;
    }
  }

  return { avgResponseDays, mergeRate, daysSinceLastCommit };
}

/**
 * End-to-end helper for vet callers: reads the repo score, derives
 * signals from a scout candidate, and returns the grade. Callers pass
 * the `projectHealth` straight through from `scout.vetIssue()`.
 *
 * Which "repo score" this grades from (#1465): the `getRepoScore` input is
 * the cached HISTORY record (the user's own merge outcomes, see
 * docs/repo-scores.md §History score) — NOT `repo-vet`'s fresh health
 * rubric. The fresh side only enters through `projectHealth`, and only when
 * scout actually fetched it: the `search` surface passes a `checkFailed`
 * sentinel (health not fetched per candidate), so search grades purely from
 * history-side signals, while `vet` re-grades with fresh health. Same 1-10
 * scale, different inputs — the two surfaces can legitimately disagree.
 */
export function gradeFromCandidate(params: {
  repo: string;
  // Scout 1.0 made ProjectHealth a discriminated union (success vs check-failed)
  // (#158). Accept it whole; the failure arm carries no snapshot fields, so we
  // normalize it to the minimal grade-input shape below.
  projectHealth: ProjectHealth;
  getRepoScore: (repo: string) =>
    | {
        mergedPRCount: number;
        closedWithoutMergeCount: number;
        avgResponseDays: number | null;
      }
    | undefined;
}): GradeResult {
  const repoScore = params.getRepoScore(params.repo);
  // Narrow the union into the minimal shape deriveGradeSignals expects. The
  // check-failed arm has no avgIssueResponseDays/daysSinceLastCommit, and the
  // grader already treats checkFailed as untrusted (no snapshot signals).
  const ph = params.projectHealth;
  const projectHealth = ph.checkFailed
    ? { avgIssueResponseDays: null, daysSinceLastCommit: null, checkFailed: true }
    : {
        avgIssueResponseDays: ph.avgIssueResponseDays,
        daysSinceLastCommit: ph.daysSinceLastCommit,
        checkFailed: false,
      };
  return computeSuccessGrade(
    deriveGradeSignals({
      projectHealth,
      repoScore: repoScore
        ? {
            mergedPRCount: repoScore.mergedPRCount,
            closedWithoutMergeCount: repoScore.closedWithoutMergeCount,
            avgResponseDays: repoScore.avgResponseDays,
          }
        : null,
    }),
  );
}

export function computeSuccessGrade(signals: GradeSignals): GradeResult {
  const graded: SignalScore[] = [];
  const unknowns: string[] = [];

  const resp = sanitize(signals.avgResponseDays, 0, Number.MAX_SAFE_INTEGER);
  if (resp === null) unknowns.push('maintainer responsiveness');
  else graded.push(gradeResponsiveness(resp));

  const mr = sanitize(signals.mergeRate, 0, 1);
  if (mr === null) unknowns.push('merge rate');
  else graded.push(gradeMergeRate(mr));

  const act = sanitize(signals.daysSinceLastCommit, 0, Number.MAX_SAFE_INTEGER);
  if (act === null) unknowns.push('activity');
  else graded.push(gradeActivity(act));

  // No signal available at all — score the lowest band so callers see missing
  // data as a strong negative rather than a neutral score.
  if (graded.length === 0) {
    return { score: BANDS[BANDS.length - 1], reason: `unknown ${unknowns.join(', ')}` };
  }

  const worstKnown = worst(graded);
  const finalScore = unknowns.length > 0 ? degradeOneStep(worstKnown.score) : worstKnown.score;

  const reasonParts = [worstKnown.detail];
  if (unknowns.length > 0) reasonParts.push(`unknown ${unknowns.join(', ')}`);

  return { score: finalScore, reason: reasonParts.join(', ') };
}
