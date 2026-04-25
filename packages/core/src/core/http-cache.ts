/**
 * HTTP caching with ETags for GitHub API responses.
 *
 * Stores ETags and response bodies for cacheable GET endpoints in
 * `~/.oss-autopilot/cache/`. On subsequent requests, sends `If-None-Match`
 * headers — 304 responses don't count against GitHub rate limits.
 *
 * Also provides in-flight request deduplication so that concurrent calls
 * for the same endpoint (e.g., star counts for two PRs in the same repo)
 * share a single HTTP round-trip.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getCacheDir } from './paths.js';
import { debug } from './logger.js';
import { getHttpStatusCode } from './errors.js';

const MODULE = 'http-cache';

/** Shape of a single cache entry on disk. */
export interface CacheEntry {
  etag: string;
  url: string;
  body: unknown;
  cachedAt: string;
}

/**
 * Maximum age (in ms) before a cache entry is considered stale and eligible for
 * eviction during cleanup. Defaults to 24 hours. Entries older than this are
 * still *usable* for conditional requests (the ETag may still be valid), but
 * `evictStale()` will remove them.
 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Soft cap on the number of entries kept on disk (#1057 M27). `set()`
 * opportunistically evicts the oldest entries when the directory grows past
 * this ceiling. The cap is deliberately high (2000) so it doesn't thrash a
 * normal day's traffic — it's a belt-and-suspenders guard against unbounded
 * growth on long-running sessions that accumulate cache files between the
 * daily `evictStale()` sweep.
 */
const DEFAULT_MAX_ENTRIES = 2000;

/**
 * File-based HTTP cache backed by `~/.oss-autopilot/cache/`.
 *
 * Each cache entry is stored as a separate JSON file keyed by the SHA-256
 * hash of the request URL. This avoids filesystem issues with URL-based
 * filenames and keeps lookup O(1).
 */
export class HttpCache {
  private readonly cacheDir: string;
  private readonly maxEntries: number;

  /** In-flight request deduplication map: URL -> Promise<response>. */
  private readonly inflightRequests = new Map<string, Promise<unknown>>();

  constructor(cacheDir?: string, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.cacheDir = cacheDir ?? getCacheDir();
    this.maxEntries = maxEntries;
  }

  /** Derive a filesystem-safe cache key from a URL. */
  private keyFor(url: string): string {
    return crypto.createHash('sha256').update(url).digest('hex');
  }

  /** Full path to the cache file for a given URL. */
  private pathFor(url: string): string {
    return path.join(this.cacheDir, `${this.keyFor(url)}.json`);
  }

  /**
   * Return the cached body if the entry exists and is younger than `maxAgeMs`.
   * Useful for time-based caching where ETag validation isn't applicable
   * (e.g., caching aggregated results from paginated API calls).
   */
  getIfFresh(key: string, maxAgeMs: number): unknown | null {
    const entry = this.get(key);
    if (!entry) return null;
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
    return entry.body;
  }

