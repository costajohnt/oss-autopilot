/**
 * Stable machine identity (#1856): a random UUID written once to
 * `~/.oss-autopilot/machine-id` and read back on every later need.
 *
 * Work claims record the id next to a `worktree` path so two claims are
 * compared as the same checkout only when they are on the same machine. A
 * hostname cannot do that: it changes with the network (`air.local`) or a
 * rename (`air` to `air-2`), and two machines can share one. The file lives
 * outside `state.json`, so the Gist never carries it and no machine inherits
 * another's id. A read or write failure yields no id (with a debug line);
 * claims then fall back to the hostname rule.
 */

import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getMachineIdPath } from './paths.js';
import { debug } from './logger.js';

const MODULE = 'machine-id';

/**
 * How long to wait for a concurrent creator to fill the file it has just
 * published. Its link lands with the id already inside, so an empty file is
 * almost always a crash leftover; the retries only cover a writer that is
 * still between its own create and its content write.
 */
const EMPTY_FILE_RETRIES = 5;
const EMPTY_FILE_RETRY_MS = 20;

/** Read the stored id, or null when the file is missing or empty. Throws on an unreadable file. */
function readStoredMachineId(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const stored = fs.readFileSync(filePath, 'utf8').trim();
  return stored.length > 0 ? stored : null;
}

/** Synchronous sleep; the whole id lookup is synchronous and runs once per process. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The stored id, re-reading a few times while the file is present but empty. */
function readStoredMachineIdWithRetry(filePath: string): string | null {
  let stored = readStoredMachineId(filePath);
  for (let attempt = 0; stored === null && attempt < EMPTY_FILE_RETRIES; attempt++) {
    sleepSync(EMPTY_FILE_RETRY_MS);
    stored = readStoredMachineId(filePath);
  }
  return stored;
}

function isFileExistsError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST';
}

/**
 * Publish a tmp file holding a fresh UUID as `filePath`. Returns true when it
 * created the file, false when another process already had. Throws on any
 * other failure.
 *
 * The create is a hard link of the already-written tmp file: an exclusive
 * `writeFileSync` (`wx`) would create the name before writing the id, and a
 * second session reading in that window would see an empty file and
 * overwrite it with an id of its own. The link lands with the content in
 * place and still fails with EEXIST when the name is taken.
 */
function didCreateMachineIdFile(tmpPath: string, filePath: string): boolean {
  try {
    fs.linkSync(tmpPath, filePath);
    return true;
  } catch (err) {
    if (!isFileExistsError(err)) throw err;
    return false;
  }
}

/**
 * Publish the tmp file as `filePath` and return the id the file holds
 * afterwards. The id another process published first wins; an empty file
 * that stays empty is a crash leftover and is replaced in one rename. The
 * id is always re-read from disk, never taken from what this process wrote.
 */
function publishMachineId(tmpPath: string, filePath: string): string {
  if (didCreateMachineIdFile(tmpPath, filePath)) {
    debug(MODULE, `Created machine id file ${filePath}`);
  } else {
    const concurrent = readStoredMachineIdWithRetry(filePath);
    if (concurrent !== null) {
      debug(MODULE, `Machine id file ${filePath} was created by another process; using its id`);
      return concurrent;
    }
    fs.renameSync(tmpPath, filePath);
    debug(MODULE, `Replaced empty machine id file ${filePath}`);
  }
  const published = readStoredMachineId(filePath);
  if (published === null) throw new Error(`Machine id file ${filePath} is empty right after it was written`);
  return published;
}

/**
 * The stored id, or a fresh UUID written to `filePath` (private to the user).
 * Throws when the file is unusable.
 *
 * Two sessions starting on a fresh machine at once would otherwise both see
 * no file and each write its own id, and the loser's claims would carry an
 * id that no longer exists on disk. So the id is written to a per-process
 * tmp file first and the file is created atomically with its content; the
 * tmp file is removed whichever way the publish ends.
 */
function readOrCreateMachineId(filePath: string): string {
  const stored = readStoredMachineId(filePath);
  if (stored !== null) return stored;
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, `${randomUUID()}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    return publishMachineId(tmpPath, filePath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

/**
 * This machine's id, creating `~/.oss-autopilot/machine-id` on first need.
 * Returns undefined when the file can neither be read nor written; callers
 * treat that as "unknown machine" rather than failing.
 */
export function getMachineId(): string | undefined {
  try {
    return readOrCreateMachineId(getMachineIdPath());
  } catch (err) {
    debug(MODULE, 'Could not read or create the machine id file; claims will carry no machineId', err);
    return undefined;
  }
}
