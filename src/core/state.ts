/**
 * State management for the OSS Contribution Agent
 * Persists state to a JSON file in ~/.oss-autopilot/
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentState, INITIAL_STATE, TrackedPR, TrackedIssue, RepoScore, StateEvent, StateEventType } from './types.js';
import { getStatePath, getBackupDir, getDataDir } from './utils.js';

// Legacy path for migration
const LEGACY_STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const LEGACY_BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');

export class StateManager {
  private state: AgentState;
  private readonly inMemoryOnly: boolean;

  constructor(inMemoryOnly = false) {
    this.inMemoryOnly = inMemoryOnly;
    this.state = inMemoryOnly ? this.createFreshState() : this.load();
  }

  /**
   * Create a fresh state with new array instances (deep copy)
   */
  private createFreshState(): AgentState {
    return {
      version: INITIAL_STATE.version,
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
   * Check if initial setup has been completed
   */
  isSetupComplete(): boolean {
    return this.state.config.setupComplete === true;
  }

  /**
   * Mark setup as complete
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
        const state = JSON.parse(data) as AgentState;

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

        console.error(`Loaded state: ${state.activePRs.length} active PRs, ${state.mergedPRs.length} merged`);
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
        const state = JSON.parse(data) as AgentState;

        if (this.isValidState(state)) {
          console.error(`Successfully restored state from backup: ${backupFile}`);
          console.error(`Restored state: ${state.activePRs.length} active PRs, ${state.mergedPRs.length} merged`);

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

    return (
      typeof s.version === 'number' &&
      Array.isArray(s.activePRs) &&
      Array.isArray(s.activeIssues) &&
      Array.isArray(s.dormantPRs) &&
      Array.isArray(s.mergedPRs) &&
      Array.isArray(s.closedPRs) &&
      typeof s.repoScores === 'object' &&
      s.repoScores !== null &&
      Array.isArray(s.events) &&
      typeof s.config === 'object' &&
      s.config !== null
    );
  }

  /**
   * Save current state to file with backup
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
      const backupFile = path.join(backupDir, `state-${timestamp}.json`);
      fs.copyFileSync(statePath, backupFile);

      // Keep only last 10 backups
      this.cleanupBackups();
    }

    // Save state
    fs.writeFileSync(statePath, JSON.stringify(this.state, null, 2));
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
   * Get the current state (read-only)
   */
  getState(): Readonly<AgentState> {
    return this.state;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AgentState['config']>): void {
    this.state.config = { ...this.state.config, ...config };
  }

  // === Event Logging ===

  /**
   * Append an event to the event log
   */
  appendEvent(type: StateEventType, data: Record<string, unknown>): void {
    const event: StateEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      at: new Date().toISOString(),
      data,
    };
    this.state.events.push(event);
    // Note: We don't call save() here - the caller should save when appropriate
  }

  /**
   * Get events by type
   */
  getEventsByType(type: StateEventType): StateEvent[] {
    return this.state.events.filter(e => e.type === type);
  }

  /**
   * Get events within a time range
   */
  getEventsInRange(since: Date, until: Date = new Date()): StateEvent[] {
    return this.state.events.filter(e => {
      const eventTime = new Date(e.at);
      return eventTime >= since && eventTime <= until;
    });
  }

  // === PR Management ===

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

  /**
   * Find a PR by URL across all states (active, dormant, merged, closed)
   */
  findPR(url: string): TrackedPR | undefined {
    return (
      this.state.activePRs.find(p => p.url === url) ||
      this.state.dormantPRs.find(p => p.url === url) ||
      this.state.mergedPRs.find(p => p.url === url) ||
      this.state.closedPRs.find(p => p.url === url)
    );
  }

  updatePR(url: string, updates: Partial<TrackedPR>): void {
    const index = this.state.activePRs.findIndex(p => p.url === url);
    if (index !== -1) {
      this.state.activePRs[index] = { ...this.state.activePRs[index], ...updates };
    }
  }

  movePRToMerged(url: string): boolean {
    const index = this.state.activePRs.findIndex(p => p.url === url);
    if (index === -1) {
      console.error(`Warning: PR not found in active PRs: ${url}`);
      return false;
    }
    const pr = this.state.activePRs.splice(index, 1)[0];
    pr.status = 'merged';
    pr.mergedAt = new Date().toISOString();
    this.state.mergedPRs.push(pr);
    this.appendEvent('pr_merged', {
      url: pr.url,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      mergedAt: pr.mergedAt,
    });
    console.error(`PR merged: ${pr.repo}#${pr.number}`);

    // Update repo score
    this.incrementMergedCount(pr.repo);
    return true;
  }

  movePRToClosed(url: string): boolean {
    const index = this.state.activePRs.findIndex(p => p.url === url);
    if (index === -1) {
      console.error(`Warning: PR not found in active PRs: ${url}`);
      return false;
    }
    const pr = this.state.activePRs.splice(index, 1)[0];
    pr.status = 'closed';
    pr.closedAt = new Date().toISOString();
    this.state.closedPRs.push(pr);
    this.appendEvent('pr_closed', {
      url: pr.url,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      closedAt: pr.closedAt,
    });
    console.error(`PR closed: ${pr.repo}#${pr.number}`);

    // Update repo score
    this.incrementClosedCount(pr.repo);
    return true;
  }

  movePRToDormant(url: string): void {
    const index = this.state.activePRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.activePRs.splice(index, 1)[0];
      pr.activityStatus = 'dormant';
      this.state.dormantPRs.push(pr);
      this.appendEvent('pr_dormant', {
        url: pr.url,
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        daysSinceActivity: pr.daysSinceActivity,
      });
      console.error(`PR marked dormant: ${pr.repo}#${pr.number}`);
    }
  }

  reactivatePR(url: string): void {
    const index = this.state.dormantPRs.findIndex(p => p.url === url);
    if (index !== -1) {
      const pr = this.state.dormantPRs.splice(index, 1)[0];
      pr.activityStatus = 'active';
      this.state.activePRs.push(pr);
      console.error(`PR reactivated: ${pr.repo}#${pr.number}`);
    }
  }

  moveDormantPRToMerged(url: string): boolean {
    const index = this.state.dormantPRs.findIndex(p => p.url === url);
    if (index === -1) {
      console.error(`Warning: PR not found in dormant PRs: ${url}`);
      return false;
    }
    const pr = this.state.dormantPRs.splice(index, 1)[0];
    pr.status = 'merged';
    pr.mergedAt = new Date().toISOString();
    this.state.mergedPRs.push(pr);
    console.error(`Dormant PR merged: ${pr.repo}#${pr.number}`);

    // Update repo score
    this.incrementMergedCount(pr.repo);
    return true;
  }

  moveDormantPRToClosed(url: string): boolean {
    const index = this.state.dormantPRs.findIndex(p => p.url === url);
    if (index === -1) {
      console.error(`Warning: PR not found in dormant PRs: ${url}`);
      return false;
    }
    const pr = this.state.dormantPRs.splice(index, 1)[0];
    pr.status = 'closed';
    pr.closedAt = new Date().toISOString();
    this.state.closedPRs.push(pr);
    console.error(`Dormant PR closed: ${pr.repo}#${pr.number}`);

    // Update repo score
    this.incrementClosedCount(pr.repo);
    return true;
  }

  // === Issue Management ===

  addIssue(issue: TrackedIssue): void {
    const existing = this.state.activeIssues.find(i => i.url === issue.url);
    if (existing) {
      console.error(`Issue ${issue.url} already tracked`);
      return;
    }

    this.state.activeIssues.push(issue);
    console.error(`Added issue: ${issue.repo}#${issue.number}`);
  }

  updateIssue(url: string, updates: Partial<TrackedIssue>): void {
    const index = this.state.activeIssues.findIndex(i => i.url === url);
    if (index !== -1) {
      this.state.activeIssues[index] = { ...this.state.activeIssues[index], ...updates };
    }
  }

  removeIssue(url: string): void {
    const index = this.state.activeIssues.findIndex(i => i.url === url);
    if (index !== -1) {
      this.state.activeIssues.splice(index, 1);
    }
  }

  linkIssueToPR(issueUrl: string, prNumber: number): void {
    const issue = this.state.activeIssues.find(i => i.url === issueUrl);
    if (issue) {
      issue.linkedPRNumber = prNumber;
      issue.status = 'pr_submitted';
    }
  }

  // === Trusted Projects ===

  addTrustedProject(repo: string): void {
    if (!this.state.config.trustedProjects.includes(repo)) {
      this.state.config.trustedProjects.push(repo);
      console.error(`Added trusted project: ${repo}`);
    }
  }

  // === Starred Repos Management ===

  /**
   * Get the list of starred repositories
   */
  getStarredRepos(): string[] {
    return this.state.config.starredRepos || [];
  }

  /**
   * Set the list of starred repositories and update the fetch timestamp
   */
  setStarredRepos(repos: string[]): void {
    this.state.config.starredRepos = repos;
    this.state.config.starredReposLastFetched = new Date().toISOString();
    console.error(`Updated starred repos: ${repos.length} repositories`);
  }

  /**
   * Check if the starred repos cache is stale (older than 24 hours)
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

  // === PR Utilities ===

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
   * Get the score for a repository
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
   * Calculate the score based on the repo's metrics
   * Base 5, +2 per merged (max +4), -1 per closed without merge (max -3),
   * +1 if responsive, -2 if hostile. Clamp 1-10.
   */
  private calculateScore(repoScore: RepoScore): number {
    let score = 5; // Base score

    // +2 per merged PR (max +4)
    const mergedBonus = Math.min(repoScore.mergedPRCount * 2, 4);
    score += mergedBonus;

    // -1 per closed without merge (max -3)
    const closedPenalty = Math.min(repoScore.closedWithoutMergeCount, 3);
    score -= closedPenalty;

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
   * Update a repository's score with partial updates
   */
  updateRepoScore(repo: string, updates: Partial<RepoScore>): void {
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
   * Increment merged PR count for a repository
   */
  incrementMergedCount(repo: string): void {
    if (!this.state.repoScores[repo]) {
      this.state.repoScores[repo] = this.createDefaultRepoScore(repo);
    }

    const repoScore = this.state.repoScores[repo];
    repoScore.mergedPRCount += 1;
    repoScore.lastMergedAt = new Date().toISOString();
    repoScore.score = this.calculateScore(repoScore);
    repoScore.lastEvaluatedAt = new Date().toISOString();

    console.error(`Incremented merged count for ${repo}: ${repoScore.mergedPRCount} merged, score: ${repoScore.score}/10`);
  }

  /**
   * Increment closed without merge count for a repository
   */
  incrementClosedCount(repo: string): void {
    if (!this.state.repoScores[repo]) {
      this.state.repoScores[repo] = this.createDefaultRepoScore(repo);
    }

    const repoScore = this.state.repoScores[repo];
    repoScore.closedWithoutMergeCount += 1;
    repoScore.score = this.calculateScore(repoScore);
    repoScore.lastEvaluatedAt = new Date().toISOString();

    console.error(`Incremented closed count for ${repo}: ${repoScore.closedWithoutMergeCount} closed, score: ${repoScore.score}/10`);
  }

  /**
   * Mark a repository as having hostile comments
   */
  markRepoHostile(repo: string): void {
    if (!this.state.repoScores[repo]) {
      this.state.repoScores[repo] = this.createDefaultRepoScore(repo);
    }

    const repoScore = this.state.repoScores[repo];
    repoScore.signals.hasHostileComments = true;
    repoScore.score = this.calculateScore(repoScore);
    repoScore.lastEvaluatedAt = new Date().toISOString();

    console.error(`Marked ${repo} as hostile, score: ${repoScore.score}/10`);
  }

  /**
   * Get repositories with score at or above the threshold
   */
  getHighScoringRepos(minScore?: number): string[] {
    const threshold = minScore ?? this.state.config.minRepoScoreThreshold;
    return Object.values(this.state.repoScores)
      .filter(rs => rs.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .map(rs => rs.repo);
  }

  /**
   * Get repositories with score at or below the threshold
   */
  getLowScoringRepos(maxScore?: number): string[] {
    const threshold = maxScore ?? this.state.config.minRepoScoreThreshold;
    return Object.values(this.state.repoScores)
      .filter(rs => rs.score <= threshold)
      .sort((a, b) => a.score - b.score)
      .map(rs => rs.repo);
  }

  // === Statistics ===

  getStats(): Stats {
    // Merge rate = merged / (merged + closed + dormant)
    // Dormant PRs are effectively "pending" outcomes, but we include them
    // to show a conservative rate
    const completed = this.state.mergedPRs.length + this.state.closedPRs.length;
    const mergeRate = completed > 0
      ? (this.state.mergedPRs.length / completed) * 100
      : 0;

    return {
      activePRs: this.state.activePRs.length,
      dormantPRs: this.state.dormantPRs.length,
      mergedPRs: this.state.mergedPRs.length,
      closedPRs: this.state.closedPRs.length,
      activeIssues: this.state.activeIssues.length,
      trustedProjects: this.state.config.trustedProjects.length,
      mergeRate: mergeRate.toFixed(1) + '%',
      // Additional stats
      totalTracked: this.state.activePRs.length + this.state.dormantPRs.length +
                    this.state.mergedPRs.length + this.state.closedPRs.length,
      needsResponse: this.state.activePRs.filter(p => p.hasUnreadComments).length,
    };
  }
}

/**
 * Statistics returned by StateManager.getStats()
 */
export interface Stats {
  activePRs: number;
  dormantPRs: number;
  mergedPRs: number;
  closedPRs: number;
  activeIssues: number;
  trustedProjects: number;
  mergeRate: string;
  totalTracked: number;
  needsResponse: number;
}

// Singleton instance
let stateManager: StateManager | null = null;

export function getStateManager(): StateManager {
  if (!stateManager) {
    stateManager = new StateManager();
  }
  return stateManager;
}

/**
 * Reset the singleton state manager (for testing)
 */
export function resetStateManager(): void {
  stateManager = null;
}
