/**
 * State persistence layer for the OSS Contribution Agent.
 * Handles file I/O, locking, backup/restore, and v1-to-v2 migration.
 * No module-level mutable state — functions accept/return AgentState objects.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentState, INITIAL_STATE } from './types.js';
import { getStatePath, getBackupDir, getDataDir } from './utils.js';
import { errorMessage } from './errors.js';
import { debug, warn } from './logger.js';

const MODULE = 'state';

// Current state version
const CURRENT_STATE_VERSION = 2;

// Lock file timeout: if a lock is older than this, it is considered stale
const LOCK_TIMEOUT_MS = 30_000; // 30 seconds

// Legacy path for migration
const LEGACY_STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const LEGACY_BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');

/**
 * Check whether an existing lock file is stale (expired or corrupt).
 * Returns true if the lock should be considered stale and can be removed.
 */
function isLockStale(lockPath: string): boolean {
  try {
    const existing = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    return Date.now() - existing.timestamp > LOCK_TIMEOUT_MS;
  } catch (err) {
    // Lock file is unreadable or contains invalid JSON — treat as stale
    debug(MODULE, 'Lock file unreadable or invalid JSON, treating as stale', err);
    return true;
  }
}

/**
 * Acquire an advisory file lock using exclusive-create (`wx` flag).
 * If the lock file already exists but is stale (older than LOCK_TIMEOUT_MS or corrupt),
 * it is removed and re-acquired.
 * @throws Error if the lock is held by another active process.
 */
export function acquireLock(lockPath: string): void {
  const lockData = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
  try {
    fs.writeFileSync(lockPath, lockData, { flag: 'wx' }); // Fails if file exists
    return;
  } catch (err) {
    // Lock file exists (EEXIST from 'wx' flag) — check if it is stale
    debug(MODULE, 'Lock file already exists, checking staleness', err);
  }

  if (!isLockStale(lockPath)) {
    throw new Error('State file is locked by another process');
  }

  // Stale lock detected — remove it and try to re-acquire
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    // Another process may have removed the stale lock first — proceed to re-acquire regardless
    debug(MODULE, 'Stale lock already removed by another process', err);
  }
  try {
    fs.writeFileSync(lockPath, lockData, { flag: 'wx' });
  } catch (err) {
    // Another process grabbed the lock between unlink and write
    debug(MODULE, 'Lock re-acquire failed (race condition)', err);
    throw new Error('State file is locked by another process', { cause: err });
  }
}

/**
 * Release an advisory file lock, but only if this process owns it.
 * Silently ignores missing lock files or locks owned by other processes.
 */
export function releaseLock(lockPath: string): void {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (data.pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch (err) {
    // Lock already removed or unreadable — nothing to do
    debug(MODULE, 'Lock file already removed or unreadable during release', err);
  }
}

/**
 * Write data to `filePath` atomically by first writing to a temporary file
 * in the same directory and then renaming. Rename is atomic on POSIX filesystems,
 * preventing partial/corrupt state files if the process crashes mid-write.
 */
export function atomicWriteFileSync(filePath: string, data: string, mode?: number): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data, { mode: mode ?? 0o600 });
  fs.renameSync(tmpPath, filePath);
  // Ensure permissions are correct (rename preserves the tmp file's mode,
  // but on some systems the mode from writeFileSync is masked by umask)
  if (mode !== undefined) {
    fs.chmodSync(filePath, mode);
  }
}

/**
 * Migrate state from v1 (local PR tracking) to v2 (fresh GitHub fetching).
 * Preserves repoScores and config; drops the legacy PR arrays.
 */
function migrateV1ToV2(rawState: Record<string, unknown>): AgentState {
  debug(MODULE, 'Migrating state from v1 to v2 (fresh GitHub fetching)...');

  // Extract merged/closed PR arrays from v1 state to seed repo scores.
  // Don't increment counts here as the score may already reflect these PRs.
  const mergedPRs = (rawState.mergedPRs as Array<{ repo: string }> | undefined) || [];
  const closedPRs = (rawState.closedPRs as Array<{ repo: string }> | undefined) || [];

  // Ensure every repo referenced by historical PRs has a score record
  const repoScores = { ...((rawState.repoScores as AgentState['repoScores']) || {}) };
  for (const pr of [...mergedPRs, ...closedPRs]) {
    if (!repoScores[pr.repo]) {
      repoScores[pr.repo] = {
        repo: pr.repo,
        score: 5,
        mergedPRCount: 0,
        closedWithoutMergeCount: 0,
        avgResponseDays: null,
        lastEvaluatedAt: new Date().toISOString(),
        signals: {
          hasActiveMaintainers: true,
          isResponsive: false,
          hasHostileComments: false,
        },
      };
    }
  }

  const migratedState: AgentState = {
    version: 2,
    activeIssues: (rawState.activeIssues as AgentState['activeIssues']) || [],
    repoScores,
    config: rawState.config as AgentState['config'],
    events: (rawState.events as AgentState['events']) || [],
    lastRunAt: new Date().toISOString(),
  };

  debug(MODULE, `Migration complete. Preserved ${Object.keys(repoScores).length} repo scores.`);
  return migratedState;
}

