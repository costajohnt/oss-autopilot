/**
 * Engaged issues (#1862): the issues the user is working on, as opposed to
 * ones they commented on in passing.
 *
 * An issue is engaged when the user claimed it locally (`activeIssues`) or
 * one of their PRs links it: an open PR (closing keyword or any mention in
 * the title/body), a recently closed or merged PR, or a merged/closed ledger
 * entry with an issue link. `IssueConversationMonitor` scans engaged issues
 * under a wider reply rule (any substantive non-bot comment counts, not only
 * maintainer or @mention replies) and fetches the live ones directly when
 * the commenter search does not return them.
 *
 * Pure: builds a keyed map from the lists the daily run already holds. URLs
 * are compared through `issueRefKey`, so `Org/Repo` and `org/repo`, trailing
 * slashes and `#fragment`s all name the same issue.
 */

import type { EngagementReason, FetchedPR, IssueEngagement, TrackedIssue } from './types.js';
import { issueRefKey, parseGitHubUrl } from './urls.js';

const REASON_RANK: Record<EngagementReason, number> = { open_pr: 0, claim: 1, closed_pr: 2, merged_pr: 3 };

/** One engaged issue, keyed for lookup against search results. */
export interface EngagedIssue extends IssueEngagement {
  /** `issueRefKey` of the issue. */
  key: string;
  /** Canonical `https://github.com/owner/repo/issues/N` URL. */
  url: string;
  /**
   * Fetch the issue directly when the comment search misses it. True for
   * live engagements (claims, open PRs, the recent closed/merged lists);
   * false for ledger links, which can be years old and count only when the
   * search already found the issue active.
   */
  fetchWhenMissing: boolean;
}

/** A closed or merged PR with its issue link, from the digest lists or the ledger. */
export interface EngagedPRLink {
  url: string;
  /** Issue the PR closes via a closing keyword. */
  issueUrl?: string;
  /** When the PR was opened; optional on older ledger entries. */
  openedAt?: string;
}

/** Everything the daily run knows about the user's claims and PRs. */
export interface EngagedIssuesInput {
  /** Local claims; `updatedAt` is the claim stamp (see `StateManager.addIssue`). */
  claims: readonly Pick<TrackedIssue, 'url' | 'updatedAt'>[];
  openPRs: readonly Pick<FetchedPR, 'url' | 'issueUrl' | 'mentionedIssueUrls' | 'createdAt'>[];
  recentlyClosedPRs: readonly (EngagedPRLink & { closedAt: string })[];
  recentlyMergedPRs: readonly (EngagedPRLink & { mergedAt: string })[];
  ledgerClosedPRs: readonly (EngagedPRLink & { closedAt: string })[];
  ledgerMergedPRs: readonly (EngagedPRLink & { mergedAt: string })[];
}

interface Engagement extends IssueEngagement {
  issueUrl: string;
  fetchWhenMissing: boolean;
}

function laterOf(a: string, b: string): string {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(bMs)) return a;
  if (Number.isNaN(aMs)) return b;
  return bMs > aMs ? b : a;
}

/** Issues an open PR closes or mentions; both are the same engagement. */
function* openPREngagements(prs: EngagedIssuesInput['openPRs']): Generator<Engagement> {
  for (const pr of prs) {
    const mentions = pr.mentionedIssueUrls ?? [];
    const links = pr.issueUrl ? [pr.issueUrl, ...mentions] : mentions;
    for (const issueUrl of links) {
      yield { issueUrl, reason: 'open_pr', prUrl: pr.url, since: pr.createdAt, fetchWhenMissing: true };
    }
  }
}

/** Issues closed or merged PRs link, dated by the opening time when known. */
function* linkedPREngagements(input: EngagedIssuesInput): Generator<Engagement> {
  const lists = [
    { prs: input.recentlyClosedPRs, reason: 'closed_pr' as const, recent: true },
    { prs: input.recentlyMergedPRs, reason: 'merged_pr' as const, recent: true },
    { prs: input.ledgerClosedPRs, reason: 'closed_pr' as const, recent: false },
    { prs: input.ledgerMergedPRs, reason: 'merged_pr' as const, recent: false },
  ];
  for (const { prs, reason, recent } of lists) {
    for (const pr of prs) {
      if (!pr.issueUrl) continue;
      const endedAt = 'closedAt' in pr ? pr.closedAt : pr.mergedAt;
      yield { reason, issueUrl: pr.issueUrl, prUrl: pr.url, since: pr.openedAt ?? endedAt, fetchWhenMissing: recent };
    }
  }
}

/** Every engagement, strongest reason first. */
function* engagements(input: EngagedIssuesInput): Generator<Engagement> {
  yield* openPREngagements(input.openPRs);
  for (const claim of input.claims) {
    yield { issueUrl: claim.url, reason: 'claim', since: claim.updatedAt, fetchWhenMissing: true };
  }
  yield* linkedPREngagements(input);
}

/** Fold one engagement into the map: strongest reason, latest since, fetch if any is live. */
function record(byKey: Map<string, EngagedIssue>, engagement: Engagement): void {
  const parsed = parseGitHubUrl(engagement.issueUrl);
  const key = issueRefKey(engagement.issueUrl);
  if (!parsed || !key) return;
  const current = byKey.get(key);
  if (!current) {
    byKey.set(key, {
      key,
      url: `https://github.com/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`,
      reason: engagement.reason,
      prUrl: engagement.prUrl,
      since: engagement.since,
      fetchWhenMissing: engagement.fetchWhenMissing,
    });
    return;
  }
  if (REASON_RANK[engagement.reason] < REASON_RANK[current.reason]) {
    current.reason = engagement.reason;
    current.prUrl = engagement.prUrl;
  }
  current.since = laterOf(current.since, engagement.since);
  current.fetchWhenMissing ||= engagement.fetchWhenMissing;
}

/**
 * Collect the user's engaged issues, keyed by `issueRefKey`. When several
 * engagements name one issue, the entry keeps the strongest reason (and its
 * PR), the latest `since`, and fetches directly if any engagement is live.
 * Links that do not parse as GitHub URLs are skipped. Iteration order is
 * strongest-reason first (engagements are visited in that order, so an
 * issue is inserted at its strongest reason's position), so a caller that
 * caps direct fetches keeps the open-PR and claim issues.
 */
export function collectEngagedIssues(input: EngagedIssuesInput): Map<string, EngagedIssue> {
  const byKey = new Map<string, EngagedIssue>();
  for (const engagement of engagements(input)) record(byKey, engagement);
  return byKey;
}

/** The `IssueEngagement` projection of an engaged issue, for the digest entry. */
export function toIssueEngagement({ reason, prUrl, since }: EngagedIssue): IssueEngagement {
  return prUrl === undefined ? { reason, since } : { reason, prUrl, since };
}
