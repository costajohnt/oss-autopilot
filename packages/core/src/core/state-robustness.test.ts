/**
 * State file robustness (#1951): lock contention, stale-lock takeover, and
 * which load failures may fall back to a backup. Real files under a per-test
 * HOME; only the waits and single fs calls are staged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { acquireLock, releaseLock, loadState, saveState, createFreshState } from './state-persistence.js';
import { StateManager } from './state.js';
import { ConcurrencyError, NewerStateVersionError, StateLockTimeoutError } from './errors.js';
import { getBackupDir, getDataDir, getStatePath } from './paths.js';

// Real fs throughout; these four are spies so a test can fail one call or run
// a rival process's step between two steps of the code under test.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    linkSync: vi.fn(actual.linkSync),
  };
});

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockRenameSync = vi.mocked(fs.renameSync);
const mockLinkSync = vi.mocked(fs.linkSync);
const real = await vi.importActual<typeof fs>('node:fs');

const MINUTE = 60_000;
const scratch = { home: '', previousHome: '' };

beforeEach(() => {
  scratch.previousHome = process.env.HOME ?? '';
  scratch.home = real.mkdtempSync(path.join(os.tmpdir(), 'oss-state-robustness-'));
  process.env.HOME = scratch.home;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env.HOME = scratch.previousHome;
  mockReadFileSync.mockReset();
  mockWriteFileSync.mockReset();
  mockRenameSync.mockReset();
  mockLinkSync.mockReset();
  vi.restoreAllMocks();
  real.rmSync(scratch.home, { recursive: true, force: true });
});

function lockPath(): string {
  return getStatePath() + '.lock';
}

/** A lock whose owner (this test's parent process) is alive. */
function liveLock(ageMs: number): string {
  return JSON.stringify({ pid: process.ppid, timestamp: Date.now() - ageMs });
}

/** A minute-old lock with no owner PID to find alive, as a crashed writer leaves behind. */
function ownerlessLock(): string {
  return JSON.stringify({ timestamp: Date.now() - MINUTE });
}

function readLock(): string {
  return real.readFileSync(lockPath(), 'utf8');
}

/** Replace the real sleep; `onWait` runs with the 1-based number of the wait. */
function stubWait(onWait: (call: number) => void = () => {}) {
  const spy = vi.spyOn(Atomics, 'wait');
  spy.mockImplementation(() => {
    onWait(spy.mock.calls.length);
    return 'timed-out';
  });
  return spy;
}

function entryContent(file: string): string {
  return real.statSync(file).isDirectory() ? '<dir>' : real.readFileSync(file, 'utf8');
}

/** Every path under the data dir with its content: equal snapshots mean nothing was touched. */
function snapshotDataDir(): Record<string, string> {
  const dir = getDataDir();
  const names = real.readdirSync(dir, { recursive: true, encoding: 'utf8' });
  return Object.fromEntries(names.map((name) => [name, entryContent(path.join(dir, name))]));
}

function stateJson(githubUsername: string, version = 4): string {
  return JSON.stringify({ version, config: { githubUsername } });
}

function readStateFile(): unknown {
  return JSON.parse(real.readFileSync(getStatePath(), 'utf8'));
}

function writeState(content: string): void {
  real.writeFileSync(getStatePath(), content, { mode: 0o600 });
}

