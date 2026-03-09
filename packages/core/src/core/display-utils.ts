/**
 * Display Utils - Human-readable display label computation for PR statuses.
 * Extracted from PRMonitor to isolate presentation logic (#263).
 *
 * Uses two reason-keyed maps (ACTION_DISPLAY / WAIT_DISPLAY) instead of a
 * single status-keyed map, reflecting the 2-status taxonomy where the
 * granular reason lives in `actionReason` / `waitReason`.
 */

import { FetchedPR, ActionReason, WaitReason } from './types.js';
import { warn } from './logger.js';

const ACTION_DISPLAY: Record<ActionReason, { label: string; description: (pr: FetchedPR) => string }> = {
  needs_response: {
    label: '[Needs Response]',
    description: (pr) =>
      pr.lastMaintainerComment ? `@${pr.lastMaintainerComment.author} commented` : 'Maintainer awaiting response',
  },
  needs_changes: {
    label: '[Needs Changes]',
    description: () => 'Review requested changes — push commits to address',
  },
  failing_ci: {
    label: '[CI Failing]',
    description: (pr) => {
      const checks = pr.classifiedChecks || [];
      const actionable = checks.filter((c) => c.category === 'actionable');
      if (actionable.length > 0)
        return `${actionable.length} check${actionable.length === 1 ? '' : 's'} failed: ${actionable.map((c) => c.name).join(', ')}`;
      const infrastructure = checks.filter((c) => c.category === 'infrastructure');
      if (infrastructure.length > 0)
        return `${infrastructure.length} check${infrastructure.length === 1 ? '' : 's'} cancelled/timed out (infrastructure)`;
      const failingNames = pr.failingCheckNames || [];
      if (failingNames.length > 0) return `${failingNames.length} check${failingNames.length === 1 ? '' : 's'} failed`;
      return 'One or more CI checks are failing';
    },
  },
  merge_conflict: {
    label: '[Merge Conflict]',
    description: () => 'PR has merge conflicts with the base branch',
  },
  incomplete_checklist: {
    label: '[Incomplete Checklist]',
    description: (pr) =>
      pr.checklistStats
        ? `${pr.checklistStats.checked}/${pr.checklistStats.total} items checked`
        : 'PR body has unchecked required checkboxes',
  },
  ci_not_running: {
    label: '[CI Not Running]',
    description: () => 'No CI checks have been triggered',
  },
  needs_rebase: {
    label: '[Needs Rebase]',
    description: () => 'PR branch is significantly behind upstream',
  },
  missing_required_files: {
    label: '[Missing Files]',
    description: (pr) =>
      pr.missingRequiredFiles ? `Missing: ${pr.missingRequiredFiles.join(', ')}` : 'Required files are missing',
  },
};

const WAIT_DISPLAY: Record<WaitReason, { label: string; description: (pr: FetchedPR) => string }> = {
  pending_review: {
    label: '[Waiting on Maintainer]',
    description: () => 'Awaiting review',
  },
  pending_merge: {
    label: '[Waiting on Maintainer]',
    description: () => 'Approved and CI passes — waiting for merge',
  },
  changes_addressed: {
    label: '[Waiting on Maintainer]',
    description: (pr) => {
      if (pr.hasUnrespondedComment && pr.lastMaintainerComment) {
        return `Changes addressed — waiting for @${pr.lastMaintainerComment.author} to re-review`;
      }
      return 'Changes addressed — awaiting re-review';
    },
  },
  ci_blocked: {
    label: '[CI Blocked]',
    description: (pr) => {
      const checks = pr.classifiedChecks || [];
      if (checks.length > 0 && checks.every((c) => c.category !== 'actionable')) {
        const categories = [...new Set(checks.map((c) => c.category))];
        return `All failing checks are non-actionable (${categories.join(', ')})`;
      }
      return 'CI checks are failing but no action is needed from you';
    },
  },
  stale_ci_failure: {
    label: '[Stale CI Failure]',
    description: (pr) => `CI failing for ${pr.daysSinceActivity}+ days — likely pre-existing or non-actionable`,
  },
};

/** Convert a bracketed display label like "[CI Failing]" to a plain lowercase string like "ci failing". */
function labelToPlainText(reason: ActionReason): string {
  const label = ACTION_DISPLAY[reason]?.label;
  if (!label) return reason;
  return label.replace(/[[\]]/g, '').toLowerCase();
}

/** Compute display label and description for a FetchedPR (#79). */
export function computeDisplayLabel(pr: FetchedPR): { displayLabel: string; displayDescription: string } {
  if (pr.status === 'needs_addressing' && pr.actionReason) {
    const entry = ACTION_DISPLAY[pr.actionReason];
    if (entry) {
      let displayDescription = entry.description(pr);
      // Append secondary action reasons when multiple issues exist (#675)
      if (pr.actionReasons && pr.actionReasons.length > 1) {
        const secondary = pr.actionReasons.slice(1).map(labelToPlainText);
        displayDescription += ` (also: ${secondary.join(', ')})`;
      }
      return { displayLabel: entry.label, displayDescription };
    }
  }
  if (pr.status === 'waiting_on_maintainer' && pr.waitReason) {
    const entry = WAIT_DISPLAY[pr.waitReason];
    if (entry) return { displayLabel: entry.label, displayDescription: entry.description(pr) };
  }
  // Fallback for missing reason — log so we can identify data issues
  warn(
    'display-utils',
    `PR ${pr.url} has status "${pr.status}" but no matching reason (actionReason=${pr.actionReason}, waitReason=${pr.waitReason})`,
  );
  if (pr.status === 'needs_addressing') {
    return { displayLabel: '[Needs Addressing]', displayDescription: 'Action required' };
  }
  return { displayLabel: '[Waiting on Maintainer]', displayDescription: 'Awaiting maintainer action' };
}
