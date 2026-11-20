/**
 * `cleanup` (#1956): report, and with `--apply` remove, stale data under
 * `~/.oss-autopilot`: overnight worktrees and rejected state copies.
 *
 * Overnight worktrees (`worktrees/<owner>-<repo>-<n>`) are created by the
 * overnight-preparer agent, not by this CLI, and nothing recorded their
 * removal. A worktree is removed only when every check below passes, in this
 * order; a check that fails or errors keeps it, with the reason in the output:
 *
 * 1. it is a direct child of `worktrees/`, a real directory (not a symlink)
 *    with a name the preparer creates, and it resolves inside the data dir;
 * 2. it is the root of a linked Git worktree (`.git` is a file);
 * 3. `git status --porcelain --untracked-files=all` is empty: no modified and
 *    no untracked files, whatever `status.showUntrackedFiles` says;
 * 4. HEAD is contained in a remote-tracking ref, so no commit lives only here;
 * 5. no rebase, merge, cherry-pick (a leftover `sequencer` included), revert
 *    or bisect is in progress;
 * 6. every ignored file sits under a build-output directory
 *    ({@link BUILD_OUTPUT}); an ignored `.env`, or an ignored file that is
 *    merely named `build`, keeps the worktree;
 * 7. no file is flagged skip-worktree or assume-unchanged, which would hide
 *    an edit from 3;
 * 8. every commit in this worktree's HEAD reflog is reachable from a branch,
 *    a remote-tracking ref or a tag;
 * 9. nothing touched it for {@link WORKTREE_MIN_AGE_DAYS} days.
 *
 * Each worktree is judged and, with `--apply`, removed at once, so nothing
 * happens to it between the two. Removal is `git worktree remove` without
 * `--force`, which re-checks 3 itself and leaves the branch in the clone. No
 * network access, no `rm`. `--apply` refuses during an unattended run. A
 * check that throws, and a removal Git refuses, are listed in `errors`.
 *
 * Two deliberate differences from the issue text:
 * - PR merged/closed is not checked (that needs the network). A clean,
 *   pushed, idle worktree of a still-open PR is removed too; the preparer
 *   recreates it on demand.
 * - `doctor` reports counts only, not sizes or ages; the detail is here.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { assertAttended, errorMessage } from '../core/errors.js';
import { resolveDataDir } from '../core/paths.js';
import { DAY_MS, WORKTREE_NAME, isInside, pruneRejectedCopies, staleRejectedCopies } from '../core/stale-data.js';
import type { PruneResult } from '../core/stale-data.js';
import { git } from './overnight-push-prep.js';

export const WORKTREE_MIN_AGE_DAYS = 14;

/** Ignored paths under a directory with one of these names are rebuildable, not work. */
export const BUILD_OUTPUT = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', '.venv']);

// Every call, the removal included: no index lock for a read, no
// `core.fsmonitor` program the repo's config names, and untracked files
// always count (`worktree remove` runs its own status and would otherwise
// honour `status.showUntrackedFiles=no` and delete them).
const SAFE_GIT = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'status.showUntrackedFiles=all'];
const IN_PROGRESS = [
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'sequencer',
];
// Deleting a large `node_modules` on a loaded disk outlasts the runner's 60 s.
const REMOVE_TIMEOUT_MS = 10 * 60_000;
const MAX_NAMED_PATHS = 3;

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

export interface WorktreeScan {
  worktrees: WorktreeReport[];
  /** What went wrong: a scan that threw, a removal that was planned and then refused. */
  errors: string[];
}

export interface CleanupOutput extends WorktreeScan {
  /** False: a dry run, nothing was deleted. */
  applied: boolean;
  /** Rejected state copies past retention: removed when `applied`, else listed. */
  rejectedCopies: string[];
}

export interface CleanupOptions {
  apply: boolean;
}

const COMMIT_MESSAGE_SUFFIX = '.commit-msg.txt';

function gitOut(worktree: string, args: string[]): string {
  return git(worktree, [...SAFE_GIT, ...args]).trim();
}

function gitDirOf(dir: string): string {
  return gitOut(dir, ['rev-parse', '--absolute-git-dir']);
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
  const index = path.join(gitDirOf(dir), 'index');
  const dirMtime = fs.statSync(dir).mtimeMs;
  const lastTouched = fs.existsSync(index) ? Math.max(dirMtime, fs.statSync(index).mtimeMs) : dirMtime;
  return Math.max(0, Math.floor((now - lastTouched) / DAY_MS));
}

