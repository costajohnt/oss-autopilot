/**
 * Tests for github-stats.ts — PR count caching, merged/closed PR fetching,
 * and recent PR queries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HttpCache } from './http-cache.js';
import {
  fetchUserMergedPRCounts,
  fetchUserClosedPRCounts,
  fetchMergedPRsSince,
  fetchClosedPRsSince,
  fetchRecentlyMergedPRs,
  fetchRecentlyClosedPRs,
  PR_COUNTS_CACHE_TTL_MS,
} from './github-stats.js';

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

/** ISO timestamp N days before now — recent-PR fetches filter on a live window. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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
    const cached = testCache.getIfFresh('pr-counts:v3:merged:testuser', PR_COUNTS_CACHE_TTL_MS);
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
    testCache.set('pr-counts:v3:merged:testuser', '', {
      reposEntries: [['org/old-repo', { count: 5, lastMergedAt: '2025-01-01T00:00:00Z' }]],
      monthlyCounts: { '2025-01': 5 },
      monthlyOpenedCounts: {},
      dailyActivityCounts: {},
    });

    // Backdate the cache entry to 25 hours ago (exceeds the 24-hour TTL)
    const cacheFiles = fs.readdirSync(testCacheDir).filter((f) => f.endsWith('.json'));
    for (const file of cacheFiles) {
      const filePath = path.join(testCacheDir, file);
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (entry.url === 'pr-counts:v3:merged:testuser') {
        entry.cachedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        fs.writeFileSync(filePath, JSON.stringify(entry), 'utf8');
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
    expect(testCache.getIfFresh('pr-counts:v3:merged:testuser', PR_COUNTS_CACHE_TTL_MS)).not.toBeNull();
    expect(testCache.getIfFresh('pr-counts:v3:closed:testuser', PR_COUNTS_CACHE_TTL_MS)).not.toBeNull();
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

describe('fetchUserPRCounts star filtering', () => {
  beforeEach(() => {
    testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-cache-stars-test-'));
    testCache = new HttpCache(testCacheDir);
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  it('should exclude repos below minStars when star counts are known', async () => {
    const items = [
      makeMergedItem('popular-org', 'big-repo', '2025-06-01T00:00:00Z'),
      makeMergedItem('small-org', 'tiny-repo', '2025-06-02T00:00:00Z'),
    ];
    items[0].html_url = 'https://github.com/popular-org/big-repo/pull/1';
    items[1].html_url = 'https://github.com/small-org/tiny-repo/pull/2';
    const octokit = makeOctokit(items);

    const starFilter = {
      minStars: 50,
      knownStarCounts: new Map([
        ['popular-org/big-repo', 500],
        ['small-org/tiny-repo', 10],
      ]),
    };

    const result = await fetchUserMergedPRCounts(octokit, 'testuser', starFilter);

    expect(result.repos.size).toBe(1);
    expect(result.repos.has('popular-org/big-repo')).toBe(true);
    expect(result.repos.has('small-org/tiny-repo')).toBe(false);
    expect(result.monthlyCounts['2025-06']).toBe(1);
  });

  it('should exclude repos with unknown star counts (not yet fetched)', async () => {
    const items = [
      makeMergedItem('known-org', 'known-repo', '2025-06-01T00:00:00Z'),
      makeMergedItem('unknown-org', 'new-repo', '2025-06-02T00:00:00Z'),
    ];
    items[0].html_url = 'https://github.com/known-org/known-repo/pull/1';
    items[1].html_url = 'https://github.com/unknown-org/new-repo/pull/2';
    const octokit = makeOctokit(items);

    const starFilter = {
      minStars: 50,
      knownStarCounts: new Map([['known-org/known-repo', 100]]),
    };

    const result = await fetchUserMergedPRCounts(octokit, 'testuser', starFilter);

    // Only known-org/known-repo included — unknown-org/new-repo has no star data, so it's excluded
    expect(result.repos.size).toBe(1);
    expect(result.repos.has('known-org/known-repo')).toBe(true);
  });

  it('should not filter when no starFilter is provided', async () => {
    const items = [makeMergedItem('org', 'repo', '2025-06-01T00:00:00Z')];
    const octokit = makeOctokit(items);

    const result = await fetchUserMergedPRCounts(octokit, 'testuser');

    expect(result.repos.size).toBe(1);
  });

  it('should use separate cache keys for different minStars values', async () => {
    const items = [makeMergedItem('org', 'repo', '2025-06-01T00:00:00Z')];
    const octokit = makeOctokit(items);

    const filter50 = { minStars: 50, knownStarCounts: new Map([['org/repo', 100]]) };
    const filter100 = { minStars: 100, knownStarCounts: new Map([['org/repo', 100]]) };

    await fetchUserMergedPRCounts(octokit, 'testuser', filter50);
    await fetchUserMergedPRCounts(octokit, 'testuser', filter100);

    // Should have made 2 API calls (different cache keys)
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(2);
  });

  it('should also filter closed PR counts by stars', async () => {
    const items = [
      makeClosedItem('big-org', 'popular', '2025-06-01T00:00:00Z'),
      makeClosedItem('tiny-org', 'unpopular', '2025-06-02T00:00:00Z'),
    ];
    items[0].html_url = 'https://github.com/big-org/popular/pull/1';
    items[1].html_url = 'https://github.com/tiny-org/unpopular/pull/2';
    const octokit = makeOctokit(items);

    const starFilter = {
      minStars: 50,
      knownStarCounts: new Map([
        ['big-org/popular', 200],
        ['tiny-org/unpopular', 5],
      ]),
    };

    const result = await fetchUserClosedPRCounts(octokit, 'testuser', starFilter);

    expect(result.repos.size).toBe(1);
    expect(result.repos.has('big-org/popular')).toBe(true);
  });
});

describe('fetchMergedPRsSince', () => {
  beforeEach(() => {
    testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-cache-merged-since-test-'));
    testCache = new HttpCache(testCacheDir);
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  it('should return merged PRs for the user, excluding own repos', async () => {
    const items = [
      {
        html_url: 'https://github.com/external-org/repo/pull/42',
        title: 'Fix bug',
        pull_request: { merged_at: '2025-06-15T12:00:00Z' },
        closed_at: '2025-06-15T12:00:00Z',
      },
      {
        html_url: 'https://github.com/testuser/my-repo/pull/10',
        title: 'My own PR',
        pull_request: { merged_at: '2025-06-14T12:00:00Z' },
        closed_at: '2025-06-14T12:00:00Z',
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' }, '2025-06-01');

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://github.com/external-org/repo/pull/42');
    expect(result[0].title).toBe('Fix bug');
    expect(result[0].mergedAt).toBe('2025-06-15T12:00:00Z');
  });

  it('should return empty array when no username is configured', async () => {
    const octokit = makeOctokit([]);
    const result = await fetchMergedPRsSince(octokit, { githubUsername: '' });
    expect(result).toEqual([]);
  });

  it('should fetch all merged PRs when no watermark is provided', async () => {
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/1',
        title: 'Old PR',
        pull_request: { merged_at: '2024-01-01T00:00:00Z' },
        closed_at: '2024-01-01T00:00:00Z',
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' });

    expect(result).toHaveLength(1);
    const query = octokit.search.issuesAndPullRequests.mock.calls[0][0].q;
    expect(query).not.toContain('merged:>');
  });

  it('should include date filter when watermark is provided', async () => {
    const octokit = makeOctokit([]);

    await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' }, '2025-06-01T00:00:00Z');

    const query = octokit.search.issuesAndPullRequests.mock.calls[0][0].q;
    expect(query).toContain('merged:>2025-06-01T00:00:00Z');
  });

  it('should skip PRs with no merge date', async () => {
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/1',
        title: 'No date PR',
        pull_request: { merged_at: null },
        closed_at: null,
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' });

    expect(result).toHaveLength(0);
  });

  it('should fall back to closed_at when merged_at is missing', async () => {
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/1',
        title: 'Fallback PR',
        pull_request: { merged_at: null },
        closed_at: '2025-06-15T12:00:00Z',
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' });

    expect(result).toHaveLength(1);
    expect(result[0].mergedAt).toBe('2025-06-15T12:00:00Z');
  });

  it('should persist openedAt from the search result created_at (#1461)', async () => {
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/1',
        title: 'Ledger PR',
        created_at: '2025-06-01T08:00:00Z',
        pull_request: { merged_at: '2025-06-15T12:00:00Z' },
        closed_at: '2025-06-15T12:00:00Z',
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' });

    expect(result[0].openedAt).toBe('2025-06-01T08:00:00Z');
  });

  it('should leave openedAt undefined when created_at is absent (#1461)', async () => {
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/1',
        title: 'Legacy-shaped item',
        pull_request: { merged_at: '2025-06-15T12:00:00Z' },
        closed_at: '2025-06-15T12:00:00Z',
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' });

    expect(result[0].openedAt).toBeUndefined();
  });
});

describe('fetchClosedPRsSince', () => {
  beforeEach(() => {
    testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-cache-closed-since-test-'));
    testCache = new HttpCache(testCacheDir);
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  it('should return closed-without-merge PRs, excluding own repos', async () => {
    const items = [
      {
        html_url: 'https://github.com/external-org/repo/pull/99',
        title: 'Rejected PR',
        closed_at: '2025-07-01T10:00:00Z',
      },
      {
        html_url: 'https://github.com/testuser/my-repo/pull/5',
        title: 'Own repo PR',
        closed_at: '2025-07-01T10:00:00Z',
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchClosedPRsSince(octokit, { githubUsername: 'testuser' }, '2025-06-01');

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://github.com/external-org/repo/pull/99');
    expect(result[0].title).toBe('Rejected PR');
    expect(result[0].closedAt).toBe('2025-07-01T10:00:00Z');
  });

  it('should return empty array when no username is configured', async () => {
    const octokit = makeOctokit([]);
    const result = await fetchClosedPRsSince(octokit, { githubUsername: '' });
    expect(result).toEqual([]);
  });

  it('should skip PRs with no close date', async () => {
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/1',
        title: 'No date PR',
        closed_at: null,
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchClosedPRsSince(octokit, { githubUsername: 'testuser' });

    expect(result).toHaveLength(0);
  });

  it('should include date filter when watermark is provided', async () => {
    const octokit = makeOctokit([]);

    await fetchClosedPRsSince(octokit, { githubUsername: 'testuser' }, '2025-07-01T00:00:00Z');

    const query = octokit.search.issuesAndPullRequests.mock.calls[0][0].q;
    expect(query).toContain('closed:>2025-07-01T00:00:00Z');
  });

  it('should persist openedAt from the search result created_at (#1461)', async () => {
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/9',
        title: 'Ledger closed PR',
        created_at: '2025-06-20T08:00:00Z',
        closed_at: '2025-07-01T10:00:00Z',
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchClosedPRsSince(octokit, { githubUsername: 'testuser' });

    expect(result[0].openedAt).toBe('2025-06-20T08:00:00Z');
  });
});

describe('fetchRecentlyMergedPRs', () => {
  beforeEach(() => {
    testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-cache-recent-merged-test-'));
    testCache = new HttpCache(testCacheDir);
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  it('should return recently merged PRs excluding own repos', async () => {
    const mergedAt = isoDaysAgo(2);
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/7',
        title: 'Recent merge',
        pull_request: { merged_at: mergedAt },
        closed_at: mergedAt,
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchRecentlyMergedPRs(octokit, { githubUsername: 'testuser' }, 7);

    expect(result).toHaveLength(1);
    expect(result[0].repo).toBe('org/repo');
    expect(result[0].number).toBe(7);
    expect(result[0].mergedAt).toBe(mergedAt);
  });

  it('should drop PRs merged before the window even when recently updated (#1567)', async () => {
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/7',
        title: 'Old merge, new comment',
        pull_request: { merged_at: isoDaysAgo(90) },
        closed_at: isoDaysAgo(90),
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchRecentlyMergedPRs(octokit, { githubUsername: 'testuser' }, 7);

    expect(result).toEqual([]);
  });

  it('should return empty when no username configured', async () => {
    const octokit = makeOctokit([]);
    const result = await fetchRecentlyMergedPRs(octokit, { githubUsername: '' });
    expect(result).toEqual([]);
  });

  it('should carry openedAt from the search result created_at (#1461)', async () => {
    const openedAt = isoDaysAgo(30);
    const mergedAt = isoDaysAgo(2);
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/7',
        title: 'Recent merge',
        created_at: openedAt,
        pull_request: { merged_at: mergedAt },
        closed_at: mergedAt,
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchRecentlyMergedPRs(octokit, { githubUsername: 'testuser' }, 7);

    expect(result[0].openedAt).toBe(openedAt);
  });
});

describe('fetchRecentlyClosedPRs', () => {
  beforeEach(() => {
    testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-cache-recent-closed-test-'));
    testCache = new HttpCache(testCacheDir);
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  it('should return recently closed PRs excluding own repos', async () => {
    const closedAt = isoDaysAgo(1);
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/3',
        title: 'Closed without merge',
        closed_at: closedAt,
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchRecentlyClosedPRs(octokit, { githubUsername: 'testuser' }, 7);

    expect(result).toHaveLength(1);
    expect(result[0].repo).toBe('org/repo');
    expect(result[0].number).toBe(3);
    expect(result[0].closedAt).toBe(closedAt);
  });

  it('should carry openedAt from the search result created_at (#1461)', async () => {
    const openedAt = isoDaysAgo(20);
    const closedAt = isoDaysAgo(1);
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/3',
        title: 'Closed without merge',
        created_at: openedAt,
        closed_at: closedAt,
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchRecentlyClosedPRs(octokit, { githubUsername: 'testuser' }, 7);

    expect(result[0].openedAt).toBe(openedAt);
  });

  // Regression (#1567): apache/superset#37458 was closed within the window but
  // its close-date facet was missing from GitHub's search index, so a
  // `closed:>={since}` query returned nothing while `updated:>={since}` found
  // it with a correct closed_at. Bounding on `updated` is what makes such a PR
  // visible at all.
  it('should bound the search on updated, not closed (#1567)', async () => {
    const octokit = makeOctokit([]);

    await fetchRecentlyClosedPRs(octokit, { githubUsername: 'testuser' }, 7);

    const searchCall = vi.mocked(octokit.search.issuesAndPullRequests).mock.calls[0][0];
    expect(searchCall.q).toContain('updated:>=');
    expect(searchCall.q).not.toContain('closed:>=');
  });

  it('should drop PRs closed before the window even when recently updated (#1567)', async () => {
    const items = [
      {
        html_url: 'https://github.com/org/repo/pull/3',
        title: 'Old close, new comment',
        closed_at: isoDaysAgo(90),
      },
    ];
    const octokit = makeOctokit(items);

    const result = await fetchRecentlyClosedPRs(octokit, { githubUsername: 'testuser' }, 7);

    expect(result).toEqual([]);
  });
});

describe('fetchRecentlyMergedPRs uses is:public query (#792)', () => {
  beforeEach(() => {
    testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-cache-recent-merged-public-test-'));
    testCache = new HttpCache(testCacheDir);
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  it('should include is:public in the search query', async () => {
    const octokit = makeOctokit([]);

    await fetchRecentlyMergedPRs(octokit, { githubUsername: 'testuser' }, 7);

    const searchCall = vi.mocked(octokit.search.issuesAndPullRequests).mock.calls[0][0];
    expect(searchCall.q).toContain('is:public');
  });

  it('should not filter by excludeRepos — those only affect issue discovery (#591)', async () => {
    const items = [
      {
        html_url: 'https://github.com/excluded-org/private-repo/pull/5',
        title: 'Excluded repo PR',
        pull_request: { merged_at: isoDaysAgo(2) },
        closed_at: isoDaysAgo(2),
      },
    ];
    const octokit = makeOctokit(items);

    // excludeRepos is not even accepted by fetchRecentlyMergedPRs — it only takes githubUsername
    const result = await fetchRecentlyMergedPRs(octokit, { githubUsername: 'testuser' }, 7);

    expect(result).toHaveLength(1);
  });
});

describe('fetchRecentlyClosedPRs uses is:public query (#792)', () => {
  beforeEach(() => {
    testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-cache-recent-closed-public-test-'));
    testCache = new HttpCache(testCacheDir);
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  it('should include is:public in the search query', async () => {
    const octokit = makeOctokit([]);

    await fetchRecentlyClosedPRs(octokit, { githubUsername: 'testuser' }, 7);

    const searchCall = vi.mocked(octokit.search.issuesAndPullRequests).mock.calls[0][0];
    expect(searchCall.q).toContain('is:public');
  });
});
