/**
 * computeActionMenu: the collect_implementations item (#1856). Kept out of
 * daily-logic.test.ts, which sits at the file-size lint ceiling.
 */

import { describe, it, expect } from 'vitest';
import { computeActionMenu } from './daily-logic.js';
import { makeCapacityAssessment as makeCapacity } from './test-utils.js';

describe('computeActionMenu — background implementations (#1856)', () => {
  it('adds collect_implementations only when a finished implementation exists', () => {
    const none = computeActionMenu([], makeCapacity(), [], undefined, undefined, 0, 0, 0, 0);
    expect(none.items.map((i) => i.key)).not.toContain('collect_implementations');

    const menu = computeActionMenu([], makeCapacity(), [], undefined, undefined, 0, 0, 0, 2);
    const item = menu.items.find((i) => i.key === 'collect_implementations');
    expect(item?.label).toBe('Collect finished implementations (2)');
    expect(item?.description).toContain('background implementation');
    // Sits before search and done, like the other follow-up items.
    const keys = menu.items.map((i) => i.key);
    expect(keys.indexOf('collect_implementations')).toBeLessThan(keys.indexOf('search'));
  });
});