/**
 * Validate that a loaded state has the required structure.
 * Handles both v1 (with PR arrays) and v2 (without).
 */
function isValidState(state: unknown): state is AgentState {
  if (!state || typeof state !== 'object') return false;
  const s = state as Record<string, unknown>;

  // Migrate older states that don't have repoScores
  if (s.repoScores === undefined) {
    s.repoScores = {};
  }

  // Migrate older states that don't have events
  if (s.events === undefined) {
    s.events = [];
  }

  // Migrate older states that don't have mergedPRs
  if (s.mergedPRs === undefined) {
    s.mergedPRs = [];
  }

  // Base requirements for all versions
  const hasBaseFields =
    typeof s.version === 'number' &&
    typeof s.repoScores === 'object' &&
    s.repoScores !== null &&
    Array.isArray(s.events) &&
    typeof s.config === 'object' &&
    s.config !== null;

  if (!hasBaseFields) return false;

  // v1 requires base PR arrays to be present (they will be dropped during migration)
  if (s.version === 1) {
    return (
      Array.isArray(s.activePRs) &&
      Array.isArray(s.dormantPRs) &&
      Array.isArray(s.mergedPRs) &&
      Array.isArray(s.closedPRs)
    );
  }

  // v2+ doesn't require PR arrays
  return true;
}

/**
 * Create a fresh state (v2: fresh GitHub fetching).
 */
export function createFreshState(): AgentState {
  return {
    version: CURRENT_STATE_VERSION,
    activeIssues: [],
    repoScores: {},
    config: {
      ...INITIAL_STATE.config,
      setupComplete: false,
      languages: [...INITIAL_STATE.config.languages],
      labels: [...INITIAL_STATE.config.labels],
      excludeRepos: [],
      trustedProjects: [],
      shelvedPRUrls: [],
      dismissedIssues: {},
    },
    events: [],
    lastRunAt: new Date().toISOString(),
  };
}

/**
 * Migrate state from legacy ./data/ location to ~/.oss-autopilot/.
 * Returns true if migration was performed.
 */
function migrateFromLegacyLocation(): boolean {
  const newStatePath = getStatePath();

  // If new state already exists, no migration needed
  if (fs.existsSync(newStatePath)) {
    return false;
  }

  // Check for legacy state file
  if (!fs.existsSync(LEGACY_STATE_FILE)) {
    return false;
  }

  debug(MODULE, 'Migrating state from ./data/ to ~/.oss-autopilot/...');

  try {
    // Ensure the new data directory exists
    getDataDir();

    // Copy state file
    fs.copyFileSync(LEGACY_STATE_FILE, newStatePath);
    debug(MODULE, `Migrated state file to ${newStatePath}`);

    // Copy backups if they exist
    if (fs.existsSync(LEGACY_BACKUP_DIR)) {
      const newBackupDir = getBackupDir();
      const backupFiles = fs
        .readdirSync(LEGACY_BACKUP_DIR)
        .filter((f) => f.startsWith('state-') && f.endsWith('.json'));

      for (const backupFile of backupFiles) {
        const srcPath = path.join(LEGACY_BACKUP_DIR, backupFile);
        const destPath = path.join(newBackupDir, backupFile);
        fs.copyFileSync(srcPath, destPath);
      }
      debug(MODULE, `Migrated ${backupFiles.length} backup files`);
    }

    // Remove legacy files
    fs.unlinkSync(LEGACY_STATE_FILE);
    debug(MODULE, 'Removed legacy state file');

    // Remove legacy backup files
    if (fs.existsSync(LEGACY_BACKUP_DIR)) {
      const backupFiles = fs.readdirSync(LEGACY_BACKUP_DIR);
      for (const file of backupFiles) {
        fs.unlinkSync(path.join(LEGACY_BACKUP_DIR, file));
      }
      fs.rmdirSync(LEGACY_BACKUP_DIR);
    }

    // Try to remove legacy data directory if empty
    const legacyDataDir = path.dirname(LEGACY_STATE_FILE);
    if (fs.existsSync(legacyDataDir)) {
      const remaining = fs.readdirSync(legacyDataDir);
      if (remaining.length === 0) {
        fs.rmdirSync(legacyDataDir);
        debug(MODULE, 'Removed empty legacy data directory');
      }
    }

    debug(MODULE, 'Migration complete!');
    return true;
  } catch (error) {
    warn(MODULE, `Failed to migrate state: ${errorMessage(error)}`);

    // Clean up partial migration to avoid inconsistent state
    if (fs.existsSync(newStatePath) && fs.existsSync(LEGACY_STATE_FILE)) {
      // If both files exist, the migration was partial - remove the new file
      try {
        fs.unlinkSync(newStatePath);
        debug(MODULE, 'Cleaned up partial migration - removed incomplete new state file');
      } catch (cleanupErr) {
        warn(MODULE, 'Could not clean up partial migration file');
        debug(MODULE, 'Partial migration cleanup failed', cleanupErr);
      }
    }

    warn(MODULE, 'To resolve this issue:');
    warn(MODULE, '  1. Ensure you have write permissions to ~/.oss-autopilot/');
    warn(MODULE, '  2. Check available disk space');
    warn(MODULE, '  3. Manually copy ./data/state.json to ~/.oss-autopilot/state.json');
    warn(MODULE, '  4. Or delete ./data/state.json to start fresh');

    return false;
  }
}

