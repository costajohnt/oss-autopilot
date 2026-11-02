/**
 * Engaged issues (#1862): the issues the user is working on, as opposed to
 * ones they commented on in passing.
 *
 * An issue is engaged when the user claimed it locally (`activeIssues`,
 * candidates excluded) or one of their PRs closes it through a closing
 * keyword: an open PR, a recently closed or merged PR, or a merged/closed
 * ledger entry no older than {@link LEDGER_LINK_MAX_AGE_DAYS}. Plain
 * mentions in a PR body ("similar to #12", "see #4 for the upstream bug") are
 * not engagement: they named unrelated issues, bumped the engagement time
 * past earlier maintainer replies, and ate into the comment-fetch cap.
 * `IssueConversationMonitor` scans engaged issues under a wider reply rule
 * (any substantive non-bot comment counts, not only maintainer or @mention
 * replies) and fetches the live ones directly when the commenter search does
 * not return them.
 *
 * Pure: builds a keyed map from the lists the daily run already holds. URLs
 * are compared through `issueRefKey`, so `Org/Repo` and `org/repo`, trailing
 * slashes and `#fragment`s all name the same issue.
 */

import type { EngagementReason, FetchedPR, IssueEngagement, TrackedIssue } from './types.js';
import { issueRefKey, parseGitHubUrl } from './urls.js';

const REASON_RANK: Record<EngagementReason, number> = { open_pr: 0, claim: 1, closed_pr: 2, merged_pr: 3 };

/**
 * Oldest ledger link that still counts as engagement. A PR merged or closed
 * longer ago than this is finished work: a comment on its issue months later
 * is a new conversation, and the passing-comment rule (maintainer, @mention
 * or quote reply) is the right one for it.
 */
export const LEDGER_LINK_MAX_AGE_DAYS = 90;

/** One engaged issue, keyed for lookup against search results. */
export interface EngagedIssue extends IssueEngagement {
  /** `issueRefKey` of the issue. */
  key: string;
  /** Canonical `https://github.com/owner/repo/issues/N` URL. */
  url: string;
  /**
   * Whether the user claimed the issue locally, whatever `reason` says. An
   * open PR outranks the claim as the reason, but a bare "any update?" on the
   * issue still asks the claimant, so the monitor reads this, not `reason`.
   */
  claimed: boolean;
  /**
   * Fetch the issue directly when the comment search misses it. True for
   * live engagements (claims, open PRs, the recent closed/merged lists);
   * false for ledger links, which count only when the search already found
   * the issue active.
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
  /** Local claims; `updatedAt` is the claim stamp (see `StateManager.addIssue`). `candidate` entries are not claims. */
  claims: readonly Pick<TrackedIssue, 'url' | 'updatedAt' | 'status'>[];
  /** Open PRs; only the closing link (`issueUrl`) is engagement, not body mentions. */
  openPRs: readonly Pick<FetchedPR, 'url' | 'issueUrl' | 'createdAt'>[];
  recentlyClosedPRs: readonly (EngagedPRLink & { closedAt: string })[];
  recentlyMergedPRs: readonly (EngagedPRLink & { mergedAt: string })[];
  ledgerClosedPRs: readonly (EngagedPRLink & { closedAt: string })[];
  ledgerMergedPRs: readonly (EngagedPRLink & { mergedAt: string })[];
}

export interface CollectEngagedIssuesOptions {
  /** Reference time for the ledger age bound; defaults to now. */
  now?: Date;
}

interface Engagement extends IssueEngagement {
  issueUrl: string;
  fetchWhenMissing: boolean;
}

/** The later of two optional ISO stamps; an unreadable or missing one loses. */
function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  const aMs = a === undefined ? NaN : Date.parse(a);
  const bMs = b === undefined ? NaN : Date.parse(b);
  if (Number.isNaN(bMs)) return a;
  if (Number.isNaN(aMs)) return b;
  return bMs > aMs ? b : a;
}

/** Issues an open PR closes. */
function* openPREngagements(prs: EngagedIssuesInput['openPRs']): Generator<Engagement> {
  for (const pr of prs) {
    if (!pr.issueUrl) continue;
    yield { issueUrl: pr.issueUrl, reason: 'open_pr', prUrl: pr.url, since: pr.createdAt, fetchWhenMissing: true };
  }
}

/**
 * Issues closed or merged PRs link, dated by the opening time. An entry
 * without one (older ledger rows) carries no `since`: the close or merge time
 * is not when the user engaged, and a baseline later than the real engagement
 * would hide replies, so the monitor falls back to the user's last comment.
 */
function* linkedPREngagements(input: EngagedIssuesInput, nowMs: number): Generator<Engagement> {
  const lists = [
    { prs: input.recentlyClosedPRs, reason: 'closed_pr' as const, isRecent: true },
    { prs: input.recentlyMergedPRs, reason: 'merged_pr' as const, isRecent: true },
    { prs: input.ledgerClosedPRs, reason: 'closed_pr' as const, isRecent: false },
    { prs: input.ledgerMergedPRs, reason: 'merged_pr' as const, isRecent: false },
  ];
  for (const { prs, reason, isRecent } of lists) {
    for (const pr of prs) {
      const engagement = linkedEngagement(pr, reason, isRecent, nowMs);
      if (engagement) yield engagement;
    }
  }
}

