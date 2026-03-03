/**
 * Display Utils - Human-readable display label computation for PR statuses.
 * Extracted from PRMonitor to isolate presentation logic (#263).
 */

import { FetchedPR, FetchedPRStatus } from './types.js';
import { warn } from './logger.js';

const MODULE = 'display-utils';

/**
 * Deterministic mapping from FetchedPRStatus -> human-readable display label (#79).
 * Ensures consistent label text across sessions — agents no longer derive these.
 */
const STATUS_DISPLAY: Record<FetchedPRStatus, { label: string; description: (pr: FetchedPR) => string }> = {
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
  ci_not_running: {
    label: '[CI Not Running]',
    description: () => 'No CI checks have been triggered',
  },
  merge_conflict: {
    label: '[Merge Conflict]',
    description: () => 'PR has merge conflicts with the base branch',
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
  incomplete_checklist: {
    label: '[Incomplete Checklist]',
    description: (pr) =>
      pr.checklistStats
        ? `${pr.checklistStats.checked}/${pr.checklistStats.total} items checked`
        : 'PR body has unchecked required checkboxes',
  },
  changes_addressed: {
    label: '[Changes Addressed]',
    description: (pr) =>
      pr.lastMaintainerComment
        ? `Waiting for @${pr.lastMaintainerComment.author} to re-review`
        : 'Waiting for maintainer re-review',
  },
  waiting: {
    label: '[Waiting]',
    description: () => 'CI pending or awaiting review',
  },
  waiting_on_maintainer: {
    label: '[Waiting on Maintainer]',
    description: () => 'Approved and CI passes — waiting for merge',
  },
  healthy: {
    label: '[Healthy]',
    description: () => 'Everything looks good — normal review cycle',
  },
  approaching_dormant: {
    label: '[Approaching Dormant]',
    description: (pr) => `No activity for ${pr.daysSinceActivity} days`,
  },
  dormant: {
    label: '[Dormant]',
    description: (pr) => `No activity for ${pr.daysSinceActivity} days`,
  },
};

/** Compute display label and description for a FetchedPR (#79). */
export function computeDisplayLabel(pr: FetchedPR): { displayLabel: string; displayDescription: string } {
  const entry = STATUS_DISPLAY[pr.status];
  if (!entry) {
    warn(MODULE, `Unknown status "${pr.status}" for PR #${pr.number} (${pr.url})`);
    return { displayLabel: `[${pr.status}]`, displayDescription: 'Unknown status' };
  }
  return {
    displayLabel: entry.label,
    displayDescription: entry.description(pr),
  };
}
