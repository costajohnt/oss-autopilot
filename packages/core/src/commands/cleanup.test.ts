/**
 * `cleanup` against real repositories in a temp dir: a bare "remote", a
 * clone of it outside the data dir, and linked worktrees under
 * `<data>/worktrees`, the layout the overnight preparer leaves behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { resolveDataDir } from '../core/paths.js';
import { DAY_MS } from '../core/stale-data.js';
import { WORKTREE_MIN_AGE_DAYS, cleanWorktrees, printCleanup, runCleanup } from './cleanup.js';
import type { CleanupOptions, WorktreeReport } from './cleanup.js';
import { git } from './overnight-push-prep.js';

const NOW = Date.now();
const OLD = NOW + (WORKTREE_MIN_AGE_DAYS + 1) * DAY_MS;
const APPLY: CleanupOptions = { apply: true };
const DRY_RUN: CleanupOptions = { apply: false };
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];

const ctx = { tmp: '', origin: '', clone: '', dataDir: '' };

/** Commit `file` with `content` in `dir`. */
function commitFile(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', file]);
  git(dir, [...IDENTITY, 'commit', '-q', '-m', file]);
}

/** A linked worktree of the clone on a new branch at the pushed commit. */
function addWorktree(name: string, parent: string = path.join(ctx.dataDir, 'worktrees')): string {
  const dir = path.join(parent, name);
  git(ctx.clone, ['worktree', 'add', '-q', '-b', `overnight/${name}`, dir, 'origin/main']);
  return dir;
}

function only(dir: string, options: CleanupOptions, now: number = OLD): WorktreeReport {
  const found = cleanWorktrees(ctx.dataDir, options, now).find((r) => r.path === dir);
  if (!found) throw new Error(`no report for ${dir}`);
  return found;
}

/** Seven rejected copies a month old in the (temp HOME) data dir. */
function writeOldCopies(): void {
  fs.mkdirSync(resolveDataDir(), { recursive: true });
  for (let i = 0; i < 7; i++) {
    const ts = NOW - (30 + i) * DAY_MS;
    const file = path.join(resolveDataDir(), `state-cache.json.rejected-${ts}`);
    fs.writeFileSync(file, '{}');
    fs.utimesSync(file, ts / 1000, ts / 1000);
  }
}

beforeEach(() => {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-'));
  ctx.tmp = fs.realpathSync(made);
  ctx.origin = path.join(ctx.tmp, 'origin.git');
  ctx.clone = path.join(ctx.tmp, 'clone');
  ctx.dataDir = path.join(ctx.tmp, 'data');
  fs.mkdirSync(path.join(ctx.dataDir, 'worktrees'), { recursive: true });
  git(ctx.tmp, ['init', '-q', '--bare', '-b', 'main', ctx.origin]);
  git(ctx.tmp, ['init', '-q', '-b', 'main', ctx.clone]);
  commitFile(ctx.clone, 'a.txt', 'a\n');
  git(ctx.clone, ['remote', 'add', 'origin', ctx.origin]);
  git(ctx.clone, ['push', '-q', '-u', 'origin', 'main']);
});

