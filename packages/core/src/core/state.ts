/**
 * State management for the OSS Contribution Agent.
 * Thin coordinator that delegates persistence to state-persistence.ts
 * and scoring logic to repo-score-manager.ts.
 */

import * as fs from 'node:fs';
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
import { AgentStateSchema } from './state-schema.js';
import {
  loadState,
  saveState,
  reloadStateIfChanged,
  createFreshState,
  atomicWriteFileSync,
  type LoadRecoveryInfo,
} from './state-persistence.js';
import * as repoScoring from './repo-score-manager.js';
import type { Stats } from './repo-score-manager.js';
import { debug, warn } from './logger.js';
import { errorMessage, ConfigurationError, ConcurrencyError, isTransientNetworkError } from './errors.js';
import { GistStateStore, type OctokitLike } from './gist-state-store.js';
import * as guidelinesStoreModule from './guidelines-store.js';
import { renderGistWarning, type GistHealth, type GistWarningCause } from './gist-health.js';
import { getStatePath, getStateCachePath, getGistIdPath } from './paths.js';
import { parseGitHubUrl } from './urls.js';

export { acquireLock, releaseLock, atomicWriteFileSync } from './state-persistence.js';
export type { LoadRecoveryInfo } from './state-persistence.js';
export type { Stats } from './repo-score-manager.js';

const MODULE = 'state';

/**
 * Validate stored-PR URL shape before persistence (mirror of the read-side
 * filter in dashboard-data#storedToMergedPRs/storedToClosedPRs). Bad URLs are
 * logged at warn level so operators see the drop in the daily output.
 */
function filterValidUrlEntries<T extends { url: string }>(
  entries: T[],
  kind: 'merged' | 'closed',
): { valid: T[]; dropped: number } {
  const valid: T[] = [];
  let dropped = 0;
  for (const entry of entries) {
    if (parseGitHubUrl(entry.url) === null) {
      warn(MODULE, `Dropping ${kind} PR with invalid URL: ${entry.url}`);
      dropped++;
      continue;
    }
    valid.push(entry);
  }
  return { valid, dropped };
}

/**
 * Fill outcome-ledger timestamps (#1461) missing on an existing stored PR
 * from a richer re-seen entry. Only fills absent fields — never overwrites —
 * so an earlier enriched write (and stamps like commentsFetchedAt that live
 * solely on the stored entry) cannot be clobbered by a later minimal one.
 * @returns true when at least one field was filled
 */
function upgradeLedgerFields(
  existing: { openedAt?: string; firstMaintainerResponseAt?: string },
  incoming: { openedAt?: string; firstMaintainerResponseAt?: string },
): boolean {
  let changed = false;
  if (incoming.openedAt && !existing.openedAt) {
    existing.openedAt = incoming.openedAt;
    changed = true;
  }
  if (incoming.firstMaintainerResponseAt && !existing.firstMaintainerResponseAt) {
    existing.firstMaintainerResponseAt = incoming.firstMaintainerResponseAt;
    changed = true;
  }
  return changed;
}

/**
 * Push state to the backing Gist when Gist mode is active. Best-effort:
 * network/auth failures are logged via `warn()` but never propagated —
 * the caller's primary mutation has already succeeded locally and the
 * next successful push (or a daily run) will re-sync.
 *
 * Intended for state-mutating PR-flow commands (shelve / unshelve / move /
 * dismiss / undismiss / claim) so Gist-sync users don't see day-long drift
 * between machines waiting for the next `daily` checkpoint. See issue #1036.
 *
 * @returns `null` when the push succeeded (or Gist mode is off); otherwise a
 * human-readable warning the caller should surface in its structured output.
 * `checkpoint()` resolves `false` without throwing when the push failed
 * after its retry — previously that was discarded everywhere except
 * `state --sync`, so a failed cross-machine sync reported clean success
 * (#1370). stderr `warn()` alone is invisible to MCP/dashboard consumers.
 */
