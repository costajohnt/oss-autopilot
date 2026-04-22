/**
 * Status determination logic for PRs — extracted from PRMonitor (#263).
 *
 * Computes the top-level status (needs_addressing vs waiting_on_maintainer),
 * granular action/wait reasons, and staleness tier for a single PR based on
 * its CI, review, merge-conflict, and timeline signals.
 */

import type { ActionReason, DetermineStatusInput, DetermineStatusResult, StalenessTier } from './types.js';

/** Days of inactivity after which an actionable CI failure is demoted to stale_ci_failure (#675). */
export const STALE_CI_DEMOTION_DAYS = 5;

/**
 * CI-fix bots that push commits as a direct result of the contributor's push (#568).
 * Their commits represent contributor work and should count as addressing feedback.
 * This is intentionally an allowlist — not all `[bot]` accounts are CI-fix bots
 * (e.g. dependabot[bot] and renovate[bot] open their own PRs).
 * Values must be lowercase — lookup uses .toLowerCase() for case-insensitive matching.
 */
export const CI_FIX_BOTS: ReadonlySet<string> = new Set(['autofix-ci[bot]', 'prettier-ci[bot]', 'pre-commit-ci[bot]']);

/** Minimum gap (ms) between maintainer comment and contributor commit for
 *  the commit to count as "addressing" the feedback (#547). Prevents false
 *  positives from race conditions, clock skew, and in-flight pushes. */
