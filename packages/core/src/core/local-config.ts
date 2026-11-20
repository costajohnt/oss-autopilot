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
export type MachinePathKey = 'issueListPath' | 'skippedIssuesPath';

/** The synced values the accessors fall back to (a slice of `state.config`). */
export type SyncedPaths = Partial<Record<MachinePathKey, string>>;

// An empty string records "cleared on this machine", so the synced value does
// not come back after `setup --set issueListPath=`.
const LocalConfigSchema = z.looseObject({
  issueListPath: z.string().optional(),
  skippedIssuesPath: z.string().optional(),
  localRepoCache: LocalRepoCacheSchema.optional(),
});

type LocalConfig = z.infer<typeof LocalConfigSchema>;

/** The stored file, or `{}` when it is missing or unreadable (with a warning). */
function readLocalConfig(): LocalConfig {
  const filePath = getLocalConfigPath();
  if (!fs.existsSync(filePath)) return {};
  try {
    return LocalConfigSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (err) {
    warn(MODULE, `Ignoring unreadable ${filePath}: ${errorMessage(err)}`);
    return {};
  }
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

/**
 * This machine's value for a path setting.
 *
 * The local value wins. With none, the synced value is returned unchanged
 * (callers already handle a path that is not on disk), and it is copied to
 * the local file when it is absolute and exists here, so a later write from
 * another machine cannot replace it.
 */
export function getMachinePath(key: MachinePathKey, synced: SyncedPaths): string | undefined {
  const local = readLocalConfig()[key];
  if (local !== undefined) return local || undefined;
  const syncedValue = synced[key];
  if (syncedValue && path.isAbsolute(syncedValue) && fs.existsSync(syncedValue)) {
    adopt({ [key]: syncedValue });
  }
  return syncedValue;
}

/** Set (or, with `undefined` or an empty string, clear) a path setting for this machine only. */
export function setMachinePath(key: MachinePathKey, value = ''): void {
  updateLocalConfig({ [key]: value });
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
