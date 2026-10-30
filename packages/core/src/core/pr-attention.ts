/**
 * Unified PR attention taxonomy (#1352).
 *
 * The headline "needs attention" number used to be computed twice — the CLI
 * brief counted `collectActionableIssues()` output while the dashboard
 * counted raw `status === 'needs_addressing'` — and the cases the CLI
 * deliberately excludes (stuck CI, dormant maintainer waits) sat
 * undifferentiated inside `waiting_on_maintainer`. This module is the single
 * classifier both surfaces consume.
 *
 * Buckets (mutually exclusive, first match wins):
 * - `needs_attention` — the contributor has a concrete code-related next
 *   step today (`status === 'needs_addressing'`: response, changes, CI fix,
 *   conflict, checklist). This is the headline count on BOTH surfaces.
 * - `stuck_ci` — waiting PRs whose CI has been `pending` long past any
 *   normal run time. A "ping / investigate" workflow, not a coding one.
 * - `dormant_followup` — waiting PRs with `review_required` and no activity
 *   past the follow-up threshold. A "draft a nudge" workflow.
 * - `waiting` — everything else that's healthy to leave alone.
 */

import type { AttentionBucket, FetchedPR } from './types.js';

export type { AttentionBucket } from './types.js';

/**
 * Days of inactivity after which a `pending` CI status reads as stuck rather
 * than in-flight. Real CI runs finish in minutes-to-hours; multiple days of
 * `pending` means a webhook was lost, a runner died, or a required check
 * never started.
 */
export const STUCK_CI_THRESHOLD_DAYS = 3;

/**
 * Days of inactivity after which a `review_required` PR becomes a follow-up
 * candidate. Matches the middle step of the 7/14/30 dormant-PR follow-up
 * cadence — early enough to nudge before the PR goes fully dormant
 * (default `dormantThresholdDays` is 30).
 */
export const DORMANT_FOLLOWUP_THRESHOLD_DAYS = 14;

/** The minimal slice of {@link FetchedPR} the classifier reads. */
export type AttentionInput = Pick<FetchedPR, 'status' | 'ciStatus' | 'reviewDecision' | 'daysSinceActivity'>;

/**
 * Classify one PR into its attention bucket. Pure — both the CLI daily path
 * and the dashboard `/api/data` path call this, so the two surfaces cannot
 * diverge on what a count means.
 */
export function classifyAttentionBucket(pr: AttentionInput): AttentionBucket {
  if (pr.status === 'needs_addressing') return 'needs_attention';

  // From here on the PR is waiting_on_maintainer — subdivide the wait.
  if (pr.ciStatus === 'pending' && pr.daysSinceActivity >= STUCK_CI_THRESHOLD_DAYS) {
    return 'stuck_ci';
  }
  if (pr.reviewDecision === 'review_required' && pr.daysSinceActivity >= DORMANT_FOLLOWUP_THRESHOLD_DAYS) {
    return 'dormant_followup';
  }
  return 'waiting';
}

/**
 * Unanswered contributor pings after which a dormant PR becomes a
 * close-with-offer-to-reopen candidate instead of another nudge.
 */
export const CLOSE_SUGGESTION_MIN_PINGS = 2;

/**
 * True when a PR is dormant on the maintainer clock (`stalenessTier`, which
 * ignores the contributor's own activity), still waiting on the maintainer,
 * and the contributor has already pinged at least
 * {@link CLOSE_SUGGESTION_MIN_PINGS} times with no reply. Surfaced through
 * the dormant follow-up workflow as a suggestion only; nothing is closed or
 * posted automatically.
 */
export function shouldSuggestClose(
  pr: Pick<FetchedPR, 'status' | 'stalenessTier' | 'authorPingsSinceMaintainerActivity'>,
): boolean {
  return (
    pr.status === 'waiting_on_maintainer' &&
    pr.stalenessTier === 'dormant' &&
    (pr.authorPingsSinceMaintainerActivity ?? 0) >= CLOSE_SUGGESTION_MIN_PINGS
  );
}

export interface AttentionSummary {
  needsAttention: number;
  stuckCI: number;
  dormantFollowup: number;
  waiting: number;
}

/** Count PRs per bucket — the shape both headline surfaces render from. */
export function summarizeAttentionBuckets(prs: readonly AttentionInput[]): AttentionSummary {
  const summary: AttentionSummary = { needsAttention: 0, stuckCI: 0, dormantFollowup: 0, waiting: 0 };
  for (const pr of prs) {
    switch (classifyAttentionBucket(pr)) {
      case 'needs_attention': {
        summary.needsAttention++;
        break;
      }
      case 'stuck_ci': {
        summary.stuckCI++;
        break;
      }
      case 'dormant_followup': {
        summary.dormantFollowup++;
        break;
      }
      case 'waiting': {
        summary.waiting++;
        break;
      }
    }
  }
  return summary;
}