export const MIN_RESPONSE_GAP_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Check whether the HEAD commit was authored by the contributor (#547).
 * Returns true when the author matches, when the author is a known CI-fix
 * bot (#568), or when author info is unavailable (graceful degradation).
 */
export function isContributorCommit(commitAuthor?: string, contributorUsername?: string): boolean {
  if (!commitAuthor || !contributorUsername) return true; // degrade gracefully
  const author = commitAuthor.toLowerCase();
  if (CI_FIX_BOTS.has(author)) return true; // CI-fix bots act on behalf of the contributor (#568)
  return author === contributorUsername.toLowerCase();
}

/**
 * Parse an ISO-8601-ish date string into epoch milliseconds.
 *
 * Central helper so the whole module compares dates numerically via `getTime()`
 * rather than relying on the lexicographic property of UTC ISO strings — the
 * latter happens to sort correctly today but silently breaks on any other date
 * format (local-time ISO, `Date.toString()`, non-standard). See #1044.
 *
 * Returns `NaN` for `undefined`, empty, or unparseable inputs so callers can
 * make an explicit fail-closed decision; never throws.
 */
export function normalizeToEpochMs(date: string | undefined | null): number {
  if (!date) return Number.NaN;
  return new Date(date).getTime();
}

/**
 * Check whether the contributor's commit is meaningfully after the maintainer's
 * comment — i.e. the commit timestamp is at least MIN_RESPONSE_GAP_MS later (#547).
 *
 * Fails closed (returns `false`) if either date is unparseable, avoiding the
 * silent lexicographic fallback that would produce wrong results for non-UTC
 * ISO inputs. See #1044.
 */
export function isCommitAfterComment(commitDate: string, commentDate: string): boolean {
  const commitMs = normalizeToEpochMs(commitDate);
  const commentMs = normalizeToEpochMs(commentDate);
  if (!Number.isFinite(commitMs) || !Number.isFinite(commentMs)) return false;
  return commitMs - commentMs >= MIN_RESPONSE_GAP_MS;
}

/**
 * Resolve the latest commit date, filtering out non-contributor commits (#547, #568).
 * Returns undefined when the commit was by a non-contributor or when no date is available.
 */
function resolveContributorCommitDate(input: DetermineStatusInput): string | undefined {
  const { latestCommitDate, latestCommitAuthor, contributorUsername } = input;
  if (!latestCommitDate) return undefined;
  return isContributorCommit(latestCommitAuthor, contributorUsername) ? latestCommitDate : undefined;
}

/** Check whether an unresponded comment has been addressed by a subsequent contributor commit. */
function isCommentAddressedByCommit(
  commitDate: string | undefined,
  commentDate: string | undefined,
  changesRequestedDate: string | undefined,
): boolean {
  if (!commitDate || !commentDate) return false;
  if (!isCommitAfterComment(commitDate, commentDate)) return false;
  // Safety net (#431): if a CHANGES_REQUESTED review came after the commit, it's not addressed.
  // Fail-closed on unparseable `changesRequestedDate` (#1044): treat unknown ordering as "not addressed".
  if (changesRequestedDate) {
    const commitMs = normalizeToEpochMs(commitDate);
    const changesRequestedMs = normalizeToEpochMs(changesRequestedDate);
    if (!Number.isFinite(commitMs) || !Number.isFinite(changesRequestedMs)) return false;
    if (commitMs < changesRequestedMs) return false;
  }
  return true;
}

/**
 * Check whether a changes_requested review has been addressed by a subsequent contributor commit.
 *
 * Fails closed (returns `false`) on unparseable inputs (#1044).
 */
function isChangesAddressedByCommit(commitDate: string | undefined, changesRequestedDate: string | undefined): boolean {
  if (!commitDate || !changesRequestedDate) return false;
  const commitMs = normalizeToEpochMs(commitDate);
  const changesRequestedMs = normalizeToEpochMs(changesRequestedDate);
  if (!Number.isFinite(commitMs) || !Number.isFinite(changesRequestedMs)) return false;
  return commitMs >= changesRequestedMs;
}

/**
 * Collect all applicable action reasons independently, without short-circuiting (#675).
 * Used alongside the priority-based decision tree to surface secondary issues.
 */
function collectAllActionReasons(input: DetermineStatusInput): ActionReason[] | undefined {
  const {
    ciStatus,
    hasMergeConflict,
    hasUnrespondedComment,
    hasIncompleteChecklist,
    reviewDecision,
    lastMaintainerCommentDate,
    latestChangesRequestedDate,
    hasActionableCIFailure = true,
  } = input;

  const commitDate = resolveContributorCommitDate(input);
  const reasons: ActionReason[] = [];

  if (
    hasUnrespondedComment &&
    !isCommentAddressedByCommit(commitDate, lastMaintainerCommentDate, latestChangesRequestedDate)
  ) {
    reasons.push('needs_response');
  }
  if (
    reviewDecision === 'changes_requested' &&
    latestChangesRequestedDate &&
    !isChangesAddressedByCommit(commitDate, latestChangesRequestedDate)
  ) {
    reasons.push('needs_changes');
  }
  if (ciStatus === 'failing' && hasActionableCIFailure) {
    reasons.push('failing_ci');
  }
  if (hasMergeConflict) {
    reasons.push('merge_conflict');
  }
  if (hasIncompleteChecklist) {
    reasons.push('incomplete_checklist');
  }

  return reasons.length > 0 ? reasons : undefined;
}

/**
 * Determine the overall status of a PR based on its signals.
 */
export function determineStatus(input: DetermineStatusInput): DetermineStatusResult {
  const primary = determinePrimaryStatus(input);
  const actionReasons = collectAllActionReasons(input);
  if (actionReasons) {
    return { ...primary, actionReasons };
  }
  return primary;
}

/**
 * Priority-based decision tree for the primary status classification.
 * Returns the single highest-priority status; `determineStatus` augments
 * this with the full `actionReasons` array.
 */
function determinePrimaryStatus(input: DetermineStatusInput): DetermineStatusResult {
  const {
    ciStatus,
    hasMergeConflict,
    hasUnrespondedComment,
    hasIncompleteChecklist,
    reviewDecision,
    daysSinceActivity,
    dormantThreshold,
    approachingThreshold,
    lastMaintainerCommentDate,
    latestChangesRequestedDate,
    hasActionableCIFailure = true,
  } = input;

  // Compute staleness tier (independent of status)
  let stalenessTier: StalenessTier = 'active';
  if (daysSinceActivity >= dormantThreshold) stalenessTier = 'dormant';
  else if (daysSinceActivity >= approachingThreshold) stalenessTier = 'approaching_dormant';

  const commitDate = resolveContributorCommitDate(input);

  // Priority order: needs_addressing (response/changes/ci/conflict/checklist) > waiting_on_maintainer (review/merge/addressed/ci_blocked)

  if (hasUnrespondedComment) {
    if (isCommentAddressedByCommit(commitDate, lastMaintainerCommentDate, latestChangesRequestedDate)) {
      if (ciStatus === 'failing' && hasActionableCIFailure)
        return { status: 'needs_addressing', actionReason: 'failing_ci', stalenessTier };
      // Non-actionable CI failures (infrastructure, fork, auth) don't block changes_addressed —
      // the contributor can't fix them, so the relevant status is "waiting for re-review" (#502)
      return { status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier };
    }
    return { status: 'needs_addressing', actionReason: 'needs_response', stalenessTier };
  }

  // Review requested changes but no unresponded comment.
  if (reviewDecision === 'changes_requested' && latestChangesRequestedDate) {
    if (!isChangesAddressedByCommit(commitDate, latestChangesRequestedDate)) {
      return { status: 'needs_addressing', actionReason: 'needs_changes', stalenessTier };
    }
    // Commit is after review — changes have been addressed
    if (ciStatus === 'failing' && hasActionableCIFailure)
      return { status: 'needs_addressing', actionReason: 'failing_ci', stalenessTier };
    // Non-actionable CI failures don't block changes_addressed (#502)
    return { status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier };
  }

  if (ciStatus === 'failing') {
    if (hasActionableCIFailure) {
      // Demote stale CI failures: if failing for 5+ days with no activity, likely pre-existing (#675)
      if (daysSinceActivity >= STALE_CI_DEMOTION_DAYS) {
        return { status: 'waiting_on_maintainer', waitReason: 'stale_ci_failure', stalenessTier };
      }
      return { status: 'needs_addressing', actionReason: 'failing_ci', stalenessTier };
    }
    return { status: 'waiting_on_maintainer', waitReason: 'ci_blocked', stalenessTier };
  }

  if (hasMergeConflict) {
    return { status: 'needs_addressing', actionReason: 'merge_conflict', stalenessTier };
  }

  if (hasIncompleteChecklist) {
    return { status: 'needs_addressing', actionReason: 'incomplete_checklist', stalenessTier };
  }

  // Approved and CI passing/unknown = waiting on maintainer to merge
  if (reviewDecision === 'approved' && (ciStatus === 'passing' || ciStatus === 'unknown')) {
    return { status: 'waiting_on_maintainer', waitReason: 'pending_merge', stalenessTier };
  }

  // Default: no actionable issues found. Covers pending CI, no reviews yet, etc.
  return { status: 'waiting_on_maintainer', waitReason: 'pending_review', stalenessTier };
}
