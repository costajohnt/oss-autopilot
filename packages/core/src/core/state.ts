/**
 * State management for the OSS Contribution Agent.
 * Thin coordinator that delegates persistence to state-persistence.ts
 * and scoring logic to repo-score-manager.ts.
 */

import {
  AgentState,
  TrackedIssue,
  RepoScore,
  RepoScoreUpdate,
  StateEvent,
  StateEventType,
  DailyDigest,
  LocalRepoCache,
  StatusOverride,
  FetchedPRStatus,
  StoredMergedPR,
  StoredClosedPR,
} from './types.js';
import { loadState, saveState, reloadStateIfChanged, createFreshState } from './state-persistence.js';
import * as repoScoring from './repo-score-manager.js';
import type { Stats } from './repo-score-manager.js';
import { debug } from './logger.js';

export { acquireLock, releaseLock, atomicWriteFileSync } from './state-persistence.js';
export type { Stats } from './repo-score-manager.js';

const MODULE = 'state';

// Maximum number of events to retain in the event log
const MAX_EVENTS = 1000;

/**
 * Singleton manager for persistent agent state stored in ~/.oss-autopilot/state.json.
 *
 * Delegates file I/O to state-persistence.ts and scoring logic to repo-score-manager.ts.
 * Retains lightweight CRUD operations for config, events, issues, shelving, dismissal,
 * and status overrides.
 */
export class StateManager {
  private state: AgentState;
  private readonly inMemoryOnly: boolean;
  private lastLoadedMtimeMs: number = 0;
  private _batching = false;
  private _batchDirty = false;

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
    }
  }

  /**
   * Execute multiple mutations as a single batch, deferring disk I/O until the
   * batch completes. Nested `batch()` calls are flattened — only the outermost saves.
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
   */
  save(): void {
    this.state.lastRunAt = new Date().toISOString();

    if (this.inMemoryOnly) {
      return;
    }

    this.lastLoadedMtimeMs = saveState(this.state);
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
    return true;
  }

  // === Dashboard Data Setters ===

  setLastDigest(digest: DailyDigest): void {
    this.state.lastDigest = digest;
    this.state.lastDigestAt = digest.generatedAt;
    this.autoSave();
  }

  setMonthlyMergedCounts(counts: Record<string, number>): void {
    this.state.monthlyMergedCounts = counts;
    this.autoSave();
  }

  setMonthlyClosedCounts(counts: Record<string, number>): void {
    this.state.monthlyClosedCounts = counts;
    this.autoSave();
  }

  setMonthlyOpenedCounts(counts: Record<string, number>): void {
    this.state.monthlyOpenedCounts = counts;
    this.autoSave();
  }

  setDailyActivityCounts(counts: Record<string, number>): void {
    this.state.dailyActivityCounts = counts;
    this.autoSave();
  }

  setLocalRepoCache(cache: LocalRepoCache): void {
    this.state.localRepoCache = cache;
    this.autoSave();
  }

  // === Merged PR Storage ===

  getMergedPRs(): StoredMergedPR[] {
    return this.state.mergedPRs ?? [];
  }

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

  getMergedPRWatermark(): string | undefined {
    return this.state.mergedPRs?.[0]?.mergedAt || undefined;
  }

  // === Closed PR Storage ===

  getClosedPRs(): StoredClosedPR[] {
    return this.state.closedPRs ?? [];
  }

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

  getClosedPRWatermark(): string | undefined {
    return this.state.closedPRs?.[0]?.closedAt || undefined;
  }

  // === Configuration ===

  updateConfig(config: Partial<AgentState['config']>): void {
    this.state.config = { ...this.state.config, ...config };
    this.autoSave();
  }

  // === Event Logging ===

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
    this.autoSave();
  }

  getEventsByType(type: StateEventType): StateEvent[] {
    return this.state.events.filter((e) => e.type === type);
  }

  getEventsInRange(since: Date, until: Date = new Date()): StateEvent[] {
    return this.state.events.filter((e) => {
      const eventTime = new Date(e.at);
      return eventTime >= since && eventTime <= until;
    });
  }

  // === Issue Management ===

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

  getStarredRepos(): string[] {
    return this.state.config.starredRepos || [];
  }

  setStarredRepos(repos: string[]): void {
    this.state.config.starredRepos = repos;
    this.state.config.starredReposLastFetched = new Date().toISOString();
    debug(MODULE, `Updated starred repos: ${repos.length} repositories`);
    this.autoSave();
  }

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

  isPRShelved(url: string): boolean {
    return this.state.config.shelvedPRUrls?.includes(url) ?? false;
  }

  // === Dismiss / Undismiss Issues ===

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

  undismissIssue(url: string): boolean {
    if (!this.state.config.dismissedIssues || !(url in this.state.config.dismissedIssues)) {
      return false;
    }
    delete this.state.config.dismissedIssues[url];
    this.autoSave();
    return true;
  }

  getIssueDismissedAt(url: string): string | undefined {
    return this.state.config.dismissedIssues?.[url];
  }

  // === Status Overrides ===

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

  clearStatusOverride(url: string): boolean {
    if (!this.state.config.statusOverrides || !(url in this.state.config.statusOverrides)) {
      return false;
    }
    delete this.state.config.statusOverrides[url];
    this.autoSave();
    return true;
  }

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

  getRepoScore(repo: string): Readonly<RepoScore> | undefined {
    return repoScoring.getRepoScore(this.state, repo);
  }

  updateRepoScore(repo: string, updates: RepoScoreUpdate): void {
    repoScoring.updateRepoScore(this.state, repo, updates);
    this.autoSave();
  }

  incrementMergedCount(repo: string): void {
    repoScoring.incrementMergedCount(this.state, repo);
    this.autoSave();
  }

  incrementClosedCount(repo: string): void {
    repoScoring.incrementClosedCount(this.state, repo);
    this.autoSave();
  }

  markRepoHostile(repo: string): void {
    repoScoring.markRepoHostile(this.state, repo);
    this.autoSave();
  }

  getReposWithMergedPRs(): string[] {
    return repoScoring.getReposWithMergedPRs(this.state);
  }

  getReposWithOpenPRs(): string[] {
    return repoScoring.getReposWithOpenPRs(this.state);
  }

  getHighScoringRepos(minScore?: number): string[] {
    return repoScoring.getHighScoringRepos(this.state, minScore);
  }

  getLowScoringRepos(maxScore?: number): string[] {
    return repoScoring.getLowScoringRepos(this.state, maxScore);
  }

  getStats(): Stats {
    return repoScoring.getStats(this.state);
  }
}

// Singleton instance
let stateManager: StateManager | null = null;

/**
 * Get the singleton StateManager instance, creating it on first call.
 */
export function getStateManager(): StateManager {
  if (!stateManager) {
    stateManager = new StateManager();
  }
  return stateManager;
}

/**
 * Reset the singleton StateManager instance to null. Intended for test isolation.
 */
export function resetStateManager(): void {
  stateManager = null;
}
