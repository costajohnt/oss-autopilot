/**
 * `work claim/finish/release/list` against a REAL StateManager (#1856, #1852).
 *
 * The vitest setup file points HOME at a fresh temp dir, so the singleton
 * writes a real state.json there. Each test starts from no state file and a
 * reset singleton; "reload" tests reset the singleton again so the next
 * command reads the file back from disk. Cross-machine (Gist) behaviour is
 * in core/gist-state-store.concurrency.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMachineId, getStatePath, getStateManager, resetStateManager } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { runWorkClaim, runWorkFinish, runWorkList, runWorkRelease } from './work.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const HOUR = 3_600_000;
const WEEK = 168 * HOUR;
const ISSUE_A = 'https://github.com/owner/repo/issues/1';
const ISSUE_B = 'https://github.com/owner/repo/issues/2';
const ISSUE_C = 'https://github.com/owner/repo/issues/3';
const PR_URL = 'https://github.com/owner/repo/pull/9';
const SESSION = 'air/20261102T120000-1a2b';
const OTHER_SESSION = 'mbp/20261102T120500-9f9f';
/** What `work claim` stores as `host`: the short hostname, as `hostname -s` prints it. */
const SHORT_HOST = os.hostname().split('.', 1)[0];
/** What `work claim` stores as `machineId`: the id file under the temp HOME, created here on first need. */
const MACHINE_ID = getMachineId();

function freshState(): void {
  resetStateManager();
  fs.rmSync(getStatePath(), { force: true });
}

/** Drop the singleton so the next command reads state.json from disk. */
function reload(): void {
  resetStateManager();
}

interface DiskClaim {
  url: string;
  status: string;
  session: string;
  expiresAt: string;
  host?: string;
  machineId?: string;
  [key: string]: unknown;
}

function readDisk(): { workClaims?: DiskClaim[] } {
  return JSON.parse(fs.readFileSync(getStatePath(), 'utf8'));
}

/** Rewrite the first stored claim on disk as if another machine had written it, then drop the singleton. */
function rewriteFirstClaim(patch: Partial<DiskClaim>): void {
  const state = JSON.parse(fs.readFileSync(getStatePath(), 'utf8')) as { workClaims: DiskClaim[] };
  Object.assign(state.workClaims[0], patch);
  fs.writeFileSync(getStatePath(), JSON.stringify(state));
  reload();
}

function iso(ms: number): string {
  const at = new Date(ms);
  return at.toISOString();
}

async function claimImpl(url: string, worktree: string, extra: Partial<Parameters<typeof runWorkClaim>[0]> = {}) {
  return runWorkClaim({ url, kind: 'implementation', session: SESSION, worktree, ...extra });
}

/** Fake clock at NOW and an empty state file around every test of the enclosing describe. */
function useFreshState(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    freshState();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    freshState();
  });
}

