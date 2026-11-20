/**
 * Retention for the rejected state copies under `~/.oss-autopilot` (#1956).
 *
 * `state.json.rejected-<ms>` (state-persistence.ts),
 * `state-cache.json.rejected-<ms>` (gist-state-store.ts) and
 * `local-config.json.rejected-<ms>` (local-config.ts) preserve a file that
 * failed validation so the user can recover it by hand. Nothing
 * reads them back, and one bad night can write dozens.
 *
 * Kept: the newest {@link REJECTED_KEEP} of each kind, the oldest of each kind
 * (the first copy of an incident is the one most likely to hold the state
 * from before it), and every copy younger than {@link REJECTED_MIN_AGE_DAYS}.
 * Only direct children of the data
 * directory whose names match what the code itself writes are considered, and
 * only regular files: a symlink or a directory with a matching name is left
 * alone.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from './errors.js';
import { warn } from './logger.js';

const MODULE = 'stale-data';

export const REJECTED_KEEP = 5;
export const REJECTED_MIN_AGE_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Directory names the overnight preparer gives its worktrees: `<owner>-<repo>-<n>`, `...-issue-<n>`. */
export const WORKTREE_NAME = /^[\w.-]+-\d+$/;

const REJECTED_PATTERN = /^(state|state-cache|local-config)\.json\.rejected-(\d+)$/;

/** True when `child`, with every symlink resolved, sits strictly inside `parent`. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

interface RejectedCopy {
  file: string;
  kind: string;
  /** Newest of the timestamp in the name and the file's mtime. */
  lastTouchedMs: number;
}

function readRejectedCopy(dataDir: string, name: string): RejectedCopy | null {
  const match = REJECTED_PATTERN.exec(name);
  if (!match) return null;
  const file = path.join(dataDir, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || !isInside(dataDir, file)) return null;
  return { file, kind: match[1], lastTouchedMs: Math.max(Number(match[2]), stat.mtimeMs) };
}

/** One unreadable entry (a file that vanished mid-scan) is skipped, not fatal. */
function tryReadRejectedCopy(dataDir: string, name: string): RejectedCopy | null {
  try {
    return readRejectedCopy(dataDir, name);
  } catch (err) {
    warn(MODULE, `Skipping ${name} in ${dataDir}: ${errorMessage(err)}`);
    return null;
  }
}

/** A total order, so copies with equal timestamps still rank: by time, then by name. */
function isNewer(a: RejectedCopy, b: RejectedCopy): boolean {
  if (a.kind !== b.kind || a.lastTouchedMs < b.lastTouchedMs) return false;
  return a.lastTouchedMs > b.lastTouchedMs || a.file.localeCompare(b.file) > 0;
}

/**
 * Rejected copies in `dataDir` that retention no longer covers, in no order.
 * Read-only. Throws on an unreadable directory; a missing one is empty.
 */
export function staleRejectedCopies(dataDir: string, now: number = Date.now()): string[] {
  if (!fs.existsSync(dataDir)) return [];
  const copies: RejectedCopy[] = [];
  for (const name of fs.readdirSync(dataDir)) {
    const copy = tryReadRejectedCopy(dataDir, name);
    if (copy) copies.push(copy);
  }
  const cutoff = now - REJECTED_MIN_AGE_DAYS * DAY_MS;
  // ponytail: O(n^2) rank instead of a sort; n is a handful of files.
  const isCovered = (copy: RejectedCopy) =>
    copy.lastTouchedMs >= cutoff ||
    copies.filter((other) => isNewer(other, copy)).length < REJECTED_KEEP ||
    copies.every((other) => !isNewer(copy, other));
  return copies.filter((copy) => !isCovered(copy)).map((copy) => copy.file);
}

export interface PruneResult {
  /** Paths deleted (or, from a dry run, the paths that would be). */
  removed: string[];
  errors: string[];
}

function didRemove(file: string, errors: string[]): boolean {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    errors.push(`Could not delete rejected state copy ${file}: ${errorMessage(err)}`);
    return false;
  }
  return true;
}

function listStale(dataDir: string, now: number, errors: string[]): string[] {
  try {
    return staleRejectedCopies(dataDir, now);
  } catch (err) {
    errors.push(`Could not prune rejected state copies in ${dataDir}: ${errorMessage(err)}`);
    return [];
  }
}

/**
 * Delete what {@link staleRejectedCopies} lists. Never throws: it runs beside
 * state loading and the overnight run, and a failed prune must not fail
 * either. Every failure, and every prune that deleted something, is logged at
 * warn, so an automatic delete always leaves a trace.
 */
export function pruneRejectedCopies(dataDir: string, now: number = Date.now()): PruneResult {
  const errors: string[] = [];
  const removed = listStale(dataDir, now, errors).filter((file) => didRemove(file, errors));
  for (const error of errors) warn(MODULE, error);
  if (removed.length > 0) {
    const names = removed.map((file) => path.basename(file)).join(', ');
    warn(
      MODULE,
      `Pruned ${removed.length} rejected state copy(ies) from ${dataDir}, keeping the newest ${REJECTED_KEEP} and the oldest of each kind and all younger than ${REJECTED_MIN_AGE_DAYS} days: ${names}`,
    );
  }
  return { removed, errors };
}
