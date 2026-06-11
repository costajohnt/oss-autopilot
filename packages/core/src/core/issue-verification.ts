/**
 * Deterministic issue verification (#1353, #1354).
 *
 * One GraphQL round-trip answers the two questions the issue-scout agent
 * historically hallucinated: "is this issue actually open?" and "is it
 * actually taken?". The query fetches the issue's `state`/`stateReason`,
 * its assignees, every cross-referenced PR with `closingIssuesReferences`,
 * and `viewer.login` — so "is this my PR?" is derived from the same token
 * that fetched the data instead of a cached username.
 *
 * Classification is a pure function (`classifyIssueAvailability`) so the
 * verdict rules are unit-testable without network access. The distinction
 * that matters (#1353): a PR whose `closingIssuesReferences` includes this
 * issue is a real claim (`closing`); a PR that merely mentions the issue in
 * its timeline is just a mention (`cross-referenced`) and must not drive a
 * "Taken" verdict.
 */

import { ValidationError } from './errors.js';
import type { Octokit } from '@octokit/rest';

/** How a PR found in the issue's timeline relates to the issue. */
export type LinkedPRLinkType = 'closing' | 'cross-referenced';

export interface VerifiedLinkedPR {
  number: number;
  url: string;
  title: string;
  /** Lowercase normalization of GraphQL's OPEN/CLOSED/MERGED union. */
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  /** PR author login; null for ghost (deleted) accounts. */
  author: string | null;
  /** True when the PR author is the authenticated user (case-insensitive). */
  isOwn: boolean;
  /** `closing` = the PR's closingIssuesReferences names this issue (a real
   * claim). `cross-referenced` = timeline mention only (NOT a claim). */
  linkType: LinkedPRLinkType;
  updatedAt: string | null;
}

/**
 * The short-circuit signal consumers route on:
 * - `closed` — issue is not open; stop all further analysis (#1353).
 * - `own-open-pr` — the authenticated user already has an open closing PR;
 *   not a new opportunity (#1354).
 * - `taken` — someone else has an open closing PR, or the issue is assigned
 *   to someone else.
 * - `at-risk` — no hard claim, but signals competition or imminent closure
 *   (open cross-referencing PRs, or a merged closing PR awaiting issue close).
 * - `available` — open, unassigned, no claiming PRs.
 */
export type IssueAvailabilityVerdict = 'closed' | 'own-open-pr' | 'taken' | 'at-risk' | 'available';

export interface IssueVerification {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  /** Lowercase normalization of GraphQL's OPEN/CLOSED union. */
  state: 'open' | 'closed';
  /** Lowercase GraphQL IssueStateReason. `completed` = fixed upstream (mark
   * Done); `not_planned` = wontfix (drop permanently). Note: an OPEN issue
   * can carry `reopened` — never infer closed-ness from a non-null reason;
   * branch on `state` only. */
  stateReason: 'completed' | 'not_planned' | 'reopened' | 'duplicate' | null;
  closedAt: string | null;
  assignees: string[];
  linkedPRs: VerifiedLinkedPR[];
  verdict: IssueAvailabilityVerdict;
  verdictReason: string;
  /** Login of the authenticated user the verdict was computed for. */
  userLogin: string;
}

/** Inputs for the pure verdict classifier — the fetched facts, no I/O. */
export interface ClassifyIssueAvailabilityInput {
  state: 'open' | 'closed';
  stateReason: IssueVerification['stateReason'];
  assignees: string[];
  linkedPRs: VerifiedLinkedPR[];
  userLogin: string;
}