describe('work claim / finish / release / list: lifecycle, expiry and the cap (real StateManager)', () => {
  useFreshState();

  it('round-trips a claim through disk: claim, reload, list, finish, reload, release, reload', async () => {
    const claimed = await claimImpl(ISSUE_A, '/work/wt/a', { branch: 'fix/thing' });
    expect(claimed.outcome).toBe('claimed');
    // Local mode has nothing to sync to, so the claim is as shared as it gets.
    expect(claimed.synced).toBe(true);
    expect(claimed.claim).toMatchObject({
      kind: 'implementation',
      url: ISSUE_A,
      session: SESSION,
      status: 'running',
      branch: 'fix/thing',
      worktree: '/work/wt/a',
      host: SHORT_HOST,
      machineId: MACHINE_ID,
      startedAt: '2026-11-02T12:00:00.000Z',
      expiresAt: '2026-11-03T12:00:00.000Z',
    });
    expect(readDisk().workClaims).toHaveLength(1);

    reload();
    const listed = await runWorkList();
    expect(listed.claims.map((c) => c.url)).toEqual([ISSUE_A]);
    expect(listed.expiredCount).toBe(0);
    expect(listed.now).toBe('2026-11-02T12:00:00.000Z');
    expect(listed.warnings).toBeUndefined();

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
    // A pr claim has no checkout, so no host or machine id either.
    expect(pr.claim.host).toBeUndefined();
    expect(pr.claim.machineId).toBeUndefined();
    const custom = await claimImpl(ISSUE_A, '/work/wt/a', { ttlHours: 1.5 });
    expect(custom.claim.expiresAt).toBe('2026-11-02T13:30:00.000Z');
  });

  it('finish keeps the branch collectable for a week past finishedAt, whatever the running TTL was', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    await claimImpl(ISSUE_B, '/work/wt/b', { ttlHours: 168 });
    vi.setSystemTime(NOW + 20 * HOUR);

    const short = await runWorkFinish({ url: ISSUE_A });
    expect(short.claim?.expiresAt).toBe(iso(NOW + 20 * HOUR + WEEK));
    const long = await runWorkFinish({ url: ISSUE_B });
    expect(long.claim?.expiresAt).toBe(iso(NOW + 20 * HOUR + WEEK));

    // Still offered three days later, well past the original 24 h.
    vi.setSystemTime(NOW + 3 * 24 * HOUR);
    reload();
    const listed = await runWorkList();
    expect(listed.claims.map((c) => c.status)).toEqual(['finished', 'finished']);
  });

  it('re-claiming its own finished implementation keeps it finished; release then claim starts over', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    const finished = await runWorkFinish({ url: ISSUE_A });
    vi.setSystemTime(NOW + HOUR);

    const renewed = await claimImpl(ISSUE_A, '/work/wt/a');
    expect(renewed.outcome).toBe('renewed');
    expect(renewed.claim).toMatchObject({ status: 'finished', finishedAt: finished.claim?.finishedAt });
    // The renewal uses the finished TTL, not the 24 h running default.
    expect(renewed.claim.expiresAt).toBe(iso(NOW + HOUR + WEEK));
    expect(readDisk().workClaims?.[0]).toMatchObject({ status: 'finished' });

    await runWorkRelease({ url: ISSUE_A });
    const restarted = await claimImpl(ISSUE_A, '/work/wt/a');
    expect(restarted.outcome).toBe('claimed');
    expect(restarted.claim).toMatchObject({ status: 'running', expiresAt: iso(NOW + HOUR + 24 * HOUR) });
    expect(restarted.claim.finishedAt).toBeUndefined();
  });

  it('ignores expired claims on list, finish and release, and leaves the file alone until a real write', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a', { ttlHours: 1 });
    await runWorkClaim({ url: PR_URL, kind: 'pr', session: SESSION, ttlHours: 1 });
    const before = fs.statSync(getStatePath()).mtimeMs;

    vi.setSystemTime(NOW + HOUR + 1);
    reload();
    const listed = await runWorkList();
    expect(listed.claims).toEqual([]);
    expect(listed.expiredCount).toBe(2);

    // Expired, so nothing to finish or release, and neither writes: a
    // prune-only save would mark the state un-pushed for a change nobody made.
    const finished = await runWorkFinish({ url: ISSUE_A });
    expect(finished.claim).toBeNull();
    const released = await runWorkRelease({ url: PR_URL });
    expect(released.released).toEqual([]);
    expect(readDisk().workClaims).toHaveLength(2);
    expect(fs.statSync(getStatePath()).mtimeMs).toBe(before);

    // The next claim write prunes them.
    await claimImpl(ISSUE_B, '/work/wt/b');
    expect(readDisk().workClaims?.map((c) => c.url)).toEqual([ISSUE_B]);
  });

  it('a new claim prunes expired entries and the expired checkout no longer blocks', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a', { ttlHours: 1 });
    vi.setSystemTime(NOW + HOUR + 1);

    const next = await claimImpl(ISSUE_B, '/work/wt/a');
    expect(next.outcome).toBe('claimed');
    expect(readDisk().workClaims?.map((c) => c.url)).toEqual([ISSUE_B]);
  });

  it('warns when pruning a claim whose expiresAt is not a date, and does not count it as live', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    const state = JSON.parse(fs.readFileSync(getStatePath(), 'utf8')) as { workClaims: DiskClaim[] };
    state.workClaims[0].expiresAt = 'soon';
    fs.writeFileSync(getStatePath(), JSON.stringify(state));
    reload();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const listed = await runWorkList();
    expect(listed.claims).toEqual([]);
    expect(listed.expiredCount).toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();

    await claimImpl(ISSUE_B, '/work/wt/b');
    expect(readDisk().workClaims?.map((c) => c.url)).toEqual([ISSUE_B]);
    const logged = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes(`Pruning work claim on ${ISSUE_A}`) && line.includes('"soon"'))).toBe(
      true,
    );
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
      outcome: 'claimed',
    });
    // Raising the cap lets the third one through.
    getStateManager().updateConfig({ maxConcurrentImplementations: 3 });
    await expect(claimImpl(ISSUE_C, '/work/wt/c')).resolves.toMatchObject({ outcome: 'claimed' });
  });

  it('a finished implementation frees a cap slot but keeps its checkout', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    await claimImpl(ISSUE_B, '/work/wt/b');
    await runWorkFinish({ url: ISSUE_A });

    await expect(claimImpl(ISSUE_C, '/work/wt/a')).rejects.toThrow(/already hosts an implementation/);
    await expect(claimImpl(ISSUE_C, '/work/wt/c')).resolves.toMatchObject({ outcome: 'claimed' });
  });

  it('refuses two running implementations in the same checkout, however the path is spelled', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');

    await expect(claimImpl(ISSUE_B, '/work/wt/a/')).rejects.toThrow(ValidationError);
    await expect(claimImpl(ISSUE_B, '/work/wt/../wt/a')).rejects.toThrow(
      `/work/wt/a already hosts an implementation of ${ISSUE_A} (session ${SESSION}, running)`,
    );
    expect(readDisk().workClaims).toHaveLength(1);
  });
});

