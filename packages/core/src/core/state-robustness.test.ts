/**
 * State file robustness (#1951): lock contention, stale-lock takeover, and
 * which load failures may fall back to a backup. Real files under a per-test
 * HOME; only the waits and single fs calls are staged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { acquireLock, loadState, saveState, createFreshState } from './state-persistence.js';
import { StateManager } from './state.js';
import { ConcurrencyError, StateLockTimeoutError } from './errors.js';
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

function failStateReads(error: Error): void {
  mockReadFileSync.mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === getStatePath()) throw error;
    return real.readFileSync(...args);
  });
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
  it('leaves a lock alone when a rival took it over between the staleness check and the claim', () => {
    real.writeFileSync(lockPath(), ownerlessLock());
    stubWait();
    const rival = { lock: '' };
    mockRenameSync.mockImplementationOnce((from, to) => {
      acquireLock(lockPath()); // the rival: a complete takeover of the same stale lock
      rival.lock = readLock();
      real.renameSync(from, to); // the claim now grabs the rival's fresh lock
    });

    expect(() => acquireLock(lockPath())).toThrow(StateLockTimeoutError);

    expect(JSON.parse(rival.lock)).toMatchObject({ pid: process.pid });
    expect(readLock()).toBe(rival.lock);
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
