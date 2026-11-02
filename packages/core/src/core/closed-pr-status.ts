/**
 * Status updates for issues whose PR closed without merge (#1863).
 *
 * When the user closes their own PR unmerged, the write-up usually stays in
 * the PR thread while the linked issue still shows their "I'll work on this"
 * as the latest word. The daily run turns such closes into a one-off nudge:
 * draft a short status comment on the linked issue (the user posts it
 * themselves) and release the local claim so the issue re-enters the
 * commented-issue monitor instead of reading as in progress.
 *
 * Pure selection logic lives here: which recently closed PRs still have a
 * live successor, which fall outside the window, and which link the same
 * issue. Everything that needs GitHub (who closed the PR, whether the user
 * has commented since) sits in `PRMonitor.fetchPRClosedBy` and
 * `IssueConversationMonitor.hasUserCommentSince`, orchestrated by daily.ts.
 *
 * URLs are compared through `issueRefKey`, so `Org/Repo` and `org/repo`,
 * trailing slashes and `#fragment`s all name the same issue.
 */

import type { ClosedPR } from './types.js';
import { issueRefKey } from './urls.js';
import { debug } from './logger.js';

const MODULE = 'closed-pr-status';

/**
 * How long after the close a PR may prompt a status update. Matches the
 * default lookback of `PRMonitor.fetchRecentlyClosedPRs`; re-checked here
 * because that search is bounded on `updated`, not on the close date.
 */
export const CLOSED_PR_STATUS_WINDOW_DAYS = 7;

const WINDOW_MS = CLOSED_PR_STATUS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

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
 * Any PR of the user's that may supersede a closed one: open PRs
 * (`FetchedPR`, which also carry `mentionedIssueUrls`), recently merged PRs,
 * or merged-ledger entries (issue link only).
 */
export interface IssueLinkedPR {
  url: string;
  /** Issue the PR closes via a closing keyword. */
  issueUrl?: string;
  /** Every issue/PR the title and body mention, keyword or not (open PRs only). */
  mentionedIssueUrls?: readonly string[];
}

/** A recently closed PR with a parsed issue link. */
export type ClosedPRStatusCandidate = ClosedPR & { issueUrl: string };

/** A possible successor, reduced to the normalized refs it links. */
interface Successor {
  url: string;
  /** Identity for the self-check; the URL itself when it does not parse. */
  selfKey: string;
  /** `issueRefKey`s of everything the PR closes or mentions. */
  keys: Set<string>;
}

function toSuccessor(other: IssueLinkedPR): Successor {
  const keys = new Set<string>();
  const closes = other.issueUrl && issueRefKey(other.issueUrl);
  if (closes) keys.add(closes);
  if (other.mentionedIssueUrls) {
    for (const mention of other.mentionedIssueUrls) {
      const key = issueRefKey(mention);
      if (key) keys.add(key);
    }
  }
  return { url: other.url, selfKey: issueRefKey(other.url) ?? other.url, keys };
}

/**
 * The normalized issue key a closed PR should be nudged about, or null when
 * it should be left alone (reason debug-logged). See
 * {@link selectClosedPRStatusCandidates} for the rules.
 */
function eligibleIssueKey(pr: ClosedPR, successors: readonly Successor[], nowMs: number): string | null {
  if (pr.issueUrl === undefined) return null;
  const issueKey = issueRefKey(pr.issueUrl);
  if (!issueKey) {
    debug(MODULE, `Skipping ${pr.url}: issue URL ${pr.issueUrl} does not parse`);
    return null;
  }
  const closedMs = Date.parse(pr.closedAt);
  if (Number.isNaN(closedMs)) {
    debug(MODULE, `Skipping ${pr.url}: closedAt ${JSON.stringify(pr.closedAt)} does not parse`);
    return null;
  }
  if (nowMs - closedMs > WINDOW_MS) {
    debug(MODULE, `Skipping ${pr.url}: closed ${pr.closedAt}, outside the ${CLOSED_PR_STATUS_WINDOW_DAYS}-day window`);
    return null;
  }
  const prKey = issueRefKey(pr.url);
  const selfKey = prKey ?? pr.url;
  const wanted = prKey === null ? [issueKey] : [issueKey, prKey];
  const successor = successors.find((other) => other.selfKey !== selfKey && wanted.some((key) => other.keys.has(key)));
  if (successor) {
    debug(MODULE, `Skipping ${pr.url}: superseded by ${successor.url}`);
    return null;
  }
  return issueKey;
}

/**
 * Pick the recently closed PRs that should prompt a status update.
 *
 * Drops, in this order:
 * - PRs with no parsed issue link (nothing to update) or an issue URL that
 *   does not parse.
 * - PRs whose `closedAt` is unparseable or older than
 *   {@link CLOSED_PR_STATUS_WINDOW_DAYS} relative to `now`. The search behind
 *   `recentlyClosedPRs` is bounded on `updated`, so a stale close that just
 *   got a comment can come back.
 * - Superseded PRs: another of the user's PRs in `otherPRs` closes the same
 *   issue, or mentions the issue or the closed PR anywhere in its title or
 *   body (`#N`, `owner/repo#N`, or the URL). The issue thread then already
 *   has a live successor and the claim stays. Superseding is the safe
 *   direction, so any mention counts, closing keyword or not.
 *
 * When several closed PRs link the same issue, only the latest close
 * survives so the user is asked about each issue once.
 */
export function selectClosedPRStatusCandidates(
  recentlyClosedPRs: readonly ClosedPR[],
  otherPRs: readonly IssueLinkedPR[],
  now: Date = new Date(),
): ClosedPRStatusCandidate[] {
  const successors = otherPRs.map((other) => toSuccessor(other));
  const nowMs = now.getTime();
  const latestPerIssue = new Map<string, ClosedPRStatusCandidate>();
  for (const pr of recentlyClosedPRs) {
    const issueKey = eligibleIssueKey(pr, successors, nowMs);
    if (issueKey === null) continue;
    const current = latestPerIssue.get(issueKey);
    if (!current || Date.parse(pr.closedAt) > Date.parse(current.closedAt)) {
      latestPerIssue.set(issueKey, pr as ClosedPRStatusCandidate);
    }
  }
  return Array.from(latestPerIssue, ([, pr]) => pr);
}

/** Project a candidate onto the digest shape. */
export function toClosedPRStatusUpdate(pr: ClosedPRStatusCandidate): ClosedPRStatusUpdate {
  return { prUrl: pr.url, issueUrl: pr.issueUrl, closedAt: pr.closedAt };
}
