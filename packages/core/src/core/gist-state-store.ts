/**
 * Gist-based persistence layer for oss-autopilot state.
 *
 * Manages a single private GitHub Gist that stores `state.json` (structured state)
 * and potentially freeform markdown documents. Provides an in-memory file cache
 * for session-scoped reads and a local cache write-through for degraded-mode fallback.
 *
 * Bootstrap flow:
 *  1. Check for locally stored Gist ID file (`~/.oss-autopilot/gist-id`)
 *  2. If found, fetch that Gist directly via `GET /gists/:id`
 *  3. If not found locally, search the user's Gists for description `oss-autopilot-state`
 *  4. If found via search, store the ID locally and fetch it
 *  5. If not found anywhere, create a new private Gist with seed files and store the ID
 *  6. Cache all Gist file contents in memory for session-scoped reads
 *  7. Write state to a local cache file for fallback
 */

import * as fs from 'fs';
import { AgentState } from './types.js';
import { AgentStateSchema } from './state-schema.js';
import { atomicWriteFileSync, createFreshState, migrateV1ToV2, migrateV2ToV3 } from './state-persistence.js';
import { getGistIdPath, getStateCachePath } from './utils.js';
import { debug, warn } from './logger.js';
import { GistPermissionError, isRateLimitError } from './errors.js';

const MODULE = 'gist-store';

/** Well-known Gist description used for search-based discovery. */
export const GIST_DESCRIPTION = 'oss-autopilot-state';

/** Primary state file name inside the Gist. */
export const STATE_FILE_NAME = 'state.json';

/** Result of a successful bootstrap. */
export interface BootstrapResult {
  gistId: string;
  state: AgentState;
  created: boolean;
  /** True when state was loaded from local cache due to API failure. */
  degraded?: boolean;
}

/**
 * Minimal Octokit-shaped interface for the Gist API methods we use.
 * Accepts the real ThrottledOctokit or a plain mock object in tests.
 */
export interface OctokitLike {
  gists: {
    get: (params: { gist_id: string }) => Promise<{ data: GistResponseData }>;
    list: (params: { per_page: number; page: number }) => Promise<{ data: GistListItem[] }>;
    create: (params: {
      description: string;
      public: boolean;
      files: Record<string, { content: string }>;
    }) => Promise<{ data: GistResponseData }>;
    update: (params: {
      gist_id: string;
      files: Record<string, { content: string }>;
    }) => Promise<{ data: GistResponseData }>;
  };
}

/** Shape of a single Gist in a list response (subset). */
interface GistListItem {
  id: string;
  description: string | null;
}

/** Shape of a full Gist response (subset). */
interface GistResponseData {
  id: string;
  description: string | null;
  files: Record<string, { filename: string; content?: string } | null>;
}

/**
 * Gist-backed state store with in-memory file cache and local write-through.
 */
export class GistStateStore {
  private gistId: string | null = null;
  readonly cachedFiles: Map<string, string> = new Map();
  readonly dirtyFiles: Set<string> = new Set();
  private readonly octokit: OctokitLike;
  private lastRefreshAt = 0;
  private static readonly REFRESH_THROTTLE_MS = 30_000;

  constructor(octokit: OctokitLike) {
    this.octokit = octokit;
  }

  /**
   * Bootstrap the Gist store: locate or create the backing Gist,
   * populate the in-memory cache, and write the local cache file.
   */
  async bootstrap(): Promise<BootstrapResult> {
    try {
      await this.checkGistScope();

      // Step 1: Try loading Gist ID from local file
      const localId = this.readLocalGistId();
      if (localId) {
        debug(MODULE, `Found local Gist ID: ${localId}`);
        try {
          this.gistId = localId;
          const state = await this.fetchAndCache(localId);
          return { gistId: localId, state, created: false };
        } catch (err) {
          warn(MODULE, `Failed to fetch Gist ${localId}, will search/create`, err);
          // Fall through to search
        }
      }

      // Step 2: Search user's Gists by description
      const foundId = await this.searchForGist();
      if (foundId) {
        debug(MODULE, `Found Gist via search: ${foundId}`);
        this.gistId = foundId;
        this.writeLocalGistId(foundId);
        const state = await this.fetchAndCache(foundId);
        return { gistId: foundId, state, created: false };
      }

      // Step 3: Create a new Gist
      debug(MODULE, 'No existing Gist found, creating new one');
      const { id, state } = await this.createGist();
      this.writeLocalGistId(id);
      return { gistId: id, state, created: true };
    } catch (err) {
      // Configuration errors (e.g. GistPermissionError) must surface, not degrade
      if (err instanceof GistPermissionError) throw err;

      // All API paths failed — enter degraded mode
      warn(MODULE, 'All Gist API paths failed, entering degraded mode', err);

      // Try reading from local cache file
      try {
        const cachePath = getStateCachePath();
        if (fs.existsSync(cachePath)) {
          let obj: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));

          // Chain migrations
          if (typeof obj === 'object' && obj !== null) {
            const record = obj as Record<string, unknown>;
            if (record.version === 1) obj = migrateV1ToV2(record);
            if ((obj as Record<string, unknown>).version === 2) obj = migrateV2ToV3(obj as Record<string, unknown>);
          }

          const cachedState = AgentStateSchema.parse(obj);
          debug(MODULE, 'Loaded state from local cache in degraded mode');
          return { gistId: '', state: cachedState, created: false, degraded: true };
        }
      } catch (cacheErr) {
        debug(MODULE, `Failed to read local cache in degraded mode: ${cacheErr}`);
      }

