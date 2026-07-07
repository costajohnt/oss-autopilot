/**
 * Action-menu issue effort classification (#1264).
 *
 * Extracted from `workflows/action-menu.md`'s in-prompt truth table so
 * the rules are typed, unit-testable, and tunable without editing
 * markdown. Same architectural shape as the typed-core extractions in
 * #1245 (compliance-score), #1242 (repo-vet), #1243 (strategy), and
 * #1252 (pr-quality-rubric).
 */

/** Issue types the action menu surfaces. Match the strings the CLI emits in
 * `data.daily.actionableIssues[*].type`. */
export type ActionableIssueType =
  | 'needs_response'
  | 'needs_changes'
  | 'incomplete_checklist'
  | 'ci_failing'
  | 'merge_conflict';

export type IssueEffort = 'small' | 'medium' | 'large';

/**
 * Decide the effort label for an actionable issue based on its type and
 * how many maintainer hints accompany it. Default falls through to
 * `medium` for any unrecognized combination — the action-menu workflow
 * still renders something useful when the CLI surfaces a new issue
 * type before this function is updated.
 *
 * Truth table sourced verbatim from `workflows/action-menu.md`:
 *
 * | Effort | Condition |
 * |--------|-----------|
 * | small  | needs_response with 0-1 hints, incomplete_checklist |
 * | medium | needs_response with 2+ hints, needs_changes with 0-2 hints, ci_failing |
 * | large  | merge_conflict, needs_changes with 3+ hints |
 */
export function computeIssueEffort(type: ActionableIssueType, hintCount: number): IssueEffort {
  const hints = Math.max(0, hintCount);
  switch (type) {
    case 'needs_response':
      return hints <= 1 ? 'small' : 'medium';
    case 'incomplete_checklist':
      return 'small';
    case 'needs_changes':
      return hints >= 3 ? 'large' : 'medium';
    case 'ci_failing':
      return 'medium';
    case 'merge_conflict':
      return 'large';
    default:
      return 'medium';
  }
}
