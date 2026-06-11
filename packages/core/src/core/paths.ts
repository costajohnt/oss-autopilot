/**
 * Filesystem path helpers for the oss-autopilot user data directory.
 *
 * All paths root at `~/.oss-autopilot/`, and every getter that returns a
 * directory path implicitly creates it (with mode 0o700) if missing.
 *
 * Extracted from utils.ts under #1116.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Returns the oss-autopilot data directory path, creating it if it does not exist.
 *
 * The directory is located at `~/.oss-autopilot/` and serves as the root for
 * all persisted user data (state, backups, cache).
 *
 * @returns Absolute path to the data directory (e.g., `/Users/you/.oss-autopilot`)
 *
 * @example
 * const dir = getDataDir();
 * // "/Users/you/.oss-autopilot"
 */
export function getDataDir(): string {
  const dir = path.join(os.homedir(), '.oss-autopilot');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Returns the path to the state file (`~/.oss-autopilot/state.json`).
 *
 * Implicitly creates the data directory via {@link getDataDir} if it does not exist.
 */
export function getStatePath(): string {
  return path.join(getDataDir(), 'state.json');
}

/**
 * Returns the legacy (pre-`~/.oss-autopilot`) state file path: `./data/state.json`
 * relative to the working directory.
 *
 * Functions rather than module constants so tests can mock them per-file:
 * as constants in state-persistence.ts they resolved to the one shared
 * `packages/core/data/` during vitest, and the migration tests racing
 * parallel workers on that real directory caused CI flakes (#1382).
 */
export function getLegacyStatePath(): string {
  return path.join(process.cwd(), 'data', 'state.json');
}

/** Legacy backup directory (`./data/backups`); see {@link getLegacyStatePath}. */
export function getLegacyBackupDir(): string {
  return path.join(process.cwd(), 'data', 'backups');
}

/**
 * Returns the backup directory path, creating it if it does not exist.
 *
 * Located at `~/.oss-autopilot/backups/`. Used for automatic state backups
 * before each write operation.
 */
export function getBackupDir(): string {
  const dir = path.join(getDataDir(), 'backups');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Returns the HTTP cache directory path, creating it if it does not exist.
 *
 * Located at `~/.oss-autopilot/cache/`. Used by HttpCache to store
 * ETag-based response caches for GitHub API endpoints.
 */
export function getCacheDir(): string {
  const dir = path.join(getDataDir(), 'cache');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Returns the path to the local Gist ID file (`~/.oss-autopilot/gist-id`).
 *
 * Stores the GitHub Gist ID used by the Gist-based persistence layer,
 * avoiding a search-by-description API call on every session.
 */
export function getGistIdPath(): string {
  return path.join(getDataDir(), 'gist-id');
}

/**
 * Returns the path to the local state cache file (`~/.oss-autopilot/state-cache.json`).
 *
 * A write-through cache of the Gist-hosted state, used as a fallback when
 * the GitHub API is unreachable (degraded mode).
 */
export function getStateCachePath(): string {
  return path.join(getDataDir(), 'state-cache.json');
}

/**
 * Check whether the state file exists without creating the data directory.
 *
 * Used for first-run detection in the CLI — we don't want to create
 * `~/.oss-autopilot/` just to check if the user has ever run the tool.
 */
export function stateFileExists(): boolean {
  const stateFile = path.join(os.homedir(), '.oss-autopilot', 'state.json');
  return fs.existsSync(stateFile);
}

/**
 * Read the CLI package version from package.json relative to the running CLI bundle.
 * Resolves `../package.json` from `process.argv[1]` (the bundle entry point).
 * Falls back to '0.0.0' if the file is unreadable.
 */
export function getCLIVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(process.argv[1]), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}
