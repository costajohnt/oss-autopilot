/**
 * Linked-PR classification (#910, #978).
 *
 * Given the first linked PR on an issue, decide how it affects whether
 * the issue is actionable for the current user. Previously described as
 * prose in agents/issue-scout.md; extracted here as a pure function so
 * the classification is unit-testable and uniform across callers.
 *
 * Integration with the vet flow is deferred — scout does not yet surface
 * linked-PR metadata on `IssueCandidate`, so consumers need to fetch the
 * linked PR themselves (e.g. via Octokit) and hand the shape to this
 * function. See #978 for the upstream data-contract work.
 */

export type LinkedPRClassification =
  | 'none'
  | 'user_open'
  | 'user_closed'
  | 'user_merged'
  | 'other_open'
  | 'other_closed'
  | 'other_merged';

export type LinkedPRState = 'open' | 'closed' | 'merged';

export interface LinkedPR {
  /**
   * May be `null` for deleted GitHub accounts ("ghost" users); the
   * declared type on GitHub's API allows null here even though the REST
   * schema example typically shows a populated user.
   */
  author: { login: string } | null;
  state: LinkedPRState;
}

/**
 * Normalize a state value from either REST (lowercase `open`/`closed`
 * plus a separate `merged` boolean) or GraphQL (uppercase `OPEN`/
 * `CLOSED`/`MERGED` union) into our internal lowercase form. Callers
 * converting from REST should pre-mix `merged` into the state before
 * calling; see the tests for expected shapes.
 */
function normalizeState(state: string): LinkedPRState | null {
  const lower = state.toLowerCase();
  if (lower === 'open' || lower === 'closed' || lower === 'merged') return lower;
  return null;
}

export function classifyLinkedPR(params: { linkedPR: LinkedPR | null; userLogin: string }): LinkedPRClassification {
  const { linkedPR, userLogin } = params;
  if (!linkedPR) return 'none';

  const state = normalizeState(linkedPR.state);
  // Unknown state (e.g., future-extended values) is safest to treat as
  // "closed" — skip-worthy but non-fatal — rather than throwing and
  // breaking the whole vetting pipeline on one malformed payload.
  const effectiveState: LinkedPRState = state ?? 'closed';

  // GitHub usernames are case-insensitive ASCII. Ghost authors (deleted
  // accounts) return `null` or an empty login; in both cases we can't
  // prove the PR is the user's own, so we classify it as "other_*".
  const authorLogin = linkedPR.author?.login ?? '';
  const isUserOwn = authorLogin !== '' && userLogin !== '' && authorLogin.toLowerCase() === userLogin.toLowerCase();

  if (isUserOwn) {
    if (effectiveState === 'open') return 'user_open';
    if (effectiveState === 'merged') return 'user_merged';
    return 'user_closed';
  }
  if (effectiveState === 'open') return 'other_open';
  if (effectiveState === 'merged') return 'other_merged';
  return 'other_closed';
}