/**
 * Attempt to restore state from the most recent valid backup.
 * Returns the restored state if successful, or null if no valid backup is found.
 */
function tryRestoreFromBackup(): AgentState | null {
  const backupDir = getBackupDir();

  if (!fs.existsSync(backupDir)) {
    return null;
  }

  // Get backup files sorted by name (most recent first, since names include timestamps)
  const backupFiles = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('state-') && f.endsWith('.json'))
    .sort()
    .reverse();

  for (const backupFile of backupFiles) {
    const backupPath = path.join(backupDir, backupFile);
    try {
      const data = fs.readFileSync(backupPath, 'utf-8');
      let state = JSON.parse(data) as AgentState;

      if (isValidState(state)) {
        debug(MODULE, `Successfully restored state from backup: ${backupFile}`);

        // Migrate from v1 to v2 if needed
        if (state.version === 1) {
          state = migrateV1ToV2(state as unknown as Record<string, unknown>);
        }

        const repoCount = Object.keys(state.repoScores).length;
        debug(MODULE, `Restored state v${state.version}: ${repoCount} repo scores`);

        // Overwrite the corrupted main state file with the restored backup (atomic write)
        const statePath = getStatePath();
        atomicWriteFileSync(statePath, JSON.stringify(state, null, 2), 0o600);
        debug(MODULE, 'Restored backup written to main state file');

        return state;
      }
    } catch (backupErr) {
      // This backup is also corrupted, try the next one
      warn(MODULE, `Backup ${backupFile} is corrupted, trying next...`);
      debug(MODULE, `Backup ${backupFile} parse failed`, backupErr);
    }
  }

  return null;
}

/**
 * Load state from file, or create initial state if none exists.
 * If the main state file is corrupted, attempts to restore from the most recent backup.
 * Performs migration from legacy ./data/ location if needed.
 * @returns Object with the loaded state and the file's mtime (for change detection).
 */
export function loadState(): { state: AgentState; mtimeMs: number } {
  // Try to migrate from legacy location first
  migrateFromLegacyLocation();

  const statePath = getStatePath();

  try {
    if (fs.existsSync(statePath)) {
      const data = fs.readFileSync(statePath, 'utf-8');
      let state = JSON.parse(data) as AgentState;

      // Validate required fields exist
      if (!isValidState(state)) {
        warn(MODULE, 'Invalid state file structure, attempting to restore from backup...');
        const restoredState = tryRestoreFromBackup();
        if (restoredState) {
          const mtimeMs = safeGetMtimeMs(statePath);
          return { state: restoredState, mtimeMs };
        }
        warn(MODULE, 'No valid backup found, starting fresh');
        return { state: createFreshState(), mtimeMs: 0 };
      }

      // Migrate from v1 to v2 if needed
      if (state.version === 1) {
        state = migrateV1ToV2(state as unknown as Record<string, unknown>);
        // Save the migrated state immediately (atomic write)
        atomicWriteFileSync(statePath, JSON.stringify(state, null, 2), 0o600);
        debug(MODULE, 'Migrated state saved');
      }

      // Strip legacy fields from persisted state (snoozedPRs and PR dismiss
      // entries were removed in the three-state PR model simplification)
      try {
        let needsCleanupSave = false;
        const rawConfig = state.config as unknown as Record<string, unknown>;
        if (rawConfig.snoozedPRs) {
          delete rawConfig.snoozedPRs;
          needsCleanupSave = true;
        }
        // Strip PR URLs from dismissedIssues (PR dismiss removed)
        if (state.config.dismissedIssues) {
          const PR_URL_RE = /\/pull\/\d+$/;
          for (const url of Object.keys(state.config.dismissedIssues)) {
            if (PR_URL_RE.test(url)) {
              delete state.config.dismissedIssues[url];
              needsCleanupSave = true;
            }
          }
        }
        if (needsCleanupSave) {
          atomicWriteFileSync(statePath, JSON.stringify(state, null, 2), 0o600);
          warn(MODULE, 'Cleaned up removed features (snoozedPRs, dismissed PR URLs) from persisted state');
        }
      } catch (cleanupError) {
        warn(MODULE, `Failed to clean up removed features from state: ${errorMessage(cleanupError)}`);
        // Continue with loaded state — cleanup will be retried on next load
      }

      // Record file mtime so reloadIfChanged() can detect external writes
      const mtimeMs = safeGetMtimeMs(statePath);

      // Log appropriate message based on version
      const repoCount = Object.keys(state.repoScores).length;
      debug(MODULE, `Loaded state v${state.version}: ${repoCount} repo scores tracked`);
      return { state, mtimeMs };
    }
  } catch (error) {
    warn(MODULE, 'Error loading state:', error);
    warn(MODULE, 'Attempting to restore from backup...');
    const restoredState = tryRestoreFromBackup();
    if (restoredState) {
      const mtimeMs = safeGetMtimeMs(statePath);
      return { state: restoredState, mtimeMs };
    }
    warn(MODULE, 'No valid backup found, starting fresh');
  }

  debug(MODULE, 'No existing state found, initializing...');
  return { state: createFreshState(), mtimeMs: 0 };
}