function operationInProgress(dir: string): string | null {
  const gitDir = gitDirOf(dir);
  const found = IN_PROGRESS.filter((name) => fs.existsSync(path.join(gitDir, name)));
  return found.length > 0 ? `operation in progress (${found.join(', ')})` : null;
}

/** Directory segments only: an ignored regular file named `build` is not build output. */
function isBuildOutput(ignoredPath: string): boolean {
  // A directory entry ends in `/`, so its own name is not the last segment.
  const directories = ignoredPath.split('/').slice(0, -1);
  return directories.some((segment) => BUILD_OUTPUT.has(segment));
}

function ignoredOutsideBuildOutput(dir: string): string | null {
  // `matching` lists an ignored directory once instead of every file in it.
  const status = gitOut(dir, ['status', '--porcelain', '--ignored=matching', '--untracked-files=normal']);
  const ignored = status.split('\n').filter((line) => line.startsWith('!! '));
  const precious = ignored.map((line) => line.slice(3)).filter((ignoredPath) => !isBuildOutput(ignoredPath));
  if (precious.length === 0) return null;
  const more = precious.length > MAX_NAMED_PATHS ? `, and ${precious.length - MAX_NAMED_PATHS} more` : '';
  return `ignored files outside build output: ${precious.slice(0, MAX_NAMED_PATHS).join(', ')}${more}`;
}

function hiddenEdits(dir: string): string | null {
  // `ls-files -v` tags: `S` skip-worktree, a lowercase letter assume-unchanged.
  const isFlagged = /^[a-zS] /m.test(gitOut(dir, ['ls-files', '-v']));
  return isFlagged ? 'files flagged skip-worktree or assume-unchanged (edits to them are invisible)' : null;
}

function reflogOnlyCommits(dir: string): string | null {
  // This worktree's own HEAD reflog; `rev-list -g` cannot take `--not`.
  // ponytail: the commits go on the command line; a reflog too long for that
  // makes the spawn fail, and a failed check keeps the worktree.
  const reflog = gitOut(dir, ['reflog', 'show', '--format=%H', 'HEAD']);
  const commits = new Set(reflog.split('\n').filter((sha) => sha !== ''));
  if (commits.size === 0) return null;
  const lost = gitOut(dir, ['rev-list', ...commits, '--not', '--branches', '--remotes', '--tags']);
  if (lost === '') return null;
  return `${lost.split('\n').length} commit(s) reachable only from this worktree's HEAD reflog`;
}

const DEEP_CHECKS = [operationInProgress, ignoredOutsideBuildOutput, hiddenEdits, reflogOnlyCommits];

/** Why a clean-or-not, pushed-or-not worktree of `ageDays` is kept, or null when it may go. */
function keepReason(dir: string, report: WorktreeReport, ageDays: number): string | null {
  if (!report.clean) return 'uncommitted or untracked files';
  if (!report.pushed) return 'HEAD is not on any remote-tracking branch (unpushed work)';
  for (const check of DEEP_CHECKS) {
    const reason = check(dir);
    if (reason) return reason;
  }
  if (ageDays < WORKTREE_MIN_AGE_DAYS) return `touched ${ageDays} day(s) ago (kept for ${WORKTREE_MIN_AGE_DAYS})`;
  return null;
}

function judge(dataDir: string, dir: string, now: number): WorktreeReport {
  const refused = refusal(dataDir, dir);
  if (refused) return kept(dir, refused);
  const ageDays = idleDays(dir, now);
  const isClean = gitOut(dir, ['status', '--porcelain', '--untracked-files=all']) === '';
  const isPushed = gitOut(dir, ['for-each-ref', '--count=1', '--contains', 'HEAD', 'refs/remotes']) !== '';
  const report = { ...kept(dir, ''), ageDays, clean: isClean, pushed: isPushed };
  const reason = keepReason(dir, report, ageDays);
  if (reason) return { ...report, reason };
  return { ...report, action: 'would-remove', reason: `clean, pushed, idle ${ageDays} days` };
}

/** A report plus, when a check threw or a removal failed, the error to surface. */
interface Outcome {
  report: WorktreeReport;
  error?: string;
}

