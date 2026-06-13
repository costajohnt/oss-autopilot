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
 *
 * Concurrency model (#1115, #1235):
 *
 *  Each fetch captures the response's `ETag` and stores it as
 *  `lastFetchedEtag`. The next `push()` sends that ETag back as
 *  `If-Match` so the GitHub Gist API rejects the write with 412 Precondition
 *  Failed if another machine pushed in the interval.
 *
 *  On 412, the store attempts a single merge: it re-fetches the Gist
 *  (refreshing the ETag), re-applies the in-memory dirty content on top of
 *  the now-current remote state, and pushes once more. If that second push
 *  also returns 412, `push()` throws {@link GistConcurrencyError}.
 *
 *  Per-file conflict policy on the merge re-apply step:
 *
 *   - `state.json` is fail-loud. The `StateManager` contract advertises
 *     optimistic compare-and-swap (state.ts:285-296), so silently clobbering
 *     a concurrent remote write would violate it. To detect concurrent
 *     writes without per-file ETags (the Gist API only exposes one ETag for
 *     the whole gist), we snapshot each file's content at fetch time. If
 *     the post-refresh `state.json` differs from the snapshot we held
 *     before the refresh, another machine wrote it: `push()` throws
 *     `GistConcurrencyError` instead of overwriting.
 *   - Freeform documents (e.g. per-repo guidelines) keep last-write-wins.
 *     The `setDocument` / `setGuidelines` callers' intent on a manual write
 *     is "overwrite". Local dirty content is reapplied on top of the
 *     refreshed remote.
 *
 *  In both cases, when the second push also 412s, local mutations stay in
 *  memory so the caller can decide whether to refresh and retry.
 */

import * as fs from 'node:fs';
import { AgentState } from './types.js';
import { AgentStateSchema } from './state-schema.js';
import {
  atomicWriteFileSync,
  createFreshState,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
} from './state-persistence.js';
import { getGistIdPath, getStateCachePath } from './paths.js';
import { debug, warn } from './logger.js';
import {
  ConfigurationError,
  GistPermissionError,
  GistConcurrencyError,
  GistCorruptError,
  isRateLimitError,
} from './errors.js';

const MODULE = 'gist-store';

/**
 * Extract the ETag header from an Octokit response, tolerating both lower-
 * and upper-case header names. Returns `null` when no ETag is present (test
 * mocks, degraded responses, etc.).
 */
function extractEtag(headers: Record<string, string | undefined> | undefined): string | null {
  if (!headers) return null;
  return headers.etag ?? headers.ETag ?? null;
}

/**
 * Preserve corrupt Gist content for user recovery. Returns the path written,
 * or null if the preservation itself failed (logged at warn). Mirrors the
 * pattern in state-persistence.ts:401-407 for the local-state path.
 *
 * See {@link GistCorruptError} and issue #1201.
 */
function preserveRejectedGistContent(raw: string, gistId: string): string | null {
  try {
    const rejectedPath = `${getStateCachePath()}.rejected-${Date.now()}`;
    fs.writeFileSync(rejectedPath, raw, { encoding: 'utf8', mode: 0o600 });
    return rejectedPath;
  } catch (err) {
    warn(
      MODULE,
      `Could not preserve rejected Gist content for ${gistId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

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
 * Discriminated outcome of {@link GistStateStore.refreshFromGist} (#1209 L9).
 * Lets callers distinguish "got fresh data" from "throttled / no-op / failed"
 * without conflating them as a single boolean.
 */
export type RefreshResult =
  | { status: 'refreshed' }
  | { status: 'no-gist' }
  | { status: 'throttled'; sinceLastMs: number }
  | { status: 'error'; error: Error };

/**
 * Minimal Octokit-shaped interface for the Gist API methods we use.
 * Accepts the real ThrottledOctokit or a plain mock object in tests.
 *
 * Responses include the optional `headers` envelope (ETag-based concurrency,
 * #1115). Tests that don't care about ETags can omit the headers field — the
 * code path treats a missing ETag as "no concurrency check available, fall
 * back to last-write-wins".
 */
export interface OctokitLike {
  gists: {
    get: (params: {
      gist_id: string;
    }) => Promise<{ data: GistResponseData; headers?: Record<string, string | undefined> }>;
    list: (params: { per_page: number; page: number }) => Promise<{ data: GistListItem[] }>;
    create: (params: {
      description: string;
      public: boolean;
      files: Record<string, { content: string }>;
    }) => Promise<{ data: GistResponseData; headers?: Record<string, string | undefined> }>;
    update: (params: {
      gist_id: string;
      files: Record<string, { content: string }>;
      headers?: Record<string, string>;
    }) => Promise<{ data: GistResponseData; headers?: Record<string, string | undefined> }>;
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
  /**
   * Per-file content snapshot captured at fetch time (#1235). The Gist API
   * exposes a single ETag for the whole gist, so we cannot use `If-Match`
   * to detect a per-file conflict on the 412 merge re-apply. Holding the
   * baseline content lets us compare it against the freshly-fetched remote
   * and decide whether `state.json` changed under us. Updated only by
   * `fetchAndCache` and successful `push()`; not mutated by `setState` /
   * `setDocument` so the baseline reflects the remote, not local edits.
   */
  private baselineFiles: Map<string, string> = new Map();
  /**
   * ETag captured from the most recent successful Gist fetch (#1115).
   * Sent back as `If-Match` on `update` so concurrent writes from another
   * machine surface as 412 Precondition Failed instead of silently winning
   * the last-write-wins race. `null` when the SDK didn't surface the header
   * (e.g. test mocks without headers) — in that case we skip the check.
   */
  private lastFetchedEtag: string | null = null;
  private readonly octokit: OctokitLike;
  private lastRefreshAt = 0;
  private static readonly REFRESH_THROTTLE_MS = 30_000;
  /**
   * Most recent error from a `refreshFromGist()` attempt, or `null` when the
   * last attempt succeeded or was skipped by the throttle. Lets callers
   * (StateManager) distinguish "throttled, nothing new to see" from "fetch
   * failed, you're now operating on stale state" without changing the
   * existing boolean return contract (#1193).
   */
  lastRefreshError: Error | null = null;

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
          // A corrupt or permission-broken Gist must surface immediately
          // (#1367): falling through to search would either re-find the same
          // corrupt Gist or silently abandon it and create a fresh one.
          if (err instanceof ConfigurationError) throw err;
          if (isRateLimitError(err)) throw err;
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
      // Configuration errors (GistPermissionError, GistCorruptError) and rate
      // limits must surface, not degrade (#1367). A corrupt Gist especially:
      // fetchAndCache arms this.gistId/lastFetchedEtag before the parse
      // throws, so a degraded store could push() local or fresh state over
      // the corrupt remote — the exact data loss #1201 exists to prevent.
      // Rate limits propagate per the errors.ts contract; degrading would
      // present "you are rate-limited" as a stale local cache.
      if (err instanceof ConfigurationError) throw err;
      if (isRateLimitError(err)) throw err;

      // All API paths failed — enter degraded mode. Disarm the remote write
      // path first: a degraded store never verified its Gist, so it must
      // never be able to push to one (#1367).
      this.gistId = null;
      this.lastFetchedEtag = null;
      warn(MODULE, 'All Gist API paths failed, entering degraded mode', err);

      // Try reading from local cache file
      const cachePath = getStateCachePath();
      let cacheRaw: string | null = null;
      try {
        if (fs.existsSync(cachePath)) {
          cacheRaw = fs.readFileSync(cachePath, 'utf8');
          let obj: unknown = JSON.parse(cacheRaw);

          // Chain migrations
          if (typeof obj === 'object' && obj !== null) {
            const record = obj as Record<string, unknown>;
            if (record.version === 1) obj = migrateV1ToV2(record);
            if ((obj as Record<string, unknown>).version === 2) obj = migrateV2ToV3(obj as Record<string, unknown>);
            if ((obj as Record<string, unknown>).version === 3) obj = migrateV3ToV4(obj as Record<string, unknown>);
          }

          const cachedState = AgentStateSchema.parse(obj);
          debug(MODULE, 'Loaded state from local cache in degraded mode');
          return { gistId: '', state: cachedState, created: false, degraded: true };
        }
      } catch (cacheErr) {
        // Promote to warn (#1201) and preserve corrupt cache so fresh-state
        // fallback doesn't silently destroy recoverable data on next push.
        if (cacheRaw) {
          const rejectedPath = preserveRejectedGistContent(cacheRaw, 'local-cache');
          warn(
            MODULE,
            `Local state cache failed to parse in degraded mode: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}. ` +
              `Corrupt cache preserved at: ${rejectedPath ?? '(could not preserve)'}`,
          );
        } else {
          warn(
            MODULE,
            `Failed to read local cache in degraded mode: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
          );
        }
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
          // See bootstrap(): corrupt/permission/rate-limit errors surface
          // immediately rather than falling through (#1367).
          if (err instanceof ConfigurationError) throw err;
          if (isRateLimitError(err)) throw err;
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
      // Same surfacing contract as bootstrap() (#1367): configuration errors
      // and rate limits rethrow; only genuine API unavailability degrades.
      if (err instanceof ConfigurationError) throw err;
      if (isRateLimitError(err)) throw err;

      // All API paths failed — enter degraded mode with the push path
      // disarmed (see bootstrap()).
      this.gistId = null;
      this.lastFetchedEtag = null;
      warn(MODULE, 'bootstrapWithMigration: all Gist API paths failed, entering degraded mode', err);

      // Try reading from local cache file
      const cachePath = getStateCachePath();
      let cacheRaw: string | null = null;
      try {
        if (fs.existsSync(cachePath)) {
          cacheRaw = fs.readFileSync(cachePath, 'utf8');
          let obj: unknown = JSON.parse(cacheRaw);

          // Chain migrations
          if (typeof obj === 'object' && obj !== null) {
            const record = obj as Record<string, unknown>;
            if (record.version === 1) obj = migrateV1ToV2(record);
            if ((obj as Record<string, unknown>).version === 2) obj = migrateV2ToV3(obj as Record<string, unknown>);
            if ((obj as Record<string, unknown>).version === 3) obj = migrateV3ToV4(obj as Record<string, unknown>);
          }

          const cachedState = AgentStateSchema.parse(obj);
          debug(MODULE, 'bootstrapWithMigration: loaded state from local cache in degraded mode');
          return { gistId: '', state: cachedState, created: false, degraded: true, migrated: false };
        }
      } catch (cacheErr) {
        if (cacheRaw) {
          const rejectedPath = preserveRejectedGistContent(cacheRaw, 'local-cache');
          warn(
            MODULE,
            `bootstrapWithMigration: local cache failed to parse: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}. ` +
              `Corrupt cache preserved at: ${rejectedPath ?? '(could not preserve)'}`,
          );
        } else {
          warn(
            MODULE,
            `bootstrapWithMigration: failed to read local cache: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
          );
        }
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
   * Push all dirty files to the backing Gist.
   *
   * Behavior:
   *  - When an ETag is available from the previous fetch, sends `If-Match`
   *    so a 412 surfaces if another machine pushed since we last fetched.
   *  - On 412, attempts a single merge: re-fetches the Gist (refreshing the
   *    ETag), re-applies the in-memory dirty content on top of the remote,
   *    and pushes once more. If the second push also 412s, throws
   *    {@link GistConcurrencyError} — the caller can decide whether to
   *    refreshFromGist + retry.
   *  - On any other error, retries once (existing behavior). If the retry
   *    also fails, returns `false`.
   *
   * Returns `true` on success (or when there is nothing to push).
   * Returns `false` if a non-conflict push fails on both attempts.
   * Throws {@link GistConcurrencyError} on unresolvable conflicts (#1115).
   * Throws if the Gist ID has not been resolved yet (bootstrap not called).
   */
  async push(): Promise<boolean> {
    if (this.dirtyFiles.size === 0) {
      return true;
    }

    if (this.gistId === null) {
      throw new Error('GistStateStore: cannot push before bootstrap — gistId is null');
    }

    const buildFiles = (): Record<string, { content: string }> => {
      const out: Record<string, { content: string }> = {};
      for (const filename of this.dirtyFiles) {
        const content = this.cachedFiles.get(filename);
        if (content !== undefined) {
          out[filename] = { content };
        }
      }
      return out;
    };

    /** Attempt a single push, capturing the response ETag for the next push. */
    const attempt = async (
      etag: string | null,
    ): Promise<{ ok: true } | { ok: false; status?: number; err: unknown }> => {
      try {
        const params: Parameters<OctokitLike['gists']['update']>[0] = {
          gist_id: this.gistId as string,
          files: buildFiles(),
        };
        if (etag) {
          params.headers = { 'if-match': etag };
        }
        const response = await this.octokit.gists.update(params);
        // Refresh our cached ETag so the next push uses the post-update value.
        const newEtag = extractEtag(response.headers);
        if (newEtag) this.lastFetchedEtag = newEtag;
        return { ok: true };
      } catch (err) {
        const status = (err as { status?: number }).status;
        return { ok: false, status, err };
      }
    };

    // ── Phase 1: best-shot push with current ETag ─────────────────────
    let result = await attempt(this.lastFetchedEtag);

    // ── Phase 2: ETag mismatch — try to merge once ────────────────────
    if (!result.ok && result.status === 412) {
      const expectedEtag = this.lastFetchedEtag;
      debug(MODULE, `push hit 412 (ETag mismatch); attempting merge — refreshing and retrying once`);
      // Snapshot the dirty contents before refresh (fetchAndCache wipes the cache).
      const stagedContents: Record<string, string> = {};
      for (const filename of this.dirtyFiles) {
        const content = this.cachedFiles.get(filename);
        if (content !== undefined) stagedContents[filename] = content;
      }
      // Snapshot the full cache and baseline before refresh so a partial
      // failure inside fetchAndCache (e.g. parse throws after the cache
      // was already cleared and repopulated) can be rolled back without
      // leaving the store with a stale ETag pointing at corrupt or
      // half-populated state (#1235).
      const preRefreshCache = new Map(this.cachedFiles);
      const preRefreshBaseline = new Map(this.baselineFiles);
      const preRefreshEtag = this.lastFetchedEtag;
      const reapplyStaged = (): void => {
        for (const [filename, content] of Object.entries(stagedContents)) {
          this.cachedFiles.set(filename, content);
        }
      };
      try {
        await this.fetchAndCache(this.gistId);
      } catch (refreshErr) {
        warn(MODULE, `Merge refresh after 412 failed: ${refreshErr}`);
        // Roll back any partial mutation from fetchAndCache so the
        // caller's retry path sees the prior state (with local
        // mutations re-applied on top).
        this.cachedFiles.clear();
        for (const [filename, content] of preRefreshCache) {
          this.cachedFiles.set(filename, content);
        }
        this.baselineFiles = preRefreshBaseline;
        this.lastFetchedEtag = preRefreshEtag;
        reapplyStaged();
        // Preserve the GistCorruptError type so callers don't retry
        // against a corrupt remote (which a CONCURRENCY_ERROR would
        // invite). Other failure types continue to surface as a
        // concurrency error — the gist content is still likely fine.
        if (refreshErr instanceof GistCorruptError) throw refreshErr;
        throw new GistConcurrencyError(expectedEtag, null);
      }
      // Per-file conflict policy (#1235):
      //  - state.json must fail loud when its remote copy moved under us;
      //    silently overwriting would violate the StateManager
      //    optimistic-concurrency contract (state.ts:285-296).
      //  - Freeform documents (guidelines, etc.) keep last-write-wins —
      //    `setDocument` callers' intent on a manual write is "overwrite".
      if (stagedContents[STATE_FILE_NAME] !== undefined) {
        const baselineBeforeRefresh = preRefreshBaseline.get(STATE_FILE_NAME);
        const remoteAfterRefresh = this.cachedFiles.get(STATE_FILE_NAME);
        if (baselineBeforeRefresh !== remoteAfterRefresh) {
          warn(
            MODULE,
            'state.json changed remotely while a push was in flight; surfacing GistConcurrencyError instead of clobbering (#1235)',
          );
          // Preserve local state.json (and other staged dirty files) in
          // memory so the caller can refresh and reapply if appropriate.
          reapplyStaged();
          throw new GistConcurrencyError(expectedEtag, this.lastFetchedEtag);
        }
      }
      // Re-apply our staged dirty contents on top of the refreshed remote.
      reapplyStaged();
      result = await attempt(this.lastFetchedEtag);
      if (!result.ok && result.status === 412) {
        warn(MODULE, 'Second push after merge also returned 412; surfacing GistConcurrencyError');
        throw new GistConcurrencyError(expectedEtag, this.lastFetchedEtag);
      }
    }

    // ── Phase 3: any other failure — retry once (existing behavior) ───
    if (!result.ok) {
      debug(MODULE, `push failed on first attempt, retrying: ${result.err}`);
      result = await attempt(this.lastFetchedEtag);
      if (!result.ok) {
        warn(MODULE, `push failed after retry, giving up: ${result.err}`);
        return false;
      }
    }

    // Success: flush dirty set and write local cache. Refresh the
    // per-file baseline to reflect what we just wrote — the next 412
    // merge re-apply check compares against this.
    this.dirtyFiles.clear();
    this.baselineFiles = new Map(this.cachedFiles);

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
   * Throttled to at most once per 30 seconds — ATTEMPTS, not just successes:
   * a failed fetch stamps the throttle too (#1443), so an outage does not
   * turn every SPA poll into an immediate full re-fetch.
   *
   * Returns a discriminated union so callers can tell apart the four
   * outcomes that previously collapsed into a single boolean (#1209 L9):
   *   - `{ status: 'refreshed' }` — fresh data loaded successfully.
   *   - `{ status: 'no-gist' }` — store not in Gist mode (e.g. degraded).
   *   - `{ status: 'throttled', sinceLastMs }` — within the 30s throttle.
   *   - `{ status: 'error', error }` — fetch attempt failed.
   */
  async refreshFromGist(): Promise<RefreshResult> {
    if (!this.gistId) return { status: 'no-gist' };
    const now = Date.now();
    const sinceLastMs = now - this.lastRefreshAt;
    // Throttle hits are not failures — preserve any previous lastRefreshError
    // for the caller to inspect.
    if (sinceLastMs < GistStateStore.REFRESH_THROTTLE_MS) {
      return { status: 'throttled', sinceLastMs };
    }
    // Stamp the ATTEMPT, success or failure (#1443): the success-only stamp
    // let failed refreshes bypass the throttle entirely, contradicting the
    // doc comment and hammering the API during an outage.
    this.lastRefreshAt = now;
    try {
      await this.fetchAndCache(this.gistId);
      this.lastRefreshError = null;
      return { status: 'refreshed' };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      warn(MODULE, `refreshFromGist failed: ${error.message}`);
      this.lastRefreshError = error;
      return { status: 'error', error };
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
    const response = await this.octokit.gists.get({ gist_id: gistId });
    this.gistId = gistId;
    // Capture the ETag for optimistic-concurrency push (#1115). Header
    // names from Octokit are lower-cased; tolerate both shapes for robustness.
    this.lastFetchedEtag = extractEtag(response.headers);

    // Populate in-memory cache with ALL files from the Gist
    this.cachedFiles.clear();
    for (const [filename, file] of Object.entries(response.data.files)) {
      if (file && file.content != null) {
        this.cachedFiles.set(filename, file.content);
      }
    }
    // Snapshot the just-fetched contents as the per-file baseline (#1235).
    // The 412 merge path uses this to detect whether a concurrent write
    // changed `state.json` between this fetch and the next push attempt.
    this.baselineFiles = new Map(this.cachedFiles);

    // Parse state.json
    const state = this.parseStateFromCache();

    // Write-through to local cache for degraded-mode fallback
    this.writeLocalStateCache(state);

    return state;
  }

  /**
   * Parse `state.json` from the in-memory cache. Handles v1→v4 migration
   * by running through the Zod schema (which requires version: 4).
   *
   * Throws {@link GistCorruptError} on parse or schema-validation failure.
   * The corrupt raw content is preserved as `<state-cache-path>.rejected-<ts>`
   * so the caller can recover (#1201).
   *
   * Returning fresh state on failure (the previous behavior) is unsafe in
   * Gist mode because the next `push()` would overwrite the Gist with the
   * empty fallback, silently destroying repoScores, dismissedIssues,
   * guidelines pointers, and digest history.
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
        if ((obj as Record<string, unknown>).version === 3) obj = migrateV3ToV4(obj as Record<string, unknown>);
      }

      return AgentStateSchema.parse(obj);
    } catch (err) {
      const rejectedPath = preserveRejectedGistContent(raw, this.gistId ?? 'unknown');
      warn(
        MODULE,
        `Gist state.json failed to parse — refusing to overwrite with fresh state. ` +
          `Corrupt content preserved at: ${rejectedPath ?? '(could not preserve)'}`,
      );
      throw new GistCorruptError(this.gistId ?? 'unknown', rejectedPath, err);
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
      // A rate-limited search must not read as "no Gist found" — bootstrap
      // would proceed to create a duplicate Gist while throttled (#1367).
      if (isRateLimitError(err)) throw err;
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
    this.baselineFiles = new Map(this.cachedFiles);

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
    this.baselineFiles = new Map(this.cachedFiles);

    // Write-through to local cache
    this.writeLocalStateCache(seedState);

    return { id: data.id, state: seedState };
  }

  /** Read the locally persisted Gist ID, or return null if not found. */
  private readLocalGistId(): string | null {
    try {
      const gistIdPath = getGistIdPath();
      if (fs.existsSync(gistIdPath)) {
        const id = fs.readFileSync(gistIdPath, 'utf8').trim();
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
