/**
 * Retention for the rejected state copies under `~/.oss-autopilot` (#1956).
 *
 * `state.json.rejected-<ms>` (state-persistence.ts) and
 * `state-cache.json.rejected-<ms>` (gist-state-store.ts) preserve a state
 * file that failed validation so the user can recover it by hand. Nothing
 * reads them back, and one bad night can write dozens.
 *
 * Kept: the newest {@link REJECTED_KEEP} of each kind, and every copy younger
 * than {@link REJECTED_MIN_AGE_DAYS}. Only direct children of the data
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

const REJECTED_PATTERN = /^(state|state-cache)\.json\.rejected-(\d+)$/;

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

/**
 * Rejected copies in `dataDir` that retention no longer covers, in no order.
 * Read-only. Throws on an unreadable directory; a missing one is empty.
 */
export function staleRejectedCopies(dataDir: string, now: number = Date.now()): string[] {
  if (!fs.existsSync(dataDir)) return [];
  const copies: RejectedCopy[] = [];
  for (const name of fs.readdirSync(dataDir)) {
    const copy = readRejectedCopy(dataDir, name);
    if (copy) copies.push(copy);
  }
  const cutoff = now - REJECTED_MIN_AGE_DAYS * DAY_MS;
  // ponytail: O(n^2) rank instead of a sort; n is a handful of files.
  const newerOfKind = (copy: RejectedCopy) =>
    copies.filter((other) => other.kind === copy.kind && other.lastTouchedMs > copy.lastTouchedMs).length;
  return copies
    .filter((copy) => copy.lastTouchedMs < cutoff && newerOfKind(copy) >= REJECTED_KEEP)
    .map((copy) => copy.file);
}

function listStale(dataDir: string, now: number): string[] {
  try {
    return staleRejectedCopies(dataDir, now);
  } catch (err) {
    warn(MODULE, `Could not prune rejected state copies in ${dataDir}: ${errorMessage(err)}`);
    return [];
  }
}

function didRemove(file: string): boolean {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    warn(MODULE, `Could not delete rejected state copy ${file}: ${errorMessage(err)}`);
    return false;
  }
  return true;
}

/**
 * Delete what {@link staleRejectedCopies} lists and return the paths removed.
 * Never throws: it runs beside state loading and the overnight run, and a
 * failed prune must not fail either. Failures are logged at warn.
 */
export function pruneRejectedCopies(dataDir: string, now: number = Date.now()): string[] {
  return listStale(dataDir, now).filter((file) => didRemove(file));
}