/**
 * Safely read a file's mtime. Returns 0 if the stat call fails.
 */
function safeGetMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (error) {
    debug(MODULE, `Could not read state file mtime (reload detection will always trigger): ${errorMessage(error)}`);
    return 0;
  }
}

/**
 * Clean up old backup files, keeping only the 10 most recent.
 */
function cleanupBackups(): void {
  const backupDir = getBackupDir();
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('state-'))
      .sort()
      .reverse();

    // Keep only the 10 most recent backups
    for (const file of files.slice(10)) {
      try {
        fs.unlinkSync(path.join(backupDir, file));
      } catch (error) {
        warn(MODULE, `Could not delete old backup ${file}:`, errorMessage(error));
      }
    }
  } catch (error) {
    warn(MODULE, 'Could not clean up backups:', errorMessage(error));
  }
}

/**
 * Persist state to disk, creating a timestamped backup of the previous
 * state file first. Retains at most 10 backup files.
 * @returns The file's mtime after writing (for change detection).
 */
export function saveState(state: Readonly<AgentState>): number {
  const statePath = getStatePath();
  const lockPath = statePath + '.lock';
  const backupDir = getBackupDir();

  // Acquire advisory lock to prevent concurrent writes
  acquireLock(lockPath);

  try {
    // Create backup of existing state (best-effort, non-fatal)
    try {
      if (fs.existsSync(statePath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const randomSuffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
        const backupFile = path.join(backupDir, `state-${timestamp}-${randomSuffix}.json`);
        fs.copyFileSync(statePath, backupFile);
        fs.chmodSync(backupFile, 0o600);

        // Keep only last 10 backups
        cleanupBackups();
      }
    } catch (backupErr) {
      warn(MODULE, `Could not create backup before save: ${errorMessage(backupErr)}`);
      // Continue with save — losing a backup is acceptable, losing the save is not
    }

    // Atomic write: write to temp file then rename to prevent corruption on crash
    atomicWriteFileSync(statePath, JSON.stringify(state, null, 2), 0o600);
    const mtimeMs = safeGetMtimeMs(statePath);
    debug(MODULE, 'State saved successfully');
    return mtimeMs;
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Re-read state from disk if the file has been modified since the last load/save.
 * Uses mtime comparison (single statSync call) to avoid unnecessary JSON parsing.
 * @returns The new state and mtime if reloaded, or null if no change detected.
 */
export function reloadStateIfChanged(lastLoadedMtimeMs: number): { state: AgentState; mtimeMs: number } | null {
  try {
    const statePath = getStatePath();
    const currentMtimeMs = fs.statSync(statePath).mtimeMs;
    if (currentMtimeMs === lastLoadedMtimeMs) return null;
    const result = loadState();
    // Ensure mtime is always current after reload (covers backup-restore and fresh-state paths)
    // to prevent repeated unnecessary reloads on every request.
    try {
      result.mtimeMs = fs.statSync(statePath).mtimeMs;
    } catch (err) {
      // If file was just loaded, stat should not fail. If it does,
      // next reloadIfChanged() will simply trigger another reload.
      debug(MODULE, 'Could not re-read mtime after reload (will retry next cycle)', err);
    }
    return result;
  } catch (error) {
    // statSync failure (file deleted) is benign — keep current in-memory state.
    warn(MODULE, `Failed to reload state from disk: ${errorMessage(error)}`);
    return null;
  }
}
