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
  'none' | 'user_open' | 'user_closed' | 'user_merged' | 'other_open' | 'other_closed' | 'other_merged';

export type LinkedPRState = 'open' | 'closed' | 'merged';

export interface LinkedPR {
  /**
   * May be `null` for deleted GitHub accounts ("ghost" users); the
   * declared type on GitHub's API allows null here even though the REST
   * schema example typically shows a populated user.
   */
  author: { login: string } | null;
  state: LinkedPRState;
  /**
   * ISO timestamp of the linked PR's last update, surfaced from scout's
   * timeline-event metadata when available (#97). Optional so existing
   * callers and fixtures that don't carry the field continue to type-check.
   * Used by `isLinkedPRStalled` to flag open PRs that haven't been touched
   * in the last `STALLED_PR_THRESHOLD_DAYS` days.
   */
  updatedAt?: string;
}

/**
 * Days of inactivity that classify an open linked PR as "stalled" — kept
 * in sync with scout's `STALLED_PR_THRESHOLD_DAYS` so the autopilot helper
 * and scout's own annotation use the same boundary.
 */
export const STALLED_PR_THRESHOLD_DAYS = 30;

/**
 * Determine whether an autopilot-shaped `LinkedPR` is stalled.
 *
 * True when:
 *   - the PR is open, AND
 *   - `updatedAt` is set, AND
 *   - the elapsed time since `updatedAt` is at least `thresholdDays`.
 *
 * Returns false for closed/merged PRs, missing `updatedAt`, or invalid
 * timestamps. Reimplemented locally rather than delegating to scout's
 * helper so this module owns autopilot's `LinkedPR` shape contract end
 * to end (avoids a runtime import dependency on scout's internal type).
 */
export function isLinkedPRStalled(
  linkedPR: LinkedPR | null | undefined,
  now: Date = new Date(),
  thresholdDays: number = STALLED_PR_THRESHOLD_DAYS,
): boolean {
  if (!linkedPR) return false;
  if (linkedPR.state !== 'open') return false;
  if (!linkedPR.updatedAt) return false;
  const updatedMs = Date.parse(linkedPR.updatedAt);
  if (!Number.isFinite(updatedMs)) return false;
  const ageDays = (now.getTime() - updatedMs) / (1000 * 60 * 60 * 24);
  return ageDays >= thresholdDays;
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
