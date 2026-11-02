/**
 * Tests for the dismiss comparison the daily run and the dashboard share
 * (#1862). Kept out of daily-logic.test.ts, which sits at the file-size cap.
 */

import { describe, it, expect } from 'vitest';
import { isCoveredByDismiss } from './daily-logic.js';

describe('isCoveredByDismiss (#1862)', () => {
  it('covers a reply posted at or before the dismiss', () => {
    expect(isCoveredByDismiss('2026-05-03T00:00:00Z', '2026-05-02T00:00:00Z')).toBe(true);
    expect(isCoveredByDismiss('2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')).toBe(true);
  });

  it('does not cover a reply newer than the dismiss', () => {
    expect(isCoveredByDismiss('2026-05-03T00:00:00Z', '2026-05-04T00:00:00Z')).toBe(false);
  });

  it('fails open on an unreadable timestamp on either side', () => {
    expect(isCoveredByDismiss('garbage', '2026-05-02T00:00:00Z')).toBe(false);
    expect(isCoveredByDismiss('2026-05-03T00:00:00Z', 'garbage')).toBe(false);
  });
});
