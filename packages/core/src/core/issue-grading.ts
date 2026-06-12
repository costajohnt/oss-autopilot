/**
 * Issue success-likelihood grade (#858).
 *
 * Predicts the probability that a contribution to a given repo will be
 * accepted and merged, using signals already collected during vetting.
 *
 * The grade is letter-based (A/B/C/F — no D). Each signal is graded
 * independently; the overall grade is the worst of the three, and is
 * further degraded one step if any signal is unknown (missing data is
 * treated as a risk, not ignored). This matches the policy previously
 * described as prose in agents/issue-scout.md.
 */

import type { ProjectHealth } from '@oss-scout/core';

export type GradeLetter = 'A' | 'B' | 'C' | 'F';

export interface GradeSignals {
  /** Average maintainer response time in days; null if unknown. */
  avgResponseDays: number | null;
  /** Fraction of recent PRs that merged (0–1); null if unknown. */
  mergeRate: number | null;
  /** Days since the most recent commit on the default branch; null if unknown. */
  daysSinceLastCommit: number | null;
}

export interface GradeResult {
  letter: GradeLetter;
  /** Short human-readable explanation of what drove the grade. */
  reason: string;
}

type SignalGrade = { letter: GradeLetter; detail: string };

const SEVERITY: Record<GradeLetter, number> = { A: 0, B: 1, C: 2, F: 3 };
const LETTERS: readonly GradeLetter[] = ['A', 'B', 'C', 'F'];

function worst(grades: SignalGrade[]): SignalGrade {
  return grades.reduce((acc, g) => (SEVERITY[g.letter] > SEVERITY[acc.letter] ? g : acc));
}

function degradeOneStep(letter: GradeLetter): GradeLetter {
  return LETTERS[Math.min(SEVERITY[letter] + 1, LETTERS.length - 1)];
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

function gradeResponsiveness(avgResponseDays: number): SignalGrade {
  if (avgResponseDays < 3) return { letter: 'A', detail: `~${Math.round(avgResponseDays)}-day avg response` };
  if (avgResponseDays < 14) return { letter: 'B', detail: `${Math.round(avgResponseDays)}-day avg response` };
  if (avgResponseDays <= 60) return { letter: 'C', detail: `${Math.round(avgResponseDays)}-day avg response` };
  return { letter: 'F', detail: 'unresponsive maintainers' };
}

function gradeMergeRate(mergeRate: number): SignalGrade {
  const pct = Math.round(mergeRate * 100);
  if (mergeRate > 0.7) return { letter: 'A', detail: `merges ${pct}% of PRs` };
  if (mergeRate >= 0.4) return { letter: 'B', detail: `merges ${pct}% of PRs` };
  if (mergeRate >= 0.1) return { letter: 'C', detail: `merges ${pct}% of PRs` };
  return { letter: 'F', detail: `merges ${pct}% of PRs` };
}

function gradeActivity(daysSinceLastCommit: number): SignalGrade {
  if (daysSinceLastCommit < 7) return { letter: 'A', detail: 'commits in last week' };
  if (daysSinceLastCommit < 30) return { letter: 'B', detail: 'commits in last month' };
  if (daysSinceLastCommit < 90) return { letter: 'C', detail: 'commits in last 90 days' };
  return { letter: 'F', detail: `no commits in ${daysSinceLastCommit}+ days` };
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
 * history-side signals, while `vet` re-grades with fresh health. Same letter
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
  const graded: SignalGrade[] = [];
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

  // No signal available at all — give F so callers see missing data as a
  // strong negative rather than a neutral grade.
  if (graded.length === 0) {
    return { letter: 'F', reason: `unknown ${unknowns.join(', ')}` };
  }

  const worstKnown = worst(graded);
  const finalLetter = unknowns.length > 0 ? degradeOneStep(worstKnown.letter) : worstKnown.letter;

  const reasonParts = [worstKnown.detail];
  if (unknowns.length > 0) reasonParts.push(`unknown ${unknowns.join(', ')}`);

  return { letter: finalLetter, reason: reasonParts.join(', ') };
}
