import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HttpCache, cachedRequest, type CacheEntry } from './http-cache.js';

/** Create a temporary directory for cache tests. */
function makeTmpCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oss-autopilot-cache-test-'));
}

describe('HttpCache', () => {
  let cacheDir: string;
  let cache: HttpCache;

  beforeEach(() => {
    cacheDir = makeTmpCacheDir();
    cache = new HttpCache(cacheDir);
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  describe('get / set', () => {
    it('returns null for a URL that has not been cached', () => {
      expect(cache.get('/repos/owner/repo')).toBeNull();
    });

    it('stores and retrieves a cache entry', () => {
      const body = { stargazers_count: 42 };
      cache.set('/repos/owner/repo', '"abc123"', body);

      const entry = cache.get('/repos/owner/repo');
      expect(entry).not.toBeNull();
      expect(entry!.etag).toBe('"abc123"');
      expect(entry!.url).toBe('/repos/owner/repo');
      expect(entry!.body).toEqual(body);
      expect(entry!.cachedAt).toBeTruthy();
    });

    it('returns null for a corrupt cache file', () => {
      // Write garbage to the cache file
      const key = crypto.createHash('sha256').update('/repos/bad/data').digest('hex');
      fs.writeFileSync(path.join(cacheDir, `${key}.json`), 'not valid json', 'utf-8');

      expect(cache.get('/repos/bad/data')).toBeNull();
    });

    it('returns null on hash collision (url mismatch)', () => {
      // Manually write a cache entry with a different URL for the same hash
      const key = crypto.createHash('sha256').update('/repos/a/b').digest('hex');
      const entry: CacheEntry = {
        etag: '"x"',
        url: '/repos/different/url',
        body: {},
        cachedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify(entry), 'utf-8');

      expect(cache.get('/repos/a/b')).toBeNull();
    });

    it('overwrites an existing cache entry', () => {
      cache.set('/repos/owner/repo', '"v1"', { stars: 1 });
      cache.set('/repos/owner/repo', '"v2"', { stars: 99 });

      const entry = cache.get('/repos/owner/repo');
      expect(entry!.etag).toBe('"v2"');
      expect(entry!.body).toEqual({ stars: 99 });
    });
  });

  describe('inflight deduplication', () => {
    it('reports no inflight for unknown URL', () => {
      expect(cache.hasInflight('/repos/x/y')).toBe(false);
      expect(cache.getInflight('/repos/x/y')).toBeUndefined();
    });

    it('tracks and cleans up inflight requests', () => {
      const promise = Promise.resolve({ stars: 10 });
      const cleanup = cache.setInflight('/repos/x/y', promise);

      expect(cache.hasInflight('/repos/x/y')).toBe(true);
      expect(cache.getInflight('/repos/x/y')).toBe(promise);

      cleanup();

      expect(cache.hasInflight('/repos/x/y')).toBe(false);
    });
  });

  describe('evictStale', () => {
    it('removes entries older than maxAgeMs', () => {
      // Write an entry with a cachedAt in the past
      const key = crypto.createHash('sha256').update('/repos/old/entry').digest('hex');
      const oldEntry: CacheEntry = {
        etag: '"old"',
        url: '/repos/old/entry',
        body: { stars: 0 },
        cachedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      };
      fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify(oldEntry), 'utf-8');

      // Write a fresh entry
      cache.set('/repos/fresh/entry', '"new"', { stars: 100 });

      // Evict entries older than 1 hour
      const evicted = cache.evictStale(60 * 60 * 1000);

      expect(evicted).toBe(1);
      expect(cache.get('/repos/old/entry')).toBeNull();
      expect(cache.get('/repos/fresh/entry')).not.toBeNull();
    });

    it('removes corrupt cache files during eviction', () => {
      fs.writeFileSync(path.join(cacheDir, 'corrupt.json'), 'garbage', 'utf-8');
      const evicted = cache.evictStale(0);
      expect(evicted).toBe(1);
    });

    it('returns 0 for empty cache', () => {
      expect(cache.evictStale()).toBe(0);
    });
  });

  describe('clear', () => {
    it('removes all cache entries', () => {
      cache.set('/repos/a/b', '"e1"', { stars: 1 });
      cache.set('/repos/c/d', '"e2"', { stars: 2 });

      expect(cache.size()).toBe(2);
      cache.clear();
      expect(cache.size()).toBe(0);
    });

    it('does not throw on empty cache', () => {
      expect(() => cache.clear()).not.toThrow();
    });
  });

  describe('size', () => {
    it('returns 0 for empty cache', () => {
      expect(cache.size()).toBe(0);
    });

    it('returns correct count', () => {
      cache.set('/repos/a/b', '"e1"', {});
      cache.set('/repos/c/d', '"e2"', {});
      expect(cache.size()).toBe(2);
    });

    it('returns 0 for non-existent directory', () => {
      const missing = new HttpCache('/tmp/does-not-exist-oss-autopilot-test');
      expect(missing.size()).toBe(0);
    });
  });
});

describe('cachedRequest', () => {
  let cacheDir: string;
  let cache: HttpCache;

  beforeEach(() => {
    cacheDir = makeTmpCacheDir();
    cache = new HttpCache(cacheDir);
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns fresh data and caches ETag on first call', async () => {
    const body = { stargazers_count: 500 };
    const fetcher = async (_headers: Record<string, string>) => ({
      data: body,
      headers: { etag: '"etag-abc"' } as Record<string, string>,
    });

    const result = await cachedRequest(cache, '/repos/o/r', fetcher);

    expect(result).toEqual(body);
    // Verify the entry was cached
    const entry = cache.get('/repos/o/r');
    expect(entry).not.toBeNull();
    expect(entry!.etag).toBe('"etag-abc"');
  });

  it('sends If-None-Match header when cache entry exists', async () => {
    // Seed the cache
    cache.set('/repos/o/r', '"etag-v1"', { stargazers_count: 100 });

    let capturedHeaders: Record<string, string> = {};
    const fetcher = async (headers: Record<string, string>) => {
      capturedHeaders = headers;
      return {
        data: { stargazers_count: 200 },
        headers: { etag: '"etag-v2"' } as Record<string, string>,
      };
    };

    await cachedRequest(cache, '/repos/o/r', fetcher);

    expect(capturedHeaders['if-none-match']).toBe('"etag-v1"');
  });

  it('returns cached body on 304 Not Modified', async () => {
    const cachedBody = { stargazers_count: 42 };
    cache.set('/repos/o/r', '"etag-v1"', cachedBody);

    const fetcher = async (_headers: Record<string, string>): Promise<never> => {
      const err = new Error('Not Modified') as Error & { status: number };
      err.status = 304;
      throw err;
    };

    const result = await cachedRequest(cache, '/repos/o/r', fetcher);

    expect(result).toEqual(cachedBody);
  });

  it('throws on 304 when no cache entry exists', async () => {
    const fetcher = async (_headers: Record<string, string>): Promise<never> => {
      const err = new Error('Not Modified') as Error & { status: number };
      err.status = 304;
      throw err;
    };

    await expect(cachedRequest(cache, '/repos/o/r', fetcher)).rejects.toThrow('Not Modified');
  });

  it('propagates non-304 errors', async () => {
    const fetcher = async (_headers: Record<string, string>): Promise<never> => {
      const err = new Error('Forbidden') as Error & { status: number };
      err.status = 403;
      throw err;
    };

    await expect(cachedRequest(cache, '/repos/o/r', fetcher)).rejects.toThrow('Forbidden');
  });

  it('deduplicates concurrent requests for the same URL', async () => {
    let callCount = 0;
    const fetcher = async (_headers: Record<string, string>) => {
      callCount++;
      // Simulate async latency
      await new Promise((r) => setTimeout(r, 50));
      return {
        data: { stargazers_count: 99 },
        headers: { etag: '"e1"' } as Record<string, string>,
      };
    };

    // Fire two requests concurrently for the same URL
    const [r1, r2] = await Promise.all([
      cachedRequest(cache, '/repos/o/r', fetcher),
      cachedRequest(cache, '/repos/o/r', fetcher),
    ]);

    expect(r1).toEqual({ stargazers_count: 99 });
    expect(r2).toEqual({ stargazers_count: 99 });
    // The fetcher should only have been called once
    expect(callCount).toBe(1);
  });

  it('does not cache when response has no ETag', async () => {
    const fetcher = async (_headers: Record<string, string>) => ({
      data: { stargazers_count: 10 },
      headers: {} as Record<string, string>,
    });

    await cachedRequest(cache, '/repos/o/r', fetcher);

    expect(cache.get('/repos/o/r')).toBeNull();
  });

  it('updates cache when ETag changes', async () => {
    cache.set('/repos/o/r', '"v1"', { stargazers_count: 10 });

    const fetcher = async (_headers: Record<string, string>) => ({
      data: { stargazers_count: 20 },
      headers: { etag: '"v2"' } as Record<string, string>,
    });

    const result = await cachedRequest(cache, '/repos/o/r', fetcher);
    expect(result).toEqual({ stargazers_count: 20 });

    const entry = cache.get('/repos/o/r');
    expect(entry!.etag).toBe('"v2"');
    expect(entry!.body).toEqual({ stargazers_count: 20 });
  });
});
