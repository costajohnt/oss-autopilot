/**
 * `work claim/finish/release/list` against a REAL StateManager (#1856, #1852).
 *
 * The vitest setup file points HOME at a fresh temp dir, so the singleton
 * writes a real state.json there. Each test starts from no state file and a
 * reset singleton; "reload" tests reset the singleton again so the next
 * command reads the file back from disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { getStatePath, getStateManager, resetStateManager } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { runWorkClaim, runWorkFinish, runWorkList, runWorkRelease } from './work.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const HOUR = 3_600_000;
const ISSUE_A = 'https://github.com/owner/repo/issues/1';
const ISSUE_B = 'https://github.com/owner/repo/issues/2';
const ISSUE_C = 'https://github.com/owner/repo/issues/3';
const PR_URL = 'https://github.com/owner/repo/pull/9';
const SESSION = 'air/20261102T1200';

function freshState(): void {
  resetStateManager();
  fs.rmSync(getStatePath(), { force: true });
}

/** Drop the singleton so the next command reads state.json from disk. */
function reload(): void {
  resetStateManager();
}

function readDisk(): { workClaims?: Array<{ url: string; status: string; session: string }> } {
  return JSON.parse(fs.readFileSync(getStatePath(), 'utf8'));
}

async function claimImpl(url: string, worktree: string, extra: Partial<Parameters<typeof runWorkClaim>[0]> = {}) {
  return runWorkClaim({ url, kind: 'implementation', session: SESSION, worktree, ...extra });
}