describe('work claim / finish / release / list: hosts, sessions and foreign claims (real StateManager)', () => {
  useFreshState();

  it('the same checkout path on another machine (another machineId) is a different checkout', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    rewriteFirstClaim({ host: 'other-machine', machineId: 'other-id' });

    await expect(claimImpl(ISSUE_B, '/work/wt/a')).resolves.toMatchObject({ outcome: 'claimed' });
    expect(readDisk().workClaims?.map((c) => c.host)).toEqual(['other-machine', SHORT_HOST]);
    expect(readDisk().workClaims?.map((c) => c.machineId)).toEqual(['other-id', MACHINE_ID]);
  });

  it('a renamed host with this machine id is still this machine: the same path is refused', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    rewriteFirstClaim({ host: `${SHORT_HOST}-2` });

    await expect(claimImpl(ISSUE_B, '/work/wt/a')).rejects.toThrow(/already hosts an implementation/);
    expect(readDisk().workClaims).toHaveLength(1);
  });

  it('a legacy claim without machineId keeps the hostname rule: another host is free, this host is not', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    rewriteFirstClaim({ host: 'other-machine', machineId: undefined });
    await expect(claimImpl(ISSUE_B, '/work/wt/a')).resolves.toMatchObject({ outcome: 'claimed' });

    await runWorkRelease({ url: ISSUE_B });
    rewriteFirstClaim({ host: SHORT_HOST, machineId: undefined });
    await expect(claimImpl(ISSUE_C, '/work/wt/a')).rejects.toThrow(/already hosts an implementation/);
  });

  it('stores the short hostname (`hostname -s`): a domain suffix changes with the network, the machine does not', async () => {
    vi.spyOn(os, 'hostname').mockReturnValue('air.local');
    const claimed = await claimImpl(ISSUE_A, '/work/wt/a');
    expect(claimed.claim.host).toBe('air');
    expect(readDisk().workClaims?.[0]?.host).toBe('air');
  });

  it('a symlink to a checkout in use on this machine is the same checkout', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-claim-'));
    const link = `${checkout}-link`;
    fs.symlinkSync(checkout, link);
    try {
      await claimImpl(ISSUE_A, checkout);
      await expect(claimImpl(ISSUE_B, link)).rejects.toThrow(/already hosts an implementation/);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('re-claiming the same item renews it in place (outcome: renewed) and keeps the order of others', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    await claimImpl(ISSUE_B, '/work/wt/b');

    vi.setSystemTime(NOW + 2 * HOUR);
    const renewed = await claimImpl('https://github.com/OWNER/repo/issues/1', '/work/wt/a');
    expect(renewed.outcome).toBe('renewed');
    expect(renewed.claim.expiresAt).toBe('2026-11-03T14:00:00.000Z');
    const listed = await runWorkList();
    expect(listed.claims.map((c) => c.url)).toEqual([ISSUE_B, 'https://github.com/OWNER/repo/issues/1']);
  });

  it("refuses another session's live claim unless takeover is passed, then reports took-over", async () => {
    await runWorkClaim({ url: PR_URL, kind: 'pr', session: 'air/1' });
    await claimImpl(ISSUE_A, '/work/wt/a', { session: 'air/1' });

    await expect(runWorkClaim({ url: PR_URL, kind: 'pr', session: 'mbp/2' })).rejects.toThrow(
      `${PR_URL} is already claimed: pr claimed in session air/1 (0 min, running). Pass --takeover`,
    );
    await expect(claimImpl(ISSUE_A, '/work/wt/other', { session: 'mbp/2' })).rejects.toThrow(/already claimed/);
    expect(readDisk().workClaims?.map((c) => c.session)).toEqual(['air/1', 'air/1']);

    const taken = await runWorkClaim({ url: PR_URL, kind: 'pr', session: 'mbp/2', takeover: true });
    expect(taken.outcome).toBe('took-over');
    const takenImpl = await claimImpl(ISSUE_A, '/work/wt/other', { session: 'mbp/2', takeover: true });
    expect(takenImpl.outcome).toBe('took-over');
    expect(takenImpl.claim.status).toBe('running');
    const listed = await runWorkList();
    expect(listed.claims.map((c) => c.session)).toEqual(['mbp/2', 'mbp/2']);
  });

  it('finish with --session refuses a claim another session holds and leaves it running', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');

    await expect(runWorkFinish({ url: ISSUE_A, session: OTHER_SESSION })).rejects.toThrow(
      `The claim on ${ISSUE_A} belongs to session ${SESSION}, not ${OTHER_SESSION}; it was not marked finished.`,
    );
    expect(readDisk().workClaims?.[0]).toMatchObject({ status: 'running' });

    const own = await runWorkFinish({ url: ISSUE_A, session: SESSION });
    expect(own.claim?.status).toBe('finished');
    // Without a live claim there is nothing to mismatch: the agent sees null and reports "not recorded".
    await expect(runWorkFinish({ url: ISSUE_B, session: OTHER_SESSION })).resolves.toMatchObject({ claim: null });
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
    // Release needs a selector; finish's session is validated like claim's.
    await expect(runWorkRelease({})).rejects.toThrow(/needs a URL or --session/);
    await expect(runWorkFinish({ url: ISSUE_A, session: ' ' })).rejects.toThrow(/--session must not be empty/);
    // A remote run is a valid location and carries no host or machine id.
    const remote = await runWorkClaim({ url: ISSUE_A, kind: 'implementation', session: SESSION, runId: 'run-42' });
    expect(remote.claim).toMatchObject({ runId: 'run-42' });
    expect(remote.claim.host).toBeUndefined();
    expect(remote.claim.machineId).toBeUndefined();
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

  it("keeps a newer release's claim byte-for-byte through claim, finish and release on other items (#1831)", async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    const foreign = {
      kind: 'review',
      url: 'https://github.com/owner/repo/pull/77',
      session: 'newer-client/1',
      startedAt: '2026-11-02T11:00:00.000Z',
      expiresAt: '2026-11-09T11:00:00.000Z',
      status: 'paused',
      reviewer: 'someone',
      nested: { depth: 2, flags: ['a', 'b'] },
    };
    const state = JSON.parse(fs.readFileSync(getStatePath(), 'utf8')) as { workClaims: unknown[] };
    state.workClaims.push(foreign);
    fs.writeFileSync(getStatePath(), JSON.stringify(state));
    reload();

    await claimImpl(ISSUE_B, '/work/wt/b');
    await runWorkFinish({ url: ISSUE_B });
    await runWorkRelease({ url: ISSUE_A });
    reload();
    const listed = await runWorkList();
    expect(listed.claims.map((c) => c.url)).toEqual([foreign.url, ISSUE_B]);

    const stored = readDisk().workClaims?.find((c) => c.url === foreign.url);
    expect(JSON.stringify(stored)).toBe(JSON.stringify(foreign));
  });

  it('drops a claim it cannot read instead of rejecting the whole state, keeping the others', async () => {
    await claimImpl(ISSUE_A, '/work/wt/a');
    const state = JSON.parse(fs.readFileSync(getStatePath(), 'utf8')) as { workClaims: unknown[] };
    state.workClaims.push({ url: ISSUE_B }, 'not even an object');
    fs.writeFileSync(getStatePath(), JSON.stringify(state));
    reload();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const listed = await runWorkList();
    expect(listed.claims.map((c) => c.url)).toEqual([ISSUE_A]);
    expect(listed.expiredCount).toBe(0);
    const logged = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('2 unreadable work claim(s)'))).toBe(true);
    // No backup restore, no fresh state: the readable claim survived the load.
    expect(getStateManager().getLoadRecovery()).toBeNull();
  });
});
