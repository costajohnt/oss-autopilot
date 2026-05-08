/**
 * Tests for follow-up history helpers (#1277).
 */

import { describe, it, expect } from 'vitest';
import {
  getFollowUpHistory,
  lastFollowUp,
  isWithinTierWindow,
  recordFollowUp,
  TIER_WINDOW_DAYS,
} from './follow-up-history.js';
import { AgentStateSchema } from './state-schema.js';
import type { AgentState } from './state-schema.js';

function emptyState(): AgentState {
  return AgentStateSchema.parse({ version: 4 });
}

const PR = 'https://github.com/owner/repo/pull/123';

describe('getFollowUpHistory', () => {
  it('returns empty array for unset state field', () => {
    expect(getFollowUpHistory(emptyState(), PR)).toEqual([]);
  });

  it('returns empty array for unknown PR url', () => {
    const s = recordFollowUp(emptyState(), 'https://other/url', {
      tier: 'light_check_in',
      timestamp: new Date().toISOString(),
    });
    expect(getFollowUpHistory(s, PR)).toEqual([]);
  });

  it('returns the recorded entries for a known url', () => {
    const ts = new Date().toISOString();
    const s = recordFollowUp(emptyState(), PR, { tier: 'light_check_in', timestamp: ts });
    expect(getFollowUpHistory(s, PR)).toEqual([{ tier: 'light_check_in', timestamp: ts }]);
  });
});

describe('recordFollowUp', () => {
  it('appends across multiple calls without losing prior entries', () => {
    const t1 = '2026-04-01T00:00:00.000Z';
    const t2 = '2026-04-15T00:00:00.000Z';
    let s = recordFollowUp(emptyState(), PR, { tier: 'light_check_in', timestamp: t1 });
    s = recordFollowUp(s, PR, { tier: 'direct_check_in', timestamp: t2 });
    expect(getFollowUpHistory(s, PR)).toHaveLength(2);
  });

  it('does not mutate the input state', () => {
    const before = emptyState();
    const after = recordFollowUp(before, PR, {
      tier: 'light_check_in',
      timestamp: new Date().toISOString(),
    });
    expect(before.prFollowUpHistory).toBeUndefined();
    expect(after.prFollowUpHistory?.[PR]).toBeDefined();
  });
});

describe('lastFollowUp', () => {
  it('returns null when no entries exist', () => {
    expect(lastFollowUp(emptyState(), PR)).toBeNull();
  });

  it('returns the newest entry by timestamp', () => {
    const older = '2026-03-01T00:00:00.000Z';
    const newer = '2026-04-01T00:00:00.000Z';
    let s = recordFollowUp(emptyState(), PR, { tier: 'light_check_in', timestamp: newer });
    s = recordFollowUp(s, PR, { tier: 'direct_check_in', timestamp: older });
    expect(lastFollowUp(s, PR)?.timestamp).toBe(newer);
  });
});

describe('isWithinTierWindow', () => {
  it('returns false when there are no prior follow-ups', () => {
    expect(isWithinTierWindow(emptyState(), PR, 'light_check_in')).toBe(false);
  });

  it('returns true when the same-tier follow-up is within the window', () => {
    const now = new Date('2026-04-10T00:00:00.000Z');
    const recent = new Date('2026-04-08T00:00:00.000Z').toISOString();
    const s = recordFollowUp(emptyState(), PR, { tier: 'light_check_in', timestamp: recent });
    expect(isWithinTierWindow(s, PR, 'light_check_in', now)).toBe(true);
  });

  it('returns false when the same-tier follow-up is outside the window', () => {
    const now = new Date('2026-04-10T00:00:00.000Z');
    const oldEntry = new Date('2026-03-01T00:00:00.000Z').toISOString();
    const s = recordFollowUp(emptyState(), PR, { tier: 'light_check_in', timestamp: oldEntry });
    expect(isWithinTierWindow(s, PR, 'light_check_in', now)).toBe(false);
  });

  it('returns false when the prior follow-up was a different tier', () => {
    const now = new Date('2026-04-10T00:00:00.000Z');
    const recent = new Date('2026-04-08T00:00:00.000Z').toISOString();
    const s = recordFollowUp(emptyState(), PR, { tier: 'light_check_in', timestamp: recent });
    expect(isWithinTierWindow(s, PR, 'direct_check_in', now)).toBe(false);
  });

  it('uses the documented tier window per tier', () => {
    expect(TIER_WINDOW_DAYS.light_check_in).toBe(7);
    expect(TIER_WINDOW_DAYS.direct_check_in).toBe(14);
    expect(TIER_WINDOW_DAYS.final_check_in).toBe(30);
  });
});
