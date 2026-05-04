/**
 * State persistence layer for the OSS Contribution Agent.
 * Handles file I/O, locking, backup/restore, and schema migration (v1→v2→v3→v4).
 * No module-level mutable state — functions accept/return AgentState objects.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentState } from './types.js';
import { AgentStateSchema } from './state-schema.js';
import { getStatePath, getBackupDir, getDataDir } from './paths.js';
import { errorMessage, ConcurrencyError } from './errors.js';
import { debug, warn } from './logger.js';

const MODULE = 'state';

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
    const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
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
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
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
export function migrateV1ToV2(rawState: Record<string, unknown>): Record<string, unknown> {
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

  const migratedState = {
    version: 2 as const,
    activeIssues: (rawState.activeIssues as AgentState['activeIssues']) || [],
    repoScores,
    config: rawState.config as AgentState['config'],
    lastRunAt: new Date().toISOString(),
  };

  debug(MODULE, `Migration complete. Preserved ${Object.keys(repoScores).length} repo scores.`);
  return migratedState;
}

/**
 * Migrate state from v2 to v3.
 * Drops: events, dailyActivityCounts, config.showHealthCheck, config.scoreThreshold.
 * Adds: analyzedIssueConversations, learningsExtractedAt on StoredMergedPR/StoredClosedPR.
 * New optional fields are handled by Zod defaults (undefined/optional).
 */
export function migrateV2ToV3(rawState: Record<string, unknown>): Record<string, unknown> {
  debug(MODULE, 'Migrating state from v2 to v3 (drop dead fields, add learnings tracking)...');

  // Remove dead fields from root
  delete rawState.events;
  delete rawState.dailyActivityCounts;

  // Remove dead fields from config
  const config = rawState.config as Record<string, unknown> | undefined;
  if (config) {
    delete config.showHealthCheck;
    delete config.scoreThreshold;
  }

  // Bump version
  rawState.version = 3;

  debug(MODULE, 'v2 to v3 migration complete.');
  return rawState;
}

/**
 * Migrate state from v3 to v4 (#867).
 * Adds: commentsFetchedAt on StoredMergedPR / StoredClosedPR. The new field is
 * optional, so no data transformation is needed — only the version bump.
 */
export function migrateV3ToV4(rawState: Record<string, unknown>): Record<string, unknown> {
  debug(MODULE, 'Migrating state from v3 to v4 (add commentsFetchedAt to stored PR records)...');
  rawState.version = 4;
  debug(MODULE, 'v3 to v4 migration complete (no data transformation required).');
  return rawState;
}

/**
 * Create a fresh state (v4).
 * Leverages Zod schema defaults to produce a complete state.
 */
