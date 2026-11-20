import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import {
  DAY_MS,
  REJECTED_KEEP,
  REJECTED_MIN_AGE_DAYS,
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

describe('staleRejectedCopies', () => {
  it('keeps the newest copies however old they are', () => {
    for (let i = 0; i < REJECTED_KEEP; i++) writeCopy('state.json', 100 + i);
    expect(staleRejectedCopies(ctx.dataDir, NOW)).toEqual([]);
  });

  it('lists old copies beyond the newest', () => {
    const files: string[] = [];
    for (let i = 0; i < REJECTED_KEEP + 3; i++) files.push(writeCopy('state-cache.json', OLD_DAYS + i));
    expect(new Set(staleRejectedCopies(ctx.dataDir, NOW))).toEqual(new Set(files.slice(REJECTED_KEEP)));
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
    expect(pruneRejectedCopies(ctx.dataDir, NOW)).toEqual([]);
    expect(fs.readFileSync(outside, 'utf8')).toBe('precious');
    expect(fs.readdirSync(ctx.dataDir)).toHaveLength(REJECTED_KEEP + 5);
  });

  it('is empty for a missing directory', () => {
    expect(staleRejectedCopies(path.join(ctx.tmp, 'absent'), NOW)).toEqual([]);
  });
});

describe('pruneRejectedCopies', () => {
  it('deletes only what retention no longer covers', () => {
    const kept: string[] = [];
    for (let i = 0; i < REJECTED_KEEP; i++) kept.push(writeCopy('state-cache.json', OLD_DAYS + i));
    const old = [writeCopy('state-cache.json', 30), writeCopy('state-cache.json', 40)];

    expect(new Set(pruneRejectedCopies(ctx.dataDir, NOW))).toEqual(new Set(old));
    expect(new Set(fs.readdirSync(ctx.dataDir))).toEqual(new Set(kept.map((f) => path.basename(f))));
  });

  it('warns instead of throwing when the directory cannot be read', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notADir = path.join(ctx.tmp, 'file');
    fs.writeFileSync(notADir, '');

    expect(pruneRejectedCopies(notADir, NOW)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not prune rejected state copies'));
  });

  it('warns and carries on when one delete fails', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < REJECTED_KEEP; i++) writeCopy('state.json', OLD_DAYS + i);
    const old = writeCopy('state.json', 60);
    fs.chmodSync(ctx.dataDir, 0o500);

    const removed = pruneRejectedCopies(ctx.dataDir, NOW);
    fs.chmodSync(ctx.dataDir, 0o700);

    expect(removed).toEqual([]);
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
