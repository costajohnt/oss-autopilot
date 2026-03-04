/**
 * Tests for github-stats caching behavior.
 * Tests that fetchUserMergedPRCounts and fetchUserClosedPRCounts
 * use time-based caching to avoid redundant paginated API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HttpCache } from './http-cache.js';
import { fetchUserMergedPRCounts, fetchUserClosedPRCounts, PR_COUNTS_CACHE_TTL_MS } from './github-stats.js';

// Mock getHttpCache to return a cache backed by a temp directory
let testCacheDir: string;
let testCache: HttpCache;

vi.mock('./http-cache.js', async () => {
  const actual = await vi.importActual<typeof import('./http-cache.js')>('./http-cache.js');
  return {
    ...actual,
    getHttpCache: vi.fn(() => testCache),
  };
});

function makeOctokit(items: unknown[], totalCount?: number) {
  return {
    search: {
      issuesAndPullRequests: vi.fn().mockResolvedValue({
        data: {
          total_count: totalCount ?? items.length,
          items,
        },
      }),
    },
  } as any;
}

function makeMergedItem(owner: string, repo: string, mergedAt: string) {
  return {
    html_url: `https://github.com/${owner}/${repo}/pull/1`,
    pull_request: { merged_at: mergedAt },
    closed_at: mergedAt,
    created_at: mergedAt,
  };
}

function makeClosedItem(owner: string, repo: string, closedAt: string) {
  return {
    html_url: `https://github.com/${owner}/${repo}/pull/1`,
    closed_at: closedAt,
    created_at: closedAt,
  };
}

describe('fetchUserPRCounts caching', () => {
  beforeEach(() => {
    testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-cache-stats-test-'));
    testCache = new HttpCache(testCacheDir);
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  it('should fetch from API on first call and cache the result', async () => {
    const items = [makeMergedItem('org', 'repo', '2025-06-01T00:00:00Z')];
    const octokit = makeOctokit(items);

    const result = await fetchUserMergedPRCounts(octokit, 'testuser');

    expect(result.repos.size).toBe(1);
    expect(result.repos.get('org/repo')).toEqual({ count: 1, lastMergedAt: '2025-06-01T00:00:00Z' });
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);

    // Verify the result was cached
    const cached = testCache.getIfFresh('pr-counts:v2:merged:testuser', PR_COUNTS_CACHE_TTL_MS);
    expect(cached).not.toBeNull();
  });

  it('should exclude own repos via -user: qualifier in search query', async () => {
    const items = [makeMergedItem('org', 'repo', '2025-06-01T00:00:00Z')];
    const octokit = makeOctokit(items);

    await fetchUserMergedPRCounts(octokit, 'testuser');

    const call = octokit.search.issuesAndPullRequests.mock.calls[0][0];
    expect(call.q).toContain('-user:testuser');
  });

  it('should return cached result on second call without hitting API', async () => {
    const items = [makeMergedItem('org', 'repo', '2025-06-01T00:00:00Z')];
    const octokit = makeOctokit(items);

    // First call — hits API
    const result1 = await fetchUserMergedPRCounts(octokit, 'testuser');
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    const result2 = await fetchUserMergedPRCounts(octokit, 'testuser');
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1); // Still 1
    expect(result2.repos.size).toBe(1);
    expect(result2.repos.get('org/repo')).toEqual(result1.repos.get('org/repo'));
    expect(result2.monthlyCounts).toEqual(result1.monthlyCounts);
  });

  it('should fetch from API when cache is expired', async () => {
    const items = [makeMergedItem('org', 'repo', '2025-06-01T00:00:00Z')];
    const octokit = makeOctokit(items);

    // Seed the cache with an old entry
    testCache.set('pr-counts:v2:merged:testuser', '', {
      reposEntries: [['org/old-repo', { count: 5, lastMergedAt: '2025-01-01T00:00:00Z' }]],
      monthlyCounts: { '2025-01': 5 },
      monthlyOpenedCounts: {},
      dailyActivityCounts: {},
    });

    // Backdate the cache entry to 25 hours ago (exceeds the 24-hour TTL)
    const cacheFiles = fs.readdirSync(testCacheDir).filter((f) => f.endsWith('.json'));
    for (const file of cacheFiles) {
      const filePath = path.join(testCacheDir, file);
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (entry.url === 'pr-counts:v2:merged:testuser') {
        entry.cachedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        fs.writeFileSync(filePath, JSON.stringify(entry), 'utf-8');
      }
    }

    // Should hit API because cache is expired
    const result = await fetchUserMergedPRCounts(octokit, 'testuser');
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
    expect(result.repos.get('org/repo')).toBeDefined();
  });

  it('should cache closed PR counts separately from merged', async () => {
    const mergedItems = [makeMergedItem('org', 'repo-a', '2025-06-01T00:00:00Z')];
    const closedItems = [makeClosedItem('org', 'repo-b', '2025-07-01T00:00:00Z')];
    const mergedOctokit = makeOctokit(mergedItems);
    const closedOctokit = makeOctokit(closedItems);

    await fetchUserMergedPRCounts(mergedOctokit, 'testuser');
    await fetchUserClosedPRCounts(closedOctokit, 'testuser');

    // Both should have hit the API
    expect(mergedOctokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
    expect(closedOctokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);

    // Verify separate cache keys
    expect(testCache.getIfFresh('pr-counts:v2:merged:testuser', PR_COUNTS_CACHE_TTL_MS)).not.toBeNull();
    expect(testCache.getIfFresh('pr-counts:v2:closed:testuser', PR_COUNTS_CACHE_TTL_MS)).not.toBeNull();
  });

  it('should reconstruct Map correctly from cached entries', async () => {
    const items = [
      makeMergedItem('org1', 'repo-a', '2025-06-01T00:00:00Z'),
      makeMergedItem('org2', 'repo-b', '2025-07-01T00:00:00Z'),
    ];
    const octokit = makeOctokit(items);

    // First call populates cache
    await fetchUserMergedPRCounts(octokit, 'testuser');

    // Second call reads from cache
    const result = await fetchUserMergedPRCounts(octokit, 'testuser');

    // Map should be properly reconstructed
    expect(result.repos).toBeInstanceOf(Map);
    expect(result.repos.size).toBe(2);
    expect(result.repos.get('org1/repo-a')).toEqual({ count: 1, lastMergedAt: '2025-06-01T00:00:00Z' });
    expect(result.repos.get('org2/repo-b')).toEqual({ count: 1, lastMergedAt: '2025-07-01T00:00:00Z' });
  });

  it('should not cache when username is empty', async () => {
    const octokit = makeOctokit([]);

    const result = await fetchUserMergedPRCounts(octokit, '');

    expect(result.repos.size).toBe(0);
    expect(octokit.search.issuesAndPullRequests).not.toHaveBeenCalled();
    expect(testCache.size()).toBe(0);
  });

  it('should preserve histogram data through cache round-trip', async () => {
    const items = [
      makeMergedItem('org', 'repo', '2025-06-15T12:00:00Z'),
      makeMergedItem('org', 'repo', '2025-06-20T12:00:00Z'),
      makeMergedItem('org', 'repo', '2025-07-01T12:00:00Z'),
    ];
    // Make each item unique by giving different PR numbers
    items[0].html_url = 'https://github.com/org/repo/pull/1';
    items[1].html_url = 'https://github.com/org/repo/pull/2';
    items[2].html_url = 'https://github.com/org/repo/pull/3';

    const octokit = makeOctokit(items);
    await fetchUserMergedPRCounts(octokit, 'testuser');

    // Read from cache
    const result = await fetchUserMergedPRCounts(octokit, 'testuser');

    expect(result.monthlyCounts['2025-06']).toBe(2);
    expect(result.monthlyCounts['2025-07']).toBe(1);
    expect(result.dailyActivityCounts['2025-06-15']).toBe(2); // merged + opened
    expect(result.monthlyOpenedCounts['2025-06']).toBe(2);
    expect(result.monthlyOpenedCounts['2025-07']).toBe(1);
  });
});
