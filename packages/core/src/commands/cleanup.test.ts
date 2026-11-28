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
import { isRoot } from '../test-lib/is-root.js';
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
  const found = cleanWorktrees(ctx.dataDir, options, now).worktrees.find((r) => r.path === dir);
  if (!found) throw new Error(`no report for ${dir}`);
  return found;
}

/** Commit a `.gitignore` to main and push it, so worktrees made after start from it. */
function ignoreOnMain(patterns: string): void {
  commitFile(ctx.clone, '.gitignore', patterns);
  git(ctx.clone, ['push', '-q', 'origin', 'main']);
}

/** Make the worktree look untouched for a month, for callers that use the real clock. */
function backdate(dir: string): void {
  const then = (NOW - 30 * DAY_MS) / 1000;
  const gitDir = git(dir, ['rev-parse', '--absolute-git-dir']).trim();
  fs.utimesSync(path.join(gitDir, 'index'), then, then);
  fs.utimesSync(dir, then, then);
}

/** A filter program that leaves `<name>.ran` behind when Git runs it. */
function filterProgram(name: string): { program: string; marker: string } {
  const marker = path.join(ctx.tmp, `${name}.ran`);
  const program = path.join(ctx.tmp, `${name}.sh`);
  fs.writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  return { program, marker };
}

/** `* filter=<driver>` in the attributes file outside the tree, as a tick could write it. */
function attributeAll(dir: string, driver: string): void {
  const commonDir = path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']).trim());
  fs.mkdirSync(path.join(commonDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(commonDir, 'info', 'attributes'), `* filter=${driver}\n`);
}

/** Same content, newer stat data than the index: the next status re-hashes it through the filter. */
function touchTracked(dir: string): void {
  const later = NOW / 1000 + 60;
  fs.utimesSync(path.join(dir, 'a.txt'), later, later);
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(ctx.tmp, { recursive: true, force: true });
});