describe('work claim / finish / release / list (real StateManager)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    freshState();
  });

  afterEach(() => {
    vi.useRealTimers();
    freshState();
  });

  it('round-trips a claim through disk: claim, reload, list, finish, reload, release, reload', async () => {
    const claimed = await claimImpl(ISSUE_A, '/work/wt/a', { branch: 'fix/thing' });
    expect(claimed.replaced).toBe(false);
    expect(claimed.claim).toMatchObject({
      kind: 'implementation',
      url: ISSUE_A,
      session: SESSION,
      status: 'running',
      branch: 'fix/thing',
      worktree: '/work/wt/a',
      startedAt: '2026-11-02T12:00:00.000Z',
      expiresAt: '2026-11-03T12:00:00.000Z',
    });
    expect(readDisk().workClaims).toHaveLength(1);

    reload();
    const listed = await runWorkList();
    expect(listed.claims.map((c) => c.url)).toEqual([ISSUE_A]);
    expect(listed.expiredCount).toBe(0);
    expect(listed.now).toBe('2026-11-02T12:00:00.000Z');

    const finished = await runWorkFinish({ url: ISSUE_A });
    expect(finished.claim).toMatchObject({ status: 'finished', finishedAt: '2026-11-02T12:00:00.000Z' });

    reload();
    const afterFinish = await runWorkList();
    expect(afterFinish.claims[0]).toMatchObject({ status: 'finished' });
    expect(readDisk().workClaims?.[0]).toMatchObject({ status: 'finished' });

    const released = await runWorkRelease({ url: ISSUE_A });
    expect(released.released).toEqual([ISSUE_A]);

    reload();
    const afterRelease = await runWorkList();
    expect(afterRelease.claims).toEqual([]);
    expect(readDisk().workClaims).toEqual([]);
  });

  it('pr claims default to a 12-hour TTL, implementations to 24, and --ttl overrides both', async () => {
    const pr = await runWorkClaim({ url: PR_URL, kind: 'pr', session: SESSION });
    expect(pr.claim.expiresAt).toBe('2026-11-03T00:00:00.000Z');
    const custom = await claimImpl(ISSUE_A, '/work/wt/a', { ttlHours: 1.5 });
    expect(custom.claim.expiresAt).toBe('2026-11-02T13:30:00.000Z');
  });

  it('ignores expired claims on list and vet paths, and prunes them on the next write', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a', { ttlHours: 1 });
    await runWorkClaim({ url: PR_URL, kind: 'pr', session: SESSION, ttlHours: 1 });

    vi.setSystemTime(NOW + HOUR + 1);
    reload();
    const listed = await runWorkList();
    expect(listed.claims).toEqual([]);
    expect(listed.expiredCount).toBe(2);
    // Read-only: still on disk until a write.
    expect(readDisk().workClaims).toHaveLength(2);

    // Expired, so nothing to finish or release...
    const finished = await runWorkFinish({ url: ISSUE_A });
    expect(finished.claim).toBeNull();
    // ...and a release of an expired item reports nothing released but prunes.
    const released = await runWorkRelease({ url: PR_URL });
    expect(released.released).toEqual([]);
    expect(readDisk().workClaims).toEqual([]);
  });

  it('a new claim prunes expired entries and the expired checkout no longer blocks', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a', { ttlHours: 1 });
    vi.setSystemTime(NOW + HOUR + 1);

    const next = await claimImpl(ISSUE_B, '/work/wt/a');
    expect(next.replaced).toBe(false);
    expect(readDisk().workClaims?.map((c) => c.url)).toEqual([ISSUE_B]);
  });

  it('enforces maxConcurrentImplementations (default 2) with a clear error', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    await claimImpl(ISSUE_B, '/work/wt/b');

    await expect(claimImpl(ISSUE_C, '/work/wt/c')).rejects.toThrow(ValidationError);
    await expect(claimImpl(ISSUE_C, '/work/wt/c')).rejects.toThrow(
      /Implementation cap reached: 2 of 2 running .*maxConcurrentImplementations/,
    );
    expect(readDisk().workClaims).toHaveLength(2);

    // A pr claim is not an implementation and is unaffected by the cap.
    await expect(runWorkClaim({ url: PR_URL, kind: 'pr', session: SESSION })).resolves.toMatchObject({
      replaced: false,
    });
    // Raising the cap lets the third one through.
    getStateManager().updateConfig({ maxConcurrentImplementations: 3 });
    await expect(claimImpl(ISSUE_C, '/work/wt/c')).resolves.toMatchObject({ replaced: false });
  });

  it('a finished implementation frees a cap slot but keeps its checkout', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    await claimImpl(ISSUE_B, '/work/wt/b');
    await runWorkFinish({ url: ISSUE_A });

    await expect(claimImpl(ISSUE_C, '/work/wt/a')).rejects.toThrow(/already hosts an implementation/);
    await expect(claimImpl(ISSUE_C, '/work/wt/c')).resolves.toMatchObject({ replaced: false });
  });

  it('refuses two running implementations in the same checkout, however the path is spelled', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');

    await expect(claimImpl(ISSUE_B, '/work/wt/a/')).rejects.toThrow(ValidationError);
    await expect(claimImpl(ISSUE_B, '/work/wt/../wt/a')).rejects.toThrow(
      `/work/wt/a already hosts an implementation of ${ISSUE_A} (session ${SESSION}, running)`,
    );
    expect(readDisk().workClaims).toHaveLength(1);
  });

  it('re-claiming the same item renews it in place (replaced: true) and keeps the order of others', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    await claimImpl(ISSUE_B, '/work/wt/b');

    vi.setSystemTime(NOW + 2 * HOUR);
    const renewed = await claimImpl('https://github.com/OWNER/repo/issues/1', '/work/wt/a');
    expect(renewed.replaced).toBe(true);
    expect(renewed.claim.expiresAt).toBe('2026-11-03T14:00:00.000Z');
    const listed = await runWorkList();
    expect(listed.claims.map((c) => c.url)).toEqual([ISSUE_B, 'https://github.com/OWNER/repo/issues/1']);
  });

  it('a different session can take over a pr claim (the workflow asks first)', async () => {
    await runWorkClaim({ url: PR_URL, kind: 'pr', session: 'air/1' });
    const taken = await runWorkClaim({ url: PR_URL, kind: 'pr', session: 'mbp/2' });
    expect(taken.replaced).toBe(true);
    const listed = await runWorkList();
    expect(listed.claims).toHaveLength(1);
    expect(listed.claims[0].session).toBe('mbp/2');
  });

  it('releases every claim a session holds, optionally only one kind, leaving other sessions alone', async () => {
    await runWorkClaim({ url: PR_URL, kind: 'pr', session: 'air/1' });
    await runWorkClaim({ url: 'https://github.com/owner/repo/pull/10', kind: 'pr', session: 'mbp/2' });
    await runWorkClaim({ url: ISSUE_A, kind: 'implementation', session: 'air/1', worktree: '/work/wt/a' });

    const prs = await runWorkRelease({ session: 'air/1', kind: 'pr' });
    expect(prs.released).toEqual([PR_URL]);
    const afterPrs = await runWorkList();
    expect(afterPrs.claims.map((c) => c.url)).toEqual(['https://github.com/owner/repo/pull/10', ISSUE_A]);

    const rest = await runWorkRelease({ session: 'air/1' });
    expect(rest.released).toEqual([ISSUE_A]);
    const afterRest = await runWorkList();
    expect(afterRest.claims.map((c) => c.session)).toEqual(['mbp/2']);
  });

  it('validates its input before touching state', async () => {
    // Kind/URL mismatch both ways.
    await expect(
      runWorkClaim({ url: PR_URL, kind: 'implementation', session: SESSION, worktree: '/x' }),
    ).rejects.toThrow(ValidationError);
    await expect(runWorkClaim({ url: ISSUE_A, kind: 'pr', session: SESSION })).rejects.toThrow(ValidationError);
    // An implementation needs a location.
    await expect(runWorkClaim({ url: ISSUE_A, kind: 'implementation', session: SESSION })).rejects.toThrow(
      /--worktree .* or --run-id/,
    );
    // Session is required and sane.
    await expect(runWorkClaim({ url: ISSUE_A, kind: 'implementation', session: '  ', worktree: '/x' })).rejects.toThrow(
      /--session must not be empty/,
    );
    await expect(
      runWorkClaim({ url: ISSUE_A, kind: 'implementation', session: 'a\nb', worktree: '/x' }),
    ).rejects.toThrow(/control characters/);
    // Kind and TTL.
    await expect(
      runWorkClaim({ url: ISSUE_A, kind: 'review' as 'pr', session: SESSION, worktree: '/x' }),
    ).rejects.toThrow(/--kind must be/);
    await expect(claimImpl(ISSUE_A, '/x', { ttlHours: 0 })).rejects.toThrow(/--ttl/);
    await expect(claimImpl(ISSUE_A, '/x', { ttlHours: 200 })).rejects.toThrow(/--ttl/);
    // Release needs a selector.
    await expect(runWorkRelease({})).rejects.toThrow(/needs a URL or --session/);
    // A remote run is a valid location.
    await expect(
      runWorkClaim({ url: ISSUE_A, kind: 'implementation', session: SESSION, runId: 'run-42' }),
    ).resolves.toMatchObject({ claim: { runId: 'run-42' } });
    expect(readDisk().workClaims).toHaveLength(1);
  });

  it('finish and release of an unknown item are not errors', async () => {
    const finished = await runWorkFinish({ url: ISSUE_A });
    const byUrl = await runWorkRelease({ url: ISSUE_A });
    const bySession = await runWorkRelease({ session: 'nobody' });
    expect(finished.claim).toBeNull();
    expect(byUrl.released).toEqual([]);
    expect(bySession.released).toEqual([]);
  });
});
