/**
 * Canonical PR quality rubric (#1252).
 *
 * Single source of truth for the PR-quality checks shared between
 * `skills/pr-etiquette/SKILL.md` (human-facing checklist) and
 * `agents/pr-compliance-checker.md` (agent-facing scoring via
 * `computeComplianceScore` in compliance-score.ts).
 *
 * Both surfaces had the same checks listed independently, with the
 * "< 10 files, < 400 lines ideal" threshold duplicated. Drift was
 * inevitable as either surface evolved. This module exports the
 * rubric as structured data so the two consumers cannot drift
 * silently — `compliance-score.ts` re-exports its WEIGHTS /
 * FOCUSED_CHANGES from here, and the skill prose references this
 * file as the canonical definition.
 *
 * Same architectural shape as the typed-core extractions in
 * #858 / #910 / #911 / #1245 / #1242 / #1243 — pull the rubric out
 * of prose into typed code so it's testable and tunable.
 */

export type PRQualityTier = 'required' | 'conditional' | 'optional';

export interface PRQualityCheck {
  /** Stable identifier referenced by the agent's scoring code. */
  id:
    | 'issueReference'
    | 'description'
    | 'title'
    | 'focusedChanges'
    | 'minimalDiff'
    | 'tests'
    | 'docs'
    | 'branch'
    | 'screenshots';
  /** Human-facing label as it appears in the skill checklist. */
  label: string;
  /** One-line description for both the skill checklist and the
   * agent's recommendation prose. */
  description: string;
  tier: PRQualityTier;
  /**
   * Percent weight in the agent's compliance score, when the check
   * is part of the scored set. `null` for checks the skill lists but
   * the agent doesn't currently score (Minimal Diff, Docs, Screenshots).
   */
  weight: number | null;
}

/**
 * Canonical "focused changes" thresholds. Mirrored by
 * compliance-score.ts's `FOCUSED_CHANGES` constant — that file
 * imports these values.
 */
export const FOCUSED_CHANGES_THRESHOLDS = {
  passFiles: 10,
  passLines: 400,
  warnFiles: 20,
  warnLines: 800,
} as const;

/**
 * Title byte budget. Mirrored by compliance-score.ts's
 * `TITLE_LENGTH_BUDGET` — that file imports this value.
 */
export const TITLE_LENGTH_BUDGET = 72;

/**
 * The full rubric. The order is the order the skill renders the
 * checklist in; the weights total 100 across the scored entries.
 */
export const PR_QUALITY_RUBRIC: readonly PRQualityCheck[] = [
  {
    id: 'issueReference',
    label: 'Issue Reference',
    description: 'PR links to issue (`Closes #X` or `Fixes #X`)',
    tier: 'required',
    weight: 25,
  },
  {
    id: 'description',
    label: 'Description Quality',
    description: 'Explains what changed and why',
    tier: 'required',
    weight: 25,
  },
  {
    id: 'title',
    label: 'Title Quality',
    description: 'Descriptive, properly formatted (e.g., `fix: resolve login timeout`)',
    tier: 'required',
    weight: 10,
  },
  {
    id: 'focusedChanges',
    label: 'Focused Changes',
    description: `One logical change per PR (< ${FOCUSED_CHANGES_THRESHOLDS.passFiles} files, < ${FOCUSED_CHANGES_THRESHOLDS.passLines} lines ideal)`,
    tier: 'required',
    weight: 20,
  },
  {
    id: 'minimalDiff',
    label: 'Minimal Diff',
    description: 'No unrelated formatting changes (whitespace, quotes, imports, trailing commas)',
    tier: 'required',
    weight: null,
  },
  {
    id: 'tests',
    label: 'Tests Included',
    description: 'If project requires tests, add them',
    tier: 'conditional',
    weight: 15,
  },
  {
    id: 'docs',
    label: 'Docs Updated',
    description: 'If behavior changed, update docs',
    tier: 'conditional',
    weight: null,
  },
  {
    id: 'branch',
    label: 'Branch Naming',
    description: 'Follows convention (`feature/`, `fix/`, `docs/`)',
    tier: 'optional',
    weight: 5,
  },
  {
    id: 'screenshots',
    label: 'Screenshots',
    description: 'Included for UI changes',
    tier: 'optional',
    weight: null,
  },
] as const;

/**
 * Look up a check by id. Used by `compliance-score.ts` to wire the
 * scored checks to their canonical weight without hardcoding the
 * value in two places.
 */
export function getRubricCheck(id: PRQualityCheck['id']): PRQualityCheck | undefined {
  return PR_QUALITY_RUBRIC.find((c) => c.id === id);
}

/**
 * Sum of the weights for scored checks. Should equal 100. Tests pin
 * this so a future edit that fails to balance the weights surfaces
 * at CI time rather than silently shipping a < 100 rubric.
 */
export function totalScoredWeight(): number {
  return PR_QUALITY_RUBRIC.reduce((sum, c) => sum + (c.weight ?? 0), 0);
}