describe('cleanWorktrees: working tree contents', () => {
  it('lists a clean, pushed, idle worktree in a dry run and removes it with apply', () => {
    const dir = addWorktree('octo-repo-12');

    const planned = only(dir, DRY_RUN);
    expect(planned).toMatchObject({ action: 'would-remove', clean: true, pushed: true });
    expect(planned.ageDays).toBeGreaterThanOrEqual(WORKTREE_MIN_AGE_DAYS);
    expect(fs.existsSync(dir)).toBe(true);

    expect(cleanWorktrees(ctx.dataDir, APPLY, OLD)).toMatchObject({ worktrees: [{ action: 'removed' }], errors: [] });
    expect(fs.existsSync(dir)).toBe(false);
    // The branch outlives its worktree, and the clone no longer lists the worktree.
    expect(git(ctx.clone, ['branch', '--list', 'overnight/octo-repo-12'])).toContain('overnight/octo-repo-12');
    expect(git(ctx.clone, ['worktree', 'list'])).not.toContain('octo-repo-12');
  });

  it('removes the commit message file beside a worktree with it, and never reports one (#1937)', () => {
    const dir = addWorktree('octo-repo-13');
    const kept = addWorktree('octo-repo-14');
    fs.writeFileSync(path.join(kept, 'README.md'), 'edited\n');
    fs.writeFileSync(`${dir}.commit-msg.txt`, 'fix: a\n');
    fs.writeFileSync(`${kept}.commit-msg.txt`, 'fix: b\n');
    const unrelated = path.join(ctx.dataDir, 'worktrees', 'notes.commit-msg.txt');
    fs.writeFileSync(unrelated, 'not beside a preparer worktree name\n');

    const dryRun = cleanWorktrees(ctx.dataDir, DRY_RUN, OLD);
    expect(dryRun.worktrees.map((w) => path.basename(w.path)).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'notes.commit-msg.txt',
      'octo-repo-13',
      'octo-repo-14',
    ]);
    expect(fs.existsSync(`${dir}.commit-msg.txt`)).toBe(true);

    expect(cleanWorktrees(ctx.dataDir, APPLY, OLD).errors).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(`${dir}.commit-msg.txt`)).toBe(false);
    // A kept worktree keeps its message file; a file with another name is not touched.
    expect(fs.existsSync(`${kept}.commit-msg.txt`)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
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

  it('keeps a worktree with an untracked file when status.showUntrackedFiles=no hides it', () => {
    const dir = addWorktree('octo-repo-20');
    git(ctx.clone, ['config', 'status.showUntrackedFiles', 'no']);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
    expect(git(dir, ['status', '--porcelain'])).toBe('');

    expect(only(dir, APPLY)).toMatchObject({ action: 'kept', clean: false });
    expect(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('new\n');
  });

  it('keeps a worktree holding an ignored file that is not build output, and names it', () => {
    ignoreOnMain('node_modules/\n.env\n*.sqlite\n');
    const dir = addWorktree('octo-repo-21');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'i.js'), '1\n');
    fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=x\n');
    fs.writeFileSync(path.join(dir, 'dev.sqlite'), 'db\n');

    const report = only(dir, APPLY);
    expect(report).toMatchObject({ action: 'kept', clean: true, pushed: true });
    expect(report.reason).toBe('ignored files outside build output: .env, dev.sqlite');
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('TOKEN=x\n');
  });

  it('removes a worktree whose only ignored files are build output, at any depth', () => {
    ignoreOnMain('node_modules/\ndist/\n');
    const dir = addWorktree('octo-repo-22');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'i.js'), '1\n');
    fs.mkdirSync(path.join(dir, 'packages', 'core', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'core', 'dist', 'out.js'), '1\n');

    expect(only(dir, APPLY).action).toBe('removed');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps a worktree holding an ignored regular file that is only named like build output', () => {
    ignoreOnMain('build\n');
    const dir = addWorktree('octo-repo-32');
    fs.writeFileSync(path.join(dir, 'build'), 'a script, not a directory\n');

    const report = only(dir, APPLY);
    expect(report.action).toBe('kept');
    expect(report.reason).toBe('ignored files outside build output: build');
    expect(fs.readFileSync(path.join(dir, 'build'), 'utf8')).toBe('a script, not a directory\n');
  });

  it('removes a worktree whose ignored build is a directory', () => {
    ignoreOnMain('build\n');
    const dir = addWorktree('octo-repo-33');
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'out.js'), '1\n');

    expect(only(dir, APPLY).action).toBe('removed');
  });

  it('keeps a worktree with a leftover sequencer directory', () => {
    const dir = addWorktree('octo-repo-34');
    const gitDir = git(dir, ['rev-parse', '--absolute-git-dir']).trim();
    fs.mkdirSync(path.join(gitDir, 'sequencer'));

    expect(only(dir, APPLY)).toMatchObject({ action: 'kept', reason: 'operation in progress (sequencer)' });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('keeps a worktree with an edit hidden behind skip-worktree', () => {
    const dir = addWorktree('octo-repo-23');
    git(dir, ['update-index', '--skip-worktree', 'a.txt']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hidden edit\n');
    expect(git(dir, ['status', '--porcelain'])).toBe('');

    const report = only(dir, APPLY);
    expect(report).toMatchObject({ action: 'kept', clean: true });
    expect(report.reason).toContain('skip-worktree');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('hidden edit\n');
  });

  it('keeps a worktree with a file flagged assume-unchanged', () => {
    const dir = addWorktree('octo-repo-24');
    git(dir, ['update-index', '--assume-unchanged', 'a.txt']);

    expect(only(dir, APPLY).reason).toContain('assume-unchanged');
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('cleanWorktrees: commits and operations in progress', () => {
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

  it('keeps a worktree whose pushed commit was amended afterwards', () => {
    const dir = addWorktree('octo-repo-25');
    commitFile(dir, 'fix.txt', 'fix\n');
    git(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/prep/fix']);
    git(dir, [...IDENTITY, 'commit', '-q', '--amend', '-m', 'amended']);

    expect(only(dir, APPLY)).toMatchObject({ action: 'kept', clean: true, pushed: false });
    expect(git(dir, ['log', '-1', '--format=%s']).trim()).toBe('amended');
  });

  it('keeps a worktree whose reflog holds a commit no ref reaches (made on a detached HEAD)', () => {
    const dir = addWorktree('octo-repo-26');
    git(dir, ['checkout', '-q', '--detach']);
    commitFile(dir, 'detached.txt', 'only here\n');
    const lost = git(dir, ['rev-parse', 'HEAD']).trim();
    git(dir, ['checkout', '-q', 'overnight/octo-repo-26']);

    const report = only(dir, APPLY);
    expect(report).toMatchObject({ action: 'kept', clean: true, pushed: true });
    expect(report.reason).toBe("1 commit(s) reachable only from this worktree's HEAD reflog");
    expect(git(dir, ['cat-file', '-t', lost]).trim()).toBe('commit');
  });

  it('keeps a worktree stopped in the middle of a rebase', () => {
    const dir = addWorktree('octo-repo-27');
    commitFile(dir, 'fix.txt', 'fix\n');
    git(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/prep/fix']);
    // `--exec false` stops the rebase after the pick, with a clean tree.
    expect(() => git(dir, [...IDENTITY, 'rebase', '-q', '--exec', 'false', 'origin/main'])).toThrow();
    expect(git(dir, ['status', '--porcelain'])).toBe('');

    const report = only(dir, APPLY);
    expect(report.action).toBe('kept');
    expect(report.reason).toBe('operation in progress (rebase-merge)');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('judges the worktree itself when GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE point elsewhere', () => {
    const dirty = addWorktree('octo-repo-28');
    fs.writeFileSync(path.join(dirty, 'new.txt'), 'new\n');
    const clean = addWorktree('octo-repo-29');
    vi.stubEnv('GIT_DIR', path.join(ctx.clone, '.git'));
    vi.stubEnv('GIT_WORK_TREE', ctx.clone);
    vi.stubEnv('GIT_INDEX_FILE', path.join(ctx.clone, '.git', 'index'));

    expect(only(dirty, DRY_RUN)).toMatchObject({ action: 'kept', clean: false });
    expect(only(clean, DRY_RUN)).toMatchObject({ action: 'would-remove', clean: true, pushed: true });
  });
});

describe('cleanWorktrees: programs the worktree names (#2047)', () => {
  it.each([
    ['dry run', DRY_RUN],
    ['apply', APPLY],
  ])('refuses a worktree whose local config names a clean filter, without running it (%s)', (_mode, options) => {
    const dir = addWorktree('octo-repo-40');
    const { program, marker } = filterProgram('clean');
    git(dir, ['config', 'filter.x.clean', program]);
    attributeAll(dir, 'x');
    touchTracked(dir);

    expect(only(dir, options)).toMatchObject({
      action: 'kept',
      clean: null,
      reason: 'repository config names a filter program git would run: filter.x.clean',
    });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
    // The trap was armed: a plain status runs the program and still reports clean.
    expect(git(dir, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('refuses a process filter from an included file and a clean filter in worktree config', () => {
    const dir = addWorktree('octo-repo-41');
    const included = path.join(ctx.tmp, 'included.cfg');
    fs.writeFileSync(included, `[filter "inc"]\n\tprocess = ${filterProgram('process').program}\n`);
    git(dir, ['config', 'include.path', included]);
    git(dir, ['config', 'extensions.worktreeConfig', 'true']);
    git(dir, ['config', '--worktree', 'filter.wt.clean', filterProgram('wt').program]);

    expect(only(dir, APPLY)).toMatchObject({
      action: 'kept',
      reason: 'repository config names a filter program git would run: filter.inc.process, filter.wt.clean',
    });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("still removes a worktree when the filter driver is in the user's own global config", () => {
    const dir = addWorktree('octo-repo-42');
    const { program, marker } = filterProgram('global');
    const globalConfig = path.join(ctx.tmp, 'global.gitconfig');
    fs.writeFileSync(globalConfig, `[filter "users-own"]\n\tclean = ${program}\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    // Not `lfs`: CI runners define `filter.lfs.process` in system config, which would win.
    attributeAll(dir, 'users-own');
    touchTracked(dir);

    expect(only(dir, APPLY)).toMatchObject({ action: 'removed', clean: true, pushed: true });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("refuses a worktree with a submodule, without running the submodule's filter", () => {
    const inner = path.join(ctx.tmp, 'inner');
    git(ctx.tmp, ['init', '-q', '-b', 'main', inner]);
    commitFile(inner, 'a.txt', 'inner\n');
    const dir = addWorktree('octo-repo-43');
    git(dir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub']);
    git(dir, [...IDENTITY, 'commit', '-q', '-m', 'sub']);
    git(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/prep/sub']);
    const sub = path.join(dir, 'sub');
    const { program, marker } = filterProgram('sub');
    git(sub, ['config', 'filter.x.clean', program]);
    attributeAll(sub, 'x');
    touchTracked(sub);

    expect(only(dir, APPLY)).toMatchObject({
      action: 'kept',
      reason: 'contains submodules (git would run status under their config)',
    });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('cleanWorktrees: what it may judge, and failures', () => {
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

    expect(cleanWorktrees(ctx.dataDir, APPLY, OLD)).toEqual({ worktrees: [], errors: [] });
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

  it('reports an error, not success, when git refuses a removal it had planned', () => {
    const dir = addWorktree('octo-repo-10');
    git(ctx.clone, ['worktree', 'lock', dir]);

    const result = cleanWorktrees(ctx.dataDir, APPLY, OLD);

    expect(result.worktrees).toMatchObject([{ path: dir, action: 'kept' }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('git worktree remove refused');
    expect(fs.existsSync(dir)).toBe(true);
    expect(cleanWorktrees(ctx.dataDir, DRY_RUN, OLD).errors).toEqual([]);
  });

  it('keeps a worktree whose check errors, without throwing', () => {
    const dir = addWorktree('octo-repo-11');
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nonexistent\n');

    const result = cleanWorktrees(ctx.dataDir, DRY_RUN, OLD);

    expect(result.worktrees).toMatchObject([{ path: dir, action: 'kept' }]);
    expect(result.worktrees[0].reason).toContain('check failed');
    // A check that crashed is an error too, so the run does not look like a quiet keep.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`${dir}: check failed`);
    expect(cleanWorktrees(ctx.dataDir, APPLY, OLD).errors).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it.skipIf(isRoot)('reports a scan that throws as an error, not as a worktree row', () => {
    const dir = addWorktree('octo-repo-13');
    const root = path.join(ctx.dataDir, 'worktrees');
    fs.chmodSync(root, 0o000);

    const result = cleanWorktrees(ctx.dataDir, APPLY, OLD);
    fs.chmodSync(root, 0o700);

    expect(result.worktrees).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('could not scan');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('is empty without a worktrees directory', () => {
    expect(cleanWorktrees(path.join(ctx.tmp, 'absent'), APPLY, OLD)).toEqual({ worktrees: [], errors: [] });
  });
});

describe('runCleanup', () => {
  // HOME is a per-file temp dir (test-lib/isolate-home.ts); resolveDataDir throws if it ever is the real one.
  afterEach(() => {
    fs.rmSync(resolveDataDir(), { recursive: true, force: true });
  });

  it('reports without deleting by default', () => {
    writeOldCopies();

    const out = runCleanup(DRY_RUN);

    expect(out).toMatchObject({ applied: false, worktrees: [], errors: [] });
    expect(out.rejectedCopies).toHaveLength(1);
    expect(fs.readdirSync(resolveDataDir())).toHaveLength(7);
  });

  it('deletes with apply', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeOldCopies();

    const out = runCleanup(APPLY);

    expect(out).toMatchObject({ applied: true, errors: [] });
    expect(out.rejectedCopies).toHaveLength(1);
    expect(fs.readdirSync(resolveDataDir())).toHaveLength(6);
  });

  it('refuses --apply during an unattended run, and still allows the dry run', () => {
    writeOldCopies();
    vi.stubEnv('OSS_AUTOPILOT_UNATTENDED', '1');

    expect(() => runCleanup(APPLY)).toThrow(/Refusing to remove worktrees and rejected state copies/);
    expect(fs.readdirSync(resolveDataDir())).toHaveLength(7);
    expect(runCleanup(DRY_RUN).rejectedCopies).toHaveLength(1);
  });

  it('lists the failure when one removal fails and another succeeds', () => {
    const root = path.join(resolveDataDir(), 'worktrees');
    fs.mkdirSync(root, { recursive: true });
    const locked = addWorktree('octo-repo-30', root);
    const free = addWorktree('octo-repo-31', root);
    git(ctx.clone, ['worktree', 'lock', locked]);
    backdate(locked);
    backdate(free);

    const out = runCleanup(APPLY);

    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain(locked);
    expect(fs.existsSync(locked)).toBe(true);
    expect(fs.existsSync(free)).toBe(false);
  });

  it('is empty when the data directory does not exist', () => {
    expect(runCleanup(APPLY)).toEqual({ applied: true, worktrees: [], rejectedCopies: [], errors: [] });
  });
});

describe('printCleanup', () => {
  const worktree = { ageDays: 20, clean: true, pushed: true };

  it('prints the plan, the kept items with reasons, the errors, and the --apply hint', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    printCleanup({
      applied: false,
      worktrees: [
        { ...worktree, path: '/d/worktrees/a-1', action: 'would-remove', reason: 'clean, pushed, idle 20 days' },
        { ...worktree, path: '/d/worktrees/b-2', action: 'kept', reason: 'uncommitted or untracked files' },
      ],
      rejectedCopies: ['/d/state.json.rejected-1'],
      errors: ['could not scan /d/worktrees: EACCES'],
    });

    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Would remove 1 worktree(s), 1 rejected state copy(ies)');
    expect(out).toContain('/d/worktrees/a-1: clean, pushed, idle 20 days');
    expect(out).toContain('Kept 1 worktree(s):');
    expect(out).toContain('/d/worktrees/b-2: uncommitted or untracked files');
    expect(out).toContain('1 error(s):');
    expect(out).toContain('could not scan /d/worktrees: EACCES');
    expect(out).toContain('Re-run with --apply to remove.');
  });

  it('prints what was removed, with no hint', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    printCleanup({ applied: true, worktrees: [], rejectedCopies: [], errors: [] });

    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toBe('Removed 0 worktree(s), 0 rejected state copy(ies)');
  });
});
