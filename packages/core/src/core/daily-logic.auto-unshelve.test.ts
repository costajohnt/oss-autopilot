/**
 * Tests for shouldAutoUnshelve (#1922): a shelved PR that needs addressing
 * goes back to active only for maintainer activity newer than the shelve or
 * an action reason that was not there when it was shelved.
 */

import { describe, it, expect } from 'vitest';
import { shouldAutoUnshelve, shelveReasonsOf } from './daily-logic.js';
import { StateManager } from './state.js';
import type { ActionReason } from './types.js';

const url = 'https://github.com/owner/repo/pull/1';
const at = '2026-01-10T00:00:00.000Z';
const before = '2026-01-09T00:00:00Z';
/** A PR needing addressing for `reasons`, with no maintainer activity since the shelve. */
const needing = (...reasons: ActionReason[]) => ({
  url,
  status: 'needs_addressing' as const,
  actionReason: reasons[0],
  actionReasons: reasons,
  lastMaintainerActivityAt: before,
});
const shelvedWith = (reasons?: string[]) => ({ 'owner/repo#1': { at, reasons } });
/** {@link needing}, with the maintainer's review an hour before an 11:00 shelve (#2043). */
const reviewed = (...reasons: ActionReason[]) => ({
  ...needing(...reasons),
  lastMaintainerActivityAt: '2026-01-10T10:00:00Z',
});

describe('shelveReasonsOf (#1922)', () => {
  it('is every action reason while the PR needs addressing, none otherwise', () => {
    expect(shelveReasonsOf(needing('failing_ci', 'merge_conflict'))).toEqual(['failing_ci', 'merge_conflict']);
    expect(shelveReasonsOf({ status: 'needs_addressing', actionReason: 'failing_ci' })).toEqual(['failing_ci']);
    expect(shelveReasonsOf({ status: 'needs_addressing', actionReason: 'failing_ci', actionReasons: [] })).toEqual([
      'failing_ci',
    ]);
    expect(shelveReasonsOf({ status: 'needs_addressing' })).toEqual(['needs_addressing']);
    expect(shelveReasonsOf({ status: 'waiting_on_maintainer', actionReasons: ['failing_ci'] })).toEqual([]);
  });
});

describe('shouldAutoUnshelve (#1922)', () => {
  const both = shelvedWith(['failing_ci', 'merge_conflict']);

  it('keeps a PR shelved while it has the reasons it was shelved with', () => {
    expect(shouldAutoUnshelve(needing('failing_ci', 'merge_conflict'), both)).toBe(false);
    // Same second as the shelve: GitHub omits milliseconds, the stamp has them.
    const sameSecond = { ...needing('failing_ci'), lastMaintainerActivityAt: '2026-01-10T00:00:00Z' };
    expect(shouldAutoUnshelve(sameSecond, both)).toBe(false);
  });

  it('keeps a PR shelved when one of its reasons clears and another becomes the primary', () => {
    expect(shouldAutoUnshelve(needing('merge_conflict'), both)).toBe(false);
  });

  it('keeps a PR shelved when a reason clears and later returns', () => {
    const waiting = { url, status: 'waiting_on_maintainer' as const, lastMaintainerActivityAt: before };
    expect(shouldAutoUnshelve(waiting, both)).toBe(false);
    expect(shouldAutoUnshelve(needing('failing_ci'), both)).toBe(false);
  });

  it('unshelves when a reason appears that was not there at shelve time', () => {
    expect(shouldAutoUnshelve(needing('failing_ci', 'incomplete_checklist'), both)).toBe(true);
    expect(shouldAutoUnshelve(needing('merge_conflict'), shelvedWith(['failing_ci']))).toBe(true);
  });

  it('unshelves a PR shelved while healthy once it needs addressing, without maintainer activity', () => {
    expect(shouldAutoUnshelve(needing('failing_ci'), shelvedWith([]))).toBe(true);
  });

  it('unshelves when a maintainer acted after the shelve, whatever the reasons', () => {
    const engaged = { ...needing('failing_ci'), lastMaintainerActivityAt: '2026-01-10T00:00:01Z' };
    expect(shouldAutoUnshelve(engaged, shelvedWith(['failing_ci']))).toBe(true);
    expect(shouldAutoUnshelve(engaged, shelvedWith())).toBe(true);
  });

  it('keeps a PR shelved when the digest behind its record predates the maintainer review (#2043)', () => {
    // 9:00 digest: waiting, so nothing recorded. 10:00 changes requested. 11:00 shelved.
    const shelvedAt = { 'owner/repo#1': { at: '2026-01-10T11:00:00.000Z', reasons: [] } };
    expect(shouldAutoUnshelve(reviewed('needs_changes'), shelvedAt)).toBe(false);
    expect(shouldAutoUnshelve(reviewed('needs_response', 'needs_changes'), shelvedAt)).toBe(false);
    // A reason no maintainer creates is still new, whatever the activity time.
    expect(shouldAutoUnshelve(reviewed('needs_changes', 'failing_ci'), shelvedAt)).toBe(true);
    // The maintainer acting again after the shelve resurfaces it.
    const again = { ...reviewed('needs_changes'), lastMaintainerActivityAt: '2026-01-10T12:00:00Z' };
    expect(shouldAutoUnshelve(again, shelvedAt)).toBe(true);
  });

  it('never unshelves a PR that does not need addressing', () => {
    const pr = { url, status: 'waiting_on_maintainer' as const, lastMaintainerActivityAt: '2026-01-11T00:00:00Z' };
    expect(shouldAutoUnshelve(pr, shelvedWith(['failing_ci']))).toBe(false);
  });

  it('keeps a PR shelved when its reasons were unknown at shelve time, then compares once they are filled in', () => {
    const stateManager = new StateManager(true);
    stateManager.shelvePR(url);
    const info = () => stateManager.getState().config.shelvedPRInfo;
    const first = needing('failing_ci');

    // First daily run: cannot tell whether failing_ci is new, so it stays shelved and is recorded.
    expect(shouldAutoUnshelve(first, info())).toBe(false);
    stateManager.fillShelvedPRReasons(url, shelveReasonsOf(first));
    expect(shouldAutoUnshelve(first, info())).toBe(false);

    // Later runs: the record is left alone, so only a reason it lacks unshelves.
    stateManager.fillShelvedPRReasons(url, []);
    expect(shouldAutoUnshelve(first, info())).toBe(false);
    expect(shouldAutoUnshelve(needing('failing_ci', 'merge_conflict'), info())).toBe(true);
  });

  it('falls back to status alone without a shelve record or a maintainer-activity time', () => {
    const quiet = needing('failing_ci');
    expect(shouldAutoUnshelve(quiet, {})).toBe(true);
    expect(shouldAutoUnshelve(quiet, undefined)).toBe(true);
    expect(shouldAutoUnshelve({ ...quiet, lastMaintainerActivityAt: undefined }, shelvedWith(['failing_ci']))).toBe(
      true,
    );
    expect(shouldAutoUnshelve({ ...quiet, lastMaintainerActivityAt: 'garbage' }, shelvedWith(['failing_ci']))).toBe(
      true,
    );
  });

  it('finds the record for a PR URL in different casing', () => {
    const pr = { ...needing('failing_ci'), url: 'https://github.com/Owner/Repo/pull/1' };
    expect(shouldAutoUnshelve(pr, shelvedWith(['failing_ci']))).toBe(false);
  });
});
