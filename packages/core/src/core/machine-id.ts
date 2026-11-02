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

/** Read the stored id, or null when the file is missing or empty. Throws on an unreadable file. */
function readStoredMachineId(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const stored = fs.readFileSync(filePath, 'utf8').trim();
  return stored.length > 0 ? stored : null;
}

function isFileExistsError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST';
}

/**
 * The stored id, or a fresh UUID written to `filePath` (private to the user).
 * Throws when the file is unusable.
 *
 * The create is exclusive (`wx`): two sessions starting on a fresh machine at
 * once would otherwise both see no file and each write its own id, and the
 * loser's claims would carry an id that no longer exists on disk. When the
 * file appeared between the read and the write, the id it holds wins.
 */
function readOrCreateMachineId(filePath: string): string {
  const stored = readStoredMachineId(filePath);
  if (stored !== null) return stored;
  const created = randomUUID();
  try {
    fs.writeFileSync(filePath, `${created}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (!isFileExistsError(err)) throw err;
    const concurrent = readStoredMachineId(filePath);
    if (concurrent !== null) {
      debug(MODULE, `Machine id file ${filePath} was created by another process; using its id`);
      return concurrent;
    }
    // The file exists but holds no id (an empty file): replace its contents.
    fs.writeFileSync(filePath, `${created}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  debug(MODULE, `Created machine id file ${filePath}`);
  return created;
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