function inspect(dataDir: string, dir: string, now: number): Outcome {
  try {
    return { report: judge(dataDir, dir, now) };
  } catch (err) {
    const reason = `check failed: ${errorMessage(err)}`;
    return { report: kept(dir, reason), error: `${dir}: ${reason}` };
  }
}

function removalFailure(err: unknown): string {
  if ((err as { code?: unknown })?.code === 'ETIMEDOUT')
    return `git worktree remove was killed after ${REMOVE_TIMEOUT_MS / 1000}s; the worktree may be partly removed`;
  return `git worktree remove refused: ${errorMessage(err)}`;
}

/** Judged removable and then not removed: an error, not a keep. */
function remove(report: WorktreeReport): Outcome {
  try {
    git(report.path, [...SAFE_GIT, 'worktree', 'remove', report.path], REMOVE_TIMEOUT_MS);
  } catch (err) {
    const reason = removalFailure(err);
    return { report: { ...report, action: 'kept', reason }, error: `${report.path}: ${reason}` };
  }
  // The preparer's commit message file sits beside the worktree and goes with it.
  const message = report.path + COMMIT_MESSAGE_SUFFIX;
  if (isRegularFile(message)) fs.rmSync(message);
  return { report: { ...report, action: 'removed' } };
}

function isRegularFile(file: string): boolean {
  return fs.existsSync(file) && fs.lstatSync(file).isFile();
}

/** `<worktree name>.commit-msg.txt` (agents/overnight-preparer.md): not a worktree, so not judged or reported. */
function isCommitMessageFile(root: string, name: string): boolean {
  if (!name.endsWith(COMMIT_MESSAGE_SUFFIX)) return false;
  return WORKTREE_NAME.test(name.slice(0, -COMMIT_MESSAGE_SUFFIX.length)) && isRegularFile(path.join(root, name));
}

/** Judge one worktree and, with `apply`, remove it straight away if it may go. */
function judgeAndRemove(dataDir: string, dir: string, options: CleanupOptions, now: number): Outcome {
  const outcome = inspect(dataDir, dir, now);
  return options.apply && outcome.report.action === 'would-remove' ? remove(outcome.report) : outcome;
}

function scan(dataDir: string, root: string, options: CleanupOptions, now: number): WorktreeScan {
  // A symlinked `worktrees` would have every child resolve outside the data dir.
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) return { worktrees: [], errors: [] };
  const names = fs.readdirSync(root).filter((name) => !isCommitMessageFile(root, name));
  const outcomes = names.map((name) => judgeAndRemove(dataDir, path.join(root, name), options, now));
  const errors = outcomes.flatMap((outcome) => outcome.error ?? []);
  return { worktrees: outcomes.map((outcome) => outcome.report), errors };
}

/** Every direct child of `<dataDir>/worktrees`, judged; removed only with `apply`. Never throws. */
export function cleanWorktrees(dataDir: string, options: CleanupOptions, now: number = Date.now()): WorktreeScan {
  const root = path.join(dataDir, 'worktrees');
  try {
    return scan(dataDir, root, options, now);
  } catch (err) {
    return { worktrees: [], errors: [`could not scan ${root}: ${errorMessage(err)}`] };
  }
}

function listRejectedCopies(dataDir: string): PruneResult {
  try {
    return { removed: staleRejectedCopies(dataDir), errors: [] };
  } catch (err) {
    return { removed: [], errors: [`could not list rejected state copies in ${dataDir}: ${errorMessage(err)}`] };
  }
}

/**
 * `errors` is non-empty when anything went wrong, in a dry run too; the CLI
 * action turns that into a non-zero exit code, since a scheduler or a script
 * sees only that and a partial `--apply` is not success.
 */
export function runCleanup(options: CleanupOptions): CleanupOutput {
  if (options.apply) assertAttended('remove worktrees and rejected state copies');
  const dataDir = resolveDataDir();
  const rejected = options.apply ? pruneRejectedCopies(dataDir) : listRejectedCopies(dataDir);
  const scanned = cleanWorktrees(dataDir, options);
  const errors = [...scanned.errors, ...rejected.errors];
  return { applied: options.apply, worktrees: scanned.worktrees, rejectedCopies: rejected.removed, errors };
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
  if (data.errors.length > 0) console.log(`${data.errors.length} error(s):`);
  for (const error of data.errors) console.log(`  ${error}`);
  if (!data.applied && going.length + data.rejectedCopies.length > 0) console.log('Re-run with --apply to remove.');
}
