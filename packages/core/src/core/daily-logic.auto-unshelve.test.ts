/**
 * Tests for shouldAutoUnshelve (#1922): a shelved PR that needs addressing
 * goes back to active only for maintainer activity newer than the shelve or
 * an action reason other than the recorded one.
 */

import { describe, it, expect } from 'vitest';
import { shouldAutoUnshelve, shelveReasonOf } from './daily-logic.js';
import { StateManager } from './state.js';

const url = 'https://github.com/owner/repo/pull/1';
const at = '2026-01-10T00:00:00.000Z';
const before = '2026-01-09T00:00:00Z';
const critical = { url, status: 'needs_addressing' as const, actionReason: 'failing_ci' as const };
const quiet = { ...critical, lastMaintainerActivityAt: before };
const shelvedWith = (reason?: string) => ({ 'owner/repo#1': { at, reason } });

describe('shelveReasonOf (#1922)', () => {
  it('is the primary action reason while the PR needs addressing, none otherwise', () => {
    expect(shelveReasonOf(critical)).toBe('failing_ci');
    expect(shelveReasonOf({ status: 'needs_addressing' })).toBe('needs_addressing');
    expect(shelveReasonOf({ status: 'waiting_on_maintainer' })).toBe('none');
  });
});

describe('shouldAutoUnshelve (#1922)', () => {
  it('keeps a PR shelved while it has the reason it was shelved with', () => {
    expect(shouldAutoUnshelve(quiet, shelvedWith('failing_ci'))).toBe(false);
    // Same second as the shelve: GitHub omits milliseconds, the stamp has them.
    const sameSecond = { ...critical, lastMaintainerActivityAt: '2026-01-10T00:00:00Z' };
    expect(shouldAutoUnshelve(sameSecond, shelvedWith('failing_ci'))).toBe(false);
  });

  it('unshelves a PR shelved while healthy once it needs addressing, without maintainer activity', () => {
    expect(shouldAutoUnshelve(quiet, shelvedWith('none'))).toBe(true);
  });

  it('unshelves when the reason differs from the one it was shelved with', () => {
    const conflicted = { ...quiet, actionReason: 'merge_conflict' as const };
    expect(shouldAutoUnshelve(conflicted, shelvedWith('failing_ci'))).toBe(true);
  });

  it('unshelves when a maintainer acted after the shelve, whatever the reason', () => {
    const engaged = { ...critical, lastMaintainerActivityAt: '2026-01-10T00:00:01Z' };
    expect(shouldAutoUnshelve(engaged, shelvedWith('failing_ci'))).toBe(true);
    expect(shouldAutoUnshelve(engaged, shelvedWith())).toBe(true);
  });

  it('never unshelves a PR that does not need addressing', () => {
    const pr = { url, status: 'waiting_on_maintainer' as const, lastMaintainerActivityAt: '2026-01-11T00:00:00Z' };
    expect(shouldAutoUnshelve(pr, shelvedWith('failing_ci'))).toBe(false);
  });

  it('keeps a PR shelved when the reason was unknown at shelve time, then compares once it is recorded', () => {
    const stateManager = new StateManager(true);
    stateManager.shelvePR(url);
    const info = () => stateManager.getState().config.shelvedPRInfo;
    const after = { ...critical, lastMaintainerActivityAt: before };

    // First daily run: cannot tell whether failing_ci is new, so it stays shelved and is recorded.
    expect(shouldAutoUnshelve(after, info())).toBe(false);
    stateManager.setShelvedPRReason(url, shelveReasonOf(after));
    expect(shouldAutoUnshelve(after, info())).toBe(false);

    // A later run sees a different reason.
    expect(shouldAutoUnshelve({ ...after, actionReason: 'merge_conflict' }, info())).toBe(true);
  });

  it('falls back to status alone without a shelve record or a maintainer-activity time', () => {
    expect(shouldAutoUnshelve(quiet, {})).toBe(true);
    expect(shouldAutoUnshelve(quiet, undefined)).toBe(true);
    expect(shouldAutoUnshelve(critical, shelvedWith('failing_ci'))).toBe(true);
    expect(shouldAutoUnshelve({ ...critical, lastMaintainerActivityAt: 'garbage' }, shelvedWith('failing_ci'))).toBe(
      true,
    );
  });

  it('finds the record for a PR URL in different casing', () => {
    const pr = { ...quiet, url: 'https://github.com/Owner/Repo/pull/1' };
    expect(shouldAutoUnshelve(pr, shelvedWith('failing_ci'))).toBe(false);
  });
});