function writeBackup(name: string, content: string): void {
  real.writeFileSync(path.join(getBackupDir(), name), content, { mode: 0o600 });
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated failure`), { code });
}

function failReadsWhere(isTarget: (file: string) => boolean, error: Error): void {
  mockReadFileSync.mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (isTarget(String(args[0]))) throw error;
    return real.readFileSync(...args);
  });
}

function failStateReads(error: Error): void {
  failReadsWhere((file) => file === getStatePath(), error);
}

/** Fail the first `times` reads of the state file, then read it for real. */
function failStateReadTimes(times: number, error: Error): void {
  const seen = { count: 0 };
  failReadsWhere((file) => {
    if (file !== getStatePath()) return false;
    seen.count += 1;
    return seen.count <= times;
  }, error);
}

function failLockReads(error: Error): void {
  failReadsWhere((file) => file === lockPath(), error);
}

/** Give the state file an mtime no earlier load can have seen. */
function touchState(): void {
  const later = new Date(Date.now() + 5000);
  real.utimesSync(getStatePath(), later, later);
}

function errorLines(): string[] {
  return vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
}

function failStateTmpWrites(error: Error): void {
  mockWriteFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).endsWith('.tmp')) throw error;
    real.writeFileSync(...args);
  });
}

describe('lock contention', () => {
  it('saves once a held lock is released within the wait', () => {
    real.writeFileSync(lockPath(), liveLock(0));
    const wait = stubWait((call) => {
      if (call === 3) real.unlinkSync(lockPath());
    });

    saveState(createFreshState());

    expect(wait).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls[0][3]).toBe(25);
    expect(readStateFile()).toMatchObject({ version: 4 });
    expect(real.existsSync(lockPath())).toBe(false);
  });

  it('surfaces a ConcurrencyError after the bounded wait and writes nothing', () => {
    writeState(stateJson('on-disk'));
    const manager = new StateManager(false);
    const held = liveLock(0);
    real.writeFileSync(lockPath(), held);
    getBackupDir(); // saveState resolves (and creates) the empty backup dir before locking
    const before = snapshotDataDir();
    const wait = stubWait();

    expect(() => saveState(createFreshState())).toThrow(StateLockTimeoutError);
    expect(wait).toHaveBeenCalledTimes(40);
    expect(() => manager.save()).toThrow(ConcurrencyError);
    expect(() => manager.save()).toThrow(/locked by another process.*Nothing was written/);
    expect(snapshotDataDir()).toEqual(before);
    expect(readLock()).toBe(held);
  });

  it('rethrows a lock-file error that is not contention', () => {
    const wait = stubWait();
    const missingDir = path.join(getDataDir(), 'missing', 'state.json.lock');

    expect(() => acquireLock(missingDir)).toThrow(/ENOENT/);
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('stale-lock takeover', () => {
  it('puts a lock back when a rival took it over between the staleness check and the claim', () => {
    real.writeFileSync(lockPath(), ownerlessLock());
    stubWait();
    const rival = liveLock(0);
    mockRenameSync.mockImplementationOnce((from, to) => {
      real.unlinkSync(lockPath()); // the rival: claimed the same stale lock ...
      real.writeFileSync(lockPath(), rival); // ... and created its own
      real.renameSync(from, to); // the claim now grabs the rival's fresh lock
    });

    expect(() => acquireLock(lockPath())).toThrow(StateLockTimeoutError);

    expect(readLock()).toBe(rival);
    expect(real.readdirSync(getDataDir())).toEqual(['state.json.lock']);
  });

  it('takes the lock when a rival claimed the stale one first but has not created its own', () => {
    real.writeFileSync(lockPath(), ownerlessLock());
    const wait = stubWait();
    mockRenameSync.mockImplementationOnce((from, to) => {
      real.unlinkSync(lockPath()); // the rival's rename won
      real.renameSync(from, to); // ours fails with ENOENT
    });

    acquireLock(lockPath());

    expect(JSON.parse(readLock())).toMatchObject({ pid: process.pid });
    expect(wait).not.toHaveBeenCalled();
    expect(real.readdirSync(getDataDir())).toEqual(['state.json.lock']);
  });

  it('never overwrites a lock created while a wrongly claimed one was out of place', () => {
    real.writeFileSync(lockPath(), ownerlessLock());
    stubWait();
    const third = liveLock(0);
    mockRenameSync.mockImplementationOnce((from, to) => {
      real.writeFileSync(lockPath(), liveLock(1)); // a rival's fresh lock replaced the stale one
      real.renameSync(from, to);
    });
    mockLinkSync.mockImplementationOnce((from, to) => {
      real.writeFileSync(lockPath(), third); // a third process locks during the gap
      real.linkSync(from, to); // putting the rival's lock back fails with EEXIST
    });

    expect(() => acquireLock(lockPath())).toThrow(StateLockTimeoutError);

    expect(readLock()).toBe(third);
    expect(real.readdirSync(getDataDir())).toEqual(['state.json.lock']);
  });

  it.each([
    ['a live owner within ten minutes', liveLock(MINUTE)],
    ['a live owner under another user (pid 1)', JSON.stringify({ pid: 1, timestamp: Date.now() - MINUTE })],
    ['an owner still writing the file (empty, fresh mtime)', ''],
    ['a fresh lock with no readable timestamp', '{}'],
  ])('does not take a lock from %s', (_label, content) => {
    real.writeFileSync(lockPath(), content);
    stubWait();

    expect(() => acquireLock(lockPath())).toThrow(StateLockTimeoutError);
    expect(readLock()).toBe(content);
  });

  it('takes a lock from a live PID once it is past ten minutes', () => {
    real.writeFileSync(lockPath(), liveLock(11 * MINUTE));
    const wait = stubWait();

    acquireLock(lockPath());

    expect(JSON.parse(readLock())).toMatchObject({ pid: process.pid });
    expect(wait).not.toHaveBeenCalled();
  });

  it('takes an unreadable lock once its mtime is past the stale threshold', () => {
    real.writeFileSync(lockPath(), 'NOT VALID JSON');
    const aged = new Date(Date.now() - MINUTE);
    real.utimesSync(lockPath(), aged, aged);
    stubWait();

    acquireLock(lockPath());

    expect(JSON.parse(readLock())).toMatchObject({ pid: process.pid });
  });
});

describe('lock ownership and lock-file errors', () => {
  it('takes over a lock carrying its own PID at once: a synchronous acquirer cannot be the holder', () => {
    const leftover = JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: 'earlier-call' });
    real.writeFileSync(lockPath(), leftover);
    const wait = stubWait();

    const held = acquireLock(lockPath());

    expect(held).not.toBe(leftover);
    expect(readLock()).toBe(held);
    expect(wait).not.toHaveBeenCalled();
  });

  it('does not let a timestamp in the future make a lock immortal', () => {
    real.writeFileSync(lockPath(), JSON.stringify({ timestamp: Date.now() + 60 * MINUTE }));
    const aged = new Date(Date.now() - MINUTE);
    real.utimesSync(lockPath(), aged, aged);
    stubWait();

    const held = acquireLock(lockPath());

    expect(readLock()).toBe(held);
  });

  it('names both expiry limits and the manual way out when it times out', () => {
    real.writeFileSync(lockPath(), liveLock(0));
    stubWait();

    expect(() => acquireLock(lockPath())).toThrow(/waited \d+ ms.*30 seconds.*10 minutes.*delete .*state\.json\.lock/);
  });

  it('releases only the lock it was handed', () => {
    const held = acquireLock(lockPath());

    releaseLock(lockPath(), 'some other content');
    expect(readLock()).toBe(held);

    releaseLock(lockPath(), held);
    expect(real.existsSync(lockPath())).toBe(false);
    expect(errorLines()).toEqual([]);
  });

  it('warns instead of throwing when the lock cannot be released, and stays quiet when it is gone', () => {
    releaseLock(lockPath(), 'never taken');
    expect(errorLines()).toEqual([]);

    const held = acquireLock(lockPath());
    failLockReads(errnoError('EIO'));
    releaseLock(lockPath(), held);

    expect(errorLines().join('\n')).toMatch(/Could not release the state lock .*EIO/);
    expect(real.existsSync(lockPath())).toBe(true);
  });

  it('rethrows a lock read error instead of reporting contention', () => {
    real.writeFileSync(lockPath(), liveLock(0));
    const wait = stubWait();
    const error = errnoError('EMFILE');
    failLockReads(error);

    expect(() => acquireLock(lockPath())).toThrow(error);
    expect(wait).not.toHaveBeenCalled();
  });

  it('does not leave its own lock behind when it cannot read it back', () => {
    const error = errnoError('EMFILE');
    failLockReads(error);

    expect(() => acquireLock(lockPath())).toThrow(error);
    expect(real.existsSync(lockPath())).toBe(false);
  });

  it('puts a claimed lock back when it cannot be read to confirm it is the stale one', () => {
    const stale = ownerlessLock();
    real.writeFileSync(lockPath(), stale);
    stubWait();
    failReadsWhere((file) => file.includes('.stale-'), errnoError('EIO'));

    expect(() => acquireLock(lockPath())).toThrow(StateLockTimeoutError);

    expect(readLock()).toBe(stale);
    expect(real.readdirSync(getDataDir())).toEqual(['state.json.lock']);
  });

  it('refuses the write when its lock was taken over before the commit', () => {
    writeState(stateJson('on-disk'));
    const usurper = liveLock(0);
    // saveState reads the state file once, between acquiring and writing: take the lock over there.
    mockReadFileSync.mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === getStatePath()) real.writeFileSync(lockPath(), usurper);
      return real.readFileSync(...args);
    });

    expect(() => saveState(createFreshState())).toThrow(ConcurrencyError);

    expect(real.readFileSync(getStatePath(), 'utf8')).toBe(stateJson('on-disk'));
    expect(readLock()).toBe(usurper);
  });

  it('does not let allowReloadAndLoseMutation swallow a lock timeout', () => {
    writeState(stateJson('on-disk'));
    const manager = new StateManager(false);
    real.writeFileSync(lockPath(), liveLock(0));
    stubWait();

    expect(() => manager.save({ allowReloadAndLoseMutation: true })).toThrow(StateLockTimeoutError);
  });
});

describe('reload and save against state this client must not touch', () => {
  it('reloadIfChanged surfaces newer-version state instead of keeping stale memory', () => {
    writeState(stateJson('mine'));
    const manager = new StateManager(false);
    writeState(stateJson('theirs', 5));
    touchState();
    const before = snapshotDataDir();

    expect(() => manager.reloadIfChanged()).toThrow(NewerStateVersionError);
    expect(snapshotDataDir()).toEqual(before);
  });

  it('reloadIfChanged surfaces a read error', () => {
    writeState(stateJson('mine'));
    const manager = new StateManager(false);
    touchState();
    const error = errnoError('EIO');
    failStateReads(error);

    expect(() => manager.reloadIfChanged()).toThrow(error);
  });

  it.each(['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN'])('reloadIfChanged retries a transient %s once', (code) => {
    writeState(stateJson('mine'));
    const manager = new StateManager(false);
    writeState(stateJson('edited-elsewhere'));
    touchState();
    const wait = stubWait();
    failStateReadTimes(1, errnoError(code));

    expect(manager.reloadIfChanged()).toBe(true);
    expect(manager.getState().config.githubUsername).toBe('edited-elsewhere');
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('reloadIfChanged surfaces a transient error that persists past the retry', () => {
    writeState(stateJson('mine'));
    const manager = new StateManager(false);
    touchState();
    stubWait();
    const error = errnoError('EMFILE');
    failStateReadTimes(2, error);

    expect(() => manager.reloadIfChanged()).toThrow(error);
  });

  it('reloadIfChanged treats a file that vanishes between the stat and the read as no change', () => {
    writeState(stateJson('mine'));
    const manager = new StateManager(false);
    touchState();
    failStateReads(errnoError('ENOENT'));

    expect(manager.reloadIfChanged()).toBe(false);
    expect(manager.getState().config.githubUsername).toBe('mine');
  });

  it('save warns and still writes when the pre-save version check cannot read the file', () => {
    writeState(stateJson('on-disk'));
    failStateReads(errnoError('EIO'));

    saveState(createFreshState());

    expect(errorLines().join('\n')).toMatch(/Could not version-check the state file before save: EIO/);
    expect(readStateFile()).toMatchObject({ config: { githubUsername: '' } });
  });

  it('reloadIfChanged still treats a deleted state file as no change', () => {
    writeState(stateJson('mine'));
    const manager = new StateManager(false);
    real.unlinkSync(getStatePath());

    expect(manager.reloadIfChanged()).toBe(false);
    expect(manager.getState().config.githubUsername).toBe('mine');
  });

  it('save refuses to overwrite newer-version state even with no mtime baseline', () => {
    const manager = new StateManager(false); // started before any state file existed
    writeState(stateJson('theirs', 5));
    getBackupDir();
    const before = snapshotDataDir();

    expect(() => manager.save()).toThrow(NewerStateVersionError);
    expect(() => saveState(createFreshState())).toThrow(/Update this client/);
    expect(snapshotDataDir()).toEqual(before);
  });
});

describe('loadState failures that are not corruption', () => {
  it.each(['EMFILE', 'EIO', 'EBUSY', 'EISDIR', 'ENOENT'])('rethrows %s from the read and touches no file', (code) => {
    writeState(stateJson('current'));
    writeBackup('state-2026-01-01T00-00-00-000Z-aaaaaa.json', stateJson('older-backup'));
    const before = snapshotDataDir();
    const error = errnoError(code);
    failStateReads(error);

    expect(() => loadState()).toThrow(error);
    expect(snapshotDataDir()).toEqual(before);
  });

  it('rethrows ENOSPC from the post-migration write and keeps the state file', () => {
    writeState(stateJson('current', 3));
    writeBackup('state-2026-01-01T00-00-00-000Z-aaaaaa.json', stateJson('older-backup'));
    const before = snapshotDataDir();
    const error = errnoError('ENOSPC');
    failStateTmpWrites(error);

    expect(() => loadState()).toThrow(error);
    expect(snapshotDataDir()).toEqual(before);
  });

  it('refuses state written by a newer release with an update message and touches no file', () => {
    writeState(stateJson('from-newer-release', 5));
    writeBackup('state-2026-01-01T00-00-00-000Z-aaaaaa.json', stateJson('older-backup'));
    const before = snapshotDataDir();

    expect(() => loadState()).toThrow(/newer oss-autopilot release \(schema version 5; this release reads up to 4\)/);
    expect(() => new StateManager(false)).toThrow(/claude plugin update oss-autopilot@oss-autopilot/);
    expect(snapshotDataDir()).toEqual(before);
  });
});

describe('loadState on genuine corruption', () => {
  it('restores the newest valid backup and keeps the corrupt file as a rejected copy', () => {
    writeState('{ "version": 4, "config": {');
    writeBackup('state-2026-01-01T00-00-00-000Z-aaaaaa.json', stateJson('older-backup'));
    writeBackup('state-2026-02-01T00-00-00-000Z-bbbbbb.json', stateJson('newest-backup'));
    writeBackup('state-2026-03-01T00-00-00-000Z-cccccc.json', 'CORRUPT BACKUP');

    const result = loadState();

    expect(result.state.config.githubUsername).toBe('newest-backup');
    expect(result.recovery).toMatchObject({ source: 'backup' });
    expect(real.readFileSync(String(result.recovery?.rejectedPath), 'utf8')).toBe('{ "version": 4, "config": {');
    expect(readStateFile()).toMatchObject({ config: { githubUsername: 'newest-backup' } });
  });
});
