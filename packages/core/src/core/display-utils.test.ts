/**
 * Tests for display-utils.ts — human-readable display label computation for PR statuses.
 */

import { describe, it, expect } from 'vitest';
import { computeDisplayLabel } from './display-utils.js';
import { makeFetchedPR } from './test-utils.js';

function makePR(overrides: Parameters<typeof makeFetchedPR>[0] = {}) {
  return makeFetchedPR({
    createdAt: '2026-02-07T10:00:00Z',
    updatedAt: '2026-02-07T10:00:00Z',
    displayLabel: '',
    displayDescription: '',
    reviewDecision: 'review_required',
    daysSinceActivity: 0,
    ...overrides,
  });
}

describe('computeDisplayLabel', () => {
  it('should return [Healthy] for healthy status', () => {
    const result = computeDisplayLabel(makePR({ status: 'healthy' }));
    expect(result.displayLabel).toBe('[Healthy]');
    expect(result.displayDescription).toBe('Everything looks good — normal review cycle');
  });

  it('should return [Needs Response] for needs_response status', () => {
    const result = computeDisplayLabel(
      makePR({
        status: 'needs_response',
        lastMaintainerComment: { author: 'maintainer', body: 'Fix this', createdAt: '2026-02-07T10:00:00Z' },
      }),
    );
    expect(result.displayLabel).toBe('[Needs Response]');
    expect(result.displayDescription).toBe('@maintainer commented');
  });

  it('should return [CI Failing] for failing_ci status', () => {
    const result = computeDisplayLabel(
      makePR({
        status: 'failing_ci',
        classifiedChecks: [{ name: 'unit-tests', category: 'actionable' }],
      }),
    );
    expect(result.displayLabel).toBe('[CI Failing]');
    expect(result.displayDescription).toContain('unit-tests');
  });

  it('should return [Merge Conflict] for merge_conflict status', () => {
    const result = computeDisplayLabel(makePR({ status: 'merge_conflict' }));
    expect(result.displayLabel).toBe('[Merge Conflict]');
  });

  it('should return [Dormant] for dormant status', () => {
    const result = computeDisplayLabel(makePR({ status: 'dormant', daysSinceActivity: 45 }));
    expect(result.displayLabel).toBe('[Dormant]');
    expect(result.displayDescription).toBe('No activity for 45 days');
  });

  it('should return [Approaching Dormant] for approaching_dormant status', () => {
    const result = computeDisplayLabel(makePR({ status: 'approaching_dormant', daysSinceActivity: 27 }));
    expect(result.displayLabel).toBe('[Approaching Dormant]');
    expect(result.displayDescription).toBe('No activity for 27 days');
  });

  it('should return [Waiting on Maintainer] for waiting_on_maintainer status', () => {
    const result = computeDisplayLabel(makePR({ status: 'waiting_on_maintainer' }));
    expect(result.displayLabel).toBe('[Waiting on Maintainer]');
  });

  it('should return [Changes Addressed] for changes_addressed status', () => {
    const result = computeDisplayLabel(
      makePR({
        status: 'changes_addressed',
        lastMaintainerComment: { author: 'reviewer', body: 'LGTM with changes', createdAt: '2026-02-07T10:00:00Z' },
      }),
    );
    expect(result.displayLabel).toBe('[Changes Addressed]');
    expect(result.displayDescription).toContain('@reviewer');
  });

  it('should return [Incomplete Checklist] for incomplete_checklist status', () => {
    const result = computeDisplayLabel(
      makePR({
        status: 'incomplete_checklist',
        checklistStats: { checked: 2, total: 5 },
      }),
    );
    expect(result.displayLabel).toBe('[Incomplete Checklist]');
    expect(result.displayDescription).toBe('2/5 items checked');
  });

  it('should return [Needs Changes] for needs_changes status', () => {
    const result = computeDisplayLabel(makePR({ status: 'needs_changes' }));
    expect(result.displayLabel).toBe('[Needs Changes]');
  });
});
