import { describe, it, expect } from 'vitest';
import { truncate, formatDate, statusColor, ciStatusColor } from './utils';

describe('truncate', () => {
  it('returns the string unchanged if within limit', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('returns the string unchanged if exactly at limit', () => {
    expect(truncate('exact', 5)).toBe('exact');
  });

  it('truncates and adds ellipsis when exceeding limit', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });
});

describe('formatDate', () => {
  it('formats a valid ISO date', () => {
    const result = formatDate('2025-06-15T12:00:00Z');
    expect(result).toContain('Jun');
    expect(result).toContain('15');
    expect(result).toContain('2025');
  });

  it('returns the original string for invalid dates', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });

  it('returns the original string for empty string', () => {
    expect(formatDate('')).toBe('');
  });
});

describe('statusColor', () => {
  it.each([
    'needs_response',
    'needs_changes',
    'failing_ci',
    'merge_conflict',
    'missing_required_files',
    'needs_rebase',
    'incomplete_checklist',
  ] as const)('returns error color for action-required status "%s"', (status) => {
    expect(statusColor(status)).toBe('var(--accent-error)');
  });

  it.each([
    'changes_addressed',
    'waiting_on_maintainer',
    'ci_blocked',
    'ci_not_running',
    'waiting',
  ] as const)('returns info color for waiting status "%s"', (status) => {
    expect(statusColor(status)).toBe('var(--accent-info)');
  });

  it('returns open color for healthy status', () => {
    expect(statusColor('healthy')).toBe('var(--accent-open)');
  });

  it.each(['approaching_dormant', 'dormant'] as const)(
    'returns warning color for staleness status "%s"',
    (status) => {
      expect(statusColor(status)).toBe('var(--accent-warning)');
    },
  );

  it('returns muted color for unknown status', () => {
    expect(statusColor('unknown_status')).toBe('var(--text-muted)');
  });
});

describe('ciStatusColor', () => {
  it('returns green for passing', () => {
    expect(ciStatusColor('passing')).toBe('var(--accent-open)');
  });

  it('returns red for failing', () => {
    expect(ciStatusColor('failing')).toBe('var(--accent-error)');
  });

  it('returns yellow for pending', () => {
    expect(ciStatusColor('pending')).toBe('var(--accent-warning)');
  });

  it('returns muted for unknown', () => {
    expect(ciStatusColor('unknown')).toBe('var(--text-muted)');
  });
});
