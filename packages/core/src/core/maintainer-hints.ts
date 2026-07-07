/**
 * Maintainer-hint label constants (#1264).
 *
 * Extracted from `workflows/action-menu.md`'s in-prompt mapping so the
 * label strings live in typed code instead of markdown. Adding a new
 * hint type becomes a single-file change in core; the workflow gets
 * the new label for free instead of requiring a parallel markdown
 * edit. Same pattern as #1252.
 */

export type MaintainerHint =
  | 'demo_requested'
  | 'tests_requested'
  | 'changes_requested'
  | 'docs_requested'
  | 'rebase_requested';

/**
 * Display labels the action-menu workflow renders for each hint type.
 * Source of truth — both `data.daily.actionableIssues[*].maintainerHintsLabel`
 * (computed by the CLI) and the workflow's prose docs reference this map.
 */
export const MAINTAINER_HINT_LABELS: Record<MaintainerHint, string> = {
  demo_requested: 'demo/screenshot requested',
  tests_requested: 'tests requested',
  changes_requested: 'code changes requested',
  docs_requested: 'documentation requested',
  rebase_requested: 'rebase requested',
};

/**
 * Format an array of hints as a comma-joined human label, in the same
 * order the caller passed them. Unknown hint values are dropped silently —
 * a future CLI version might emit a hint type the workflow doesn't yet
 * know about; rendering "undefined" would be worse than omitting it.
 */
export function formatMaintainerHints(hints: readonly MaintainerHint[] | readonly string[]): string {
  const labels: string[] = [];
  for (const h of hints) {
    const label = MAINTAINER_HINT_LABELS[h as MaintainerHint];
    if (label) labels.push(label);
  }
  return labels.join(', ');
}
