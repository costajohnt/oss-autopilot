import { describe, it, expect } from 'vitest';
import {
  stripBrackets,
  pillColorClass,
  truncate,
  formatDate,
  statusColor,
  ciStatusColor,
  formatStarCount,
  getLanguageColor,
  formatRelativeTime,
  refreshLabel,
} from './utils';

describe('stripBrackets', () => {
  it('removes surrounding brackets from a label', () => {
    expect(stripBrackets('[CI Failing]')).toBe('CI Failing');
  });

  it('returns the string unchanged when no brackets are present', () => {
    expect(stripBrackets('No Brackets')).toBe('No Brackets');
  });

  it('handles empty string', () => {
    expect(stripBrackets('')).toBe('');
  });
});

describe('pillColorClass', () => {
  it('returns pill--red for attention labels', () => {
    expect(pillColorClass('[CI Failing]')).toBe('pill--red');
    expect(pillColorClass('[Needs Response]')).toBe('pill--red');
    expect(pillColorClass('[Merge Conflict]')).toBe('pill--red');
    expect(pillColorClass('[Needs Changes]')).toBe('pill--red');
    expect(pillColorClass('[Missing Files]')).toBe('pill--red');
    expect(pillColorClass('[Needs Addressing]')).toBe('pill--red');
  });

  it('returns pill--amber for warning labels', () => {
    expect(pillColorClass('[Incomplete Checklist]')).toBe('pill--amber');
    expect(pillColorClass('[CI Not Running]')).toBe('pill--amber');
    expect(pillColorClass('[Needs Rebase]')).toBe('pill--amber');
    expect(pillColorClass('[CI Blocked]')).toBe('pill--amber');
    expect(pillColorClass('[Stale CI Failure]')).toBe('pill--amber');
  });

  it('returns pill--blue for waiting labels', () => {
    expect(pillColorClass('[Waiting on Maintainer]')).toBe('pill--blue');
  });

  it('returns pill--muted for unknown labels', () => {
    expect(pillColorClass('[Something Else]')).toBe('pill--muted');
  });

  it('works with labels that have no brackets', () => {
    expect(pillColorClass('CI Failing')).toBe('pill--red');
  });
});

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
  it('returns red for needs_addressing status', () => {
    expect(statusColor('needs_addressing')).toBe('var(--red)');
  });

  it('returns blue for waiting_on_maintainer status', () => {
    expect(statusColor('waiting_on_maintainer')).toBe('var(--blue)');
  });

  it('returns muted color for unknown status', () => {
    expect(statusColor('unknown_status')).toBe('var(--text-muted)');
  });
});

describe('ciStatusColor', () => {
  it('returns green for passing', () => {
    expect(ciStatusColor('passing')).toBe('var(--green)');
  });

  it('returns red for failing', () => {
    expect(ciStatusColor('failing')).toBe('var(--red)');
  });

  it('returns amber for pending', () => {
    expect(ciStatusColor('pending')).toBe('var(--amber)');
  });

  it('returns muted for unknown', () => {
    expect(ciStatusColor('unknown')).toBe('var(--text-muted)');
  });
});

describe('formatStarCount', () => {
  it('returns raw number for counts below 1000', () => {
    expect(formatStarCount(0)).toBe('0');
    expect(formatStarCount(42)).toBe('42');
    expect(formatStarCount(999)).toBe('999');
  });

  it('formats thousands with k suffix', () => {
    expect(formatStarCount(1000)).toBe('1.0k');
    expect(formatStarCount(1200)).toBe('1.2k');
    expect(formatStarCount(42_100)).toBe('42.1k');
    expect(formatStarCount(999_999)).toBe('1000.0k');
  });

  it('formats millions with M suffix', () => {
    expect(formatStarCount(1_000_000)).toBe('1.0M');
    expect(formatStarCount(1_500_000)).toBe('1.5M');
  });
});

describe('getLanguageColor', () => {
  it('returns the correct color for known languages', () => {
    expect(getLanguageColor('TypeScript')).toBe('#3178c6');
    expect(getLanguageColor('Python')).toBe('#3572A5');
    expect(getLanguageColor('Rust')).toBe('#dea584');
  });

  it('returns muted color for unknown languages', () => {
    expect(getLanguageColor('Brainfuck')).toBe('var(--text-muted)');
  });

  it('returns muted color for null/undefined language', () => {
    expect(getLanguageColor(null)).toBe('var(--text-muted)');
    expect(getLanguageColor(undefined)).toBe('var(--text-muted)');
  });
});

describe('formatRelativeTime', () => {
  it('returns "Updated just now" for timestamps less than 60 seconds ago', () => {
    expect(formatRelativeTime(Date.now() - 30_000)).toBe('Updated just now');
    expect(formatRelativeTime(Date.now())).toBe('Updated just now');
  });

  it('returns minutes for timestamps less than 60 minutes ago', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('Updated 5m ago');
    expect(formatRelativeTime(Date.now() - 59 * 60_000)).toBe('Updated 59m ago');
  });

  it('returns hours for timestamps 60+ minutes ago', () => {
    expect(formatRelativeTime(Date.now() - 60 * 60_000)).toBe('Updated 1h ago');
    expect(formatRelativeTime(Date.now() - 3 * 60 * 60_000)).toBe('Updated 3h ago');
  });

  it('handles the boundary at exactly 60 seconds', () => {
    expect(formatRelativeTime(Date.now() - 60_000)).toBe('Updated 1m ago');
  });
});

describe('refreshLabel', () => {
  it('returns "Refreshing..." when loading is true', () => {
    expect(refreshLabel(true, false)).toBe('Refreshing...');
  });

  it('returns "Updating..." when refreshing is true', () => {
    expect(refreshLabel(false, true)).toBe('Updating...');
  });

  it('returns "Refresh" when neither loading nor refreshing', () => {
    expect(refreshLabel(false, false)).toBe('Refresh');
  });

  it('prioritizes loading over refreshing', () => {
    expect(refreshLabel(true, true)).toBe('Refreshing...');
  });
});