export async function maybeCheckpoint(stateManager: StateManager, callerModule: string): Promise<string | null> {
  if (!stateManager.isGistMode()) return null;
  try {
    const pushed = await stateManager.checkpoint();
    if (!pushed) {
      const msg =
        'Gist checkpoint push failed after retry; the local mutation is saved and will sync on the next successful push';
      warn(callerModule, msg);
      return msg;
    }
    return null;
  } catch (err) {
    const msg = `Gist checkpoint failed (local mutation succeeded, will retry on next push): ${errorMessage(err)}`;
    warn(callerModule, msg);
    return msg;
  }
}

/**
 * Singleton manager for persistent agent state stored in ~/.oss-autopilot/state.json.
 *
 * Delegates file I/O to state-persistence.ts and scoring logic to repo-score-manager.ts.
 * Retains lightweight CRUD operations for config, issues, shelving, dismissal,
 * and status overrides.
 */
/**
 * Surfaced when the in-memory cached state is no longer in sync with the
 * canonical Gist — typically because `refreshFromGist()` failed (network
 * blip, rate limit, expired token) or because the bootstrap fell back to
 * the local cache file (#1193). Commands include this in their `--json`
 * envelope so cron/dashboard consumers can react instead of silently
 * operating on stale data.
 */
export interface StalenessInfo {
  /** Why we're operating on cached data. Forward-compatible with future sources. */
  source: 'cache';
  /** Human-readable reason from the underlying error. */
  reason: string;
  /** ISO timestamp of the most recent successful refresh, or null if never. */
  lastSuccessfulRefresh: string | null;
  /** ISO timestamp when this staleness marker was first set. */
  detectedAt: string;
}

export class StateManager {
  protected state: AgentState;
  protected inMemoryOnly: boolean;
  private lastLoadedMtimeMs: number = 0;
  private _batching = false;
  private _batchDirty = false;
  protected gistStore: GistStateStore | null = null;
  protected gistDegraded = false;
  private staleness: StalenessInfo | null = null;
  private lastSuccessfulRefreshAt: string | null = null;
  private loadRecovery: LoadRecoveryInfo | null = null;

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
      this.loadRecovery = result.recovery ?? null;
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
    let localRecovery: LoadRecoveryInfo | null = null;
    if (fs.existsSync(statePath)) {
      // Existing user: load local state and migrate it into the Gist if no Gist exists yet.
      const localStateResult = loadState();
      localRecovery = localStateResult.recovery ?? null;
      const migrationResult = await gistStore.bootstrapWithMigration(localStateResult.state);
      result = migrationResult;

      // If a new Gist was just created from local state, rename the local file
      // so it no longer competes as the source of truth on future startups.
      if (migrationResult.migrated) {
        try {
          const preGistPath = statePath + '.pre-gist-migration';
          fs.renameSync(statePath, preGistPath);
          debug(MODULE, `Renamed ${statePath} to ${preGistPath} after Gist migration`);
        } catch (err) {
          warn(MODULE, `Failed to rename state.json after Gist migration: ${err}`);
        }
      }
    } else {
      result = await gistStore.bootstrap();
    }

    const manager = new StateManager(true); // start in-memory
    manager.state = result.state;
    if (result.gistId) {
      manager.state.gistId = result.gistId;
    }
    manager.gistStore = gistStore;
    manager.gistDegraded = result.degraded ?? false;
    manager.inMemoryOnly = false; // re-enable persistence
    // Surface a recovery that happened while loading the local file for Gist
    // migration — the recovered (or fresh) state is what got migrated.
    manager.loadRecovery = localRecovery;

