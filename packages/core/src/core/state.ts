/**
 * State management for the OSS Contribution Agent
 * Persists state to a JSON file in ~/.oss-autopilot/
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  AgentState,
  INITIAL_STATE,
  TrackedIssue,
  RepoScore,
  RepoScoreUpdate,
  StateEvent,
  StateEventType,
  DailyDigest,
  LocalRepoCache,
  SnoozeInfo,
  StatusOverride,
  FetchedPRStatus,
  isBelowMinStars,
} from './types.js';
import { getStatePath, getBackupDir, getDataDir } from './utils.js';
import { ValidationError, errorMessage } from './errors.js';
import { debug, warn } from './logger.js';

const MODULE = 'state';

// Current state version
const CURRENT_STATE_VERSION = 2;

// Maximum number of events to retain in the event log
const MAX_EVENTS = 1000;

/** Repo scores older than this are considered stale and excluded from low-scoring lists. */
const SCORE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

  // Extract merged/closed PR arrays from v1 state to seed repo scores
  const mergedPRs = (rawState.mergedPRs as Array<{ repo: string }> | undefined) || [];
  const closedPRs = (rawState.closedPRs as Array<{ repo: string }> | undefined) || [];

  // Update repo scores from historical PR data if not already present
  const repoScores = { ...((rawState.repoScores as AgentState['repoScores']) || {}) };

  for (const pr of mergedPRs) {
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
    // Note: Don't increment here as the score may already reflect these PRs
  }

  for (const pr of closedPRs) {
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
 * Singleton manager for persistent agent state stored in ~/.oss-autopilot/state.json.
 *
 * Handles loading, saving, backup/restore, and v1-to-v2 migration of state. Supports
 * an in-memory mode (no disk I/O) for use in tests. In v2 architecture, PR arrays are
 * legacy -- open PRs are fetched fresh from GitHub on each run rather than stored locally.
 */
export class StateManager {
  private state: AgentState;
  private readonly inMemoryOnly: boolean;

  /**
   * Create a new StateManager instance.
   * @param inMemoryOnly - When true, state is held only in memory and never read from or
   *   written to disk. Useful for unit tests that need isolated state without side effects.
   *   Defaults to false (normal persistent mode).
   */
  constructor(inMemoryOnly = false) {
    this.inMemoryOnly = inMemoryOnly;
    this.state = inMemoryOnly ? this.createFreshState() : this.load();
  }

  /**
   * Create a fresh state (v2: fresh GitHub fetching)
   */
  private createFreshState(): AgentState {
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
        snoozedPRs: {},
      },
      events: [],
      lastRunAt: new Date().toISOString(),
    };
  }

  /**
   * Check if initial setup has been completed.
   * @returns true if the user has run `/setup-oss` and completed configuration.
   */
  isSetupComplete(): boolean {
    return this.state.config.setupComplete === true;
  }

  /**
   * Mark setup as complete and record the completion timestamp.
   */
  markSetupComplete(): void {
    this.state.config.setupComplete = true;
    this.state.config.setupCompletedAt = new Date().toISOString();
  }

  /**
   * Initialize state with sensible defaults for zero-config onboarding.
   * Sets the GitHub username, marks setup as complete, and persists.
   * No-op if setup is already complete (prevents overwriting existing config).
   * @param username - The GitHub username to configure.
   */
  initializeWithDefaults(username: string): void {
    if (this.state.config.setupComplete) {
      debug(MODULE, `Setup already complete, skipping initializeWithDefaults for "${username}"`);
      return;
    }
    this.state.config.githubUsername = username;
    this.markSetupComplete();
    debug(MODULE, `Initialized with defaults for user "${username}"`);
    this.save();
  }

  /**
   * Migrate state from legacy ./data/ location to ~/.oss-autopilot/
   * Returns true if migration was performed
   */
  private migrateFromLegacyLocation(): boolean {
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
      const newStatePath = getStatePath();
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
   * Load state from file, or create initial state if none exists.
   * If the main state file is corrupted, attempts to restore from the most recent backup.
   * Performs migration from legacy ./data/ location if needed.
   */
  private load(): AgentState {
    // Try to migrate from legacy location first
    this.migrateFromLegacyLocation();

    const statePath = getStatePath();

    try {
      if (fs.existsSync(statePath)) {
        const data = fs.readFileSync(statePath, 'utf-8');
        let state = JSON.parse(data) as AgentState;

        // Validate required fields exist
        if (!this.isValidState(state)) {
          warn(MODULE, 'Invalid state file structure, attempting to restore from backup...');
          const restoredState = this.tryRestoreFromBackup();
          if (restoredState) {
            return restoredState;
          }
          warn(MODULE, 'No valid backup found, starting fresh');
          return this.createFreshState();
        }

        // Migrate from v1 to v2 if needed
        if (state.version === 1) {
          state = migrateV1ToV2(state as unknown as Record<string, unknown>);
          // Save the migrated state immediately (atomic write)
          atomicWriteFileSync(statePath, JSON.stringify(state, null, 2), 0o600);
          debug(MODULE, 'Migrated state saved');
        }

        // Log appropriate message based on version
        const repoCount = Object.keys(state.repoScores).length;
        debug(MODULE, `Loaded state v${state.version}: ${repoCount} repo scores tracked`);
        return state;
      }
    } catch (error) {
      warn(MODULE, 'Error loading state:', error);
      warn(MODULE, 'Attempting to restore from backup...');
      const restoredState = this.tryRestoreFromBackup();
      if (restoredState) {
        return restoredState;
      }
      warn(MODULE, 'No valid backup found, starting fresh');
    }

    debug(MODULE, 'No existing state found, initializing...');
    return this.createFreshState();
  }

  /**
   * Attempt to restore state from the most recent valid backup.
   * Returns the restored state if successful, or null if no valid backup is found.
   */
  private tryRestoreFromBackup(): AgentState | null {
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

        if (this.isValidState(state)) {
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
   * Validate that a loaded state has the required structure
   * Handles both v1 (with PR arrays) and v2 (without)
   */
  private isValidState(state: unknown): state is AgentState {
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
   * Persist the current state to disk, creating a timestamped backup of the previous
   * state file first. Updates `lastRunAt` to the current time. In in-memory mode,
   * only updates `lastRunAt` without any file I/O. Retains at most 10 backup files.
   */
  save(): void {
    // Update lastRunAt
    this.state.lastRunAt = new Date().toISOString();

    // Skip file operations in in-memory mode
    if (this.inMemoryOnly) {
      return;
    }

    const statePath = getStatePath();
    const lockPath = statePath + '.lock';
    const backupDir = getBackupDir();

    // Acquire advisory lock to prevent concurrent writes
    acquireLock(lockPath);

    try {
      // Create backup of existing state
      if (fs.existsSync(statePath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const randomSuffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
        const backupFile = path.join(backupDir, `state-${timestamp}-${randomSuffix}.json`);
        fs.copyFileSync(statePath, backupFile);
        fs.chmodSync(backupFile, 0o600);

        // Keep only last 10 backups
        this.cleanupBackups();
      }

      // Atomic write: write to temp file then rename to prevent corruption on crash
      atomicWriteFileSync(statePath, JSON.stringify(this.state, null, 2), 0o600);
      debug(MODULE, 'State saved successfully');
    } finally {
      releaseLock(lockPath);
    }
  }

  private cleanupBackups(): void {
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
   * Get the current state as a read-only snapshot.
   * @returns The full agent state. Callers should not mutate the returned object;
   *   use the StateManager methods to make changes.
   */
  getState(): Readonly<AgentState> {
    return this.state;
  }

  /**
   * Store the latest daily digest for dashboard rendering.
   * @param digest - The freshly generated digest from the current daily run.
   */
  setLastDigest(digest: DailyDigest): void {
    this.state.lastDigest = digest;
    this.state.lastDigestAt = digest.generatedAt;
  }

  /**
   * Store monthly merged PR counts for the contribution timeline chart.
   * @param counts - Map of "YYYY-MM" strings to merged PR counts for that month.
   */
  setMonthlyMergedCounts(counts: Record<string, number>): void {
    this.state.monthlyMergedCounts = counts;
  }

  /**
   * Store monthly closed (without merge) PR counts for the contribution timeline and success rate charts.
   * @param counts - Map of "YYYY-MM" strings to closed PR counts for that month.
   */
  setMonthlyClosedCounts(counts: Record<string, number>): void {
    this.state.monthlyClosedCounts = counts;
  }

  /**
   * Store monthly opened PR counts for the contribution timeline chart.
   * @param counts - Map of "YYYY-MM" strings to opened PR counts for that month.
   */
  setMonthlyOpenedCounts(counts: Record<string, number>): void {
    this.state.monthlyOpenedCounts = counts;
  }

  setDailyActivityCounts(counts: Record<string, number>): void {
    this.state.dailyActivityCounts = counts;
  }

  /**
   * Store cached local repo scan results (#84).
   * @param cache - The scan results, paths scanned, and timestamp.
   */
  setLocalRepoCache(cache: LocalRepoCache): void {
    this.state.localRepoCache = cache;
  }

  /**
   * Shallow-merge partial configuration updates into the current config.
   * @param config - Partial config object whose properties override existing values.
   */
  updateConfig(config: Partial<AgentState['config']>): void {
    this.state.config = { ...this.state.config, ...config };
  }

  // === Event Logging ===

  /**
   * Append an event to the event log. Events are capped at {@link MAX_EVENTS} (1000);
   * when the cap is exceeded, the oldest events are trimmed to stay within the limit.
   * @param type - The event type (e.g. 'pr_tracked').
   * @param data - Arbitrary key-value payload for the event.
   */
  appendEvent(type: StateEventType, data: Record<string, unknown>): void {
    const event: StateEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      at: new Date().toISOString(),
      data,
    };
    this.state.events.push(event);

    // Cap the events array to prevent unbounded growth
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events = this.state.events.slice(-MAX_EVENTS);
    }
  }

  /**
   * Filter the event log to events of a specific type.
   * @param type - The event type to filter by.
   * @returns All events matching the given type, in chronological order.
   */
  getEventsByType(type: StateEventType): StateEvent[] {
    return this.state.events.filter((e) => e.type === type);
  }

  /**
   * Filter the event log to events within an inclusive time range.
   * @param since - Start of the range (inclusive).
   * @param until - End of the range (inclusive). Defaults to now.
   * @returns Events whose timestamps fall within [since, until].
   */
  getEventsInRange(since: Date, until: Date = new Date()): StateEvent[] {
    return this.state.events.filter((e) => {
      const eventTime = new Date(e.at);
      return eventTime >= since && eventTime <= until;
    });
  }

  // === Issue Management ===

  /**
   * Add an issue to the active tracking list. If an issue with the same URL is
   * already tracked, the call is a no-op.
   * @param issue - The issue to begin tracking.
   */
  addIssue(issue: TrackedIssue): void {
    const existing = this.state.activeIssues.find((i) => i.url === issue.url);
    if (existing) {
      debug(MODULE, `Issue ${issue.url} already tracked`);
      return;
    }

    this.state.activeIssues.push(issue);
    debug(MODULE, `Added issue: ${issue.repo}#${issue.number}`);
  }

  // === Trusted Projects ===

  /**
   * Add a repository to the trusted projects list. Trusted projects are prioritized
   * in issue search results. No-op if the repo is already trusted.
   * @param repo - Repository in "owner/repo" format.
   */
  addTrustedProject(repo: string): void {
    if (!this.state.config.trustedProjects.includes(repo)) {
      this.state.config.trustedProjects.push(repo);
      debug(MODULE, `Added trusted project: ${repo}`);
    }
  }

  /**
   * Test whether a repo matches any of the given exclusion lists.
   * Both repo and org comparisons are case-insensitive (GitHub names are case-insensitive).
   * @param repo  - Repository in "owner/repo" format.
   * @param repos - Full "owner/repo" strings (case-insensitive match).
   * @param orgs  - Org names (case-insensitive match against the owner segment of the repo).
   */
  private static matchesExclusion(repo: string, repos: string[], orgs?: string[]): boolean {
    const repoLower = repo.toLowerCase();
    if (repos.some((r) => r.toLowerCase() === repoLower)) return true;
    if (orgs?.some((o) => o.toLowerCase() === repoLower.split('/')[0])) return true;
    return false;
  }

  /**
   * Check whether a repository matches any exclusion rule from the current config.
   * A repo is excluded if it matches an entry in `excludeRepos` (case-insensitive)
   * or if its owner segment matches an entry in `excludeOrgs` (case-insensitive).
   * @param repo - Repository in "owner/repo" format.
   */
  private isExcluded(repo: string): boolean {
    const { excludeRepos, excludeOrgs } = this.state.config;
    return StateManager.matchesExclusion(repo, excludeRepos, excludeOrgs);
  }

  /**
   * Remove repositories matching the given exclusion lists from `trustedProjects`
   * and `repoScores`. Called when a repo or org is newly excluded to keep stored
   * data consistent with current filters.
   * @param repos - Full "owner/repo" strings to exclude (case-insensitive match).
   * @param orgs  - Org names to exclude (case-insensitive match against owner segment).
   */
  cleanupExcludedData(repos: string[], orgs: string[]): void {
    const matches = (repo: string): boolean => StateManager.matchesExclusion(repo, repos, orgs);

    const beforeTrusted = this.state.config.trustedProjects.length;
    this.state.config.trustedProjects = this.state.config.trustedProjects.filter((p) => !matches(p));
    const removedTrusted = beforeTrusted - this.state.config.trustedProjects.length;

    let removedScoreCount = 0;
    for (const key of Object.keys(this.state.repoScores)) {
      if (matches(key)) {
        delete this.state.repoScores[key];
        removedScoreCount++;
      }
    }

    if (removedTrusted > 0 || removedScoreCount > 0) {
      debug(
        MODULE,
        `Removed ${removedTrusted} trusted project(s) and ${removedScoreCount} repo score(s) for excluded repos/orgs`,
      );
    }
  }

  // === Starred Repos Management ===

  /**
   * Get the cached list of the user's GitHub starred repositories.
   * @returns Array of "owner/repo" strings, or an empty array if never fetched.
   */
  getStarredRepos(): string[] {
    return this.state.config.starredRepos || [];
  }

  /**
   * Replace the cached starred repositories list and update the fetch timestamp.
   * @param repos - Array of "owner/repo" strings from the user's GitHub stars.
   */
  setStarredRepos(repos: string[]): void {
    this.state.config.starredRepos = repos;
    this.state.config.starredReposLastFetched = new Date().toISOString();
    debug(MODULE, `Updated starred repos: ${repos.length} repositories`);
  }

  /**
   * Check if the starred repos cache is stale (older than 24 hours) or has never been fetched.
   * @returns true if the cache should be refreshed.
   */
  isStarredReposStale(): boolean {
    const lastFetched = this.state.config.starredReposLastFetched;
    if (!lastFetched) {
      return true;
    }

    const staleThresholdMs = 24 * 60 * 60 * 1000; // 24 hours
    const lastFetchedDate = new Date(lastFetched);
    const now = new Date();
    return now.getTime() - lastFetchedDate.getTime() > staleThresholdMs;
  }

  // === Shelve/Unshelve ===

  /**
   * Shelve a PR by URL. Shelved PRs are excluded from capacity and actionable issues.
   * They are auto-unshelved when a maintainer engages (needs_response, needs_changes, etc.).
   * @param url - The full GitHub PR URL.
   * @returns true if newly added, false if already shelved.
   */
  shelvePR(url: string): boolean {
    if (!this.state.config.shelvedPRUrls) {
      this.state.config.shelvedPRUrls = [];
    }
    if (this.state.config.shelvedPRUrls.includes(url)) {
      return false;
    }
    this.state.config.shelvedPRUrls.push(url);
    return true;
  }

  /**
   * Unshelve a PR by URL.
   * @param url - The full GitHub PR URL.
   * @returns true if found and removed, false if not shelved.
   */
  unshelvePR(url: string): boolean {
    if (!this.state.config.shelvedPRUrls) {
      return false;
    }
    const index = this.state.config.shelvedPRUrls.indexOf(url);
    if (index === -1) {
      return false;
    }
    this.state.config.shelvedPRUrls.splice(index, 1);
    return true;
  }

  /**
   * Check if a PR is shelved.
   * @param url - The full GitHub PR URL.
   * @returns true if the URL is in the shelved list.
   */
  isPRShelved(url: string): boolean {
    return this.state.config.shelvedPRUrls?.includes(url) ?? false;
  }

  // === Dismiss / Undismiss Issues ===

  /**
   * Dismiss an issue or PR by URL. Dismissed URLs are excluded from `new_response` notifications
   * until new activity occurs after the dismiss timestamp.
   * @param url - The full GitHub issue or PR URL.
   * @param timestamp - ISO timestamp of when the issue/PR was dismissed.
   * @returns true if newly dismissed, false if already dismissed.
   */
  dismissIssue(url: string, timestamp: string): boolean {
    if (!this.state.config.dismissedIssues) {
      this.state.config.dismissedIssues = {};
    }
    if (url in this.state.config.dismissedIssues) {
      return false;
    }
    this.state.config.dismissedIssues[url] = timestamp;
    return true;
  }

  /**
   * Undismiss an issue or PR by URL.
   * @param url - The full GitHub issue or PR URL.
   * @returns true if found and removed, false if not dismissed.
   */
  undismissIssue(url: string): boolean {
    if (!this.state.config.dismissedIssues || !(url in this.state.config.dismissedIssues)) {
      return false;
    }
    delete this.state.config.dismissedIssues[url];
    return true;
  }

  /**
   * Get the timestamp when an issue or PR was dismissed.
   * @param url - The full GitHub issue or PR URL.
   * @returns The ISO dismiss timestamp, or undefined if not dismissed.
   */
  getIssueDismissedAt(url: string): string | undefined {
    return this.state.config.dismissedIssues?.[url];
  }

  // === Snooze / Unsnooze CI Failures ===

  /**
   * Snooze a PR's CI failure for a given number of days.
   * Snoozed PRs are excluded from actionable CI failure lists until the snooze expires.
   * @param url - The full GitHub PR URL.
   * @param reason - Why the CI failure is being snoozed (e.g., "upstream infrastructure issue").
   * @param durationDays - Number of days to snooze. Default 7.
   * @returns true if newly snoozed, false if already snoozed.
   */
  snoozePR(url: string, reason: string, durationDays: number): boolean {
    if (!Number.isFinite(durationDays) || durationDays <= 0) {
      throw new ValidationError(`Invalid snooze duration: ${durationDays}. Must be a positive finite number.`);
    }
    if (!this.state.config.snoozedPRs) {
      this.state.config.snoozedPRs = {};
    }
    if (url in this.state.config.snoozedPRs) {
      return false;
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    this.state.config.snoozedPRs[url] = {
      reason,
      snoozedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    return true;
  }

  /**
   * Unsnooze a PR by URL.
   * @param url - The full GitHub PR URL.
   * @returns true if found and removed, false if not snoozed.
   */
  unsnoozePR(url: string): boolean {
    if (!this.state.config.snoozedPRs || !(url in this.state.config.snoozedPRs)) {
      return false;
    }
    delete this.state.config.snoozedPRs[url];
    return true;
  }

  /**
   * Check if a PR is currently snoozed (not expired).
   * @param url - The full GitHub PR URL.
   * @returns true if the PR is snoozed and the snooze has not expired.
   */
  isSnoozed(url: string): boolean {
    const info = this.getSnoozeInfo(url);
    if (!info) return false;
    const expiresAtMs = new Date(info.expiresAt).getTime();
    if (isNaN(expiresAtMs)) {
      warn(MODULE, `Invalid expiresAt for snoozed PR ${url}: "${info.expiresAt}". Treating as not snoozed.`);
      return false;
    }
    return expiresAtMs > Date.now();
  }

  /**
   * Get snooze metadata for a PR.
   * @param url - The full GitHub PR URL.
   * @returns The snooze metadata, or undefined if not snoozed.
   */
  getSnoozeInfo(url: string): SnoozeInfo | undefined {
    return this.state.config.snoozedPRs?.[url];
  }

  /**
   * Expire all snoozes that are past their `expiresAt` timestamp.
   * @returns Array of PR URLs whose snoozes were expired.
   */
  expireSnoozes(): string[] {
    if (!this.state.config.snoozedPRs) return [];
    const expired: string[] = [];
    const now = Date.now();
    for (const [url, info] of Object.entries(this.state.config.snoozedPRs)) {
      const expiresAtMs = new Date(info.expiresAt).getTime();
      if (isNaN(expiresAtMs) || expiresAtMs <= now) {
        expired.push(url);
      }
    }
    for (const url of expired) {
      delete this.state.config.snoozedPRs![url];
    }
    return expired;
  }

  // === Status Overrides ===

  /**
   * Set a manual status override for a PR.
   * @param url - The full GitHub PR URL.
   * @param status - The target status to override to.
   * @param lastActivityAt - The PR's current updatedAt timestamp (for auto-clear detection).
   */
  setStatusOverride(url: string, status: FetchedPRStatus, lastActivityAt: string): void {
    if (!this.state.config.statusOverrides) {
      this.state.config.statusOverrides = {};
    }
    this.state.config.statusOverrides[url] = {
      status,
      setAt: new Date().toISOString(),
      lastActivityAt,
    };
  }

  /**
   * Clear a status override for a PR.
   * @param url - The full GitHub PR URL.
   * @returns true if found and removed, false if no override existed.
   */
  clearStatusOverride(url: string): boolean {
    if (!this.state.config.statusOverrides || !(url in this.state.config.statusOverrides)) {
      return false;
    }
    delete this.state.config.statusOverrides[url];
    return true;
  }

  /**
   * Get the status override for a PR, if one exists and hasn't been auto-cleared.
   * @param url - The full GitHub PR URL.
   * @param currentUpdatedAt - The PR's current updatedAt from GitHub. If newer than
   *   the stored lastActivityAt, the override is stale and auto-cleared.
   * @returns The override metadata, or undefined if none exists or it was auto-cleared.
   */
  getStatusOverride(url: string, currentUpdatedAt?: string): StatusOverride | undefined {
    const override = this.state.config.statusOverrides?.[url];
    if (!override) return undefined;

    // Auto-clear if the PR has new activity since the override was set
    if (currentUpdatedAt && currentUpdatedAt > override.lastActivityAt) {
      this.clearStatusOverride(url);
      return undefined;
    }
    return override;
  }

  // === Repository Scoring ===

  /**
   * Get the score record for a repository.
   * @param repo - Repository in "owner/repo" format.
   * @returns The RepoScore if the repo has been scored, or undefined if never evaluated.
   */
  getRepoScore(repo: string): RepoScore | undefined {
    return this.state.repoScores[repo];
  }

  /**
   * Create a default repo score for a new repository
   */
  private createDefaultRepoScore(repo: string): RepoScore {
    return {
      repo,
      score: 5, // Base score
      mergedPRCount: 0,
      closedWithoutMergeCount: 0,
      avgResponseDays: null,
      lastEvaluatedAt: new Date().toISOString(),
      signals: {
        hasActiveMaintainers: true, // Assume positive by default
        isResponsive: false,
        hasHostileComments: false,
      },
    };
  }

  /**
   * Calculate the score based on the repo's metrics.
   * Base 5, logarithmic merge bonus (max +5), -1 per closed without merge (max -3),
   * +1 if recently merged (within 90 days), +1 if responsive, -2 if hostile. Clamp 1-10.
   */
  private calculateScore(repoScore: RepoScore): number {
    let score = 5; // Base score

    // Logarithmic merge bonus (max +5): 1→+2, 2→+3, 3→+4, 5+→+5
    if (repoScore.mergedPRCount > 0) {
      const mergedBonus = Math.min(Math.round(Math.log2(repoScore.mergedPRCount + 1) * 2), 5);
      score += mergedBonus;
    }

    // -1 per closed without merge (max -3)
    const closedPenalty = Math.min(repoScore.closedWithoutMergeCount, 3);
    score -= closedPenalty;

    // +1 if lastMergedAt is set and within 90 days (recency)
    if (repoScore.lastMergedAt) {
      const lastMergedDate = new Date(repoScore.lastMergedAt);
      if (isNaN(lastMergedDate.getTime())) {
        warn(
          MODULE,
          `Invalid lastMergedAt date for ${repoScore.repo}: "${repoScore.lastMergedAt}". Skipping recency bonus.`,
        );
      } else {
        const msPerDay = 1000 * 60 * 60 * 24;
        const daysSince = Math.floor((Date.now() - lastMergedDate.getTime()) / msPerDay);
        if (daysSince <= 90) {
          score += 1;
        }
      }
    }

    // +1 if responsive
    if (repoScore.signals.isResponsive) {
      score += 1;
    }

    // -2 if hostile
    if (repoScore.signals.hasHostileComments) {
      score -= 2;
    }

    // Clamp to 1-10
    return Math.max(1, Math.min(10, score));
  }

  /**
   * Update a repository's score with partial updates. If the repo has no existing score,
   * a default score record is created first (base score 5). After applying updates, the
   * numeric score is recalculated using the formula: base 5, logarithmic merge bonus (max +5),
   * -1 per closed-without-merge (max -3), +1 if recently merged, +1 if responsive, -2 if hostile, clamped to [1, 10].
   * @param repo - Repository in "owner/repo" format.
   * @param updates - Updatable RepoScore fields to merge. The `score`, `repo`, and
   *   `lastEvaluatedAt` fields are not accepted — score is always derived via
   *   calculateScore(), and repo/lastEvaluatedAt are managed internally.
   */
  updateRepoScore(repo: string, updates: RepoScoreUpdate): void {
    if (!this.state.repoScores[repo]) {
      this.state.repoScores[repo] = this.createDefaultRepoScore(repo);
    }

    const repoScore = this.state.repoScores[repo];

    // Apply updates
    if (updates.mergedPRCount !== undefined) {
      repoScore.mergedPRCount = updates.mergedPRCount;
    }
    if (updates.closedWithoutMergeCount !== undefined) {
      repoScore.closedWithoutMergeCount = updates.closedWithoutMergeCount;
    }
    if (updates.avgResponseDays !== undefined) {
      repoScore.avgResponseDays = updates.avgResponseDays;
    }
    if (updates.lastMergedAt !== undefined) {
      repoScore.lastMergedAt = updates.lastMergedAt;
    }
    if (updates.stargazersCount !== undefined) {
      repoScore.stargazersCount = updates.stargazersCount;
    }
    if (updates.signals) {
      repoScore.signals = { ...repoScore.signals, ...updates.signals };
    }

    // Recalculate score
    repoScore.score = this.calculateScore(repoScore);
    repoScore.lastEvaluatedAt = new Date().toISOString();

    debug(MODULE, `Updated repo score for ${repo}: ${repoScore.score}/10`);
  }

  /**
   * Increment the merged PR count for a repository and recalculate its score.
   * Routes through {@link updateRepoScore} for a single mutation path.
   * @param repo - Repository in "owner/repo" format.
   */
  incrementMergedCount(repo: string): void {
    const current = this.state.repoScores[repo];
    const newCount = (current?.mergedPRCount ?? 0) + 1;
    this.updateRepoScore(repo, {
      mergedPRCount: newCount,
      lastMergedAt: new Date().toISOString(),
    });
    debug(MODULE, `Incremented merged count for ${repo}: ${newCount}`);
  }

  /**
   * Increment the closed-without-merge count for a repository and recalculate its score.
   * Routes through {@link updateRepoScore} for a single mutation path.
   * @param repo - Repository in "owner/repo" format.
   */
  incrementClosedCount(repo: string): void {
    const current = this.state.repoScores[repo];
    const newCount = (current?.closedWithoutMergeCount ?? 0) + 1;
    this.updateRepoScore(repo, {
      closedWithoutMergeCount: newCount,
    });
    debug(MODULE, `Incremented closed count for ${repo}: ${newCount}`);
  }

  /**
   * Mark a repository as having hostile maintainer comments and recalculate its score.
   * This applies a -2 penalty to the score. Creates a default score record if needed.
   * @param repo - Repository in "owner/repo" format.
   */
  markRepoHostile(repo: string): void {
    this.updateRepoScore(repo, { signals: { hasHostileComments: true } });
    debug(MODULE, `Marked ${repo} as hostile, score: ${this.state.repoScores[repo].score}/10`);
  }

  /**
   * Get repositories where the user has at least one merged PR, sorted by merged count descending.
   * These repos represent proven relationships with high merge probability.
   * @returns Array of "owner/repo" strings for repos with mergedPRCount > 0.
   */
  getReposWithMergedPRs(): string[] {
    return Object.values(this.state.repoScores)
      .filter((rs) => rs.mergedPRCount > 0)
      .sort((a, b) => b.mergedPRCount - a.mergedPRCount)
      .map((rs) => rs.repo);
  }

  /**
   * Get repositories where the user has interacted (has a score record) but has NOT
   * yet had a PR merged, excluding repos where the only interaction was rejection.
   * These represent repos with open or in-progress PRs — relationships that benefit
   * from continued search attention.
   * @returns Array of "owner/repo" strings, sorted by score descending.
   */
  getReposWithOpenPRs(): string[] {
    return Object.values(this.state.repoScores)
      .filter((rs) => rs.mergedPRCount === 0 && rs.closedWithoutMergeCount === 0)
      .sort((a, b) => b.score - a.score)
      .map((rs) => rs.repo);
  }

  /**
   * Get repositories with a score at or above the given threshold, sorted highest first.
   * @param minScore - Minimum score (inclusive). Defaults to `config.minRepoScoreThreshold`.
   * @returns Array of "owner/repo" strings for repos meeting the threshold.
   */
  getHighScoringRepos(minScore?: number): string[] {
    const threshold = minScore ?? this.state.config.minRepoScoreThreshold;
    return Object.values(this.state.repoScores)
      .filter((rs) => rs.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .map((rs) => rs.repo);
  }

  /**
   * Get repositories with a score at or below the given threshold, sorted lowest first.
   * @param maxScore - Maximum score (inclusive). Defaults to `config.minRepoScoreThreshold`.
   * @returns Array of "owner/repo" strings for repos at or below the threshold.
   */
  getLowScoringRepos(maxScore?: number): string[] {
    const threshold = maxScore ?? this.state.config.minRepoScoreThreshold;
    const now = Date.now();
    return Object.values(this.state.repoScores)
      .filter((rs) => {
        if (rs.score > threshold) return false;
        // Stale scores (>30 days) should not permanently block repos (#487)
        const age = now - new Date(rs.lastEvaluatedAt).getTime();
        if (!Number.isFinite(age)) {
          warn(MODULE, `Invalid lastEvaluatedAt for repo ${rs.repo}: "${rs.lastEvaluatedAt}", treating as stale`);
          return false;
        }
        return age <= SCORE_TTL_MS;
      })
      .sort((a, b) => a.score - b.score)
      .map((rs) => rs.repo);
  }

  // === Statistics ===

  /**
   * Compute aggregate statistics from the current state. `mergedPRs` and `closedPRs` counts
   * are summed from repo score records, excluding repos that match `excludeRepos` or `excludeOrgs`
   * in the config (#211). `totalTracked` reflects the number of non-excluded repositories with
   * score records.
   * @returns A Stats snapshot computed from the current state.
   */
  getStats(): Stats {
    // v2: Calculate from repoScores, filtering out excluded repos/orgs (#211)
    let totalMerged = 0;
    let totalClosed = 0;
    let totalTracked = 0;

    for (const [repoKey, score] of Object.entries(this.state.repoScores)) {
      if (this.isExcluded(repoKey)) continue;
      if (isBelowMinStars(score.stargazersCount, this.state.config.minStars ?? 50)) continue;
      totalTracked++;
      totalMerged += score.mergedPRCount;
      totalClosed += score.closedWithoutMergeCount;
    }

    const completed = totalMerged + totalClosed;
    const mergeRate = completed > 0 ? (totalMerged / completed) * 100 : 0;

    return {
      mergedPRs: totalMerged,
      closedPRs: totalClosed,
      activeIssues: 0,
      trustedProjects: this.state.config.trustedProjects.filter((p) => !this.isExcluded(p)).length,
      mergeRate: mergeRate.toFixed(1) + '%',
      totalTracked,
      needsResponse: 0,
    };
  }
}

/**
 * Aggregate statistics returned by {@link StateManager.getStats}.
 */
export interface Stats {
  /** Total merged PRs across scored repositories (excludes repos/orgs in exclusion config). */
  mergedPRs: number;
  /** Total PRs closed without merge across scored repositories (excludes repos/orgs in exclusion config). */
  closedPRs: number;
  /** Number of active issues. Always 0 in v2 (sourced from fresh fetch instead). */
  activeIssues: number;
  /** Number of trusted projects (excludes repos/orgs in exclusion config). */
  trustedProjects: number;
  /** Merge success rate as a percentage string (e.g. "75.0%"). */
  mergeRate: string;
  /** Number of scored repositories (excludes repos/orgs in exclusion config). */
  totalTracked: number;
  /** Number of PRs needing a response. Always 0 in v2 (sourced from fresh fetch instead). */
  needsResponse: number;
}

// Singleton instance
let stateManager: StateManager | null = null;

/**
 * Get the singleton StateManager instance, creating it on first call.
 * Subsequent calls return the same instance. Use {@link resetStateManager} to
 * clear the singleton (primarily for testing).
 * @returns The shared StateManager instance.
 */
export function getStateManager(): StateManager {
  if (!stateManager) {
    stateManager = new StateManager();
  }
  return stateManager;
}

/**
 * Reset the singleton StateManager instance to null. The next call to
 * {@link getStateManager} will create a fresh instance. Intended for test
 * isolation -- should not be called in production code.
 */
export function resetStateManager(): void {
  stateManager = null;
}