type EndedPR = EngagedPRLink & ({ closedAt: string } | { mergedAt: string });

/**
 * The engagement one finished PR carries, or undefined when it has no link or
 * is too old a ledger row. `isRecent` marks the digest's recent lists, which
 * are fetched directly when the search misses them; ledger rows are not.
 */
function linkedEngagement(
  pr: EndedPR,
  reason: 'closed_pr' | 'merged_pr',
  isRecent: boolean,
  nowMs: number,
): Engagement | undefined {
  if (!pr.issueUrl) return undefined;
  if (!isRecent && !isWithinLedgerBound(pr, nowMs)) return undefined;
  return { reason, issueUrl: pr.issueUrl, prUrl: pr.url, since: pr.openedAt, fetchWhenMissing: isRecent };
}

function isWithinLedgerBound(pr: EndedPR, nowMs: number): boolean {
  const endedMs = Date.parse('closedAt' in pr ? pr.closedAt : pr.mergedAt);
  return !Number.isNaN(endedMs) && nowMs - endedMs <= LEDGER_LINK_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/** Every engagement, strongest reason first. */
function* engagements(input: EngagedIssuesInput, nowMs: number): Generator<Engagement> {
  yield* openPREngagements(input.openPRs);
  for (const claim of input.claims) {
    if (claim.status === 'candidate') continue;
    yield { issueUrl: claim.url, reason: 'claim', since: claim.updatedAt, fetchWhenMissing: true };
  }
  yield* linkedPREngagements(input, nowMs);
}

/**
 * Keys of the user's own PRs. A closing keyword can name one of them
 * ("closes #50" on a follow-up to PR #50); that is not an issue, and looking
 * it up would only confirm so.
 */
function ownPRKeys(input: EngagedIssuesInput): Set<string> {
  const keys = new Set<string>();
  const lists: readonly (readonly { url: string }[])[] = [
    input.openPRs,
    input.recentlyClosedPRs,
    input.recentlyMergedPRs,
    input.ledgerClosedPRs,
    input.ledgerMergedPRs,
  ];
  for (const prs of lists) {
    for (const pr of prs) {
      const key = issueRefKey(pr.url);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/** Fold one engagement into the map: strongest reason, latest since, claimed or fetched if any is. */
function record(byKey: Map<string, EngagedIssue>, engagement: Engagement): void {
  const parsed = parseGitHubUrl(engagement.issueUrl);
  const key = issueRefKey(engagement.issueUrl);
  if (!parsed || !key) return;
  const isClaim = engagement.reason === 'claim';
  const current = byKey.get(key);
  if (!current) {
    byKey.set(key, {
      key,
      url: `https://github.com/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`,
      reason: engagement.reason,
      ...(engagement.prUrl !== undefined && { prUrl: engagement.prUrl }),
      ...(engagement.since !== undefined && { since: engagement.since }),
      claimed: isClaim,
      fetchWhenMissing: engagement.fetchWhenMissing,
    });
    return;
  }
  current.claimed ||= isClaim;
  if (REASON_RANK[engagement.reason] < REASON_RANK[current.reason]) {
    current.reason = engagement.reason;
    if (engagement.prUrl === undefined) delete current.prUrl;
    else current.prUrl = engagement.prUrl;
  }
  const since = laterOf(current.since, engagement.since);
  if (since === undefined) delete current.since;
  else current.since = since;
  current.fetchWhenMissing ||= engagement.fetchWhenMissing;
}

/**
 * Collect the user's engaged issues, keyed by `issueRefKey`. When several
 * engagements name one issue, the entry keeps the strongest reason (and its
 * PR), the latest `since`, is `claimed` if any engagement is a claim, and
 * fetches directly if any engagement is live.
 * Links that do not parse as GitHub URLs, or that name one of the user's own
 * PRs, are skipped. Iteration order is strongest-reason first (engagements
 * are visited in that order, so an issue is inserted at its strongest
 * reason's position). The monitor looks every live entry up regardless of
 * order; its comment-fetch cap ranks by the issue's own update time.
 */
export function collectEngagedIssues(
  input: EngagedIssuesInput,
  options: CollectEngagedIssuesOptions = {},
): Map<string, EngagedIssue> {
  const nowMs = (options.now ?? new Date()).getTime();
  const ownPRs = ownPRKeys(input);
  const byKey = new Map<string, EngagedIssue>();
  for (const engagement of engagements(input, nowMs)) {
    const key = issueRefKey(engagement.issueUrl);
    if (key !== null && ownPRs.has(key)) continue;
    record(byKey, engagement);
  }
  return byKey;
}

/** The `IssueEngagement` projection of an engaged issue, for the digest entry. */
export function toIssueEngagement({ reason, prUrl, since }: EngagedIssue): IssueEngagement {
  return {
    reason,
    ...(prUrl !== undefined && { prUrl }),
    ...(since !== undefined && { since }),
  };
}
