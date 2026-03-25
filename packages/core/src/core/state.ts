/**
 * State management for the OSS Contribution Agent.
 * Thin coordinator that delegates persistence to state-persistence.ts
 * and scoring logic to repo-score-manager.ts.
 */

import * as fs from 'fs';
import {
  AgentState,
  TrackedIssue,
  RepoScore,
  RepoScoreUpdate,
  DailyDigest,
  LocalRepoCache,
  StatusOverride,
  FetchedPRStatus,
  StoredMergedPR,
  StoredClosedPR,
} from './types.js';
import {
  loadState,
  saveState,
  reloadStateIfChanged,
  createFreshState,
  atomicWriteFileSync,
} from './state-persistence.js';
import * as repoScoring from './repo-score-manager.js';
import type { Stats } from './repo-score-manager.js';
import { debug, warn } from './logger.js';
import { errorMessage } from './errors.js';
import { GistStateStore, type OctokitLike } from './gist-state-store.js';
import { getStatePath, getStateCachePath } from './utils.js';

export { acquireLock, releaseLock, atomicWriteFileSync } from './state-persistence.js';
export type { Stats } from './repo-score-manager.js';

const MODULE = 'state';

/**
 * Singleton manager for persistent agent state stored in ~/.oss-autopilot/state.json.
 *
 * Delegates file I/O to state-persistence.ts and scoring logic to repo-score-manager.ts.
 * Retains lightweight CRUD operations for config, issues, shelving, dismissal,
 * and status overrides.
 */
export class StateManager {
  protected state: AgentState;
  protected inMemoryOnly: boolean;
  private lastLoadedMtimeMs: number = 0;
  private _batching = false;
  private _batchDirty = false;
  protected gistStore: GistStateStore | null = null;
  protected gistDegraded = false;

  /**
   * Create a new StateManager instance.
   * @param inMemoryOnly - When true, state is held only in memory and never read from or
   *   written to disk. Useful for unit tests that need isolated state without side effects.
   *   Defaults to false (normal persistent mode).
   */
  constructor(inMemoryOnly = false) {
    this.inMemoryOnly = inMemoryOnly;
    if (inMemoryOnly) {
      this.state = createFreshState();
    } else {
      const result = loadState();
      this.state = result.state;
      this.lastLoadedMtimeMs = result.mtimeMs;
      this.tryReconcilePRCounts();
    }
  }

  /**
   * Async factory that creates a StateManager backed by a GitHub Gist.
   *
   * The regular constructor is synchronous (for backwards-compat), but Gist
   * bootstrapping requires network calls, so this factory is async.
   *
   * @param token - GitHub personal access token with `gist` scope
   */
  static async createWithGist(token: string): Promise<StateManager> {
    // Dynamic import to avoid circular dependencies
    const { getOctokit } = await import('./github.js');

    const octokit = getOctokit(token) as unknown as OctokitLike;
    const gistStore = new GistStateStore(octokit);

    // Check if local state exists for migration
    const statePath = getStatePath();
    let result;
    if (fs.existsSync(statePath)) {
      // TODO: Task 8 will add bootstrapWithMigration() for migrating local state into the Gist.
      // For now, just use regular bootstrap (the Gist is authoritative once enabled).
      result = await gistStore.bootstrap();
    } else {
      result = await gistStore.bootstrap();
    }

    const manager = new StateManager(true); // start in-memory
    manager.state = result.state;
    manager.gistStore = gistStore;
    manager.gistDegraded = result.degraded ?? false;
    manager.inMemoryOnly = false; // re-enable persistence

    return manager;
  }

