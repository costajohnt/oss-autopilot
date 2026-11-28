/**
 * State persistence layer for the OSS Contribution Agent.
 * Handles file I/O, locking, backup/restore, and schema migration (v1→v2→v3→v4).
 * No module-level mutable state — functions accept/return AgentState objects.
 */

import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { AgentState } from './types.js';
import { AgentStateSchema, NEWER_WRITER_HINT, malformedWorkClaimCount, unknownStateKeys } from './state-schema.js';
import { serializeState } from './state-prune.js';
import { getStatePath, getBackupDir, getDataDir, getLegacyStatePath, getLegacyBackupDir } from './paths.js';
import { preserveRejected } from './stale-data.js';
import { errorMessage, ConcurrencyError, NewerStateVersionError, StateLockTimeoutError } from './errors.js';
import { debug, warn } from './logger.js';

const MODULE = 'state';

// A lock whose owner is gone is stale once it is older than this. The locked
// section is a synchronous copy + write + rename (milliseconds), so 30 seconds
// is far past any real write.
const LOCK_TIMEOUT_MS = 30_000;
// A lock whose PID is still alive on this host is only taken after this long:
// the owner is most likely an unrelated process that reused the PID of a
// crashed writer, and a live writer that is merely slow must keep its lock.
const LIVE_LOCK_TIMEOUT_MS = 10 * 60_000;
// Contention: poll every 25 ms for about one second, then fail (#1951).
const LOCK_RETRY_INTERVAL_MS = 25;
const LOCK_RETRY_ATTEMPTS = 40;

/** Block this thread for `ms`. saveState is synchronous, so the wait has to be too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * The lock file's content, or null when there is no lock file. Any other read
 * failure is rethrown: an fd or permission problem is not "locked".
 */
function readLockFile(lockPath: string): string | null {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return null;
  }
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return errnoCode(err) === 'EPERM';
  }
}

function parseLock(content: string): { pid?: unknown; timestamp?: unknown } {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    debug(MODULE, 'Lock file is not valid JSON', err);
  }
  return parsed ?? {};
}

/** The lock file's mtime, or a time that can never look stale when it cannot be read. */
function lockMtimeMs(lockPath: string): number {
  try {
    return fs.statSync(lockPath).mtimeMs;
  } catch (err) {
    debug(MODULE, 'Lock file disappeared while checking staleness', err);
    return Infinity;
  }
}

/**
 * Return the lock's content when it is stale, or null when it must be
 * respected (or is already gone). Age is counted from the earlier of the
 * lock's timestamp and the file mtime, so a lock without a usable timestamp
 * (empty while its owner is still writing it, or corrupt) is aged by mtime
 * instead of being stale on sight, and a timestamp in the future cannot make
 * a lock immortal.
 */
function readStaleLock(lockPath: string): string | null {
  const content = readLockFile(lockPath);
  if (content === null) return null;
  const lock = parseLock(content);
  // Saving is synchronous, so a process that is acquiring is not inside the
  // locked section: a lock with its own PID is a leftover, stale now.
  // ponytail: assumes one PID namespace and one writer thread per process.
  // Containers sharing the data directory with colliding PIDs rely on the
  // commit-point check in saveState; add a host/boot id to the lock if that
  // setup becomes real.
  if (lock.pid === process.pid) return content;
  const stamped = typeof lock.timestamp === 'number' ? lock.timestamp : Infinity;
  const since = Math.min(stamped, lockMtimeMs(lockPath));
  const limit = isPidAlive(lock.pid) ? LIVE_LOCK_TIMEOUT_MS : LOCK_TIMEOUT_MS;
  return Date.now() - since > limit ? content : null;
}

/** Link a wrongly claimed lock back into place; `linkSync` fails rather than overwrite a newer lock. */
function putBackLock(claimed: string, lockPath: string): void {
  try {
    fs.linkSync(claimed, lockPath);
  } catch (err) {
    warn(MODULE, `Could not put back a live state lock: ${errorMessage(err)}`);
  }
}

