/**
 * Status updates for issues whose PR closed without merge (#1863).
 *
 * When the user closes their own PR unmerged, the write-up usually stays in
 * the PR thread while the linked issue still shows their "I'll work on this"
 * as the latest word. The daily run turns such closes into a one-off nudge:
 * draft a short status comment on the linked issue (the user posts it
 * themselves) and release the local claim so the issue stops counting
 * toward capacity.
 *
 * "Only once" has no stamp in state. It falls out of two existing bounds:
 * the recently-closed window (`fetchRecentlyClosedPRs`, 7 days) and the
 * check in daily that the user has not commented on the issue since the
 * PR closed — once the status comment is posted, the candidate drops out.
 *
 * Pure selection logic lives here; the comment check needs GitHub and sits
 * in `IssueConversationMonitor.hasUserCommentSince`.
 */

import type { ClosedPR } from './types.js';

/** One closed-unmerged PR whose linked issue still needs a status update. */
export interface ClosedPRStatusUpdate {
  /** The PR that closed without merge; its closing comment seeds the draft. */
  prUrl: string;
  /** Issue the PR claimed to close, parsed from its body. */
  issueUrl: string;
  /** When the PR closed; the status comment must land after this. */
  closedAt: string;
}

/**
 * Any PR of the user's that carries a parsed issue link: open PRs
 * (`FetchedPR`), recently merged PRs, or merged-ledger entries.
 */
export interface IssueLinkedPR {
  url: string;
  issueUrl?: string;
}

/**
 * Pick the recently closed PRs that should prompt a status update.
 *
 * Drops PRs with no parsed issue link (nothing to update) and PRs that were
 * superseded: another of the user's PRs in `otherPRs` closes the same issue,
 * so the issue thread already has a live successor. When several closed PRs
 * link the same issue, only the latest close survives so the user is asked
 * about each issue once.
 */
export function selectClosedPRStatusCandidates(
  recentlyClosedPRs: readonly ClosedPR[],
  otherPRs: readonly IssueLinkedPR[],
): ClosedPRStatusCandidate[] {
  const linked = recentlyClosedPRs.filter(
    (pr): pr is ClosedPRStatusCandidate =>
      pr.issueUrl !== undefined && otherPRs.every((other) => other.url === pr.url || other.issueUrl !== pr.issueUrl),
  );
  const latestPerIssue = new Map<string, ClosedPRStatusCandidate>();
  for (const pr of linked) {
    const current = latestPerIssue.get(pr.issueUrl);
    if (!current || Date.parse(pr.closedAt) > Date.parse(current.closedAt)) latestPerIssue.set(pr.issueUrl, pr);
  }
  return [...latestPerIssue].map(([, pr]) => pr);
}

/** A recently closed PR with a parsed issue link. */
export type ClosedPRStatusCandidate = ClosedPR & { issueUrl: string };

/** Project a candidate onto the digest shape. */
export function toClosedPRStatusUpdate(pr: ClosedPRStatusCandidate): ClosedPRStatusUpdate {
  return { prUrl: pr.url, issueUrl: pr.issueUrl, closedAt: pr.closedAt };
}
