/**
 * Tests for the unified PR attention taxonomy (#1352).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyAttentionBucket,
  summarizeAttentionBuckets,
  STUCK_CI_THRESHOLD_DAYS,
  DORMANT_FOLLOWUP_THRESHOLD_DAYS,
  type AttentionInput,
} from './pr-attention.js';

function input(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return {
    status: 'waiting_on_maintainer',
    ciStatus: 'passing',
    reviewDecision: 'review_required',
    daysSinceActivity: 0,
    ...overrides,
  };
}

describe('classifyAttentionBucket', () => {
  it('needs_addressing is always needs_attention, regardless of CI or staleness', () => {
    expect(
      classifyAttentionBucket(input({ status: 'needs_addressing', ciStatus: 'pending', daysSinceActivity: 99 })),
    ).toBe('needs_attention');
  });

  it('pending CI past the threshold is stuck_ci', () => {
    expect(classifyAttentionBucket(input({ ciStatus: 'pending', daysSinceActivity: STUCK_CI_THRESHOLD_DAYS }))).toBe(
      'stuck_ci',
    );
  });

  it('pending CI within the threshold is just waiting (fresh runs are normal)', () => {
    expect(
      classifyAttentionBucket(input({ ciStatus: 'pending', daysSinceActivity: STUCK_CI_THRESHOLD_DAYS - 1 })),
    ).toBe('waiting');
  });

  it('review_required past the follow-up threshold is dormant_followup', () => {
    expect(
      classifyAttentionBucket(
        input({ reviewDecision: 'review_required', daysSinceActivity: DORMANT_FOLLOWUP_THRESHOLD_DAYS }),
      ),
    ).toBe('dormant_followup');
  });

  it('review_required within the threshold is waiting', () => {
    expect(
      classifyAttentionBucket(
        input({ reviewDecision: 'review_required', daysSinceActivity: DORMANT_FOLLOWUP_THRESHOLD_DAYS - 1 }),
      ),
    ).toBe('waiting');
  });

  it('approved dormant PRs are waiting, not dormant_followup (nothing to nudge for review)', () => {
    expect(classifyAttentionBucket(input({ reviewDecision: 'approved', daysSinceActivity: 40 }))).toBe('waiting');
  });

  it('stuck_ci wins over dormant_followup when both apply', () => {
    expect(
      classifyAttentionBucket(input({ ciStatus: 'pending', reviewDecision: 'review_required', daysSinceActivity: 30 })),
    ).toBe('stuck_ci');
  });

  it('the issue #1352 examples land in the new buckets, not needs_attention', () => {
    // "ciStatus: pending and 12 days since activity. CI looks stuck."
    expect(classifyAttentionBucket(input({ ciStatus: 'pending', daysSinceActivity: 12 }))).toBe('stuck_ci');
    // "reviewDecision: review_required, ciStatus: passing, 15 days dormant."
    expect(
      classifyAttentionBucket(input({ ciStatus: 'passing', reviewDecision: 'review_required', daysSinceActivity: 15 })),
    ).toBe('dormant_followup');
  });
});

describe('summarizeAttentionBuckets', () => {
  it('counts every bucket', () => {
    const summary = summarizeAttentionBuckets([
      input({ status: 'needs_addressing' }),
      input({ status: 'needs_addressing' }),
      input({ ciStatus: 'pending', daysSinceActivity: 12 }),
      input({ reviewDecision: 'review_required', daysSinceActivity: 15 }),
      input({ reviewDecision: 'approved', daysSinceActivity: 1 }),
    ]);
    expect(summary).toEqual({ needsAttention: 2, stuckCI: 1, dormantFollowup: 1, waiting: 1 });
  });

  it('returns all zeros for an empty list', () => {
    expect(summarizeAttentionBuckets([])).toEqual({
      needsAttention: 0,
      stuckCI: 0,
      dormantFollowup: 0,
      waiting: 0,
    });
  });
});