  /**
   * Look up a cached response. Returns `null` if no cache entry exists.
   */
  get(url: string): CacheEntry | null {
    const filePath = this.pathFor(url);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const entry = JSON.parse(raw) as CacheEntry;
      // Sanity-check: the file should contain the URL we asked for
      if (entry.url !== url) {
        debug(MODULE, `Cache collision detected for ${url}, ignoring`);
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Store a response with its ETag.
   */
  set(url: string, etag: string, body: unknown): void {
    const entry: CacheEntry = {
      etag,
      url,
      body,
      cachedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(this.pathFor(url), JSON.stringify(entry), { encoding: 'utf-8', mode: 0o600 });
      debug(MODULE, `Cached response for ${url}`);
      // Best-effort size cap (#1057 M27). Runs after each write rather than on
      // a schedule so long-lived sessions can't accumulate past the cap.
      this.evictIfExceeds(this.maxEntries);
    } catch (err) {
      // Non-fatal: cache write failure should not break the request
      debug(MODULE, `Failed to write cache for ${url}`, err);
    }
  }

  /**
   * If the cache directory exceeds `maxEntries`, evict the oldest entries
   * (by mtime) until it's at the cap. Best-effort — any I/O failure is
   * swallowed so cache-bookkeeping never breaks the request path.
   */
  private evictIfExceeds(maxEntries: number): void {
    if (maxEntries <= 0) return;
    try {
      const entries = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.json'));
      if (entries.length <= maxEntries) return;

      // Stat once; sort oldest first so we evict the stalest files.
      const withMtime = entries
        .map((file) => {
          const fullPath = path.join(this.cacheDir, file);
          try {
            return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((e): e is { fullPath: string; mtimeMs: number } => e !== null)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);

      const toEvict = withMtime.length - maxEntries;
      let evicted = 0;
      for (let i = 0; i < toEvict; i++) {
        try {
          fs.unlinkSync(withMtime[i].fullPath);
          evicted++;
        } catch {
          // Another process may have raced us — ignore.
        }
      }
      if (evicted > 0) {
        debug(MODULE, `Capped cache at ${maxEntries} entries: evicted ${evicted} oldest`);
      }
    } catch {
      // Cache dir missing / unreadable — not fatal.
    }
  }

  /**
   * Check whether a URL has an in-flight request.
   */
  hasInflight(url: string): boolean {
    return this.inflightRequests.has(url);
  }

  /**
   * Get the in-flight promise for a URL (for deduplication).
   */
  getInflight(url: string): Promise<unknown> | undefined {
    return this.inflightRequests.get(url);
  }

  /**
   * Register an in-flight request for deduplication.
   * Returns a cleanup function to call when the request completes.
   */
  setInflight(url: string, promise: Promise<unknown>): () => void {
    this.inflightRequests.set(url, promise);
    return () => {
      this.inflightRequests.delete(url);
    };
  }

  /**
   * Remove stale entries older than `maxAgeMs` from the cache directory.
   * Intended to be called periodically (e.g., once per daily run).
   */
  evictStale(maxAgeMs: number = DEFAULT_MAX_AGE_MS): number {
    let evicted = 0;
    try {
      const files = fs.readdirSync(this.cacheDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.cacheDir, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const entry = JSON.parse(raw) as CacheEntry;
          const age = now - new Date(entry.cachedAt).getTime();
          if (age > maxAgeMs) {
            fs.unlinkSync(filePath);
            evicted++;
          }
        } catch {
          // Corrupt entry — remove it
          try {
            fs.unlinkSync(filePath);
            evicted++;
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Cache dir might not exist yet — that's fine
    }
    if (evicted > 0) {
      debug(MODULE, `Evicted ${evicted} stale cache entries`);
    }
    return evicted;
  }

  /**
   * Remove all entries from the cache.
   */
  clear(): void {
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        fs.unlinkSync(path.join(this.cacheDir, file));
      }
      debug(MODULE, 'Cache cleared');
    } catch {
      // Cache dir might not exist yet — that's fine
    }
  }

  /**
   * Return the number of entries currently in the cache.
   */
  size(): number {
    try {
      return fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _httpCache: HttpCache | null = null;

/**
 * Get (or create) the shared HttpCache singleton.
 * The singleton is lazily initialized on first access.
 */
export function getHttpCache(): HttpCache {
  if (!_httpCache) {
    _httpCache = new HttpCache();
  }
  return _httpCache;
}

// ---------------------------------------------------------------------------
// Octokit integration helpers
// ---------------------------------------------------------------------------

/**
 * Wraps an Octokit `repos.get`-style call with ETag caching and request
 * deduplication.
 *
 * Usage:
 * ```ts
 * const data = await cachedRequest(cache, octokit, '/repos/owner/repo', () =>
 *   octokit.repos.get({ owner, repo: name }),
 * );
 * ```
 *
 * 1. If an identical request is already in-flight, returns the existing promise
 *    (request deduplication).
 * 2. If a cached ETag exists, sends `If-None-Match`. On 304, returns the
 *    cached body without consuming a rate-limit point.
 * 3. On a fresh 200, caches the ETag + body for next time.
 */
export async function cachedRequest<T>(
  cache: HttpCache,
  url: string,
  fetcher: (headers: Record<string, string>) => Promise<{ data: T; headers?: Record<string, string> }>,
): Promise<T> {
  // --- Deduplication ---
  const existing = cache.getInflight(url);
  if (existing) {
    debug(MODULE, `Dedup hit for ${url}`);
    return (await existing) as T;
  }

  const doFetch = async (): Promise<T> => {
    const extraHeaders: Record<string, string> = {};
    const cached = cache.get(url);
    if (cached) {
      extraHeaders['if-none-match'] = cached.etag;
    }

    try {
      const response = await fetcher(extraHeaders);
      // Store ETag if present (headers may be absent in test mocks)
      const etag = response.headers?.['etag'];
      if (etag) {
        cache.set(url, etag, response.data);
      }
      return response.data;
    } catch (err: unknown) {
      // Check for 304 Not Modified — re-read cache to avoid stale closure snapshot
      if (isNotModifiedError(err)) {
        const freshCached = cache.get(url);
        if (freshCached) {
          debug(MODULE, `304 cache hit for ${url}`);
          return freshCached.body as T;
        }
      }
      throw err;
    }
  };

  const promise = doFetch();
  const cleanup = cache.setInflight(url, promise);

  try {
    const result = await promise;
    return result;
  } finally {
    cleanup();
  }
}

/**
 * Time-based cache wrapper (no ETag / conditional requests).
 *
 * If a cached result exists and is younger than `maxAgeMs`, returns it.
 * Otherwise calls `fetcher`, caches the result, and returns it.
 *
 * Use this for expensive operations whose results change slowly
 * (e.g. search queries, project health checks).
 */
export async function cachedTimeBased<T>(
  cache: HttpCache,
  key: string,
  maxAgeMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = cache.getIfFresh(key, maxAgeMs);
  if (cached) {
    debug(MODULE, `Time-based cache hit for ${key}`);
    return cached as T;
  }

  const result = await fetcher();
  cache.set(key, '', result);
  return result;
}

/**
 * Detect whether an error is a 304 Not Modified response.
 * Octokit throws a RequestError with status 304 for conditional requests.
 */
function isNotModifiedError(err: unknown): boolean {
  return getHttpStatusCode(err) === 304;
}
