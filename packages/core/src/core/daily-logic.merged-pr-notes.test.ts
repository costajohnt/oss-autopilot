/**
 * computeActionMenu: the merged_pr_notes item (#1861). Kept out of
 * daily-logic.test.ts, which sits at the file-size lint ceiling.
 */

import { describe, it, expect } from 'vitest';
import { computeActionMenu } from './daily-logic.js';
import { makeCapacityAssessment as makeCapacity } from './test-utils.js';

describe('computeActionMenu merged_pr_notes (#1861)', () => {
  it('should add a merged_pr_notes item with the PR count', () => {
    const menu = computeActionMenu([], makeCapacity(), [], undefined, 0, 0, 3);
    const item = menu.items.find((i) => i.key === 'merged_pr_notes');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Merged PRs with maintainer notes (3)');
    expect(menu.items.map((i) => i.key)).toEqual(['merged_pr_notes', 'search', 'done']);
  });

  it('should use singular phrasing for one entry', () => {
    const menu = computeActionMenu([], makeCapacity(), [], undefined, 0, 0, 1);
    expect(menu.items.find((i) => i.key === 'merged_pr_notes')!.label).toBe('Merged PR with maintainer notes (1)');
  });

  it('should omit the item when the count is zero or not provided', () => {
    expect(computeActionMenu([], makeCapacity(), [], undefined, 0, 0, 0).items.map((i) => i.key)).toEqual([
      'search',
      'done',
    ]);
    expect(computeActionMenu([], makeCapacity()).items.find((i) => i.key === 'merged_pr_notes')).toBeUndefined();
  });

  it('should order the item after closed_pr_status, before search', () => {
    const menu = computeActionMenu([], makeCapacity(), [], { stuckCI: 1, dormantFollowup: 0 }, 1, 1, 2);
    expect(menu.items.map((i) => i.key)).toEqual([
      'follow_up',
      'extract_learnings',
      'closed_pr_status',
      'merged_pr_notes',
      'search',
      'done',
    ]);
  });
});
