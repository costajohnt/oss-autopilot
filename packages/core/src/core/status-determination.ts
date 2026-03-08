/**
 * Status determination logic for PRs — extracted from PRMonitor (#263).
 *
 * Computes the top-level status (needs_addressing vs waiting_on_maintainer),
 * granular action/wait reasons, and staleness tier for a single PR based on
 * its CI, review, merge-conflict, and timeline signals.
 */

import type { DetermineStatusInput, DetermineStatusResult, StalenessTier } from './types.js';

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
 * Check whether the contributor's commit is meaningfully after the maintainer's
 * comment — i.e. the commit timestamp is at least MIN_RESPONSE_GAP_MS later (#547).
 */
export function isCommitAfterComment(commitDate: string, commentDate: string): boolean {
  const commitMs = new Date(commitDate).getTime();
  const commentMs = new Date(commentDate).getTime();
  if (Number.isNaN(commitMs) || Number.isNaN(commentMs)) {
    // Fall back to simple string comparison (pre-#547 behavior)
    return commitDate > commentDate;
  }
  return commitMs - commentMs >= MIN_RESPONSE_GAP_MS;
}

/**
 * Determine the overall status of a PR based on its signals.
 */
export function determineStatus(input: DetermineStatusInput): DetermineStatusResult {
  const {
    ciStatus,
    hasMergeConflict,
    hasUnrespondedComment,
    hasIncompleteChecklist,
    reviewDecision,
    daysSinceActivity,
    dormantThreshold,
    approachingThreshold,
    latestCommitDate: rawCommitDate,
    latestCommitAuthor,
    contributorUsername,
    lastMaintainerCommentDate,
    latestChangesRequestedDate,
    hasActionableCIFailure = true,
  } = input;

  // Compute staleness tier (independent of status)
  let stalenessTier: StalenessTier = 'active';
  if (daysSinceActivity >= dormantThreshold) stalenessTier = 'dormant';
  else if (daysSinceActivity >= approachingThreshold) stalenessTier = 'approaching_dormant';

  // Only count the latest commit if it was authored by the contributor or a
  // CI bot (#547, #568). Non-contributor commits (maintainer merge commits,
  // GitHub suggestion commits) should not mask unaddressed feedback.
  const latestCommitDate =
    rawCommitDate && isContributorCommit(latestCommitAuthor, contributorUsername) ? rawCommitDate : undefined;

  // Priority order: needs_addressing (response/changes/ci/conflict/checklist) > waiting_on_maintainer (review/merge/addressed/ci_blocked)

  if (hasUnrespondedComment) {
    // If the contributor pushed a commit after the maintainer's comment,
    // the changes have been addressed — waiting for maintainer re-review.
    // Require a minimum 2-minute gap to avoid false positives from race
    // conditions (pushing while review is being submitted) (#547).
    if (
      latestCommitDate &&
      lastMaintainerCommentDate &&
      isCommitAfterComment(latestCommitDate, lastMaintainerCommentDate)
    ) {
      // Safety net (#431): if a CHANGES_REQUESTED review was submitted after
      // the commit, the maintainer still expects changes — don't mask it
      if (latestChangesRequestedDate && latestCommitDate < latestChangesRequestedDate) {
        return { status: 'needs_addressing', actionReason: 'needs_response', stalenessTier };
      }
      if (ciStatus === 'failing' && hasActionableCIFailure)
        return { status: 'needs_addressing', actionReason: 'failing_ci', stalenessTier };
      // Non-actionable CI failures (infrastructure, fork, auth) don't block changes_addressed —
      // the contributor can't fix them, so the relevant status is "waiting for re-review" (#502)
      return { status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier };
    }
    return { status: 'needs_addressing', actionReason: 'needs_response', stalenessTier };
  }

  // Review requested changes but no unresponded comment.
  // If the latest commit is before the review, the contributor hasn't addressed it yet.
  if (reviewDecision === 'changes_requested' && latestChangesRequestedDate) {
    if (!latestCommitDate || latestCommitDate < latestChangesRequestedDate) {
      return { status: 'needs_addressing', actionReason: 'needs_changes', stalenessTier };
    }
    // Commit is after review — changes have been addressed
    if (ciStatus === 'failing' && hasActionableCIFailure)
      return { status: 'needs_addressing', actionReason: 'failing_ci', stalenessTier };
    // Non-actionable CI failures don't block changes_addressed (#502)
    return { status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier };
  }

  if (ciStatus === 'failing') {
    return hasActionableCIFailure
      ? { status: 'needs_addressing', actionReason: 'failing_ci', stalenessTier }
      : { status: 'waiting_on_maintainer', waitReason: 'ci_blocked', stalenessTier };
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
