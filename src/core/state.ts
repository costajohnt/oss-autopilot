/**
 * State management for the OSS Contribution Agent
 * Persists state to a JSON file in ~/.oss-autopilot/
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentState, INITIAL_STATE, TrackedPR, TrackedIssue, RepoScore, RepoScoreUpdate, StateEvent, StateEventType, DailyDigest, LocalRepoCache } from './types.js';
import { getStatePath, getBackupDir, getDataDir } from './utils.js';

// Current state version
const CURRENT_STATE_VERSION = 2;

// Maximum number of events to retain in the event log
const MAX_EVENTS = 1000;

// Legacy path for migration
const LEGACY_STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const LEGACY_BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');

/**
 * Migrate state from v1 (local PR tracking) to v2 (fresh GitHub fetching)
 * - Preserves repoScores (used for search prioritization)
 * - Preserves config
 * - Drops PR/issue arrays (no longer needed - fetched fresh from GitHub)
 */
function migrateV1ToV2(state: AgentState): AgentState {
  console.error('Migrating state from v1 to v2 (fresh GitHub fetching)...');

  // Extract merged PR count per repo for scoring
  const mergedPRs = state.mergedPRs || [];
  const closedPRs = state.closedPRs || [];

  // Update repo scores from historical PR data if not already present
  const repoScores = { ...state.repoScores };

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
    // Keep PR arrays for history but don't actively track
    activePRs: [], // Clear active - will be fetched fresh
    activeIssues: state.activeIssues || [],
    dormantPRs: state.dormantPRs || [],
    mergedPRs: state.mergedPRs || [],
    closedPRs: state.closedPRs || [],
    repoScores,
    config: state.config,
    events: state.events || [],
    lastRunAt: new Date().toISOString(),
  };

  console.error(`Migration complete. Preserved ${Object.keys(repoScores).length} repo scores.`);
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
      activePRs: [],
      activeIssues: [],
      dormantPRs: [],
      mergedPRs: [],
      closedPRs: [],
      repoScores: {},
      config: {
        ...INITIAL_STATE.config,
        setupComplete: false,
        languages: [...INITIAL_STATE.config.languages],
        labels: [...INITIAL_STATE.config.labels],
        excludeRepos: [],
        trustedProjects: [],
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

    console.error('Migrating state from ./data/ to ~/.oss-autopilot/...');

    try {
      // Ensure the new data directory exists
      getDataDir();

      // Copy state file
      fs.copyFileSync(LEGACY_STATE_FILE, newStatePath);
      console.error(`Migrated state file to ${newStatePath}`);

      // Copy backups if they exist
      if (fs.existsSync(LEGACY_BACKUP_DIR)) {
        const newBackupDir = getBackupDir();
        const backupFiles = fs.readdirSync(LEGACY_BACKUP_DIR)
          .filter(f => f.startsWith('state-') && f.endsWith('.json'));

        for (const backupFile of backupFiles) {
          const srcPath = path.join(LEGACY_BACKUP_DIR, backupFile);
          const destPath = path.join(newBackupDir, backupFile);
          fs.copyFileSync(srcPath, destPath);
        }
        console.error(`Migrated ${backupFiles.length} backup files`);
      }

      // Remove legacy files
      fs.unlinkSync(LEGACY_STATE_FILE);
      console.error('Removed legacy state file');

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
          console.error('Removed empty legacy data directory');
        }
      }

      console.error('Migration complete!');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MIGRATION ERROR] Failed to migrate state: ${errorMessage}`);

      // Clean up partial migration to avoid inconsistent state
      const newStatePath = getStatePath();
      if (fs.existsSync(newStatePath) && fs.existsSync(LEGACY_STATE_FILE)) {
        // If both files exist, the migration was partial - remove the new file
        try {
          fs.unlinkSync(newStatePath);
          console.error('Cleaned up partial migration - removed incomplete new state file');
        } catch {
          console.error('Warning: Could not clean up partial migration file');
        }
      }

      console.error('');
      console.error('To resolve this issue:');
      console.error('  1. Ensure you have write permissions to ~/.oss-autopilot/');
      console.error('  2. Check available disk space');
      console.error('  3. Manually copy ./data/state.json to ~/.oss-autopilot/state.json');
      console.error('  4. Or delete ./data/state.json to start fresh');

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
          console.error('Invalid state file structure, attempting to restore from backup...');
          const restoredState = this.tryRestoreFromBackup();
          if (restoredState) {
            return restoredState;
          }
          console.error('No valid backup found, starting fresh');
          return this.createFreshState();
        }

        // Migrate from v1 to v2 if needed
        if (state.version === 1) {
          state = migrateV1ToV2(state);
          // Save the migrated state immediately
          fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
          console.error('Migrated state saved');
        }

        // Log appropriate message based on version
        const repoCount = Object.keys(state.repoScores).length;
        console.error(`Loaded state v${state.version}: ${repoCount} repo scores tracked`);
        return state;
      }
    } catch (error) {
      console.error('Error loading state:', error);
      console.error('Attempting to restore from backup...');
      const restoredState = this.tryRestoreFromBackup();
      if (restoredState) {
        return restoredState;
      }
      console.error('No valid backup found, starting fresh');
    }

    console.error('No existing state found, initializing...');
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
    const backupFiles = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('state-') && f.endsWith('.json'))
      .sort()
      .reverse();

    for (const backupFile of backupFiles) {
      const backupPath = path.join(backupDir, backupFile);
      try {
        const data = fs.readFileSync(backupPath, 'utf-8');
        let state = JSON.parse(data) as AgentState;

        if (this.isValidState(state)) {
          console.error(`Successfully restored state from backup: ${backupFile}`);

          // Migrate from v1 to v2 if needed
          if (state.version === 1) {
            state = migrateV1ToV2(state);
          }

          const repoCount = Object.keys(state.repoScores).length;
          console.error(`Restored state v${state.version}: ${repoCount} repo scores`);

          // Overwrite the corrupted main state file with the restored backup
          const statePath = getStatePath();
          fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
          console.error('Restored backup written to main state file');

          return state;
        }
      } catch (error) {
        // This backup is also corrupted, try the next one
        console.warn(`Backup ${backupFile} is corrupted, trying next...`);
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
    const hasBaseFields = (
      typeof s.version === 'number' &&
      typeof s.repoScores === 'object' &&
      s.repoScores !== null &&
      Array.isArray(s.events) &&
      typeof s.config === 'object' &&
      s.config !== null
    );

    if (!hasBaseFields) return false;

    // v1 requires PR arrays
    if (s.version === 1) {
      return (
        Array.isArray(s.activePRs) &&
        Array.isArray(s.activeIssues) &&
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
    const backupDir = getBackupDir();

    // Create backup of existing state
    if (fs.existsSync(statePath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const randomSuffix = Math.random().toString(36).slice(2, 8);
      const backupFile = path.join(backupDir, `state-${timestamp}-${randomSuffix}.json`);
      fs.copyFileSync(statePath, backupFile);
      fs.chmodSync(backupFile, 0o600);

      // Keep only last 10 backups
      this.cleanupBackups();
    }

    // Save state with restricted permissions (owner-only read/write)
    // Note: writeFileSync mode only applies on file creation; chmodSync enforces it on existing files
    fs.writeFileSync(statePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.chmodSync(statePath, 0o600);
    console.error('State saved successfully');
  }

  private cleanupBackups(): void {
    const backupDir = getBackupDir();
    try {
      const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('state-'))
        .sort()
        .reverse();

      // Keep only the 10 most recent backups
      for (const file of files.slice(10)) {
        try {
          fs.unlinkSync(path.join(backupDir, file));
        } catch (error) {
          console.error(`Warning: Could not delete old backup ${file}:`, error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      console.error('Warning: Could not clean up backups:', error instanceof Error ? error.message : error);
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
    return this.state.events.filter(e => e.type === type);
  }

  /**
   * Filter the event log to events within an inclusive time range.
   * @param since - Start of the range (inclusive).
   * @param until - End of the range (inclusive). Defaults to now.
   * @returns Events whose timestamps fall within [since, until].
   */
  getEventsInRange(since: Date, until: Date = new Date()): StateEvent[] {
    return this.state.events.filter(e => {
      const eventTime = new Date(e.at);
      return eventTime >= since && eventTime <= until;
    });
  }

  // === PR Management ===

  /**
   * Add a PR to the active tracking list. If a PR with the same URL is already
   * tracked, the call is a no-op (logs a warning but does not duplicate).
   * Also appends a 'pr_tracked' event.
   * @param pr - The PR to begin tracking.
   */
  addActivePR(pr: TrackedPR): void {
    // Check if already exists
    const existing = this.state.activePRs.find(p => p.url === pr.url);
    if (existing) {
      console.error(`PR ${pr.url} already tracked`);
      return;
    }

    this.state.activePRs.push(pr);
    this.appendEvent('pr_tracked', {
      url: pr.url,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
    });
    console.error(`Added active PR: ${pr.repo}#${pr.number}`);
  }

  // === Issue Management ===

  /**
   * Add an issue to the active tracking list. If an issue with the same URL is
   * already tracked, the call is a no-op.
   * @param issue - The issue to begin tracking.
   */
  addIssue(issue: TrackedIssue): void {
    const existing = this.state.activeIssues.find(i => i.url === issue.url);
    if (existing) {
      console.error(`Issue ${issue.url} already tracked`);
      return;
    }

    this.state.activeIssues.push(issue);
    console.error(`Added issue: ${issue.repo}#${issue.number}`);
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
      console.error(`Added trusted project: ${repo}`);
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
    console.error(`Updated starred repos: ${repos.length} repositories`);
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

  // === PR Utilities ===

  /**
   * Remove a PR from tracking entirely (active or dormant list). Does not move it
   * to merged/closed -- the PR is simply dropped from state.
   * @param url - The full GitHub PR URL.
   * @returns true if the PR was found and removed, false if not found.
   */
  untrackPR(url: string): boolean {
    // Check active PRs
    let index = this.state.activePRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.activePRs.splice(index, 1)[0];
      console.error(`Untracked PR: ${pr.repo}#${pr.number}`);
      return true;
    }

    // Check dormant PRs
    index = this.state.dormantPRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.dormantPRs.splice(index, 1)[0];
      console.error(`Untracked dormant PR: ${pr.repo}#${pr.number}`);
      return true;
    }

    console.error(`PR not found: ${url}`);
    return false;
  }

  /**
   * Mark an active PR's comments as read and reset its activity status to 'active'.
   * @param url - The full GitHub PR URL.
   * @returns true if the PR was found and updated, false if not in the active list.
   */
  markPRAsRead(url: string): boolean {
    const pr = this.state.activePRs.find(p => p.url === url);
    if (pr) {
      pr.hasUnreadComments = false;
      pr.activityStatus = 'active';
      console.error(`Marked as read: ${pr.repo}#${pr.number}`);
      return true;
    }
    return false;
  }

  /**
   * Mark all active PRs with unread comments as read.
   * @returns The number of PRs that were marked as read.
   */
  markAllPRsAsRead(): number {
    let count = 0;
    for (const pr of this.state.activePRs) {
      if (pr.hasUnreadComments) {
        pr.hasUnreadComments = false;
        pr.activityStatus = 'active';
        count++;
      }
    }
    console.error(`Marked ${count} PRs as read`);
    return count;
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
        console.error(`[SCORE_CALC] Invalid lastMergedAt date for ${repoScore.repo}: "${repoScore.lastMergedAt}". Skipping recency bonus.`);
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
    if (updates.signals) {
      repoScore.signals = { ...repoScore.signals, ...updates.signals };
    }

    // Recalculate score
    repoScore.score = this.calculateScore(repoScore);
    repoScore.lastEvaluatedAt = new Date().toISOString();

    console.error(`Updated repo score for ${repo}: ${repoScore.score}/10`);
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
    console.error(`  └─ incremented merged count for ${repo}: ${newCount}`);
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
    console.error(`  └─ incremented closed count for ${repo}: ${newCount}`);
  }

  /**
   * Mark a repository as having hostile maintainer comments and recalculate its score.
   * This applies a -2 penalty to the score. Creates a default score record if needed.
   * @param repo - Repository in "owner/repo" format.
   */
  markRepoHostile(repo: string): void {
    this.updateRepoScore(repo, { signals: { hasHostileComments: true } });
    console.error(`Marked ${repo} as hostile, score: ${this.state.repoScores[repo].score}/10`);
  }

  /**
   * Get repositories where the user has at least one merged PR, sorted by merged count descending.
   * These repos represent proven relationships with high merge probability.
   * @returns Array of "owner/repo" strings for repos with mergedPRCount > 0.
   */
  getReposWithMergedPRs(): string[] {
    return Object.values(this.state.repoScores)
      .filter(rs => rs.mergedPRCount > 0)
      .sort((a, b) => b.mergedPRCount - a.mergedPRCount)
      .map(rs => rs.repo);
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
      .filter(rs => rs.mergedPRCount === 0 && rs.closedWithoutMergeCount === 0)
      .sort((a, b) => b.score - a.score)
      .map(rs => rs.repo);
  }

  /**
   * Get repositories with a score at or above the given threshold, sorted highest first.
   * @param minScore - Minimum score (inclusive). Defaults to `config.minRepoScoreThreshold`.
   * @returns Array of "owner/repo" strings for repos meeting the threshold.
   */
  getHighScoringRepos(minScore?: number): string[] {
    const threshold = minScore ?? this.state.config.minRepoScoreThreshold;
    return Object.values(this.state.repoScores)
      .filter(rs => rs.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .map(rs => rs.repo);
  }

  /**
   * Get repositories with a score at or below the given threshold, sorted lowest first.
   * @param maxScore - Maximum score (inclusive). Defaults to `config.minRepoScoreThreshold`.
   * @returns Array of "owner/repo" strings for repos at or below the threshold.
   */
  getLowScoringRepos(maxScore?: number): string[] {
    const threshold = maxScore ?? this.state.config.minRepoScoreThreshold;
    return Object.values(this.state.repoScores)
      .filter(rs => rs.score <= threshold)
      .sort((a, b) => a.score - b.score)
      .map(rs => rs.repo);
  }

  // === Statistics ===

  /**
   * Compute aggregate statistics from the current state. In v2 architecture, `activePRs`,
   * `dormantPRs`, `activeIssues`, and `needsResponse` always return 0 because those counts
   * come from the fresh GitHub fetch (see PRMonitor), not from local state. The `mergedPRs`
   * and `closedPRs` counts are summed from repo score records. `totalTracked` reflects the
   * number of repositories with score records.
   * @returns A Stats snapshot computed from the current state.
   */
  getStats(): Stats {
    // v2: Calculate from repoScores (no local PR tracking)
    let totalMerged = 0;
    let totalClosed = 0;

    for (const score of Object.values(this.state.repoScores)) {
      totalMerged += score.mergedPRCount;
      totalClosed += score.closedWithoutMergeCount;
    }

    const completed = totalMerged + totalClosed;
    const mergeRate = completed > 0
      ? (totalMerged / completed) * 100
      : 0;

    return {
      // v2: These are calculated from fresh GitHub data, not stored locally
      // Return 0 for legacy fields - actual counts come from fresh fetch
      activePRs: 0,
      dormantPRs: 0,
      mergedPRs: totalMerged,
      closedPRs: totalClosed,
      activeIssues: 0,
      trustedProjects: this.state.config.trustedProjects.length,
      mergeRate: mergeRate.toFixed(1) + '%',
      totalTracked: Object.keys(this.state.repoScores).length,
      needsResponse: 0,
    };
  }
}

/**
 * Aggregate statistics returned by {@link StateManager.getStats}.
 * In v2, fields that depend on live GitHub data return 0 from local state;
 * actual counts are provided by the fresh-fetch layer (PRMonitor).
 */
export interface Stats {
  /** Number of active PRs. Always 0 in v2 (sourced from fresh fetch instead). */
  activePRs: number;
  /** Number of dormant PRs. Always 0 in v2 (sourced from fresh fetch instead). */
  dormantPRs: number;
  /** Total merged PRs across all scored repositories. */
  mergedPRs: number;
  /** Total PRs closed without merge across all scored repositories. */
  closedPRs: number;
  /** Number of active issues. Always 0 in v2 (sourced from fresh fetch instead). */
  activeIssues: number;
  /** Number of repositories in the trusted projects list. */
  trustedProjects: number;
  /** Merge success rate as a percentage string (e.g. "75.0%"). */
  mergeRate: string;
  /** Number of repositories with score records. */
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