  /**
   * Attempt PR count reconciliation, logging a warning on failure.
   * Called after every state load from disk.
   */
  private tryReconcilePRCounts(): void {
    try {
      this.reconcilePRCounts();
    } catch (err) {
      warn(MODULE, `PR count reconciliation failed (will retry on next load): ${errorMessage(err)}`);
      debug(MODULE, `Reconciliation error details: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }

  /**
   * Execute multiple mutations as a single batch, deferring disk I/O until the
   * batch completes. Nested `batch()` calls are flattened — only the outermost saves.
   * @param fn - The function containing mutations to batch
   */
  batch(fn: () => void): void {
    if (this._batching) {
      fn();
      return;
    }
    this._batching = true;
    this._batchDirty = false;
    try {
      fn();
      if (this._batchDirty) this.save();
    } finally {
      this._batching = false;
      this._batchDirty = false;
    }
  }

  /**
   * Auto-persist after a mutation. Inside a `batch()`, defers to the batch boundary.
   */
  private autoSave(): void {
    if (this._batching) {
      this._batchDirty = true;
      return;
    }
    this.save();
  }

  /**
   * Check if initial setup has been completed.
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
    this.autoSave();
  }

  /**
   * Initialize state with sensible defaults for zero-config onboarding.
   * No-op if setup is already complete.
   */
  initializeWithDefaults(username: string): void {
    if (this.state.config.setupComplete) {
      debug(MODULE, `Setup already complete, skipping initializeWithDefaults for "${username}"`);
      return;
    }
    this.batch(() => {
      this.updateConfig({ githubUsername: username });
      this.markSetupComplete();
      debug(MODULE, `Initialized with defaults for user "${username}"`);
    });
  }

  /**
   * Persist the current state to disk, creating a timestamped backup of the previous
   * state file first. In in-memory mode, only updates `lastRunAt` without any file I/O.
   *
   * In Gist mode, writes to a local cache file (not the main state file) so the Gist
   * remains the source of truth. Use `checkpoint()` to push state to the Gist.
   */
  save(): void {
    this.state.lastRunAt = new Date().toISOString();

    if (this.inMemoryOnly) {
      return;
    }

    if (this.gistStore) {
      // In Gist mode, write to local cache (not main state file).
      // The Gist is the source of truth; local cache is for fallback.
      try {
        atomicWriteFileSync(getStateCachePath(), JSON.stringify(this.state, null, 2), 0o600);
      } catch {
        // Best-effort cache write
      }
      return;
    }

    // Local file mode (existing behavior)
    this.lastLoadedMtimeMs = saveState(this.state);
  }

  /** Push current state to Gist (async). Call at well-defined moments (end of daily, after claim). */
  async checkpoint(): Promise<boolean> {
    if (!this.gistStore) return true; // not in Gist mode
    this.gistStore.setState(JSON.stringify(this.state, null, 2));
    return this.gistStore.push();
  }

  /** Whether this StateManager is backed by a Gist. */
  isGistMode(): boolean {
    return this.gistStore !== null;
  }

  /** Whether the Gist is in degraded mode (using local cache fallback). */
  isGistDegraded(): boolean {
    return this.gistDegraded;
  }

  /**
   * Get the current state as a read-only snapshot.
   */
  getState(): Readonly<AgentState> {
    return this.state;
  }

  /**
   * Re-read state from disk if the file has been modified since the last load/save.
   * Returns true if state was reloaded, false if unchanged or in-memory mode.
   */
  reloadIfChanged(): boolean {
    if (this.inMemoryOnly) return false;
    const result = reloadStateIfChanged(this.lastLoadedMtimeMs);
    if (!result) return false;
    this.state = result.state;
    this.lastLoadedMtimeMs = result.mtimeMs;
    this.tryReconcilePRCounts();
    return true;
  }

  // === Dashboard Data Setters ===

  /**
   * Store the latest daily digest and update the digest timestamp.
   * @param digest - The daily digest to store
   */
  setLastDigest(digest: DailyDigest): void {
    this.state.lastDigest = digest;
    this.state.lastDigestAt = digest.generatedAt;
    this.autoSave();
  }

  /**
   * Update monthly merged PR counts for dashboard display.
   * @param counts - Monthly merged PR counts keyed by YYYY-MM
   */
  setMonthlyMergedCounts(counts: Record<string, number>): void {
    this.state.monthlyMergedCounts = counts;
    this.autoSave();
  }

  /**
   * Update monthly closed PR counts for dashboard display.
   * @param counts - Monthly closed PR counts keyed by YYYY-MM
   */
  setMonthlyClosedCounts(counts: Record<string, number>): void {
    this.state.monthlyClosedCounts = counts;
    this.autoSave();
  }

  /**
   * Update monthly opened PR counts for dashboard display.
   * @param counts - Monthly opened PR counts keyed by YYYY-MM
   */
  setMonthlyOpenedCounts(counts: Record<string, number>): void {
    this.state.monthlyOpenedCounts = counts;
    this.autoSave();
  }

  /**
   * Update the local repository cache.
   * @param cache - Local repository cache mapping repo names to paths
   */
  setLocalRepoCache(cache: LocalRepoCache): void {
    this.state.localRepoCache = cache;
    this.autoSave();
  }

  // === Merged PR Storage ===

  /** Returns all stored merged PRs (sorted by merge date descending via addMergedPRs). */
  getMergedPRs(): StoredMergedPR[] {
    return this.state.mergedPRs ?? [];
  }

  /**
   * Add merged PRs to storage, deduplicating by URL.
   * @param prs - Merged PRs to add (duplicates by URL are ignored)
   */
  addMergedPRs(prs: StoredMergedPR[]): void {
    if (prs.length === 0) return;
    if (!this.state.mergedPRs) this.state.mergedPRs = [];
    const existingUrls = new Set(this.state.mergedPRs.map((pr) => pr.url));
    const newPRs = prs.filter((pr) => !existingUrls.has(pr.url));
    if (newPRs.length === 0) return;
    this.state.mergedPRs.push(...newPRs);
    this.state.mergedPRs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    debug(MODULE, `Added ${newPRs.length} merged PRs (total: ${this.state.mergedPRs.length})`);
    this.autoSave();
  }

  /** Returns the most recent merge date, used as a watermark for incremental fetching. */
  getMergedPRWatermark(): string | undefined {
    return this.state.mergedPRs?.[0]?.mergedAt || undefined;
  }

  // === Closed PR Storage ===

  /** Returns all stored closed-without-merge PRs (sorted by close date descending via addClosedPRs). */
  getClosedPRs(): StoredClosedPR[] {
    return this.state.closedPRs ?? [];
  }

  /**
   * Add closed PRs to storage, deduplicating by URL.
   * @param prs - Closed PRs to add (duplicates by URL are ignored)
   */
  addClosedPRs(prs: StoredClosedPR[]): void {
    if (prs.length === 0) return;
    if (!this.state.closedPRs) this.state.closedPRs = [];
    const existingUrls = new Set(this.state.closedPRs.map((pr) => pr.url));
    const newPRs = prs.filter((pr) => !existingUrls.has(pr.url));
    if (newPRs.length === 0) return;
    this.state.closedPRs.push(...newPRs);
    this.state.closedPRs.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
    debug(MODULE, `Added ${newPRs.length} closed PRs (total: ${this.state.closedPRs.length})`);
    this.autoSave();
  }

  /** Returns the most recent close date, used as a watermark for incremental fetching. */
  getClosedPRWatermark(): string | undefined {
    return this.state.closedPRs?.[0]?.closedAt || undefined;
  }

  // === Configuration ===

  /**
   * Merge partial config updates into the current configuration.
   * @param config - Partial config object to merge
   */
  updateConfig(config: Partial<AgentState['config']>): void {
    this.state.config = { ...this.state.config, ...config };
    this.autoSave();
  }

  // === Issue Management ===

  /**
   * Track a new issue. No-op if the issue URL is already tracked.
   * @param issue - The issue to track
   */
  addIssue(issue: TrackedIssue): void {
    const existing = this.state.activeIssues.find((i) => i.url === issue.url);
    if (existing) {
      debug(MODULE, `Issue ${issue.url} already tracked`);
      return;
    }

    this.state.activeIssues.push(issue);
    debug(MODULE, `Added issue: ${issue.repo}#${issue.number}`);
    this.autoSave();
  }

  // === Trusted Projects ===

  /**
   * Add a repository to the trusted projects list. No-op if already trusted.
   * @param repo - Repository in "owner/repo" format
   */
  addTrustedProject(repo: string): void {
    if (!this.state.config.trustedProjects.includes(repo)) {
      this.state.config.trustedProjects.push(repo);
      debug(MODULE, `Added trusted project: ${repo}`);
      this.autoSave();
    }
  }

  private static matchesExclusion(repo: string, repos: string[], orgs?: string[]): boolean {
    const repoLower = repo.toLowerCase();
    if (repos.some((r) => r.toLowerCase() === repoLower)) return true;
    if (orgs?.some((o) => o.toLowerCase() === repoLower.split('/')[0])) return true;
    return false;
  }

  /**
   * Remove excluded repos/orgs from trusted projects.
   * @param repos - Repository names to exclude
   * @param orgs - Organization names to exclude
   */
  cleanupExcludedData(repos: string[], orgs: string[]): void {
    const matches = (repo: string): boolean => StateManager.matchesExclusion(repo, repos, orgs);

    const beforeTrusted = this.state.config.trustedProjects.length;
    this.state.config.trustedProjects = this.state.config.trustedProjects.filter((p) => !matches(p));
    const removedTrusted = beforeTrusted - this.state.config.trustedProjects.length;

    if (removedTrusted > 0) {
      debug(MODULE, `Removed ${removedTrusted} trusted project(s) for excluded repos/orgs`);
      this.autoSave();
    }
  }

  // === Starred Repos Management ===

  /** Returns cached starred repository names. */
  getStarredRepos(): string[] {
    return this.state.config.starredRepos || [];
  }

  /**
   * Update the cached starred repositories and timestamp.
   * @param repos - Repository names in "owner/repo" format
   */
  setStarredRepos(repos: string[]): void {
    this.state.config.starredRepos = repos;
    this.state.config.starredReposLastFetched = new Date().toISOString();
    debug(MODULE, `Updated starred repos: ${repos.length} repositories`);
    this.autoSave();
  }

  /** Returns true if starred repos cache is older than 24 hours. */
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
   * Shelve a PR URL, hiding it from daily digest and capacity.
   * @param url - The PR URL to shelve
   * @returns true if newly shelved, false if already shelved
   */
  shelvePR(url: string): boolean {
    if (!this.state.config.shelvedPRUrls) {
      this.state.config.shelvedPRUrls = [];
    }
    if (this.state.config.shelvedPRUrls.includes(url)) {
      return false;
    }
    this.state.config.shelvedPRUrls.push(url);
    this.autoSave();
    return true;
  }

  /**
   * Unshelve a PR URL, restoring it to daily digest.
   * @param url - The PR URL to unshelve
   * @returns true if removed from shelf, false if not shelved
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
    this.autoSave();
    return true;
  }

  /**
   * Check if a PR is currently shelved.
   * @param url - The PR URL to check
   * @returns true if the PR is shelved
   */
  isPRShelved(url: string): boolean {
    return this.state.config.shelvedPRUrls?.includes(url) ?? false;
  }

  // === Dismiss / Undismiss Issues ===

  /**
   * Dismiss an issue's notifications. Auto-resurfaces on new activity.
   * @param url - The issue URL to dismiss
   * @param timestamp - ISO timestamp of dismissal
   * @returns true if newly dismissed, false if already dismissed
   */
  dismissIssue(url: string, timestamp: string): boolean {
    if (!this.state.config.dismissedIssues) {
      this.state.config.dismissedIssues = {};
    }
    if (url in this.state.config.dismissedIssues) {
      return false;
    }
    this.state.config.dismissedIssues[url] = timestamp;
    this.autoSave();
    return true;
  }

  /**
   * Restore a dismissed issue to notifications.
   * @param url - The issue URL to undismiss
   * @returns true if undismissed, false if not currently dismissed
   */
  undismissIssue(url: string): boolean {
    if (!this.state.config.dismissedIssues || !(url in this.state.config.dismissedIssues)) {
      return false;
    }
    delete this.state.config.dismissedIssues[url];
    this.autoSave();
    return true;
  }

  /**
   * Get the timestamp when an issue was dismissed, or undefined if not dismissed.
   * @param url - The issue URL to check
   */
  getIssueDismissedAt(url: string): string | undefined {
    return this.state.config.dismissedIssues?.[url];
  }

  // === Status Overrides ===

  /**
   * Set a manual status override for a PR. Auto-clears when the PR has new activity.
   * @param url - The PR URL
   * @param status - The overridden status
   * @param lastActivityAt - ISO timestamp of PR's last activity when override was set
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
    this.autoSave();
  }

  /**
   * Remove a manual status override for a PR.
   * @param url - The PR URL
   * @returns true if an override was removed, false if none existed
   */
  clearStatusOverride(url: string): boolean {
    if (!this.state.config.statusOverrides || !(url in this.state.config.statusOverrides)) {
      return false;
    }
    delete this.state.config.statusOverrides[url];
    this.autoSave();
    return true;
  }

  /**
   * Get the status override for a PR, auto-clearing if new activity has occurred.
   * @param url - The PR URL
   * @param currentUpdatedAt - PR's current updatedAt timestamp for staleness check
   * @returns The override if still valid, undefined otherwise
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

  // === Repository Scoring (delegated to repo-score-manager) ===

  /**
   * Get the score record for a repository.
   * @param repo - Repository in "owner/repo" format
   * @returns Read-only score record, or undefined if not tracked
   */
  getRepoScore(repo: string): Readonly<RepoScore> | undefined {
    return repoScoring.getRepoScore(this.state, repo);
  }

  /**
   * Update scoring data for a repository.
   * @param repo - Repository in "owner/repo" format
   * @param updates - Partial score fields to merge
   */
  updateRepoScore(repo: string, updates: RepoScoreUpdate): void {
    repoScoring.updateRepoScore(this.state, repo, updates);
    this.autoSave();
  }

  /**
   * Increment the merged PR count for a repository.
   * @param repo - Repository in "owner/repo" format
   */
  incrementMergedCount(repo: string): void {
    repoScoring.incrementMergedCount(this.state, repo);
    this.autoSave();
  }

  /**
   * Increment the closed-without-merge PR count.
   * @param repo - Repository in "owner/repo" format
   */
  incrementClosedCount(repo: string): void {
    repoScoring.incrementClosedCount(this.state, repo);
    this.autoSave();
  }

  /**
   * Mark a repository as hostile (score zeroed).
   * @param repo - Repository in "owner/repo" format
   */
  markRepoHostile(repo: string): void {
    repoScoring.markRepoHostile(this.state, repo);
    this.autoSave();
  }

  /** Returns repository names that have at least one merged PR. */
  getReposWithMergedPRs(): string[] {
    return repoScoring.getReposWithMergedPRs(this.state);
  }

  /** Returns repository names with open PRs but no merged PRs yet. */
  getReposWithOpenPRs(): string[] {
    return repoScoring.getReposWithOpenPRs(this.state);
  }

  /**
   * Returns repos above the score threshold.
   * @param minScore - Minimum score (default: config.minRepoScoreThreshold)
   */
  getHighScoringRepos(minScore?: number): string[] {
    return repoScoring.getHighScoringRepos(this.state, minScore);
  }

  /**
   * Returns repos below the score threshold.
   * @param maxScore - Maximum score (default: config.minRepoScoreThreshold)
   */
  getLowScoringRepos(maxScore?: number): string[] {
    return repoScoring.getLowScoringRepos(this.state, maxScore);
  }

  /** Returns aggregate contribution statistics (merge rate, PR counts, repo breakdown). */
  getStats(): Stats {
    return repoScoring.getStats(this.state);
  }

  /**
   * Reconcile repoScores merged/closed counts with the stored PR arrays.
   * Bumps counters when the array has more PRs than the counter tracks.
   */
  private reconcilePRCounts(): void {
    const merged = this.state.mergedPRs ?? [];
    const closed = this.state.closedPRs ?? [];
    if (merged.length === 0 && closed.length === 0) return;
    const updated = repoScoring.reconcilePRCounts(this.state, merged, closed);
    if (updated) this.autoSave();
  }
}

// Singleton instance
let stateManager: StateManager | null = null;
let asyncManagerPromise: Promise<StateManager> | null = null;

/**
 * Get the singleton StateManager instance, creating it on first call.
 * @returns The shared StateManager instance
 *
 * @example
 * ```typescript
 * import { getStateManager } from '@oss-autopilot/core';
 *
 * const state = getStateManager();
 * const config = state.getState().config;
 * console.log(config.githubUsername);
 * ```
 */
export function getStateManager(): StateManager {
  if (!stateManager) {
    stateManager = new StateManager();
  }
  return stateManager;
}

/**
 * Get or create a StateManager with Gist-backed persistence.
 * If a StateManager already exists (from sync init), returns it.
 * If a token is provided and no manager exists, creates one with Gist backing.
 * Falls back to sync initialization if no token is provided.
 */
export async function getStateManagerAsync(token?: string): Promise<StateManager> {
  if (stateManager) return stateManager;
  if (asyncManagerPromise) return asyncManagerPromise;

  if (token) {
    asyncManagerPromise = StateManager.createWithGist(token)
      .then((mgr) => {
        stateManager = mgr;
        asyncManagerPromise = null;
        return mgr;
      })
      .catch((err) => {
        asyncManagerPromise = null;
        warn(MODULE, `Gist initialization failed, falling back to local: ${err}`);
        return getStateManager(); // fall back to sync/local
      });
    return asyncManagerPromise;
  }

  return getStateManager();
}

/**
 * Reset the singleton StateManager instance to null. Intended for test isolation.
 */
export function resetStateManager(): void {
  stateManager = null;
  asyncManagerPromise = null;
}
