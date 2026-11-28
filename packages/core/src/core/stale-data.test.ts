import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { isRoot } from '../test-lib/is-root.js';
import {
  DAY_MS,
  REJECTED_KEEP,
  REJECTED_MIN_AGE_DAYS,
  WORKTREE_MIN_AGE_DAYS,
  countStaleData,
  pruneRejectedCopies,
  isInside,
  staleRejectedCopies,
} from './stale-data.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const OLD_DAYS = REJECTED_MIN_AGE_DAYS + 1;

const ctx = { tmp: '', dataDir: '' };

/** Write `<base>.rejected-<ts>` aged `days`, both in its name and its mtime. */
function writeCopy(base: string, days: number, offsetMs = 0): string {
  const ts = NOW - days * DAY_MS + offsetMs;
  const file = path.join(ctx.dataDir, `${base}.rejected-${ts}`);
  fs.writeFileSync(file, '{}');
  fs.utimesSync(file, ts / 1000, ts / 1000);
  return file;
}

beforeEach(() => {
  ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-data-'));
  ctx.dataDir = path.join(ctx.tmp, 'data');
  fs.mkdirSync(ctx.dataDir);
});

afterEach(() => {
  fs.rmSync(ctx.tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('countStaleData (#2049)', () => {
  it("counts every overnight worktree, and separately those idle past cleanup's threshold by their own mtime", () => {
    const root = path.join(ctx.dataDir, 'worktrees');
    const fresh = path.join(root, 'octo-repo-1');
    const old = path.join(root, 'octo-repo-2');
    fs.mkdirSync(fresh, { recursive: true });
    fs.mkdirSync(old);
    const freshSec = (NOW - DAY_MS) / 1000;
    const oldSec = (NOW - (WORKTREE_MIN_AGE_DAYS + 1) * DAY_MS) / 1000;
    fs.utimesSync(fresh, freshSec, freshSec);
    fs.utimesSync(old, oldSec, oldSec);

    expect(countStaleData(ctx.dataDir, NOW)).toEqual({ worktrees: 2, oldWorktrees: 1, rejected: 0 });
  });

  it('is all zeros with no worktrees directory', () => {
    expect(countStaleData(ctx.dataDir, NOW)).toEqual({ worktrees: 0, oldWorktrees: 0, rejected: 0 });
  });
});

describe('staleRejectedCopies', () => {
  it('keeps the newest copies however old they are', () => {
    for (let i = 0; i < REJECTED_KEEP; i++) writeCopy('state.json', 100 + i);
    expect(staleRejectedCopies(ctx.dataDir, NOW)).toEqual([]);
  });

  it('lists old copies beyond the newest', () => {
    const files: string[] = [];
    for (let i = 0; i < REJECTED_KEEP + 3; i++) files.push(writeCopy('state-cache.json', OLD_DAYS + i));
    // The last one written here is the oldest of its kind, which is kept too.
    expect(new Set(staleRejectedCopies(ctx.dataDir, NOW))).toEqual(new Set(files.slice(REJECTED_KEEP, -1)));
  });

  it('keeps the oldest copy of each kind, the one from the start of an incident', () => {
    const newest = [];
    for (let i = 0; i < REJECTED_KEEP; i++) newest.push(writeCopy('state.json', OLD_DAYS + i));
    const middle = writeCopy('state.json', 50);
    const oldest = writeCopy('state.json', 90);
    const oldestCache = writeCopy('state-cache.json', 200);

    expect(staleRejectedCopies(ctx.dataDir, NOW)).toEqual([middle]);
    expect(pruneRejectedCopies(ctx.dataDir, NOW).removed).toEqual([middle]);
    expect(fs.existsSync(oldest) && fs.existsSync(oldestCache)).toBe(true);
    expect(newest.every((file) => fs.existsSync(file))).toBe(true);
  });

  it('ranks a burst of copies with one shared timestamp instead of keeping or dropping them all', () => {
    const shared = (NOW - 40 * DAY_MS) / 1000;
    for (let ts = 1; ts <= 20; ts++) {
      const file = path.join(ctx.dataDir, `state-cache.json.rejected-${ts}`);
      fs.writeFileSync(file, '{}');
      fs.utimesSync(file, shared, shared);
    }

    // 20 copies, all equally old: the newest 5 and the oldest 1 by name order stay.
    expect(staleRejectedCopies(ctx.dataDir, NOW)).toHaveLength(20 - REJECTED_KEEP - 1);
    expect(pruneRejectedCopies(ctx.dataDir, NOW).removed).toHaveLength(20 - REJECTED_KEEP - 1);
    expect(fs.readdirSync(ctx.dataDir)).toHaveLength(REJECTED_KEEP + 1);
  });

  it.skipIf(isRoot)('skips an entry it cannot stat (a file that vanished mid-scan) with a warning', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < REJECTED_KEEP + 3; i++) writeCopy('state.json', OLD_DAYS + i);
    // Readable but not searchable: readdir lists the names, lstat on each fails.
    fs.chmodSync(ctx.dataDir, 0o400);

    const stale = staleRejectedCopies(ctx.dataDir, NOW);
    fs.chmodSync(ctx.dataDir, 0o700);

    expect(stale).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping state.json.rejected-'));
    expect(warnSpy).toHaveBeenCalledTimes(REJECTED_KEEP + 3);
  });

  it('keeps every young copy, even past the count', () => {
    for (let i = 0; i < REJECTED_KEEP + 30; i++) writeCopy('state-cache.json', 0, -i);
    expect(staleRejectedCopies(ctx.dataDir, NOW)).toEqual([]);
  });

  it('treats a recently modified file as young whatever its name says', () => {
    for (let i = 0; i < REJECTED_KEEP; i++) writeCopy('state.json', 1 + i);
    const renamedOld = writeCopy('state.json', 50);
    fs.utimesSync(renamedOld, NOW / 1000, NOW / 1000);
    expect(staleRejectedCopies(ctx.dataDir, NOW)).toEqual([]);
  });

  it('counts state.json and state-cache.json copies separately', () => {
    for (let i = 0; i < REJECTED_KEEP; i++) writeCopy('state.json', OLD_DAYS + i);
    for (let i = 0; i < REJECTED_KEEP; i++) writeCopy('state-cache.json', OLD_DAYS + 20 + i);
    expect(staleRejectedCopies(ctx.dataDir, NOW)).toEqual([]);
  });

  it('prunes local-config.json copies by the same rules and never touches local-config.json', () => {
    const kept: string[] = [];
    for (let i = 0; i < REJECTED_KEEP; i++) kept.push(writeCopy('local-config.json', OLD_DAYS + i));
    const stale = writeCopy('local-config.json', 50);
    kept.push(writeCopy('local-config.json', 90));
    const live = path.join(ctx.dataDir, 'local-config.json');
    fs.writeFileSync(live, '{}');
    fs.utimesSync(live, 0, 0);

    expect(staleRejectedCopies(ctx.dataDir, NOW)).toEqual([stale]);
    expect(pruneRejectedCopies(ctx.dataDir, NOW).removed).toEqual([stale]);
    expect(kept.every((file) => fs.existsSync(file)) && fs.existsSync(live)).toBe(true);
  });

  it('ignores names the code does not write, directories and symlinks', () => {
    for (let i = 0; i < REJECTED_KEEP; i++) writeCopy('state.json', 1 + i);
    const outside = path.join(ctx.tmp, 'outside.json');
    fs.writeFileSync(outside, 'precious');
    fs.symlinkSync(outside, path.join(ctx.dataDir, 'state.json.rejected-1'));
    fs.mkdirSync(path.join(ctx.dataDir, 'state.json.rejected-2'));
    fs.writeFileSync(path.join(ctx.dataDir, 'state.json.rejected-3.bak'), '');
    fs.writeFileSync(path.join(ctx.dataDir, 'notes.json.rejected-4'), '');
    fs.writeFileSync(path.join(ctx.dataDir, 'state.json'), '{}');

    expect(staleRejectedCopies(ctx.dataDir, NOW)).toEqual([]);
    expect(pruneRejectedCopies(ctx.dataDir, NOW)).toEqual({ removed: [], errors: [] });
    expect(fs.readFileSync(outside, 'utf8')).toBe('precious');
    expect(fs.readdirSync(ctx.dataDir)).toHaveLength(REJECTED_KEEP + 5);
  });

  it('is empty for a missing directory', () => {
    expect(staleRejectedCopies(path.join(ctx.tmp, 'absent'), NOW)).toEqual([]);
  });
});

describe('pruneRejectedCopies', () => {
  it('deletes only what retention no longer covers, and says so once at warn', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kept: string[] = [];
    for (let i = 0; i < REJECTED_KEEP; i++) kept.push(writeCopy('state-cache.json', OLD_DAYS + i));
    const old = [writeCopy('state-cache.json', 30), writeCopy('state-cache.json', 35)];
    kept.push(writeCopy('state-cache.json', 40));

    const result = pruneRejectedCopies(ctx.dataDir, NOW);

    expect(new Set(result.removed)).toEqual(new Set(old));
    expect(result.errors).toEqual([]);
    expect(new Set(fs.readdirSync(ctx.dataDir))).toEqual(new Set(kept.map((f) => path.basename(f))));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('Pruned 2 rejected state copy(ies)');
    expect(line).toContain(`newest ${REJECTED_KEEP}`);
    expect(line).toContain(path.basename(old[0]));
    expect(line).toContain(path.basename(old[1]));
  });

  it('is silent when there is nothing to prune', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeCopy('state.json', 100);

    expect(pruneRejectedCopies(ctx.dataDir, NOW)).toEqual({ removed: [], errors: [] });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reports instead of throwing when the directory cannot be read', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notADir = path.join(ctx.tmp, 'file');
    fs.writeFileSync(notADir, '');

    const result = pruneRejectedCopies(notADir, NOW);

    expect(result.removed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not prune rejected state copies'));
  });

  it.skipIf(isRoot)('reports and carries on when a delete fails', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < REJECTED_KEEP; i++) writeCopy('state.json', OLD_DAYS + i);
    const old = writeCopy('state.json', 60);
    writeCopy('state.json', 90);
    fs.chmodSync(ctx.dataDir, 0o500);

    const result = pruneRejectedCopies(ctx.dataDir, NOW);
    fs.chmodSync(ctx.dataDir, 0o700);

    expect(result.removed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(fs.existsSync(old)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not delete rejected state copy'));
  });
});

describe('isInside', () => {
  it('accepts a real child and refuses the parent itself', () => {
    fs.mkdirSync(path.join(ctx.dataDir, 'child'));
    expect(isInside(ctx.dataDir, path.join(ctx.dataDir, 'child'))).toBe(true);
    expect(isInside(ctx.dataDir, ctx.dataDir)).toBe(false);
  });

  it('refuses a symlink that leaves the parent', () => {
    const outside = path.join(ctx.tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(ctx.dataDir, 'link'));
    expect(isInside(ctx.dataDir, path.join(ctx.dataDir, 'link'))).toBe(false);
  });
});