    // Seed the staleness marker if bootstrap fell back to the local cache —
    // a `daily` running on a cron right after this start needs to know.
    if (result.degraded) {
      manager.staleness = {
        source: 'cache',
        reason: 'initial Gist bootstrap fell back to local cache',
        lastSuccessfulRefresh: null,
        detectedAt: new Date().toISOString(),
      };
    }

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
   *
   * Local-file mode uses optimistic compare-and-swap: if another process has
   * written `state.json` since we last loaded/saved, `saveState` throws
   * `ConcurrencyError`. See issue #1030.
   *
   * @throws ConcurrencyError (local file mode only) when the on-disk state
   *   was modified externally between this StateManager's last load/save
   *   and now. Callers that tolerate silent merge can set
   *   `{ allowReloadAndLoseMutation: true }` to downgrade the error into a
   *   warning — but note that doing so abandons any in-memory mutation
   *   made since the last load. Fail-loud (the default) is preferred.
   */
  save(options: { allowReloadAndLoseMutation?: boolean } = {}): void {
    this.state.lastRunAt = new Date().toISOString();

    if (this.inMemoryOnly) {
      return;
    }

    if (this.gistStore) {
      // In Gist mode, write to local cache (not main state file).
      // The Gist is the source of truth; local cache is for fallback.
      // Intentionally NO compare-and-swap on this cache path — two processes
      // racing on state-cache.json can clobber each other, but the next
      // `refreshFromGist()` or `checkpoint()` re-syncs from the authoritative
      // Gist. The trade-off is a transiently-stale offline bootstrap (#1030).
      try {
        atomicWriteFileSync(getStateCachePath(), JSON.stringify(this.state, null, 2), 0o600);
      } catch (err) {
        // Cache write failure is non-fatal (Gist remains source of truth), but
        // silent failure masks degraded-mode risk on next offline bootstrap (#994).
        warn(MODULE, `Failed to write Gist local cache: ${errorMessage(err)}`);
      }
      return;
    }

    // Local file mode with optimistic compare-and-swap.
    try {
      this.lastLoadedMtimeMs = saveState(this.state, this.lastLoadedMtimeMs);
    } catch (err) {
      if (err instanceof ConcurrencyError && options.allowReloadAndLoseMutation) {
        warn(MODULE, `Concurrent external write detected; reloading and discarding in-memory mutation. ${err.message}`);
        this.reloadIfChanged();
        return;
      }
      throw err;
    }
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
   * Single source of truth for gist persistence health (#1444). Surfaces
   * that need "is this process reliably syncing to the Gist?" (daily
   * warnings, dashboard banners/recovery gates) derive it from here instead
   * of re-combining `config.persistence` / `isGistMode()` /
   * `isGistDegraded()` at each call site.
   *
   * Composes the same primitive fields those accessors expose:
   * - no gist store + config asks for gist → `configured-but-local`
   * - gist store attached but disarmed (#1443) → `bootstrap-degraded`
   *   (`since` comes from the staleness marker the degraded bootstrap seeds)
   * - otherwise healthy (`degraded: null`)
   */
  getGistHealth(): GistHealth {
    if (this.gistStore === null) {
      return {
        mode: 'local',
        degraded:
          this.state.config.persistence === 'gist' ? { cause: 'configured-but-local', recoverable: true } : null,
      };
    }
    if (this.gistDegraded) {
      return {
        mode: 'gist',
        degraded: {
          cause: 'bootstrap-degraded',
          ...(this.staleness ? { since: this.staleness.detectedAt } : {}),
          recoverable: true,
        },
      };
    }
    return { mode: 'gist', degraded: null };
  }

  /**
   * Whether per-repo guidelines (#867) are available. True iff the Gist store
   * is initialized — in local-only mode, guidelines are unavailable and
   * write operations would throw {@link GuidelinesNotAvailableError}.
   */
  isGuidelinesAvailable(): boolean {
    return this.gistStore !== null;
  }

  /**
   * Read the per-repo guidelines for `repo` (#867). Returns null when in
   * local mode, when no file exists, or when the file is empty (tombstoned).
   */
  getGuidelines(repo: string): string | null {
    return guidelinesStoreModule.getGuidelines(this.gistStore, repo);
  }

  /**
   * Persist per-repo guidelines for `repo`. Throws when not in Gist mode or
   * when content exceeds the byte budget.
   */
  setGuidelines(repo: string, content: string): void {
    guidelinesStoreModule.setGuidelines(this.gistStore, repo, content);
    this.autoSave();
  }

  /**
   * Tombstone the guidelines file for `repo` so subsequent reads return null.
   * Throws when not in Gist mode.
   */
  deleteGuidelines(repo: string): void {
    guidelinesStoreModule.deleteGuidelines(this.gistStore, repo);
    this.autoSave();
  }

  /** List repos with non-empty guidelines stored in the Gist. */
  listGuidelinesRepos(): string[] {
    return guidelinesStoreModule.listGuidelinesRepos(this.gistStore);
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
    if (this.gistStore) return false; // Gist is the source of truth; skip local file reload
    const result = reloadStateIfChanged(this.lastLoadedMtimeMs);
    if (!result) return false;
    this.state = result.state;
    this.lastLoadedMtimeMs = result.mtimeMs;
    this.loadRecovery = result.recovery ?? null;
    this.tryReconcilePRCounts();
    return true;
  }

  /**
   * Recovery details from the most recent state load, or null when the last
   * load read the state file cleanly (or no load from disk has happened,
   * e.g. in-memory mode). Set when loadState() fell back to a backup or
   * fresh state because the main file was corrupt or invalid (#1371).
   */
  getLoadRecovery(): LoadRecoveryInfo | null {
    return this.loadRecovery;
  }

  /**
   * Re-fetch state from the backing Gist (if in Gist mode).
   * Throttled to once per 30 seconds by GistStateStore. Returns true if state was refreshed.
   */
  async refreshFromGist(): Promise<boolean> {
    if (!this.gistStore) return false;
    const result = await this.gistStore.refreshFromGist();
    // StateManager keeps its boolean shape (callers rely on truthy-check
    // semantics) but consults the discriminated union internally to know
    // whether to reload state.json from the now-fresh cache (#1209 L9).
    const refreshed = result.status === 'refreshed';
    if (refreshed) {
      const raw = this.gistStore.cachedFiles.get('state.json');
      if (!raw) {
        warn(MODULE, 'Gist refreshed but state.json missing from cache');
        // HTTP fetch succeeded but the Gist body is missing state.json — we
        // still have stale in-memory data, so surface a marker rather than
        // silently returning false (#1193 review).
        this.staleness = {
          source: 'cache',
          reason: 'Gist refresh returned no state.json file',
          lastSuccessfulRefresh: this.lastSuccessfulRefreshAt,
          detectedAt: new Date().toISOString(),
        };
        return false;
      }
      try {
        this.state = AgentStateSchema.parse(JSON.parse(raw));
        this.tryReconcilePRCounts();
      } catch (err) {
        warn(MODULE, `Failed to parse refreshed Gist state: ${errorMessage(err)}`);
        // Same reasoning as the missing-file branch: parse failure leaves us
        // on stale in-memory state, so flag it.
        this.staleness = {
          source: 'cache',
          reason: `Gist refresh succeeded but payload was invalid: ${errorMessage(err)}`,
          lastSuccessfulRefresh: this.lastSuccessfulRefreshAt,
          detectedAt: new Date().toISOString(),
        };
        return false;
      }
      // Successful refresh clears any prior staleness (#1193).
      this.lastSuccessfulRefreshAt = new Date().toISOString();
      this.staleness = null;
    } else if (this.gistStore.lastRefreshError) {
      // Distinguish "fetch failed" (set marker) from "throttled" (preserve
      // any existing marker, set nothing new).
      this.staleness = {
        source: 'cache',
        reason: errorMessage(this.gistStore.lastRefreshError),
        lastSuccessfulRefresh: this.lastSuccessfulRefreshAt,
        detectedAt: new Date().toISOString(),
      };
    }
    return refreshed;
  }

  /**
   * Returns a staleness marker when the in-memory state diverged from the
   * canonical Gist (refresh failure or degraded bootstrap), or `null` when
   * state is current. Commands surface this via their `--json` warnings
   * envelope (#1193).
   */
  getStateStaleness(): StalenessInfo | null {
    return this.staleness;
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
   * Persist the timestamp of the most recent strategy snapshot embedded
   * in a daily run output (#1270). Called from the daily pipeline after
   * `computeStrategy()` succeeds; the cadence gate in
   * {@link shouldComputeStrategy} reads this on the next run.
   */
  setLastStrategyAt(iso: string): void {
    this.state.lastStrategyAt = iso;
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
   * Entries with URLs that fail {@link parseGitHubUrl} are dropped before
   * persistence (read-side filters in dashboard-data already skip them, but
   * this prevents the bad data from reaching disk in the first place).
   *
   * Re-seen URLs are not re-added, but upgrade the stored entry in place
   * (#1461): outcome-ledger fields (`openedAt`, `firstMaintainerResponseAt`)
   * missing on the stored entry are filled from the richer incoming one.
   * Existing values are never overwritten, so stamps that live only on the
   * stored entry (commentsFetchedAt, learningsExtractedAt) and earlier
   * enriched writes stay intact.
   *
   * @param prs - Merged PRs to add (duplicates by URL upgrade in place)
   * @returns count of entries added vs. dropped (invalid URL)
   */
  addMergedPRs(prs: StoredMergedPR[]): { added: number; dropped: number } {
    if (prs.length === 0) return { added: 0, dropped: 0 };
    const { valid, dropped } = filterValidUrlEntries(prs, 'merged');
    if (valid.length === 0) return { added: 0, dropped };
    if (!this.state.mergedPRs) this.state.mergedPRs = [];
    const byUrl = new Map(this.state.mergedPRs.map((pr) => [pr.url, pr]));
    const newPRs: StoredMergedPR[] = [];
    let upgraded = false;
    for (const pr of valid) {
      const existing = byUrl.get(pr.url);
      if (existing) {
        upgraded = upgradeLedgerFields(existing, pr) || upgraded;
      } else {
        newPRs.push(pr);
        byUrl.set(pr.url, pr);
      }
    }
    if (newPRs.length === 0 && !upgraded) return { added: 0, dropped };
    this.state.mergedPRs.push(...newPRs);
    this.state.mergedPRs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    debug(MODULE, `Added ${newPRs.length} merged PRs (total: ${this.state.mergedPRs.length})`);
    this.autoSave();
    return { added: newPRs.length, dropped };
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
   * Entries with URLs that fail {@link parseGitHubUrl} are dropped before
   * persistence (read-side filters in dashboard-data already skip them, but
   * this prevents the bad data from reaching disk in the first place).
   *
   * Re-seen URLs upgrade the stored entry's missing ledger fields in place
   * (#1461) — see {@link addMergedPRs} for the full semantics.
   *
   * @param prs - Closed PRs to add (duplicates by URL upgrade in place)
   * @returns count of entries added vs. dropped (invalid URL)
   */
  addClosedPRs(prs: StoredClosedPR[]): { added: number; dropped: number } {
    if (prs.length === 0) return { added: 0, dropped: 0 };
    const { valid, dropped } = filterValidUrlEntries(prs, 'closed');
    if (valid.length === 0) return { added: 0, dropped };
    if (!this.state.closedPRs) this.state.closedPRs = [];
    const byUrl = new Map(this.state.closedPRs.map((pr) => [pr.url, pr]));
    const newPRs: StoredClosedPR[] = [];
    let upgraded = false;
    for (const pr of valid) {
      const existing = byUrl.get(pr.url);
      if (existing) {
        upgraded = upgradeLedgerFields(existing, pr) || upgraded;
      } else {
        newPRs.push(pr);
        byUrl.set(pr.url, pr);
      }
    }
    if (newPRs.length === 0 && !upgraded) return { added: 0, dropped };
    this.state.closedPRs.push(...newPRs);
    this.state.closedPRs.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
    debug(MODULE, `Added ${newPRs.length} closed PRs (total: ${this.state.closedPRs.length})`);
    this.autoSave();
    return { added: newPRs.length, dropped };
  }

  /** Returns the most recent close date, used as a watermark for incremental fetching. */
  getClosedPRWatermark(): string | undefined {
    return this.state.closedPRs?.[0]?.closedAt || undefined;
  }

  /**
   * Stamp `commentsFetchedAt` on the merged or closed PR matching `url` (#867).
   * No-op when no PR with that URL is stored.
   */
  markPRCommentsFetched(url: string, fetchedAt: string): void {
    const merged = this.state.mergedPRs?.find((pr) => pr.url === url);
    if (merged) {
      merged.commentsFetchedAt = fetchedAt;
      this.autoSave();
      return;
    }
    const closed = this.state.closedPRs?.find((pr) => pr.url === url);
    if (closed) {
      closed.commentsFetchedAt = fetchedAt;
      this.autoSave();
    }
  }

  /**
   * Stamp `learningsExtractedAt` on the merged or closed PR matching `url` (#867).
   * No-op when no PR with that URL is stored.
   */
  markPRLearningsExtracted(url: string, extractedAt: string): void {
    const merged = this.state.mergedPRs?.find((pr) => pr.url === url);
    if (merged) {
      merged.learningsExtractedAt = extractedAt;
      this.autoSave();
      return;
    }
    const closed = this.state.closedPRs?.find((pr) => pr.url === url);
    if (closed) {
      closed.learningsExtractedAt = extractedAt;
      this.autoSave();
    }
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
 *
 * **Important:** This must be called (and awaited) before any command runs for
 * Gist mode to be active. It pre-sets the singleton so that subsequent
 * `getStateManager()` calls return the Gist-backed instance. If this is not
 * called first, `getStateManager()` will lazily create a local-only
 * StateManager and Gist checkpoints will be no-ops.
 */
export async function getStateManagerAsync(token?: string): Promise<StateManager> {
  // #1415: a LOCAL-mode singleton does not short-circuit when a token is
  // provided. The only token-bearing caller is ensureGistPersistence, which
  // already verified the config says `persistence: gist` — so a local
  // singleton here means a previous transient init failure fell back (or a
  // tool body lazily created the local manager before auth resolved), and
  // this call is the retry that must be allowed to upgrade it. The old
  // unconditional early return made every retry a dead no-op, permanently
  // latching gist-configured processes into silent local-only writes.
  //
  // #1443: a gist-DEGRADED singleton is the same latch through another door.
  // A degraded bootstrap disarms the store (null gistId) but still assigns
  // gistStore, so isGistMode() alone reported it healthy and the early
  // return made re-bootstrap impossible (refreshFromGist short-circuits
  // forever on the null gistId). A later token-bearing call must be allowed
  // to replace it with a freshly bootstrapped manager.
  if (stateManager && (!token || (stateManager.isGistMode() && !stateManager.isGistDegraded()))) {
    return stateManager;
  }
  if (asyncManagerPromise) return asyncManagerPromise;

  if (token) {
    asyncManagerPromise = StateManager.createWithGist(token)
      .then((mgr) => {
        // Upgrade note: replacing a transient-fallback local singleton fixes
        // FUTURE operations. Mutations made during the degraded window stay
        // in the local state.json only — when a Gist already exists they are
        // NOT merged into it by this upgrade (bootstrapWithMigration seeds a
        // Gist from local state only on first creation). The per-call MCP
        // warning is the signal that those writes were at risk.
        //
        // The same data boundary applies when replacing a gist-DEGRADED
        // singleton (#1443): its mutations were saved to the local cache
        // file only (a degraded store never pushes), and a successful
        // re-bootstrap pulls the existing Gist — those cache-only writes
        // are NOT merged into it. The degraded-window warnings each
        // mutation surfaced (maybeCheckpoint) are the honest record.
        stateManager = mgr;
        asyncManagerPromise = null;
        return mgr;
      })
      .catch((err) => {
        asyncManagerPromise = null;
        // Configuration errors (e.g. GistPermissionError, GistCorruptError)
        // must surface — falling back to local-only would silently split state
        // across machines (#1202).
        if (err instanceof ConfigurationError) throw err;
        // Only fall back on actual network/server errors. Other failures
        // (auth, schema, concurrency conflicts) indicate the Gist mode is
        // broken in a way the user needs to address — silently falling back
        // would write subsequent mutations to the local file while the Gist
        // marker stays in config, causing permanent cross-machine divergence.
        if (!isTransientNetworkError(err)) throw err;
        // Intentional CLI semantics: a one-shot process warns and proceeds
        // local-only. Long-lived callers (MCP) detect this via the
        // ensureGistPersistence return status and retry on later calls.
        warn(MODULE, `Gist initialization failed (transient network error), falling back to local-only mode: ${err}`);
        return getStateManager();
      });
    return asyncManagerPromise;
  }

  return getStateManager();
}

/**
 * Bootstrap helper for processes that may run in Gist persistence mode.
 *
 * Peeks at the state file to check if Gist mode is configured. If so and a
 * valid token is provided, pre-sets the singleton via {@link getStateManagerAsync}
 * so subsequent synchronous {@link getStateManager} calls return the Gist-backed
 * instance. No-op when the state file is absent, unparseable, or not in Gist mode.
 *
 * Consolidates identical filesystem-peek + getStateManagerAsync logic that
 * was duplicated between the CLI bootstrap (`cli.ts`) and MCP tool bootstrap
 * (`mcp-server/src/tools.ts`) — #1000.
 *
 * @param token - GitHub token with `gist` scope, or `null` to skip activation
 *
 * @example
 * // CLI bootstrap
 * await ensureGistPersistence(token);
 */
export type GistPersistenceStatus =
  /** No state file yet, or config does not request gist mode. */
  | 'local-mode'
  /** The state file exists but could not be read/parsed for this attempt
   * (permissions, transient FS error, corrupt JSON). Callers must NOT
   * memoize this as "local mode chosen" — a later attempt may succeed. */
  | 'state-unreadable'
  /** Gist mode is configured but no token was available for this attempt. */
  | 'no-token'
  /** Gist mode active: the singleton is gist-backed AND the store is armed
   * (the bootstrap actually verified its Gist — not a degraded fallback). */
  | 'gist'
  /** Gist mode is configured and a token was available, but this process is
   * not writing to the Gist: init either fell back to a local-only manager
   * (transient network failure) or bootstrapped DEGRADED off the local
   * cache (#1443 — gist-backed but disarmed, reads stale and pushes fail).
   * A later call may recover. */
  | 'degraded';

export async function ensureGistPersistence(token: string | null): Promise<GistPersistenceStatus> {
  let persistence: string | undefined;
  try {
    const raw = fs.readFileSync(getStatePath(), 'utf8');
    persistence = JSON.parse(raw)?.config?.persistence;
  } catch (err) {
    // Anything other than a missing file (EACCES, EMFILE, corrupt JSON) must
    // not be silently classified as a local-mode CHOICE — that would
    // re-create the #1415 latch through a third door when the caller
    // memoizes the answer.
    if ((err as { code?: unknown }).code !== 'ENOENT') {
      warn(MODULE, `State file unreadable during gist-persistence check (will retry): ${errorMessage(err)}`);
      return 'state-unreadable';
    }
    // A missing state.json is NOT proof of local mode either (#1438): the
    // first-time Gist migration renames state.json away, and gist-mode
    // saves only ever write state-cache.json — so on the machine that
    // created the Gist this peek is all that stands between the user and a
    // silent fall back to fresh local state. Consult the gist-side
    // artifacts before concluding "fresh local-mode user".
    const fallback = peekGistArtifacts();
    if (fallback === 'local') return 'local-mode';
    if (fallback === 'unreadable') return 'state-unreadable';
    persistence = 'gist';
  }

  if (persistence !== 'gist') return 'local-mode';
  // #1415: report the distinction the MCP layer needs — "gist configured but
  // token missing" and "init fell back to local" both mean the process is
  // NOT writing to the Gist despite the config saying it should, and a
  // long-lived caller must keep retrying instead of memoizing the outcome.
  if (!token) return 'no-token';
  const mgr = await getStateManagerAsync(token);
  // #1443: a DEGRADED bootstrap still assigns gistStore (isGistMode() is
  // true) but the store is disarmed — reads serve the stale cache and
  // pushes fail. Reporting it 'gist' memoized the failure as success in
  // every long-lived caller (MCP init memo, dashboard recovery gate).
  return mgr.isGistMode() && !mgr.isGistDegraded() ? 'gist' : 'degraded';
}

/**
 * Decide persistence mode when `state.json` is absent (#1438).
 *
 * The local state cache is written by every successful Gist fetch and by
 * first-time Gist creation, and carries the synced config; the gist-id file
 * is written whenever a Gist is created or discovered. Either one identifies
 * a gist-configured machine whose `state.json` was renamed away by the
 * first-time migration — NOT a fresh local-mode install. A cache whose
 * config explicitly says non-gist wins over the gist-id file: it reflects
 * the most recent synced choice.
 */
function peekGistArtifacts(): 'gist' | 'local' | 'unreadable' {
  try {
    const raw = fs.readFileSync(getStateCachePath(), 'utf8');
    return JSON.parse(raw)?.config?.persistence === 'gist' ? 'gist' : 'local';
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'ENOENT') {
      warn(MODULE, `State cache unreadable during gist-persistence check (will retry): ${errorMessage(err)}`);
      return 'unreadable';
    }
  }
  try {
    return fs.existsSync(getGistIdPath()) ? 'gist' : 'local';
  } catch (err) {
    warn(MODULE, `Gist ID check failed during gist-persistence check (will retry): ${errorMessage(err)}`);
    return 'unreadable';
  }
}

/**
 * Best-effort gist bootstrap for entry points WITHOUT the auth gate (#1431):
 * the CLI's localOnly commands (shelve/move/dismiss/override/config/setup/...)
 * skip token enforcement, but a gist-configured user's mutations must still
 * reach the Gist — their maybeCheckpoint calls silently no-op when the
 * singleton never bootstrapped.
 *
 * Returns a human-readable LOCAL-ONLY warning when the process will write
 * local-only despite a gist config, or null when no warning is needed
 * (local mode, or gist mode successfully activated).
 *
 * Ordering: peek first with no token (zero spawn cost for genuinely-local
 * users), fetch a token only when the config asks for gist. Hard
 * ConfigurationErrors are converted to a warning instead of thrown — the
 * localOnly set includes config/setup, the very commands needed to REPAIR a
 * broken gist setup, so they must not be bricked by it. (The auth-gated
 * path keeps throwing per #1202.)
 */
export async function bootstrapGistBestEffort(fetchToken: () => Promise<string | null>): Promise<string | null> {
  // Prose comes from the shared renderer (#1444) so this surface, the CLI
  // envelope, and the MCP injection all describe degradation identically.
  let cause: GistWarningCause | { reason: string } | null = null;
  try {
    let status = await ensureGistPersistence(null);
    if (status === 'no-token') {
      status = await ensureGistPersistence(await fetchToken());
    }
    if (status === 'no-token') cause = 'no-token';
    else if (status === 'state-unreadable') cause = 'state-unreadable';
    else if (status === 'degraded') cause = 'init-fallback';
  } catch (err) {
    cause = {
      reason:
        err instanceof ConfigurationError
          ? `Gist initialization failed (${errorMessage(err)}) — fix the Gist setup (check the token's gist scope, or run state-show / setup) before relying on sync`
          : `Gist initialization failed: ${errorMessage(err)}`,
    };
  }
  if (cause === null) return null;
  return renderGistWarning(cause);
}

/**
 * Reset the singleton StateManager instance to null. Intended for test isolation.
 */
export function resetStateManager(): void {
  stateManager = null;
  asyncManagerPromise = null;
}
