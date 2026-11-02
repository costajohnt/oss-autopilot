/**
 * computeActionMenu: the closed_pr_status item (#1863). Kept out of
 * daily-logic.test.ts, which sits at the file-size lint ceiling.
 */

import { describe, it, expect } from 'vitest';
import { computeActionMenu } from './daily-logic.js';
import { makeCapacityAssessment as makeCapacity } from './test-utils.js';

describe('computeActionMenu closed_pr_status (#1863)', () => {
  it('should add a closed_pr_status item with the pending count', () => {
    const menu = computeActionMenu([], makeCapacity(), [], undefined, 0, 2);
    const item = menu.items.find((i) => i.key === 'closed_pr_status');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Post status update on linked issues (2)');
    expect(menu.items.map((i) => i.key)).toEqual(['closed_pr_status', 'search', 'done']);
  });

  it('should use singular phrasing for one entry', () => {
    const menu = computeActionMenu([], makeCapacity(), [], undefined, 0, 1);
    expect(menu.items.find((i) => i.key === 'closed_pr_status')!.label).toBe('Post status update on linked issue (1)');
  });

  it('should omit the item when the count is zero or not provided', () => {
    expect(computeActionMenu([], makeCapacity(), [], undefined, 0, 0).items.map((i) => i.key)).toEqual([
      'search',
      'done',
    ]);
    expect(computeActionMenu([], makeCapacity()).items.find((i) => i.key === 'closed_pr_status')).toBeUndefined();
  });

  it('should order the item after extract_learnings, before search', () => {
    const menu = computeActionMenu([], makeCapacity(), [], { stuckCI: 1, dormantFollowup: 0 }, 1, 1);
    expect(menu.items.map((i) => i.key)).toEqual([
      'follow_up',
      'extract_learnings',
      'closed_pr_status',
      'search',
      'done',
    ]);
  });
});