afterEach(() => {
  fs.rmSync(ctx.tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('cleanWorktrees', () => {
  it('lists a clean, pushed, idle worktree in a dry run and removes it with apply', () => {
    const dir = addWorktree('octo-repo-12');

    const planned = only(dir, DRY_RUN);
    expect(planned).toMatchObject({ action: 'would-remove', clean: true, pushed: true });
    expect(planned.ageDays).toBeGreaterThanOrEqual(WORKTREE_MIN_AGE_DAYS);
    expect(fs.existsSync(dir)).toBe(true);

    expect(only(dir, APPLY).action).toBe('removed');
    expect(fs.existsSync(dir)).toBe(false);
    // The branch outlives its worktree, and the clone no longer lists the worktree.
    expect(git(ctx.clone, ['branch', '--list', 'overnight/octo-repo-12'])).toContain('overnight/octo-repo-12');
    expect(git(ctx.clone, ['worktree', 'list'])).not.toContain('octo-repo-12');
  });

  it('keeps a worktree with a modified file', () => {
    const dir = addWorktree('octo-repo-1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');

    expect(only(dir, APPLY)).toMatchObject({ action: 'kept', clean: false, reason: 'uncommitted or untracked files' });
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('changed\n');
  });

  it('keeps a worktree with an untracked file', () => {
    const dir = addWorktree('octo-repo-2');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');

    expect(only(dir, APPLY)).toMatchObject({ action: 'kept', clean: false });
    expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(true);
  });

  it('keeps a worktree whose commit is on no remote-tracking ref', () => {
    const dir = addWorktree('octo-repo-issue-3');
    commitFile(dir, 'fix.txt', 'fix\n');

    const report = only(dir, APPLY);
    expect(report).toMatchObject({ action: 'kept', clean: true, pushed: false });
    expect(report.reason).toContain('unpushed');
    expect(fs.existsSync(path.join(dir, 'fix.txt'))).toBe(true);
  });

  it('removes it once that commit is pushed', () => {
    const dir = addWorktree('octo-repo-4');
    commitFile(dir, 'fix.txt', 'fix\n');
    git(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/prep/fix']);

    expect(only(dir, APPLY).action).toBe('removed');
    expect(git(ctx.clone, ['log', '-1', '--format=%s', 'origin/prep/fix']).trim()).toBe('fix.txt');
  });

  it('keeps a worktree touched inside the retention age', () => {
    const dir = addWorktree('octo-repo-5');

    const report = only(dir, APPLY, Date.now());
    expect(report).toMatchObject({ action: 'kept', clean: true, pushed: true, ageDays: 0 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('refuses a symlink that resolves outside the data directory', () => {
    const outside = path.join(ctx.tmp, 'outside');
    fs.mkdirSync(outside);
    const real = addWorktree('octo-repo-6', outside);
    const link = path.join(ctx.dataDir, 'worktrees', 'octo-repo-6');
    fs.symlinkSync(real, link);

    expect(only(link, APPLY)).toMatchObject({ action: 'kept', reason: 'not a real directory (symlink or file)' });
    expect(fs.existsSync(path.join(real, 'a.txt'))).toBe(true);
  });

  it('returns nothing when worktrees/ itself is a symlink out of the data directory', () => {
    const outside = path.join(ctx.tmp, 'outside');
    fs.mkdirSync(outside);
    const real = addWorktree('octo-repo-7', outside);
    fs.rmdirSync(path.join(ctx.dataDir, 'worktrees'));
    fs.symlinkSync(outside, path.join(ctx.dataDir, 'worktrees'));

    expect(cleanWorktrees(ctx.dataDir, APPLY, OLD)).toEqual([]);
    expect(fs.existsSync(real)).toBe(true);
  });

  it('keeps directories it did not create: other names, plain directories, full clones', () => {
    const oddName = addWorktree('scratch');
    const plain = path.join(ctx.dataDir, 'worktrees', 'octo-repo-8');
    fs.mkdirSync(plain);
    const fullClone = path.join(ctx.dataDir, 'worktrees', 'octo-repo-9');
    git(ctx.tmp, ['clone', '-q', ctx.origin, fullClone]);

    expect(only(oddName, APPLY).reason).toBe('name is not one the overnight preparer creates');
    expect(only(plain, APPLY).reason).toBe('not a linked git worktree');
    expect(only(fullClone, APPLY).reason).toBe('not a linked git worktree');
    expect(fs.existsSync(oddName) && fs.existsSync(plain) && fs.existsSync(fullClone)).toBe(true);
  });

  it('keeps a worktree git refuses to remove, without throwing', () => {
    const dir = addWorktree('octo-repo-10');
    git(ctx.clone, ['worktree', 'lock', dir]);

    const report = only(dir, APPLY);
    expect(report.action).toBe('kept');
    expect(report.reason).toContain('git worktree remove refused');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('keeps a worktree whose check errors, without throwing', () => {
    const dir = addWorktree('octo-repo-11');
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nonexistent\n');

    const report = only(dir, APPLY);
    expect(report.action).toBe('kept');
    expect(report.reason).toContain('check failed');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('is empty without a worktrees directory', () => {
    expect(cleanWorktrees(path.join(ctx.tmp, 'absent'), APPLY, OLD)).toEqual([]);
  });
});

describe('runCleanup', () => {
  // HOME is a per-file temp dir (test-lib/isolate-home.ts); resolveDataDir throws if it ever is the real one.
  afterEach(() => {
    fs.rmSync(resolveDataDir(), { recursive: true, force: true });
  });

  it('reports without deleting by default', () => {
    writeOldCopies();

    const out = runCleanup({ apply: false });

    expect(out.applied).toBe(false);
    expect(out.rejectedCopies).toHaveLength(2);
    expect(out.worktrees).toEqual([]);
    expect(fs.readdirSync(resolveDataDir())).toHaveLength(7);
  });

  it('deletes with apply', () => {
    writeOldCopies();

    const out = runCleanup({ apply: true });

    expect(out.applied).toBe(true);
    expect(out.rejectedCopies).toHaveLength(2);
    expect(fs.readdirSync(resolveDataDir())).toHaveLength(5);
  });

  it('is empty when the data directory does not exist', () => {
    expect(runCleanup({ apply: true })).toEqual({ applied: true, worktrees: [], rejectedCopies: [] });
  });
});

describe('printCleanup', () => {
  const worktree = { ageDays: 20, clean: true, pushed: true };

  it('prints the plan, the kept items with reasons, and the --apply hint', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    printCleanup({
      applied: false,
      worktrees: [
        { ...worktree, path: '/d/worktrees/a-1', action: 'would-remove', reason: 'clean, pushed, idle 20 days' },
        { ...worktree, path: '/d/worktrees/b-2', action: 'kept', reason: 'uncommitted or untracked files' },
      ],
      rejectedCopies: ['/d/state.json.rejected-1'],
    });

    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Would remove 1 worktree(s), 1 rejected state copy(ies)');
    expect(out).toContain('/d/worktrees/a-1: clean, pushed, idle 20 days');
    expect(out).toContain('Kept 1 worktree(s):');
    expect(out).toContain('/d/worktrees/b-2: uncommitted or untracked files');
    expect(out).toContain('Re-run with --apply to remove.');
  });

  it('prints what was removed, with no hint', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    printCleanup({ applied: true, worktrees: [], rejectedCopies: [] });

    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toBe('Removed 0 worktree(s), 0 rejected state copy(ies)');
  });
});
