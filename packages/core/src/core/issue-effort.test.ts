/**
 * Tests for `computeIssueEffort` (#1264).
 */

import { describe, it, expect } from 'vitest';
import { computeIssueEffort } from './issue-effort.js';

describe('computeIssueEffort', () => {
  it('rates needs_response with 0 or 1 hint as small', () => {
    expect(computeIssueEffort('needs_response', 0)).toBe('small');
    expect(computeIssueEffort('needs_response', 1)).toBe('small');
  });

  it('rates needs_response with 2+ hints as medium', () => {
    expect(computeIssueEffort('needs_response', 2)).toBe('medium');
    expect(computeIssueEffort('needs_response', 5)).toBe('medium');
  });

  it('rates incomplete_checklist as small regardless of hints', () => {
    expect(computeIssueEffort('incomplete_checklist', 0)).toBe('small');
    expect(computeIssueEffort('incomplete_checklist', 7)).toBe('small');
  });

  it('rates needs_changes with 0-2 hints as medium', () => {
    expect(computeIssueEffort('needs_changes', 0)).toBe('medium');
    expect(computeIssueEffort('needs_changes', 1)).toBe('medium');
    expect(computeIssueEffort('needs_changes', 2)).toBe('medium');
  });

  it('rates needs_changes with 3+ hints as large', () => {
    expect(computeIssueEffort('needs_changes', 3)).toBe('large');
    expect(computeIssueEffort('needs_changes', 7)).toBe('large');
  });

  it('rates ci_failing as medium', () => {
    expect(computeIssueEffort('ci_failing', 0)).toBe('medium');
    expect(computeIssueEffort('ci_failing', 5)).toBe('medium');
  });

  it('rates merge_conflict as large', () => {
    expect(computeIssueEffort('merge_conflict', 0)).toBe('large');
    expect(computeIssueEffort('merge_conflict', 4)).toBe('large');
  });

  it('falls back to medium for unrecognized type', () => {
    expect(computeIssueEffort('unknown' as never, 0)).toBe('medium');
  });

  it('treats negative hint counts as zero', () => {
    expect(computeIssueEffort('needs_response', -3)).toBe('small');
    expect(computeIssueEffort('needs_changes', -1)).toBe('medium');
  });
});