      // No cache either — return fresh state in degraded mode
      debug(MODULE, 'No local cache found, returning fresh state in degraded mode');
      return { gistId: '', state: createFreshState(), created: false, degraded: true };
    }
  }

  /**
   * Bootstrap with migration from an existing local state.
   * If a Gist already exists (found via local ID or search), uses it — no migration needed.
   * If no Gist exists, creates one seeded with the provided existingState instead of a fresh state.
   * @returns BootstrapResult extended with `migrated: true` if a new Gist was created from local state
   */
  async bootstrapWithMigration(existingState: AgentState): Promise<BootstrapResult & { migrated: boolean }> {
    try {
      await this.checkGistScope();

      // Step 1: Try loading Gist ID from local file
      const localId = this.readLocalGistId();
      if (localId) {
        debug(MODULE, `bootstrapWithMigration: found local Gist ID: ${localId}`);
        try {
          this.gistId = localId;
          const state = await this.fetchAndCache(localId);
          return { gistId: localId, state, created: false, migrated: false };
        } catch (err) {
          warn(MODULE, `bootstrapWithMigration: failed to fetch Gist ${localId}, will search/create`, err);
          // Fall through to search
        }
      }

      // Step 2: Search user's Gists by description
      const foundId = await this.searchForGist();
      if (foundId) {
        debug(MODULE, `bootstrapWithMigration: found Gist via search: ${foundId}`);
        this.gistId = foundId;
        this.writeLocalGistId(foundId);
        const state = await this.fetchAndCache(foundId);
        return { gistId: foundId, state, created: false, migrated: false };
      }

      // Step 3: No existing Gist found — create one seeded with the provided state
      debug(MODULE, 'bootstrapWithMigration: no existing Gist found, creating one seeded with local state');
      const { id, state } = await this.createGistFromState(existingState);
      this.writeLocalGistId(id);
      return { gistId: id, state, created: true, migrated: true };
    } catch (err) {
      // Configuration errors (e.g. GistPermissionError) must surface, not degrade
      if (err instanceof GistPermissionError) throw err;

      // All API paths failed — enter degraded mode
      warn(MODULE, 'bootstrapWithMigration: all Gist API paths failed, entering degraded mode', err);

      // Try reading from local cache file
      try {
        const cachePath = getStateCachePath();
        if (fs.existsSync(cachePath)) {
          let obj: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));

          // Chain migrations
          if (typeof obj === 'object' && obj !== null) {
            const record = obj as Record<string, unknown>;
            if (record.version === 1) obj = migrateV1ToV2(record);
            if ((obj as Record<string, unknown>).version === 2) obj = migrateV2ToV3(obj as Record<string, unknown>);
          }

          const cachedState = AgentStateSchema.parse(obj);
          debug(MODULE, 'bootstrapWithMigration: loaded state from local cache in degraded mode');
          return { gistId: '', state: cachedState, created: false, degraded: true, migrated: false };
        }
      } catch (cacheErr) {
        debug(MODULE, `bootstrapWithMigration: failed to read local cache in degraded mode: ${cacheErr}`);
      }

      // No cache either — use the provided existingState in degraded mode
      debug(MODULE, 'bootstrapWithMigration: no local cache found, returning existing state in degraded mode');
      return { gistId: '', state: existingState, created: false, degraded: true, migrated: false };
    }
  }

  /** Return the resolved Gist ID (available after bootstrap). */
  getGistId(): string | null {
    return this.gistId;
  }

  /**
   * Mark a file as dirty so it will be included in the next `push()` call.
   */
  markDirty(filename: string): void {
    this.dirtyFiles.add(filename);
  }

  /**
   * Read a freeform document from the in-memory cache.
   * Returns null if the file has not been loaded (or does not exist in the Gist).
   * Synchronous — all Gist contents are loaded into memory at bootstrap.
   */
  getDocument(filename: string): string | null {
    return this.cachedFiles.get(filename) ?? null;
  }

  /**
   * Write a freeform document into the in-memory cache and mark it dirty
   * so it will be included in the next `push()` call.
   */
  setDocument(filename: string, content: string): void {
    this.cachedFiles.set(filename, content);
    this.markDirty(filename);
  }

  /**
   * Return all filenames in the in-memory cache whose names start with `prefix`.
   * Useful for listing all guidelines files (e.g. prefix `guidelines--`).
   */
  listDocuments(prefix: string): string[] {
    const results: string[] = [];
    for (const filename of this.cachedFiles.keys()) {
      if (filename.startsWith(prefix)) {
        results.push(filename);
      }
    }
    return results;
  }

  /**
   * Stage new state JSON for the next `push()`. Updates the in-memory cache
   * for `state.json` and marks it dirty.
   */
  setState(stateJson: string): void {
    this.cachedFiles.set(STATE_FILE_NAME, stateJson);
    this.markDirty(STATE_FILE_NAME);
  }

  /**
   * Push all dirty files to the backing Gist. Retries once on failure.
   *
   * Returns `true` on success (or when there is nothing to push).
   * Returns `false` if both attempts fail.
   * Throws if the Gist ID has not been resolved yet (bootstrap not called).
   */
  async push(): Promise<boolean> {
    if (this.dirtyFiles.size === 0) {
      return true;
    }

    if (this.gistId === null) {
      throw new Error('GistStateStore: cannot push before bootstrap — gistId is null');
    }

    // Build PATCH payload from the dirty set
    const files: Record<string, { content: string }> = {};
    for (const filename of this.dirtyFiles) {
      const content = this.cachedFiles.get(filename);
      if (content !== undefined) {
        files[filename] = { content };
      }
    }

    const attempt = async (): Promise<boolean> => {
      await this.octokit.gists.update({ gist_id: this.gistId as string, files });
      return true;
    };

    try {
      await attempt();
    } catch (firstErr) {
      debug(MODULE, `push failed on first attempt, retrying: ${firstErr}`);
      try {
        await attempt();
      } catch (secondErr) {
        warn(MODULE, `push failed after retry, giving up: ${secondErr}`);
        return false;
      }
    }

    // Success: flush dirty set and write local cache
    this.dirtyFiles.clear();

    const raw = this.cachedFiles.get(STATE_FILE_NAME);
    if (raw) {
      try {
        const state = this.parseStateFromCache();
        this.writeLocalStateCache(state);
      } catch (err) {
        debug(MODULE, `push succeeded but local cache write failed: ${err}`);
      }
    }

    return true;
  }

  /**
   * Re-fetch the Gist and update the in-memory cache.
   * Throttled to at most once per 30 seconds.
   */
  async refreshFromGist(): Promise<boolean> {
    if (!this.gistId) return false;
    const now = Date.now();
    if (now - this.lastRefreshAt < GistStateStore.REFRESH_THROTTLE_MS) return false;
    try {
      await this.fetchAndCache(this.gistId);
      this.lastRefreshAt = now;
      return true;
    } catch (err) {
      warn(MODULE, `refreshFromGist failed: ${err}`);
      return false;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Preflight check: verify the token has Gist API scope.
   * Costs one cheap API call; catches permission issues early with a clear message.
   */
  private async checkGistScope(): Promise<void> {
    try {
      await this.octokit.gists.list({ per_page: 1, page: 1 });
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        throw new GistPermissionError();
      }
      throw err;
    }
  }

  /**
   * Fetch a Gist by ID, populate the in-memory cache, parse state,
   * and write the local cache file.
   */
  private async fetchAndCache(gistId: string): Promise<AgentState> {
    const { data } = await this.octokit.gists.get({ gist_id: gistId });
    this.gistId = gistId;

    // Populate in-memory cache with ALL files from the Gist
    this.cachedFiles.clear();
    for (const [filename, file] of Object.entries(data.files)) {
      if (file && file.content != null) {
        this.cachedFiles.set(filename, file.content);
      }
    }

    // Parse state.json
    const state = this.parseStateFromCache();

    // Write-through to local cache for degraded-mode fallback
    this.writeLocalStateCache(state);

    return state;
  }

  /**
   * Parse `state.json` from the in-memory cache. Handles v2 migration
   * by running through the Zod schema (which requires version: 3).
   * Falls back to fresh state if the file is missing or unparseable.
   */
  private parseStateFromCache(): AgentState {
    const raw = this.cachedFiles.get(STATE_FILE_NAME);
    if (!raw) {
      debug(MODULE, 'No state.json found in Gist, using fresh state');
      return createFreshState();
    }

    try {
      let obj: unknown = JSON.parse(raw);

      // Chain migrations using shared helpers from state-persistence
      if (typeof obj === 'object' && obj !== null) {
        const record = obj as Record<string, unknown>;
        if (record.version === 1) obj = migrateV1ToV2(record);
        if ((obj as Record<string, unknown>).version === 2) obj = migrateV2ToV3(obj as Record<string, unknown>);
      }

      return AgentStateSchema.parse(obj);
    } catch (err) {
      warn(MODULE, `Failed to parse state.json from Gist: ${err}`);
      return createFreshState();
    }
  }

  /**
   * Search the authenticated user's Gists for one with the well-known description.
   * Pages through up to 10 pages (100 Gists per page) to find it.
   */
  private async searchForGist(): Promise<string | null> {
    try {
      const maxPages = 10;
      for (let page = 1; page <= maxPages; page++) {
        const { data: gists } = await this.octokit.gists.list({ per_page: 100, page });
        if (gists.length === 0) break;

        const match = gists.find((g) => g.description === GIST_DESCRIPTION);
        if (match) {
          return match.id;
        }
      }
    } catch (err) {
      warn(MODULE, 'Failed to search Gists by description', err);
    }
    return null;
  }

  /**
   * Create a new private Gist with seed files and store it in memory.
   */
  private async createGist(): Promise<{ id: string; state: AgentState }> {
    const freshState = createFreshState();
    const stateContent = JSON.stringify(freshState, null, 2);

    const { data } = await this.octokit.gists.create({
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        [STATE_FILE_NAME]: { content: stateContent },
      },
    });

    this.gistId = data.id;

    // Populate in-memory cache
    this.cachedFiles.clear();
    for (const [filename, file] of Object.entries(data.files)) {
      if (file && file.content != null) {
        this.cachedFiles.set(filename, file.content);
      }
    }

    // Write-through to local cache
    this.writeLocalStateCache(freshState);

    return { id: data.id, state: freshState };
  }

  /**
   * Create a new private Gist seeded with the provided state (for migration).
   */
  private async createGistFromState(seedState: AgentState): Promise<{ id: string; state: AgentState }> {
    const stateContent = JSON.stringify(seedState, null, 2);

    const { data } = await this.octokit.gists.create({
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        [STATE_FILE_NAME]: { content: stateContent },
      },
    });

    this.gistId = data.id;

    // Populate in-memory cache
    this.cachedFiles.clear();
    for (const [filename, file] of Object.entries(data.files)) {
      if (file && file.content != null) {
        this.cachedFiles.set(filename, file.content);
      }
    }

    // Write-through to local cache
    this.writeLocalStateCache(seedState);

    return { id: data.id, state: seedState };
  }

  /** Read the locally persisted Gist ID, or return null if not found. */
  private readLocalGistId(): string | null {
    try {
      const gistIdPath = getGistIdPath();
      if (fs.existsSync(gistIdPath)) {
        const id = fs.readFileSync(gistIdPath, 'utf-8').trim();
        return id || null;
      }
    } catch (err) {
      debug(MODULE, 'Could not read local Gist ID file', err);
    }
    return null;
  }

  /** Persist the Gist ID locally for fast lookup on next session. */
  private writeLocalGistId(gistId: string): void {
    try {
      const gistIdPath = getGistIdPath();
      atomicWriteFileSync(gistIdPath, gistId, 0o600);
      debug(MODULE, `Wrote Gist ID to ${gistIdPath}`);
    } catch (err) {
      warn(MODULE, `Failed to write local Gist ID file: ${err}`);
    }
  }

  /** Write state to the local cache file for degraded-mode fallback. */
  private writeLocalStateCache(state: AgentState): void {
    try {
      const cachePath = getStateCachePath();
      atomicWriteFileSync(cachePath, JSON.stringify(state, null, 2), 0o600);
      debug(MODULE, `Wrote state cache to ${cachePath}`);
    } catch (err) {
      warn(MODULE, `Failed to write local state cache: ${err}`);
    }
  }
}