/** True when the claimed file is the lock that was judged stale. Unreadable counts as not: it is put back. */
function isJudgedLock(claimed: string, staleContent: string): boolean {
  try {
    return fs.readFileSync(claimed, 'utf8') === staleContent;
  } catch (err) {
    warn(MODULE, `Could not read a claimed state lock: ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Remove a lock judged stale without ever removing a fresh one. The rename
 * is the atomic claim: of several processes that judged the same lock stale,
 * one gets the file and the rest fail with ENOENT. If the claimed file is not
 * the lock that was judged (another process finished its own takeover in
 * between), it is put back.
 */
function removeStaleLock(lockPath: string, staleContent: string): void {
  const claimed = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, claimed);
  } catch (err) {
    debug(MODULE, 'Stale lock already claimed or released by another process', err);
    return;
  }
  if (!isJudgedLock(claimed, staleContent)) putBackLock(claimed, lockPath);
  fs.rmSync(claimed, { force: true });
}

/** Exclusive-create the lock file. False when one already exists; any other failure is rethrown. */
function didCreateLock(lockPath: string, lockData: string): boolean {
  try {
    fs.writeFileSync(lockPath, lockData, { flag: 'wx' }); // Fails if file exists
    return true;
  } catch (err) {
    if (errnoCode(err) !== 'EEXIST') throw err;
    return false;
  }
}

/**
 * Exclusive-create the lock, then re-read it: this process holds the lock
 * only if the file on disk is the one it wrote. If the re-read fails, a lock
 * this call created is removed again so it is not left orphaned.
 */
function didTakeLock(lockPath: string, lockData: string): boolean {
  const didCreate = didCreateLock(lockPath, lockData);
  try {
    return readLockFile(lockPath) === lockData;
  } catch (err) {
    if (didCreate) fs.rmSync(lockPath, { force: true });
    throw err;
  }
}

/**
 * Acquire an advisory file lock using exclusive-create (`wx` flag).
 * A held lock is retried for about a second; a stale one (see
 * {@link readStaleLock}) is taken over through an atomic rename.
 * @returns The lock content written, for {@link releaseLock} and for
 *   re-checking ownership before the write the lock protects.
 * @throws StateLockTimeoutError (a ConcurrencyError) if the lock is still
 *   held after the wait. Nothing has been written at that point.
 */
export function acquireLock(lockPath: string): string {
  const startedAt = Date.now();
  const lockData = JSON.stringify({ pid: process.pid, timestamp: startedAt, token: randomUUID() });
  for (let attempt = 0; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) sleepSync(LOCK_RETRY_INTERVAL_MS);
    if (didTakeLock(lockPath, lockData)) return lockData;
    const staleContent = readStaleLock(lockPath);
    if (staleContent !== null) {
      removeStaleLock(lockPath, staleContent);
      if (didTakeLock(lockPath, lockData)) return lockData;
    }
  }
  throw new StateLockTimeoutError(lockPath, Date.now() - startedAt);
}

/**
 * Release an advisory file lock, but only if it still holds `held`, the
 * content {@link acquireLock} returned. A missing lock is ignored; any other
 * failure is warned about, never thrown (this runs in a `finally`).
 */
export function releaseLock(lockPath: string, held: string): void {
  try {
    if (readLockFile(lockPath) === held) fs.unlinkSync(lockPath);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') warn(MODULE, `Could not release the state lock ${lockPath}: ${errorMessage(err)}`);
  }
}

/** Throw unless the lock file still holds what {@link acquireLock} wrote (it was taken over meanwhile). */
function assertLockHeld(lockPath: string, held: string): void {
  if (readLockFile(lockPath) === held) return;
  throw new ConcurrencyError(
    0,
    0,
    'The state lock was taken over by another process before the write. Nothing was written; re-run the command.',
  );
}

/**
 * Write data to `filePath` atomically by first writing to a temporary file
 * in the same directory and then renaming. Rename is atomic on POSIX filesystems,
 * preventing partial/corrupt state files if the process crashes mid-write.
 */
export function atomicWriteFileSync(filePath: string, data: string, mode?: number): void {
  // Per-process name: two unlocked writers (MCP server + a CLI run, both in
  // Gist mode) sharing one `<file>.tmp` could publish each other's partial
  // write via rename (audit 2026-10-30 L2).
  const tmpPath = `${filePath}.${process.pid}.tmp`;
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
  // Resolved via paths.js (not module constants) so tests can mock the
  // legacy location into per-test temp dirs — see #1382.
  const LEGACY_STATE_FILE = getLegacyStatePath();
  const LEGACY_BACKUP_DIR = getLegacyBackupDir();

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
        atomicWriteFileSync(statePath, serializeState(state), 0o600);
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
 * Details about a recovery that happened during {@link loadState} — set when
 * the main state file was unreadable (JSON parse error) or structurally
 * invalid (Zod rejection) and the loader fell back to a backup or fresh state.
 * Surfaced through StateManager.getLoadRecovery() so commands can include the
 * event in structured output instead of only stderr warn() lines (#1371).
 */
export interface LoadRecoveryInfo {
  /** Where the loaded state came from after the original file was rejected. */
  source: 'backup' | 'fresh';
  /** Path of the preserved `.rejected-<ts>` copy, or null if preservation failed. */
  rejectedPath: string | null;
  /** Short summary of why the original state file was rejected. */
  reason: string;
}

/**
 * What saveState's compare-and-swap and reloadStateIfChanged compare (#2006).
 * mtime alone misses two writes in one timestamp quantum (whole seconds on
 * FAT and some network or synced mounts). Every write here is an atomic
 * rename, which usually lands on a new inode; size catches in-place writers.
 * Where the file system synthesizes or reuses inode numbers (FAT/vfat, cifs
 * with noserverino, FUSE without use_ino, ext4 reusing a freed inode), or
 * reports `ino` as 0 on both sides, the check degrades to mtime + size.
 * `ino` is the decimal string of a bigint stat: a 64-bit NTFS file ID does
 * not fit a double, and two IDs that round to the same number would match.
 */
export interface StateFileIdentity {
  mtimeMs: number;
  ino: string;
  size: number;
}

/** A stat that failed. NaN never compares equal, so it always reads as "changed". */
const UNKNOWN_FILE_IDENTITY: StateFileIdentity = { mtimeMs: NaN, ino: '', size: NaN };

function statIdentitySync(filePath: string): StateFileIdentity {
  const stats = fs.statSync(filePath, { bigint: true });
  return { mtimeMs: Number(stats.mtimeNs) / 1e6, ino: stats.ino.toString(), size: Number(stats.size) };
}

function isSameIdentity(a: StateFileIdentity, b: StateFileIdentity): boolean {
  return a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.size === b.size;
}

/**
 * Result of {@link loadState}: the loaded state, the file's identity for
 * change detection, and (only when the main file was rejected) recovery
 * details. `fileId` is null only when there was no state file to take a
 * baseline from. Fresh state that replaces a rejected file keeps the
 * rejected file's identity, so an intervening valid write is not clobbered.
 */
export interface LoadStateResult {
  state: AgentState;
  fileId: StateFileIdentity | null;
  recovery?: LoadRecoveryInfo;
}

/**
 * Copy a rejected state file to `<statePath>.rejected-<timestamp>` so the
 * user can recover data manually before the file is overwritten by a backup
 * restore or fresh state. Returns the preserved path, or null if the copy
 * failed (preservation is best-effort and never throws).
 */
function preserveRejectedStateFile(statePath: string): string | null {
  try {
    const rejectedPath = preserveRejected(statePath, 'copy');
    warn(MODULE, `Previous state preserved at: ${rejectedPath}`);
    return rejectedPath;
  } catch (preserveErr) {
    warn(MODULE, `Could not preserve rejected state file: ${errorMessage(preserveErr)}`);
    return null;
  }
}

/**
 * Report work claims the lenient parse dropped from `raw` (#1856). Every path
 * that turns stored JSON into an `AgentState` (the state file, a Gist copy
 * at bootstrap or refresh, the local cache in degraded mode) calls this, so
 * a claim another machine wrote in a shape this release cannot read is never
 * dropped silently. `source` names the copy in the warning.
 */
export function warnMalformedWorkClaims(raw: unknown, state: AgentState, source: string): void {
  const malformed = malformedWorkClaimCount(raw, state);
  if (malformed > 0) warn(MODULE, `${source} has ${malformed} unreadable work claim(s); they were dropped`);
}

/**
 * Refuse stored state whose schema version is above this release's. Treating
 * it as invalid would restore an older backup (or fresh state) over newer
 * data. `source` names the copy in the message.
 */
export function assertNotNewerVersion(raw: unknown, source: string): void {
  const version = (raw as { version?: unknown } | null)?.version;
  const supported = AgentStateSchema.shape.version.value;
  if (typeof version === 'number' && version > supported) {
    throw new NewerStateVersionError(source, version, supported);
  }
}

/**
 * Refuse to save over a state file a newer release wrote. Runs on every save,
 * whatever the caller's mtime baseline: a process that started before the
 * file existed has no baseline and would otherwise write old state over it.
 * A missing or unparseable file is not this check's concern.
 */
function assertDiskStateNotNewer(statePath: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    // No file yet, or one that does not parse: nothing to protect. Any other
    // failure is worth a warning, but the save still goes ahead.
    const isExpected = errnoCode(err) === 'ENOENT' || err instanceof SyntaxError;
    if (isExpected) debug(MODULE, 'No parseable state file to version-check before save', err);
    else warn(MODULE, `Could not version-check the state file before save: ${errorMessage(err)}`);
    return;
  }
  assertNotNewerVersion(raw, 'state file');
}

/**
 * Rethrow a load failure that is not corruption, before any file is touched:
 * a newer-version state file, or anything carrying an errno `code`, i.e. a
 * file system error (EACCES, EMFILE, EIO, EISDIR, ENOSPC, ...).
 * Restoring a backup or starting fresh there would mask the real problem and
 * can overwrite a valid state file (#1371, #1951). Only unparseable or
 * structurally broken content returns, to be recovered.
 */
function rethrowUnlessCorrupt(error: unknown): void {
  if (error instanceof NewerStateVersionError) throw error;
  const code = errnoCode(error);
  if (code === 'EACCES' || code === 'EPERM') {
    throw new Error(
      `Permission denied reading state file (${code}): ${errorMessage(error)}. ` +
        'This is an environment problem, not state corruption. Check the ownership and ' +
        'permissions of ~/.oss-autopilot/state.json (e.g. run `ls -l ~/.oss-autopilot/state.json` ' +
        'and fix with chown/chmod), then retry.',
      { cause: error },
    );
  }
  if (typeof code === 'string') throw error;
}

/**
 * Load state from file, or create initial state if none exists.
 * If the main state file is corrupted, attempts to restore from the most recent backup.
 * Performs migration from legacy ./data/ location if needed.
 * @returns Object with the loaded state, the file's identity (for change detection),
 *   and recovery details when the main file was rejected.
 * @throws Error when the state file exists but cannot be read due to a file
 *   system error (EACCES/EPERM get guidance, others are rethrown as they are)
 *   or was written by a newer release. Neither is corruption, so
 *   restore-or-fresh would mask it and risk clobbering data. No file is touched.
 */
export function loadState(): LoadStateResult {
  // Try to migrate from legacy location first
  migrateFromLegacyLocation();

  const statePath = getStatePath();
  // Outside the try so the fresh-state recovery in the catch keeps it (#2006).
  let fileId: StateFileIdentity | null = null;

  try {
    if (fs.existsSync(statePath)) {
      // Baseline identity for saveState's compare-and-swap. Taken BEFORE the read:
      // if another process writes in between, we end up with a baseline older
      // than our content, and the next save fails with a ConcurrencyError the
      // caller can recover from by reloading. Taken after the read, the same
      // race pairs stale content with the new identity and the save silently
      // overwrites the other writer.
      fileId = statFileIdentity(statePath);
      const data = fs.readFileSync(statePath, 'utf8');
      let raw: unknown = JSON.parse(data);
      assertNotNewerVersion(raw, 'state file');

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

      // Validate through Zod schema. Unknown keys pass through (#1831): they
      // come from a newer release and must survive this version's next save.
      const newer = unknownStateKeys(raw);
      if (newer.length > 0) warn(MODULE, `State file (fields: ${newer.join(', ')}) ${NEWER_WRITER_HINT}`);
      const parsed = AgentStateSchema.safeParse(raw);
      if (!parsed.success) {
        const summary = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        warn(MODULE, `Invalid state file structure: ${summary}`);
        warn(MODULE, 'Attempting to restore from backup...');
        debug(MODULE, 'Full validation errors:', parsed.error.issues);

        // Preserve the rejected state file so the user can recover
        const rejectedPath = preserveRejectedStateFile(statePath);
        const reason = `Invalid state file structure: ${summary}`;

        const restoredState = tryRestoreFromBackup();
        if (restoredState) {
          const recovery: LoadRecoveryInfo = { source: 'backup', rejectedPath, reason };
          return { state: restoredState, fileId: statFileIdentity(statePath), recovery };
        }
        warn(MODULE, 'No valid backup found, starting fresh');
        return { fileId, state: createFreshState(), recovery: { source: 'fresh', rejectedPath, reason } };
      }

      // Save migrated state only after validation succeeds
      if (wasMigrated) {
        atomicWriteFileSync(statePath, serializeState(parsed.data), 0o600);
        fileId = statFileIdentity(statePath); // our own write: what we hold is what is on disk
        debug(MODULE, 'Migrated and validated state saved');
      }

      const state = parsed.data;
      warnMalformedWorkClaims(raw, state, 'State file');

      // `config.dismissedIssues` keys are issue AND PR URLs: `dismiss` accepts
      // a merged PR's URL for the merged-PR notes nudge (#1861). The former
      // "PR dismiss removed" load-time strip of `/pull/N` keys is gone; it
      // would have undone every PR dismiss on the next load.

      // Log appropriate message based on version
      const repoCount = Object.keys(state.repoScores).length;
      debug(MODULE, `Loaded state v${state.version}: ${repoCount} repo scores tracked`);
      return { state, fileId };
    }
  } catch (error) {
    rethrowUnlessCorrupt(error);

    warn(MODULE, 'Error loading state:', error);
    warn(MODULE, 'Attempting to restore from backup...');

    // Preserve the unparseable file before tryRestoreFromBackup() overwrites
    // it with restored backup contents (#1371). Only attempt when the file
    // actually exists — the error may have come from elsewhere in the block.
    const rejectedPath = fs.existsSync(statePath) ? preserveRejectedStateFile(statePath) : null;
    const reason = `Error loading state: ${errorMessage(error)}`;

    const restoredState = tryRestoreFromBackup();
    if (restoredState) {
      const recovery: LoadRecoveryInfo = { source: 'backup', rejectedPath, reason };
      return { state: restoredState, fileId: statFileIdentity(statePath), recovery };
    }
    warn(MODULE, 'No valid backup found, starting fresh');
    return { fileId, state: createFreshState(), recovery: { source: 'fresh', rejectedPath, reason } };
  }

  debug(MODULE, 'No existing state found, initializing...');
  return { state: createFreshState(), fileId: null };
}

/**
 * Read a file's identity. A failed stat returns an identity that matches
 * nothing, so the next save reports a conflict and the next reload re-reads,
 * rather than a 0 that would switch the compare-and-swap off (#2006).
 */
function statFileIdentity(filePath: string): StateFileIdentity {
  try {
    return statIdentitySync(filePath);
  } catch (error) {
    debug(MODULE, `Could not stat state file (treating it as changed): ${errorMessage(error)}`);
    return UNKNOWN_FILE_IDENTITY;
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
 * When `expected` is provided (non-null), implements optimistic
 * compare-and-swap: if the on-disk file's identity (mtime, inode, size)
 * differs from the one the caller last loaded or saved, throws
 * `ConcurrencyError` instead of overwriting. This prevents the classic
 * read-modify-write lost-update race across processes (see issues #1030,
 * #2006). Pass `null` to disable the check (no file at load).
 *
 * The check runs *inside* the advisory lock so the compare-and-swap is
 * atomic with respect to the write.
 *
 * @returns The file's identity after writing (for change detection).
 * @throws ConcurrencyError when `expected` is provided and the on-disk
 *   identity no longer matches, or the file cannot be stat'ed.
 */
export function saveState(state: Readonly<AgentState>, expected: StateFileIdentity | null = null): StateFileIdentity {
  const statePath = getStatePath();
  const lockPath = statePath + '.lock';
  const backupDir = getBackupDir();

  // Acquire advisory lock to prevent concurrent writes
  const held = acquireLock(lockPath);

  try {
    assertDiskStateNotNewer(statePath);

    // Compare-and-swap: reject the write if the file changed externally
    // between the caller's last load and now. Null bypasses the check:
    // there was no file to take a baseline from.
    if (expected !== null && fs.existsSync(statePath)) {
      const current = statFileIdentity(statePath);
      if (!isSameIdentity(current, expected)) {
        throw new ConcurrencyError(expected.mtimeMs, current.mtimeMs, undefined, expected, current);
      }
    }

    // Create backup of existing state (best-effort, non-fatal)
    try {
      if (fs.existsSync(statePath)) {
        const timestamp = new Date().toISOString().replaceAll(/[.:]/g, '-');
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

    // Atomic write: write to temp file then rename to prevent corruption on crash.
    // Ownership is re-checked first: a takeover since acquiring must not end in two writers.
    assertLockHeld(lockPath, held);
    atomicWriteFileSync(statePath, serializeState(state), 0o600);
    const fileId = statFileIdentity(statePath);
    debug(MODULE, 'State saved successfully');
    return fileId;
  } finally {
    releaseLock(lockPath, held);
  }
}

// Read failures that usually clear on their own: worth one retry before a reload fails its caller.
const TRANSIENT_READ_CODES = new Set(['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN']);

/**
 * loadState for a reload. A file that vanished since the stat is "no change"
 * (null); a transient resource error is retried once after a short pause.
 * Everything else loadState throws (newer-version state, EACCES, a second
 * failure) propagates: swallowing it would leave a long-lived process on old
 * state that its next save writes over the file (#1951).
 */
function loadStateForReload(): LoadStateResult | null {
  try {
    return loadState();
  } catch (error) {
    const code = errnoCode(error) ?? '';
    if (code === 'ENOENT') return null;
    if (!TRANSIENT_READ_CODES.has(code)) throw error;
    warn(MODULE, `State reload hit ${code}, retrying once: ${errorMessage(error)}`);
  }
  sleepSync(LOCK_RETRY_INTERVAL_MS);
  return loadState();
}

/**
 * Re-read state from disk if the file has been modified since the last load/save.
 * Compares file identity (single statSync call) to avoid unnecessary JSON parsing;
 * a null baseline always reloads.
 * @returns The new state and identity if reloaded, or null if no change detected
 *   (or the file is gone).
 * @throws What {@link loadState} throws, after one retry for transient
 *   resource errors: a newer-version state file or a persistent file system
 *   error must reach the caller, not be served as stale state.
 */
export function reloadStateIfChanged(lastLoaded: StateFileIdentity | null): LoadStateResult | null {
  const statePath = getStatePath();
  let current: StateFileIdentity;
  try {
    current = statIdentitySync(statePath);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
    // File deleted: benign, keep the current in-memory state.
    warn(MODULE, `Failed to reload state from disk: ${errorMessage(error)}`);
    return null;
  }
  if (lastLoaded !== null && isSameIdentity(current, lastLoaded)) return null;
  // No re-stat here: loadState's baseline was taken BEFORE its read (or
  // after its own backup restore), and replacing it with a later stat would
  // pair the content we hold with a newer writer's identity, so the next
  // save would overwrite that writer without a ConcurrencyError. That holds
  // for the fresh-state recovery too (#2006). A baseline that is merely old
  // costs one more reload, which converges.
  return loadStateForReload();
}
