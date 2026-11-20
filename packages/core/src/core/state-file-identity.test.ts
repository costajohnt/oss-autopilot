/**
 * saveState's compare-and-swap compares file identity (mtime, inode, size),
 * not mtime alone, and a failed stat reads as "changed" (#2006).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import { StateManager } from './state.js';
import {
  saveState,
  createFreshState,
  loadState,
  reloadStateIfChanged,
  atomicWriteFileSync,
} from './state-persistence.js';
import { serializeState } from './state-prune.js';
import { ConcurrencyError } from './errors.js';

const tmp = { dir: '' };
// statSync on this exact path throws EIO; null leaves fs alone.
const mockStatFail: { path: string | null } = { path: null };

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  const backupDir = () => {
    const dir = path.join(tmp.dir, 'backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
  return {
    ...actual,
    getDataDir: () => tmp.dir,
    getStatePath: () => path.join(tmp.dir, 'state.json'),
    getBackupDir: backupDir,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (mockStatFail.path !== null && p === mockStatFail.path) {
      throw Object.assign(new Error(`EIO: stat ${String(p)}`), { code: 'EIO' });
    }
    return (actual.statSync as (...args: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

// ── File identity, not just mtime, in the compare-and-swap (#2006) ──────────
function stateFile(): string {
  return path.join(tmp.dir, 'state.json');
}

function withUsername(name: string): ReturnType<typeof createFreshState> {
  const st = createFreshState();
  st.config.githubUsername = name;
  return st;
}

function diskUsername(): string | undefined {
  const raw = fs.readFileSync(stateFile(), 'utf8');
  return (JSON.parse(raw) as { config: { githubUsername?: string } }).config.githubUsername;
}

/** Run `fn` while statSync on state.json fails with EIO. */
function withStateStatFailing<T>(fn: () => T): T {
  mockStatFail.path = stateFile();
  try {
    return fn();
  } finally {
    mockStatFail.path = null;
  }
}

/** Save 'alice' with its mtime pinned to a whole second 10 s ago; returns the load that follows. */
function seedPinned(): { seconds: number; loaded: ReturnType<typeof loadState> } {
  const seconds = Math.floor(Date.now() / 1000) - 10;
  saveState(withUsername('alice'), null);
  fs.utimesSync(stateFile(), seconds, seconds);
  return { seconds, loaded: loadState() };
}

describe('saveState compare-and-swap uses file identity (#2006)', () => {
  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-identity-'));
  });

  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
    tmp.dir = '';
  });

  it('detects a same-mtime, same-size external atomic replace by inode', () => {
    const { seconds, loaded } = seedPinned();

    // Same-length name: identical size, mtime restored, only the inode moved.
    atomicWriteFileSync(stateFile(), serializeState(withUsername('bobby')), 0o600);
    fs.utimesSync(stateFile(), seconds, seconds);
    const after = fs.statSync(stateFile());
    expect(after.mtimeMs).toBe(loaded.fileId?.mtimeMs);
    expect(after.size).toBe(loaded.fileId?.size);

    expect(() => saveState(loaded.state, loaded.fileId)).toThrow(ConcurrencyError);
    expect(diskUsername()).toBe('bobby');
    expect(reloadStateIfChanged(loaded.fileId)?.state.config.githubUsername).toBe('bobby');
  });

  it('detects a same-mtime in-place write that changed the size', () => {
    const { seconds, loaded } = seedPinned();

    // In place (same inode), mtime pinned back: only the size differs.
    fs.writeFileSync(stateFile(), serializeState(withUsername('bob-longer-name')));
    fs.utimesSync(stateFile(), seconds, seconds);
    expect(fs.statSync(stateFile()).ino).toBe(loaded.fileId?.ino);

    expect(() => saveState(loaded.state, loaded.fileId)).toThrow(ConcurrencyError);
    expect(diskUsername()).toBe('bob-longer-name');
  });

  it('treats a failed stat of an existing file at load as changed, not as "no baseline"', () => {
    saveState(withUsername('alice'), null);
    const loaded = withStateStatFailing(() => loadState());
    expect(loaded.state.config.githubUsername).toBe('alice');
    expect(loaded.fileId).not.toBeNull();
    expect(() => saveState(withUsername('alice-2'), loaded.fileId)).toThrow(ConcurrencyError);
    expect(diskUsername()).toBe('alice');
  });

  it('treats a failed stat after our own save as changed on the next save', () => {
    const first = saveState(withUsername('alice'), null);
    const second = withStateStatFailing(() => {
      // The compare stat fails too: a conflict, nothing written.
      expect(() => saveState(withUsername('alice-2'), first)).toThrow(ConcurrencyError);
      return saveState(withUsername('alice'), null);
    });
    expect(() => saveState(withUsername('alice-3'), second)).toThrow(ConcurrencyError);
    expect(diskUsername()).toBe('alice');

    // A reload takes a real baseline again, and saving from it works.
    const reloaded = reloadStateIfChanged(second);
    expect(reloaded).not.toBeNull();
    expect(() => saveState(withUsername('alice-4'), reloaded?.fileId ?? null)).not.toThrow();
    expect(diskUsername()).toBe('alice-4');
  });

  it('a fresh install saves first time and own consecutive saves never conflict', () => {
    const sm = new StateManager(false);
    expect(fs.existsSync(stateFile())).toBe(false);
    for (let i = 1; i <= 20; i++) sm.updateConfig({ maxActivePRs: i });
    const disk = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as { config: { maxActivePRs: number } };
    expect(disk.config.maxActivePRs).toBe(20);
    expect(sm.reloadIfChanged()).toBe(false);
  });
});
