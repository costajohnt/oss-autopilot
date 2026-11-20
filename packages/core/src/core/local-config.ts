/**
 * Per-machine settings (#1950): `~/.oss-autopilot/local-config.json`.
 *
 * The synced state document is shared by every machine through the Gist, so a
 * filesystem path stored there is overwritten by whichever machine wrote
 * last. The curated list path, the skipped-issues path and the local repo
 * cache live here instead. Like `machine-id`, the file is outside
 * `state.json`, so no sync path ever carries it.
 *
 * Transition: the synced keys (`config.issueListPath`,
 * `config.skippedIssuesPath`, `localRepoCache`) stay in the schema and are
 * still read as a fallback, so a machine that has not set a local value
 * behaves as before. New clients write path settings here only; a synced
 * value is copied here the first time it is read and found on this machine's
 * disk, and is never adopted when it is not.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getLocalConfigPath } from './paths.js';
import { atomicWriteFileSync } from './state-persistence.js';
import { LocalRepoCacheSchema, type LocalRepoCache } from './state-schema.js';
import { errorMessage } from './errors.js';
import { warn } from './logger.js';

const MODULE = 'local-config';

/** Config keys whose value is a filesystem path on one machine. */
export const MACHINE_PATH_KEYS = ['issueListPath', 'skippedIssuesPath'] as const;
export type MachinePathKey = (typeof MACHINE_PATH_KEYS)[number];

/** The synced values the accessors fall back to (a slice of `state.config`). */
export type SyncedPaths = Partial<Record<MachinePathKey, string>>;

/**
 * How a stored path got into the local file: `set` by the user (`setup --set`,
 * `config`), `adopted` from the synced config because it exists on this
 * machine, or found by a `probe` (the `skipped-issues.md` next to the list;
 * an older build also stored current-directory list probes, #1933).
 */
export type MachinePathSource = 'set' | 'adopted' | 'probe';

// An empty `path` records "cleared on this machine", so the synced value does
// not come back after `setup --set issueListPath=`. A bare string is the
// shape written before the source was recorded; it loads as `set`.
const StoredPathSchema = z.union([
  z.string(),
  z.object({ path: z.string(), source: z.enum(['set', 'adopted', 'probe']) }),
]);

const LocalConfigSchema = z.looseObject({
  issueListPath: StoredPathSchema.optional(),
  skippedIssuesPath: StoredPathSchema.optional(),
  localRepoCache: LocalRepoCacheSchema.optional(),
});

type LocalConfig = z.infer<typeof LocalConfigSchema>;

/**
 * Move a file that cannot be parsed out of the way, so the next write does
 * not overwrite what the user had. Returns a note for the warning.
 */
function setAsideUnreadable(filePath: string): string {
  const rejectedPath = `${filePath}.rejected-${Date.now()}`;
  try {
    fs.renameSync(filePath, rejectedPath);
    return `kept as ${rejectedPath}`;
  } catch (err) {
    return `could not be set aside (${errorMessage(err)})`;
  }
}

/** The stored file, or `{}` when it is missing or unreadable (with a warning). */
function readLocalConfig(): LocalConfig {
  const filePath = getLocalConfigPath();
  if (!fs.existsSync(filePath)) return {};
  try {
    return LocalConfigSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (err) {
    warn(MODULE, `Ignoring unreadable ${filePath} (${errorMessage(err)}); it ${setAsideUnreadable(filePath)}`);
    return {};
  }
}

/** The stored entry for a key in its current shape, or undefined when none is stored. */
function readStoredPath(key: MachinePathKey): { path: string; source: MachinePathSource } | undefined {
  const stored = readLocalConfig()[key];
  return typeof stored === 'string' ? { path: stored, source: 'set' } : stored;
}

// ponytail: read-modify-write with no lock. Two processes setting different
// keys at once can lose one write; the next detection or `setup --set`
// rewrites it. Take the state lock here if that ever shows up.
function updateLocalConfig(patch: Partial<LocalConfig>): void {
  const next = { ...readLocalConfig(), ...patch };
  atomicWriteFileSync(getLocalConfigPath(), `${JSON.stringify(next, null, 2)}\n`, 0o600);
}

/** Best-effort copy of a synced value into the local file; the caller still has the value. */
function adopt(patch: Partial<LocalConfig>): void {
  try {
    updateLocalConfig(patch);
  } catch (err) {
    warn(MODULE, `Could not save machine-local settings: ${errorMessage(err)}`);
  }
}

/** True for an absolute path to a regular file on this machine's disk. */
function isFileHere(candidate: string): boolean {
  return path.isAbsolute(candidate) && fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * This machine's value for a path setting.
 *
 * The local value wins. With none, the synced value is returned unchanged
 * (callers already handle a path that is not on disk), and it is copied to
 * the local file when it is an absolute path to a regular file here, so a
 * later write from another machine cannot replace it.
 */
export function getMachinePath(key: MachinePathKey, synced: SyncedPaths): string | undefined {
  const local = readStoredPath(key);
  if (local) return local.path || undefined;
  const syncedValue = synced[key];
  if (syncedValue && isFileHere(syncedValue)) {
    adopt({ [key]: { path: syncedValue, source: 'adopted' } });
  }
  return syncedValue;
}

/**
 * Where the value {@link getMachinePath} returns comes from: the source
 * recorded with the local value, `synced` when there is no local value and
 * the shared config supplies one, or undefined when nothing is configured.
 */
export function getMachinePathSource(
  key: MachinePathKey,
  synced: SyncedPaths,
): MachinePathSource | 'synced' | undefined {
  const local = readStoredPath(key);
  if (local) return local.source;
  const syncedValue = synced[key];
  return syncedValue ? 'synced' : undefined;
}

/**
 * Set (or, with `undefined` or an empty string, clear) a path setting for
 * this machine only, recording how the value was obtained. A relative value
 * is stored resolved against the current directory (#1933), so it never
 * depends on where a later command runs. Returns what was stored.
 */
export function setMachinePath(key: MachinePathKey, value = '', source: MachinePathSource = 'set'): string {
  const stored = value && path.resolve(value);
  updateLocalConfig({ [key]: { path: stored, source } });
  return stored;
}

/** The cache with only the repos whose checkout is on this machine's disk. */
function withExistingRepos(cache: LocalRepoCache): LocalRepoCache {
  const repos: LocalRepoCache['repos'] = {};
  for (const [name, info] of Object.entries(cache.repos)) {
    if (fs.existsSync(info.path)) repos[name] = info;
  }
  return { ...cache, repos };
}

/**
 * This machine's local repo cache, or undefined when a scan is needed.
 *
 * Entries whose path is gone are dropped on every read (the file itself is
 * rewritten by the next scan). A synced cache left by an older client is
 * adopted once, minus the entries that are not on this disk, and is ignored
 * when none of its repos are here: it was written by another machine.
 */
export function getMachineRepoCache(synced: LocalRepoCache | undefined): LocalRepoCache | undefined {
  const local = readLocalConfig().localRepoCache;
  if (local) return withExistingRepos(local);
  if (!synced) return undefined;
  const here = withExistingRepos(synced);
  if (Object.keys(synced.repos).length > 0 && Object.keys(here.repos).length === 0) return undefined;
  adopt({ localRepoCache: here });
  return here;
}

/** Store a fresh scan for this machine only. */
export function setMachineRepoCache(cache: LocalRepoCache): void {
  updateLocalConfig({ localRepoCache: cache });
}
