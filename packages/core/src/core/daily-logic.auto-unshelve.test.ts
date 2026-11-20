/**
 * Tests for shouldAutoUnshelve (#1922): a shelved PR goes back to active only
 * for maintainer activity newer than the shelve.
 */

import { describe, it, expect } from 'vitest';
import { shouldAutoUnshelve } from './daily-logic.js';

describe('shouldAutoUnshelve (#1922)', () => {
  const url = 'https://github.com/owner/repo/pull/1';
  const stamps = { 'owner/repo#1': '2026-01-10T00:00:00.000Z' };
  const critical = { url, status: 'needs_addressing' as const };

  it('keeps a PR shelved when it already needed addressing at shelve time', () => {
    expect(shouldAutoUnshelve({ ...critical, lastMaintainerActivityAt: '2026-01-09T00:00:00Z' }, stamps)).toBe(false);
    // Same second as the shelve: GitHub omits milliseconds, the stamp has them.
    expect(shouldAutoUnshelve({ ...critical, lastMaintainerActivityAt: '2026-01-10T00:00:00Z' }, stamps)).toBe(false);
  });

  it('unshelves when a maintainer acted after the shelve', () => {
    expect(shouldAutoUnshelve({ ...critical, lastMaintainerActivityAt: '2026-01-10T00:00:01Z' }, stamps)).toBe(true);
  });

  it('never unshelves a PR that does not need addressing', () => {
    const pr = { url, status: 'waiting_on_maintainer' as const, lastMaintainerActivityAt: '2026-01-11T00:00:00Z' };
    expect(shouldAutoUnshelve(pr, stamps)).toBe(false);
  });

  it('falls back to status alone without a stamp or a maintainer-activity time', () => {
    expect(shouldAutoUnshelve({ ...critical, lastMaintainerActivityAt: '2026-01-09T00:00:00Z' }, {})).toBe(true);
    expect(shouldAutoUnshelve({ ...critical, lastMaintainerActivityAt: '2026-01-09T00:00:00Z' }, undefined)).toBe(true);
    expect(shouldAutoUnshelve(critical, stamps)).toBe(true);
    expect(shouldAutoUnshelve({ ...critical, lastMaintainerActivityAt: 'garbage' }, stamps)).toBe(true);
  });

  it('finds the stamp for a PR URL in different casing', () => {
    const pr = {
      ...critical,
      url: 'https://github.com/Owner/Repo/pull/1',
      lastMaintainerActivityAt: '2026-01-09T00:00:00Z',
    };
    expect(shouldAutoUnshelve(pr, stamps)).toBe(false);
  });
});