export function createFreshState(): AgentState {
  return AgentStateSchema.parse({ version: 4 });
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
      const data = fs.readFileSync(backupPath, 'utf8');
      let raw: unknown = JSON.parse(data);

      // Chain migrations: v1 → v2 → v3 → v4
      if (typeof raw === 'object' && raw !== null) {
        const rawObj = raw as Record<string, unknown>;
        if (rawObj.version === 1) {
          raw = migrateV1ToV2(rawObj);
        }
        if ((raw as Record<string, unknown>).version === 2) {
          raw = migrateV2ToV3(raw as Record<string, unknown>);
        }
        if ((raw as Record<string, unknown>).version === 3) {
          raw = migrateV3ToV4(raw as Record<string, unknown>);
        }
      }

      const parsed = AgentStateSchema.safeParse(raw);
      if (parsed.success) {
        const state = parsed.data;
        debug(MODULE, `Successfully restored state from backup: ${backupFile}`);

        const repoCount = Object.keys(state.repoScores).length;
        debug(MODULE, `Restored state v${state.version}: ${repoCount} repo scores`);

        // Overwrite the corrupted main state file with the restored backup (atomic write)
        const statePath = getStatePath();
        atomicWriteFileSync(statePath, JSON.stringify(state, null, 2), 0o600);
        debug(MODULE, 'Restored backup written to main state file');

        return state;
      }

      // safeParse failed — log and try next backup
      const summary = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      warn(MODULE, `Backup ${backupFile} failed schema validation: ${summary}`);
      debug(MODULE, `Backup ${backupFile} full validation errors:`, parsed.error.issues);
    } catch (backupErr) {
      // This backup is also corrupted, try the next one. Include the error
      // message in the warn so non-DEBUG users can diagnose without enabling
      // DEBUG=1 (#1209 L7); the full stack still goes to debug.
      const msg = backupErr instanceof Error ? backupErr.message : String(backupErr);
      warn(MODULE, `Backup ${backupFile} is corrupted (${msg}), trying next...`);
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
      const data = fs.readFileSync(statePath, 'utf8');
      let raw: unknown = JSON.parse(data);

      // Chain migrations: v1 → v2 → v3 → v4
      let wasMigrated = false;
      if (typeof raw === 'object' && raw !== null) {
        const rawObj = raw as Record<string, unknown>;
        if (rawObj.version === 1) {
          raw = migrateV1ToV2(rawObj);
          wasMigrated = true;
        }
        if ((raw as Record<string, unknown>).version === 2) {
          raw = migrateV2ToV3(raw as Record<string, unknown>);
          wasMigrated = true;
        }
        if ((raw as Record<string, unknown>).version === 3) {
          raw = migrateV3ToV4(raw as Record<string, unknown>);
          wasMigrated = true;
        }
      }

      // Validate through Zod schema (strips unknown keys in memory; stale keys persist on disk until next save)
      const parsed = AgentStateSchema.safeParse(raw);
      if (!parsed.success) {
        const summary = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        warn(MODULE, `Invalid state file structure: ${summary}`);
        warn(MODULE, 'Attempting to restore from backup...');
        debug(MODULE, 'Full validation errors:', parsed.error.issues);

        // Preserve the rejected state file so the user can recover
        try {
          const rejectedPath = statePath + '.rejected-' + Date.now();
          fs.copyFileSync(statePath, rejectedPath);
          warn(MODULE, `Previous state preserved at: ${rejectedPath}`);
        } catch (preserveErr) {
          warn(MODULE, `Could not preserve rejected state file: ${errorMessage(preserveErr)}`);
        }

        const restoredState = tryRestoreFromBackup();
        if (restoredState) {
          const mtimeMs = safeGetMtimeMs(statePath);
          return { state: restoredState, mtimeMs };
        }
        warn(MODULE, 'No valid backup found, starting fresh');
        return { state: createFreshState(), mtimeMs: 0 };
      }

      // Save migrated state only after validation succeeds
      if (wasMigrated) {
        atomicWriteFileSync(statePath, JSON.stringify(parsed.data, null, 2), 0o600);
        debug(MODULE, 'Migrated and validated state saved');
      }

      const state = parsed.data;

      // Strip PR URLs from dismissedIssues (PR dismiss removed).
      // This filters values inside a known field — Zod .strip() only removes unknown keys.
      try {
        let needsCleanupSave = false;
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
          warn(MODULE, 'Cleaned up dismissed PR URLs from persisted state');
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
 *
 * When `expectedMtimeMs` is provided (non-null, non-zero), implements
 * optimistic compare-and-swap: if the on-disk file has been modified since
 * the caller last loaded it, throws `ConcurrencyError` instead of
 * overwriting. This prevents the classic read-modify-write lost-update
 * race across processes (see issue #1030). Pass `null` / `0` to disable
 * the check (first write, or when the caller has already reloaded).
 *
 * The check runs *inside* the advisory lock so the compare-and-swap is
 * atomic with respect to the write.
 *
 * @returns The file's mtime after writing (for change detection).
 * @throws ConcurrencyError when `expectedMtimeMs` is provided and the
 *   on-disk mtime no longer matches.
 */
export function saveState(state: Readonly<AgentState>, expectedMtimeMs: number | null = null): number {
  const statePath = getStatePath();
  const lockPath = statePath + '.lock';
  const backupDir = getBackupDir();

  // Acquire advisory lock to prevent concurrent writes
  acquireLock(lockPath);

  try {
    // Compare-and-swap: reject the write if the file changed externally
    // between the caller's last load and now. Zero/null bypasses the
    // check for first writes and Gist-mode local-cache paths.
    if (expectedMtimeMs !== null && expectedMtimeMs > 0 && fs.existsSync(statePath)) {
      const currentMtimeMs = safeGetMtimeMs(statePath);
      if (currentMtimeMs !== expectedMtimeMs) {
        throw new ConcurrencyError(expectedMtimeMs, currentMtimeMs);
      }
    }

    // Create backup of existing state (best-effort, non-fatal)
    try {
      if (fs.existsSync(statePath)) {
        const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
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