function isSameLogin(a: string | null, b: string): boolean {
  return a !== null && a !== '' && b !== '' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Compute the availability verdict from fetched facts. Rules in priority
 * order; the first match wins.
 */
export function classifyIssueAvailability(input: ClassifyIssueAvailabilityInput): {
  verdict: IssueAvailabilityVerdict;
  verdictReason: string;
} {
  const { state, stateReason, assignees, linkedPRs, userLogin } = input;

  if (state === 'closed') {
    const reason = stateReason ?? 'unknown';
    return {
      verdict: 'closed',
      verdictReason:
        reason === 'not_planned'
          ? 'issue closed as not planned — drop it permanently'
          : `issue closed (${reason}) — mark it done upstream`,
    };
  }

  const closingPRs = linkedPRs.filter((pr) => pr.linkType === 'closing');

  const ownOpenClaim = closingPRs.find((pr) => pr.state === 'open' && pr.isOwn);
  if (ownOpenClaim) {
    return {
      verdict: 'own-open-pr',
      verdictReason: `you already have an open PR for this issue: ${ownOpenClaim.url}`,
    };
  }

  const otherOpenClaim = closingPRs.find((pr) => pr.state === 'open' && !pr.isOwn);
  if (otherOpenClaim) {
    return {
      verdict: 'taken',
      verdictReason: `open PR by ${otherOpenClaim.author ?? 'unknown author'} closes this issue: ${otherOpenClaim.url}`,
    };
  }

  const otherAssignees = assignees.filter((login) => !isSameLogin(login, userLogin));
  if (otherAssignees.length > 0) {
    return {
      verdict: 'taken',
      verdictReason: `assigned to ${otherAssignees.join(', ')}`,
    };
  }

  const mergedClaim = closingPRs.find((pr) => pr.state === 'merged');
  if (mergedClaim) {
    return {
      verdict: 'at-risk',
      verdictReason: `a merged PR closes this issue (${mergedClaim.url}) — likely resolved, awaiting issue close`,
    };
  }

  const openMention = linkedPRs.find((pr) => pr.linkType === 'cross-referenced' && pr.state === 'open');
  if (openMention) {
    return {
      verdict: 'at-risk',
      verdictReason:
        `open PR ${openMention.url} cross-references this issue (mention only, not a claim) — ` +
        'risk of being superseded by broader work',
    };
  }

  // Self-assignment was filtered out above — don't claim "unassigned" then.
  const selfAssigned = assignees.length > 0;
  return {
    verdict: 'available',
    verdictReason: selfAssigned ? 'open, assigned to you, no claiming PRs' : 'open, unassigned, no claiming PRs',
  };
}

// ── GraphQL fetch ──────────────────────────────────────────────────────

const VERIFY_ISSUE_QUERY = /* GraphQL */ `
  query VerifyIssue($owner: String!, $repo: String!, $number: Int!, $after: String) {
    viewer {
      login
    }
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        number
        title
        url
        state
        stateReason
        closedAt
        assignees(first: 10) {
          nodes {
            login
          }
        }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            ... on CrossReferencedEvent {
              source {
                ... on PullRequest {
                  number
                  url
                  title
                  state
                  isDraft
                  updatedAt
                  author {
                    login
                  }
                  closingIssuesReferences(first: 50) {
                    nodes {
                      number
                      repository {
                        nameWithOwner
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** Raw GraphQL response shape — only the fields the query selects. */
interface VerifyIssueQueryResponse {
  viewer: { login: string };
  repository: {
    issue: {
      number: number;
      title: string;
      url: string;
      state: 'OPEN' | 'CLOSED';
      stateReason: 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | 'DUPLICATE' | null;
      closedAt: string | null;
      assignees: { nodes: Array<{ login: string } | null> };
      timelineItems: {
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          source?: {
            number?: number;
            url?: string;
            title?: string;
            state?: 'OPEN' | 'CLOSED' | 'MERGED';
            isDraft?: boolean;
            updatedAt?: string | null;
            author?: { login: string } | null;
            closingIssuesReferences?: {
              nodes: Array<{ number: number; repository: { nameWithOwner: string } } | null>;
            };
          } | null;
        } | null>;
      };
    } | null;
  } | null;
}

export interface VerifyIssueParams {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Fetch + classify in one GraphQL round-trip.
 *
 * Throws `ValidationError` when the issue does not exist (or the URL points
 * at a PR — GitHub's `issue()` resolver returns null for PR numbers).
 * GraphQL/network/rate-limit errors propagate to the caller; nothing is
 * swallowed into a degraded verdict.
 */
/** True when a GraphQL error response is purely "the repo/issue we asked for
 * doesn't exist" — a caller-input problem, not an API failure. Requires every
 * error to be NOT_FOUND *and* rooted at the repository/issue path: a nested
 * NOT_FOUND (e.g. a cross-referenced source in a deleted repo) must not be
 * misdiagnosed as "issue not found". Duck-typed so we don't import octokit's
 * GraphqlResponseError class just for instanceof. */
function isGraphqlNotFound(error: unknown): boolean {
  const errors = (error as { errors?: Array<{ type?: string; path?: unknown[] } | null> } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((e) => {
    if (e?.type !== 'NOT_FOUND') return false;
    const path = Array.isArray(e.path) ? e.path : [];
    return path.length <= 2 && (path.length === 0 || (path[0] === 'repository' && (path[1] ?? 'issue') === 'issue'));
  });
}

/**
 * Hard ceiling on timeline pages (100 events each). Timeline events arrive
 * oldest-first, so silently stopping early would drop the NEWEST events —
 * exactly the ones most likely to be the active claiming PR. Past the cap we
 * fail loudly instead of returning a possibly-false `available`.
 */
const MAX_TIMELINE_PAGES = 20;

export async function fetchIssueVerification(octokit: Octokit, params: VerifyIssueParams): Promise<IssueVerification> {
  const { owner, repo, number } = params;

  type IssuePage = NonNullable<NonNullable<VerifyIssueQueryResponse['repository']>['issue']>;
  let issue: IssuePage | undefined;
  let userLogin: string | undefined;
  const timelineNodes: IssuePage['timelineItems']['nodes'] = [];

  let after: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_TIMELINE_PAGES) {
      throw new Error(
        `Issue ${owner}/${repo}#${number} has more than ${MAX_TIMELINE_PAGES * 100} cross-reference events; ` +
          'refusing to verify on a truncated timeline. Check the issue manually.',
      );
    }

    let response: VerifyIssueQueryResponse;
    try {
      response = await octokit.graphql<VerifyIssueQueryResponse>(VERIFY_ISSUE_QUERY, {
        owner,
        repo,
        number,
        after,
      });
    } catch (error) {
      // GitHub reports a missing repo/issue as a NOT_FOUND GraphQL error (the
      // client throws before our null check below can run). Surface it as the
      // same ValidationError; everything else (rate limits, network, auth)
      // propagates untouched.
      if (isGraphqlNotFound(error)) {
        throw new ValidationError(
          `Issue not found: ${owner}/${repo}#${number}. ` +
            'Check the URL — it may point at a pull request or a deleted/private issue.',
        );
      }
      throw error;
    }

    const pageIssue = response.repository?.issue;
    if (!pageIssue) {
      throw new ValidationError(
        `Issue not found: ${owner}/${repo}#${number}. ` +
          'Check the URL — it may point at a pull request or a deleted/private issue.',
      );
    }

    issue ??= pageIssue;
    userLogin = response.viewer.login;
    timelineNodes.push(...pageIssue.timelineItems.nodes);

    const pageInfo = pageIssue.timelineItems.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor;
  }

  // The loop above either assigns both then breaks, or throws.
  if (!issue || userLogin === undefined) {
    throw new Error('unreachable: timeline pagination exited without an issue');
  }

  const issueRepo = `${owner}/${repo}`.toLowerCase();

  const linkedPRs: VerifiedLinkedPR[] = [];
  const seenUrls = new Set<string>();
  for (const node of timelineNodes) {
    const source = node?.source;
    // CrossReferencedEvent sources can be issues too; PRs are the ones that
    // carry a `state` from the inline fragment. Skip everything else.
    if (!source || typeof source.number !== 'number' || !source.url || !source.state) continue;
    if (seenUrls.has(source.url)) continue;
    seenUrls.add(source.url);

    // A "closing" link must name THIS issue in THIS repo — closing references
    // to same-numbered issues in other repos don't count. Deliberate cap:
    // `closingIssuesReferences(first: 50)` — a PR closing 50+ issues is
    // pathological; its claim on this one would downgrade to a mention.
    const closesThisIssue = (source.closingIssuesReferences?.nodes ?? []).some(
      (ref) => ref !== null && ref.number === number && ref.repository.nameWithOwner.toLowerCase() === issueRepo,
    );

    const author = source.author?.login ?? null;
    linkedPRs.push({
      number: source.number,
      url: source.url,
      title: source.title ?? '',
      state: source.state.toLowerCase() as VerifiedLinkedPR['state'],
      isDraft: source.isDraft ?? false,
      author,
      isOwn: isSameLogin(author, userLogin),
      linkType: closesThisIssue ? 'closing' : 'cross-referenced',
      updatedAt: source.updatedAt ?? null,
    });
  }

  const state = issue.state.toLowerCase() as IssueVerification['state'];
  const stateReason = (issue.stateReason?.toLowerCase() ?? null) as IssueVerification['stateReason'];
  const assignees = issue.assignees.nodes.flatMap((n) => (n ? [n.login] : []));

  const { verdict, verdictReason } = classifyIssueAvailability({
    state,
    stateReason,
    assignees,
    linkedPRs,
    userLogin,
  });

  return {
    url: issue.url,
    owner,
    repo,
    number: issue.number,
    title: issue.title,
    state,
    stateReason,
    closedAt: issue.closedAt,
    assignees,
    linkedPRs,
    verdict,
    verdictReason,
    userLogin,
  };
}
