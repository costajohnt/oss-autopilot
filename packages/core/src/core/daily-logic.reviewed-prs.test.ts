/**
 * computeActionMenu: the review_follow_ups item (#1857). Kept out of
 * daily-logic.test.ts, which sits at the file-size lint ceiling.
 */

import { describe, it, expect } from 'vitest';
import { computeActionMenu } from './daily-logic.js';
import { makeCapacityAssessment as makeCapacity } from './test-utils.js';

describe('computeActionMenu review_follow_ups (#1857)', () => {
  it('should add a review_follow_ups item with the PR count', () => {
    const menu = computeActionMenu([], makeCapacity(), [], undefined, 0, 0, 0, 3);
    const item = menu.items.find((i) => i.key === 'review_follow_ups');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Review follow-ups (3)');
    expect(item!.description).toContain('PRs you reviewed');
    expect(menu.items.map((i) => i.key)).toEqual(['review_follow_ups', 'search', 'done']);
  });

  it('should omit the item when the count is zero or not provided', () => {
    expect(computeActionMenu([], makeCapacity(), [], undefined, 0, 0, 0, 0).items.map((i) => i.key)).toEqual([
      'search',
      'done',
    ]);
    expect(computeActionMenu([], makeCapacity()).items.find((i) => i.key === 'review_follow_ups')).toBeUndefined();
  });

  it('should order the item after merged_pr_notes, before search, and leave the capacity context alone', () => {
    const menu = computeActionMenu([], makeCapacity(), [], { stuckCI: 1, dormantFollowup: 0 }, 1, 1, 2, 4);
    expect(menu.items.map((i) => i.key)).toEqual([
      'follow_up',
      'extract_learnings',
      'closed_pr_status',
      'merged_pr_notes',
      'review_follow_ups',
      'search',
      'done',
    ]);
    expect(menu.context).toEqual({
      hasActionableIssues: false,
      actionableCount: 0,
      hasCapacity: true,
      hasIssueResponses: false,
      issueResponseCount: 0,
    });
  });
});
