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
  it('should return [Waiting on Maintainer] for pending_review', () => {
    const result = computeDisplayLabel(makePR({ status: 'waiting_on_maintainer', waitReason: 'pending_review' }));
    expect(result.displayLabel).toBe('[Waiting on Maintainer]');
    expect(result.displayDescription).toBe('Awaiting review');
  });

  it('should return [Needs Response] for needs_response actionReason', () => {
    const result = computeDisplayLabel(
      makePR({
        status: 'needs_addressing',
        actionReason: 'needs_response',
        lastMaintainerComment: { author: 'maintainer', body: 'Fix this', createdAt: '2026-02-07T10:00:00Z' },
      }),
    );
    expect(result.displayLabel).toBe('[Needs Response]');
    expect(result.displayDescription).toBe('@maintainer commented');
  });

  it('should return [CI Failing] for failing_ci actionReason', () => {
    const result = computeDisplayLabel(
      makePR({
        status: 'needs_addressing',
        actionReason: 'failing_ci',
        classifiedChecks: [{ name: 'unit-tests', category: 'actionable' }],
      }),
    );
    expect(result.displayLabel).toBe('[CI Failing]');
    expect(result.displayDescription).toContain('unit-tests');
  });

  it('should return [Merge Conflict] for merge_conflict actionReason', () => {
    const result = computeDisplayLabel(makePR({ status: 'needs_addressing', actionReason: 'merge_conflict' }));
    expect(result.displayLabel).toBe('[Merge Conflict]');
  });

  it('should return [Waiting on Maintainer] for pending_merge waitReason', () => {
    const result = computeDisplayLabel(makePR({ status: 'waiting_on_maintainer', waitReason: 'pending_merge' }));
    expect(result.displayLabel).toBe('[Waiting on Maintainer]');
    expect(result.displayDescription).toBe('Approved and CI passes — waiting for merge');
  });

  it('should return [Waiting on Maintainer] for changes_addressed waitReason', () => {
    const result = computeDisplayLabel(
      makePR({
        status: 'waiting_on_maintainer',
        waitReason: 'changes_addressed',
        hasUnrespondedComment: true,
        lastMaintainerComment: { author: 'reviewer', body: 'LGTM with changes', createdAt: '2026-02-07T10:00:00Z' },
      }),
    );
    expect(result.displayLabel).toBe('[Waiting on Maintainer]');
    expect(result.displayDescription).toContain('@reviewer');
  });

  it('should return [Incomplete Checklist] for incomplete_checklist actionReason', () => {
    const result = computeDisplayLabel(
      makePR({
        status: 'needs_addressing',
        actionReason: 'incomplete_checklist',
        checklistStats: { checked: 2, total: 5 },
      }),
    );
    expect(result.displayLabel).toBe('[Incomplete Checklist]');
    expect(result.displayDescription).toBe('2/5 items checked');
  });

  it('should return [Needs Changes] for needs_changes actionReason', () => {
    const result = computeDisplayLabel(makePR({ status: 'needs_addressing', actionReason: 'needs_changes' }));
    expect(result.displayLabel).toBe('[Needs Changes]');
  });

  it('should return [CI Blocked] for ci_blocked waitReason with classified checks', () => {
    const result = computeDisplayLabel(
      makePR({
        status: 'waiting_on_maintainer',
        waitReason: 'ci_blocked',
        classifiedChecks: [
          { name: 'Facebook Internal - Linter', category: 'infrastructure' },
          { name: 'Vercel Deploy', category: 'fork_limitation' },
        ],
      }),
    );
    expect(result.displayLabel).toBe('[CI Blocked]');
    expect(result.displayDescription).toBe('All failing checks are non-actionable (infrastructure, fork_limitation)');
  });

  it('should return default ci_blocked description when no classified checks', () => {
    const result = computeDisplayLabel(makePR({ status: 'waiting_on_maintainer', waitReason: 'ci_blocked' }));
    expect(result.displayLabel).toBe('[CI Blocked]');
    expect(result.displayDescription).toBe('CI checks are failing but no action is needed from you');
  });
});
