/**
 * `cleanup` (#1956): report, and with `--apply` remove, stale data under
 * `~/.oss-autopilot`: overnight worktrees and rejected state copies.
 *
 * Overnight worktrees (`worktrees/<owner>-<repo>-<n>`) are created by the
 * overnight-preparer agent, not by this CLI, and nothing recorded their
 * removal. A worktree is removed only when every check below passes; a check
 * that fails or errors keeps it, with the reason in the output:
 *
 * 1. it is a direct child of `worktrees/`, a real directory (not a symlink)
 *    with a name the preparer creates, and it resolves inside the data dir;
 * 2. it is the root of a linked Git worktree (`.git` is a file);
 * 3. `git status --porcelain` is empty (no modified or untracked files);
 * 4. HEAD is contained in a remote-tracking ref, so no commit lives only here;
 * 5. nothing touched it for {@link WORKTREE_MIN_AGE_DAYS} days.
 *
 * Removal is `git worktree remove` without `--force`, which re-checks 3
 * itself and leaves the branch in the clone. No network access, no `rm`.
 * ponytail: PR merged/closed is not checked (that needs the network); a
 * clean, pushed, idle worktree of an open PR is removed too, and the
 * preparer recreates it on demand.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../core/errors.js';
import { resolveDataDir } from '../core/paths.js';
import { DAY_MS, isInside, pruneRejectedCopies, staleRejectedCopies } from '../core/stale-data.js';
import { git } from './overnight-push-prep.js';

export const WORKTREE_MIN_AGE_DAYS = 14;

const WORKTREE_NAME = /^[\w.-]+-\d+$/;
// Read-only runs take no index lock, and `status` must not start a
// `core.fsmonitor` program the repo's config names.
const SAFE_GIT = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

export type WorktreeAction = 'removed' | 'would-remove' | 'kept';

export interface WorktreeReport {
  path: string;
  /** Whole days since the directory or its index last changed; null when unreadable. */
  ageDays: number | null;
  /** null: the check did not run or errored. */
  clean: boolean | null;
  pushed: boolean | null;
  action: WorktreeAction;
  /** Why it was kept, or why it is safe to remove. */
  reason: string;
}

export interface CleanupOutput {
  /** False: a dry run, nothing was deleted. */
  applied: boolean;
  worktrees: WorktreeReport[];
  /** Rejected state copies past retention: removed when `applied`, else listed. */
  rejectedCopies: string[];
}

export interface CleanupOptions {
  apply: boolean;
}

function gitOut(worktree: string, args: string[]): string {
  return git(worktree, [...SAFE_GIT, ...args]).trim();
}

function kept(dir: string, reason: string): WorktreeReport {
  return { path: dir, ageDays: null, clean: null, pushed: null, action: 'kept', reason };
}

/** Reason the path is not a worktree this command may judge, or null. */
function refusal(dataDir: string, dir: string): string | null {
  if (!WORKTREE_NAME.test(path.basename(dir))) return 'name is not one the overnight preparer creates';
  if (!fs.lstatSync(dir).isDirectory()) return 'not a real directory (symlink or file)';
  if (!isInside(dataDir, dir)) return 'resolves outside the data directory';
  const dotGit = path.join(dir, '.git');
  if (!fs.existsSync(dotGit) || !fs.lstatSync(dotGit).isFile()) return 'not a linked git worktree';
  const toplevel = gitOut(dir, ['rev-parse', '--show-toplevel']);
  if (fs.realpathSync(toplevel) !== fs.realpathSync(dir)) return 'not the root of its git worktree';
  return null;
}

/** Whole days since the directory itself or the worktree's index last changed. */
function idleDays(dir: string, now: number): number {
  const index = path.join(gitOut(dir, ['rev-parse', '--absolute-git-dir']), 'index');
  const dirMtime = fs.statSync(dir).mtimeMs;
  const lastTouched = fs.existsSync(index) ? Math.max(dirMtime, fs.statSync(index).mtimeMs) : dirMtime;
  return Math.max(0, Math.floor((now - lastTouched) / DAY_MS));
}

function judge(dataDir: string, dir: string, now: number): WorktreeReport {
  const refused = refusal(dataDir, dir);
  if (refused) return kept(dir, refused);
  const ageDays = idleDays(dir, now);
  const isClean = gitOut(dir, ['status', '--porcelain']) === '';
  const isPushed = gitOut(dir, ['for-each-ref', '--count=1', '--contains', 'HEAD', 'refs/remotes']) !== '';
  const report = { ...kept(dir, ''), ageDays, clean: isClean, pushed: isPushed };
  if (!isClean) return { ...report, reason: 'uncommitted or untracked files' };
  if (!isPushed) return { ...report, reason: 'HEAD is not on any remote-tracking branch (unpushed work)' };
  if (ageDays < WORKTREE_MIN_AGE_DAYS)
    return { ...report, reason: `touched ${ageDays} day(s) ago (kept for ${WORKTREE_MIN_AGE_DAYS})` };
  return { ...report, action: 'would-remove', reason: `clean, pushed, idle ${ageDays} days` };
}

function inspect(dataDir: string, dir: string, now: number): WorktreeReport {
  try {
    return judge(dataDir, dir, now);
  } catch (err) {
    return kept(dir, `check failed: ${errorMessage(err)}`);
  }
}

function remove(report: WorktreeReport): WorktreeReport {
  try {
    git(report.path, ['worktree', 'remove', report.path]);
  } catch (err) {
    return { ...report, action: 'kept', reason: `git worktree remove refused: ${errorMessage(err)}` };
  }
  return { ...report, action: 'removed' };
}

function scan(dataDir: string, root: string, options: CleanupOptions, now: number): WorktreeReport[] {
  // A symlinked `worktrees` would have every child resolve outside the data dir.
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) return [];
  const reports = fs.readdirSync(root).map((name) => inspect(dataDir, path.join(root, name), now));
  if (!options.apply) return reports;
  return reports.map((r) => (r.action === 'would-remove' ? remove(r) : r));
}

/** Every direct child of `<dataDir>/worktrees`, judged; removed only with `apply`. Never throws. */
export function cleanWorktrees(dataDir: string, options: CleanupOptions, now: number = Date.now()): WorktreeReport[] {
  const root = path.join(dataDir, 'worktrees');
  try {
    return scan(dataDir, root, options, now);
  } catch (err) {
    return [kept(root, errorMessage(err))];
  }
}

export function runCleanup(options: CleanupOptions): CleanupOutput {
  const dataDir = resolveDataDir();
  const rejectedCopies = options.apply ? pruneRejectedCopies(dataDir) : staleRejectedCopies(dataDir);
  return { applied: options.apply, worktrees: cleanWorktrees(dataDir, options), rejectedCopies };
}

export function printCleanup(data: CleanupOutput): void {
  const verb = data.applied ? 'Removed' : 'Would remove';
  const going = data.worktrees.filter((w) => w.action !== 'kept');
  const kept = data.worktrees.filter((w) => w.action === 'kept');
  console.log(`${verb} ${going.length} worktree(s), ${data.rejectedCopies.length} rejected state copy(ies)`);
  for (const w of going) console.log(`  ${w.path}: ${w.reason}`);
  for (const file of data.rejectedCopies) console.log(`  ${file}`);
  if (kept.length > 0) console.log(`Kept ${kept.length} worktree(s):`);
  for (const w of kept) console.log(`  ${w.path}: ${w.reason}`);
  if (!data.applied && going.length + data.rejectedCopies.length > 0) console.log('Re-run with --apply to remove.');
}
