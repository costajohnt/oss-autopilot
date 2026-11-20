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
  externalPRScope,
  fetchRecentlyMergedPRs,
  fetchRecentlyClosedPRs,
  PR_COUNTS_CACHE_TTL_MS,
  closingIssueUrl,
  mentionedIssueUrls,
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

type SearchArgs = { q: string; page: number; sort: string; order: string };

/** `count` merged search items, created (and merged) one minute apart, oldest first. */
function makeMergedSeries(count: number) {
  const start = Date.parse('2025-01-01T00:00:00Z');
  return Array.from({ length: count }, (_, i) => {
    const created = new Date(start + i * 60_000);
    const at = `${created.toISOString().slice(0, 19)}Z`;
    return {
      html_url: `https://github.com/org/repo/pull/${i + 1}`,
      title: `PR ${i + 1}`,
      pull_request: { merged_at: at },
      closed_at: at,
      created_at: at,
    };
  });
}

/** A Search API stand-in over `items` (oldest first): honors `created:>=` and 100-per-page paging. */
function makeSearchOver(items: Array<{ created_at: string }>) {
  const issuesAndPullRequests = vi.fn(({ q, page }: SearchArgs) => {
    const cursor = /created:>=(\S+)/.exec(q)?.[1] ?? '';
    const matching = items.filter((item) => item.created_at >= cursor);
    return Promise.resolve({
      data: { total_count: matching.length, items: matching.slice((page - 1) * 100, page * 100) },
    });
  });
  return { search: { issuesAndPullRequests } } as any;
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
    const cached = testCache.getIfFresh('pr-counts:v4:merged:testuser', PR_COUNTS_CACHE_TTL_MS);
    expect(cached).not.toBeNull();
  });

  it('returns searched PRs (url + title) through a cache round-trip, and [] from a pre-searchedPRs cache entry', async () => {
    const item = { ...makeMergedItem('org', 'repo', '2025-06-01T00:00:00Z'), title: 'fix: thing' };
    const octokit = makeOctokit([item]);
    const expected = [{ url: 'https://github.com/org/repo/pull/1', title: 'fix: thing' }];

    const fresh = await fetchUserMergedPRCounts(octokit, 'testuser');
    expect(fresh.searchedPRs).toEqual(expected);
    const cached = await fetchUserMergedPRCounts(octokit, 'testuser');
    expect(cached.searchedPRs).toEqual(expected);

    testCache.set('pr-counts:v4:merged:testuser', '', {
      reposEntries: [],
      monthlyCounts: {},
      monthlyOpenedCounts: {},
      dailyActivityCounts: {},
    });
    const legacy = await fetchUserMergedPRCounts(octokit, 'testuser');
    expect(legacy.searchedPRs).toEqual([]);
  });

  it('reports the search total past the pagination cap, through a cache round-trip (#1924)', async () => {
    const octokit = makeOctokit([makeMergedItem('org', 'repo', '2025-06-01T00:00:00Z')], 450);

    const fresh = await fetchUserMergedPRCounts(octokit, 'testuser');
    expect(fresh.totalCount).toBe(450);
    const cached = await fetchUserMergedPRCounts(octokit, 'testuser');
    expect(cached.totalCount).toBe(450);
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(3);
  });

  it('leaves the total undefined for a cache entry written before it existed (#1924)', async () => {
    testCache.set('pr-counts:v4:merged:testuser', '', {
      reposEntries: [],
      monthlyCounts: {},
      monthlyOpenedCounts: {},
      dailyActivityCounts: {},
    });

    const legacy = await fetchUserMergedPRCounts(makeOctokit([]), 'testuser');

    expect(legacy.totalCount).toBeUndefined();
  });

  it('flags a pagination-capped result as truncated, through a cache round-trip (#1897)', async () => {
    const octokit = makeOctokit([makeMergedItem('org', 'repo', '2025-06-01T00:00:00Z')], 450);

    const fresh = await fetchUserMergedPRCounts(octokit, 'testuser');
    expect(fresh.truncated).toBe(true);
    const cached = await fetchUserMergedPRCounts(octokit, 'testuser');
    expect(cached.truncated).toBe(true);

    const complete = await fetchUserClosedPRCounts(
      makeOctokit([makeClosedItem('org', 'repo', '2025-06-01T00:00:00Z')]),
      'testuser',
    );
    expect(complete.truncated).toBe(false);
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
    testCache.set('pr-counts:v4:merged:testuser', '', {
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
      if (entry.url === 'pr-counts:v4:merged:testuser') {
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
    expect(testCache.getIfFresh('pr-counts:v4:merged:testuser', PR_COUNTS_CACHE_TTL_MS)).not.toBeNull();
    expect(testCache.getIfFresh('pr-counts:v4:closed:testuser', PR_COUNTS_CACHE_TTL_MS)).not.toBeNull();
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

  describe('private repositories and untracked organisations are left out (#1924)', () => {
    it('asks only for public PRs outside the untracked organisations', async () => {
      const octokit = makeOctokit([]);

      await fetchUserMergedPRCounts(octokit, 'testuser', undefined, ['Acme']);
      await fetchUserClosedPRCounts(octokit, 'testuser', undefined, ['Acme']);

      const queries = octokit.search.issuesAndPullRequests.mock.calls.map(([args]: [SearchArgs]) => args.q);
      expect(queries).toEqual([
        'is:pr is:merged is:public author:testuser -user:testuser -org:Acme',
        'is:pr is:closed is:unmerged is:public author:testuser -user:testuser -org:Acme',
      ]);
    });

    it('does not count, list or total an untracked organisation PR the search returns anyway', async () => {
      const orgs = ['not a login', 'ACME'];
      const octokit = makeOctokit(
        [
          makeMergedItem('acme', 'internal', '2025-06-01T00:00:00Z'),
          makeMergedItem('org', 'repo', '2025-06-02T00:00:00Z'),
        ],
        2,
      );

      const merged = await fetchUserMergedPRCounts(octokit, 'testuser', undefined, orgs);
      const closed = await fetchUserClosedPRCounts(octokit, 'testuser', undefined, orgs);

      expect(merged.repos.size).toBe(1);
      expect(merged.repos.has('org/repo')).toBe(true);
      expect(merged.searchedPRs.map((pr) => pr.url)).toEqual(['https://github.com/org/repo/pull/1']);
      expect(merged.monthlyCounts).toEqual({ '2025-06': 1 });
      expect(closed.repos.size).toBe(1);
      expect(closed.repos.has('org/repo')).toBe(true);
      // The list cannot go in the query, so the total is an overcount: unknown.
      expect(merged.totalCount).toBeUndefined();
      expect(octokit.search.issuesAndPullRequests.mock.calls[0][0].q).not.toContain('-org:');
    });

    it('reuses the cached counts when the same organisations are listed in another order or case', async () => {
      const octokit = makeOctokit([makeMergedItem('org', 'repo', '2025-06-01T00:00:00Z')]);

      await fetchUserMergedPRCounts(octokit, 'testuser', undefined, ['acme', 'Beta']);
      await fetchUserMergedPRCounts(octokit, 'testuser', undefined, ['beta', 'ACME']);

      expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
    });

    it('does not serve counts cached under a different untrackedOrgs list', async () => {
      const octokit = makeOctokit([makeMergedItem('acme', 'internal', '2025-06-01T00:00:00Z')]);

      const before = await fetchUserMergedPRCounts(octokit, 'testuser');
      const after = await fetchUserMergedPRCounts(octokit, 'testuser', undefined, ['acme']);

      expect(before.repos.size).toBe(1);
      expect(after.repos.size).toBe(0);
      expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(2);
    });
  });
});

describe('externalPRScope (#1924)', () => {
  it('covers public repositories the user does not own', () => {
    expect(externalPRScope('me')).toEqual({ query: 'is:public author:me -user:me', isExact: true });
  });

  it('excludes each untracked organisation', () => {
    expect(externalPRScope('me', ['Acme', 'acme-labs'])).toEqual({
      query: 'is:public author:me -user:me -org:Acme -org:acme-labs',
      isExact: true,
    });
  });

  it('puts no cap on the number of organisations (ten -org: terms were accepted by a live search)', () => {
    const orgs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

    const scope = externalPRScope('me', orgs);

    expect(scope.isExact).toBe(true);
    expect(scope.query.split(' -org:')).toHaveLength(11);
  });

  it.each([
    ['an organisation name that is not a login', ['acme corp']],
    ['a list too long for the query limit', ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)]],
  ])('leaves the organisations out and says the scope is not exact for %s', (_label, orgs) => {
    expect(externalPRScope('me', orgs)).toEqual({ query: 'is:public author:me -user:me', isExact: false });
  });

  it('keeps the longest query the ledger fetch builds within 256 characters', () => {
    const orgs = ['a'.repeat(25), 'b'.repeat(25), 'c'.repeat(25)];
    const scope = externalPRScope('u'.repeat(15), orgs);
    const longest = `is:pr is:closed is:unmerged ${scope.query} updated:>2026-01-01T00:00:00Z created:>=2026-01-01T00:00:00Z`;

    expect(scope.isExact).toBe(true);
    expect(longest.length).toBeLessThanOrEqual(256);
  });
});

describe('ledger fetches leave out private repositories and untracked organisations (#1924)', () => {
  const config = { githubUsername: 'testuser', untrackedOrgs: ['Acme'] };
  const items = [
    { ...makeMergedItem('ACME', 'internal', '2025-06-01T00:00:00Z'), title: 'employer' },
    { ...makeMergedItem('org', 'repo', '2025-06-02T00:00:00Z'), title: 'public' },
  ];

  it('asks only for public merged PRs outside the untracked organisations and drops one returned anyway', async () => {
    const octokit = makeOctokit(items);

    const result = await fetchMergedPRsSince(octokit, config);

    expect(octokit.search.issuesAndPullRequests.mock.calls[0][0].q).toBe(
      'is:pr is:merged is:public author:testuser -user:testuser -org:Acme',
    );
    expect(result.prs.map((pr) => pr.title)).toEqual(['public']);
  });

  it('does the same for closed PRs', async () => {
    const octokit = makeOctokit(items);

    const result = await fetchClosedPRsSince(octokit, config, '2025-05-01T00:00:00Z');

    expect(octokit.search.issuesAndPullRequests.mock.calls[0][0].q).toBe(
      'is:pr is:closed is:unmerged is:public author:testuser -user:testuser -org:Acme closed:>2025-05-01T00:00:00Z',
    );
    expect(result.prs.map((pr) => pr.title)).toEqual(['public']);
  });

  it('reports a closed fetch over the limit as truncated', async () => {
    const result = await fetchClosedPRsSince(makeOctokit(items, 1001), config);

    expect(result).toEqual({ prs: [], truncated: true });
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

    expect(result.prs).toHaveLength(1);
    expect(result.prs[0].url).toBe('https://github.com/external-org/repo/pull/42');
    expect(result.prs[0].title).toBe('Fix bug');
    expect(result.prs[0].mergedAt).toBe('2025-06-15T12:00:00Z');
  });

  it('should return empty array when no username is configured', async () => {
    const octokit = makeOctokit([]);
    const result = await fetchMergedPRsSince(octokit, { githubUsername: '' });
    expect(result).toEqual({ prs: [], truncated: false });
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

    expect(result.prs).toHaveLength(1);
    const query = octokit.search.issuesAndPullRequests.mock.calls[0][0].q;
    expect(query).toBe('is:pr is:merged is:public author:testuser -user:testuser');
  });

  it('bounds the search on updated, one day before the watermark (#1924)', async () => {
    const octokit = makeOctokit([]);

    await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' }, '2025-06-01T00:00:00Z');

    const query = octokit.search.issuesAndPullRequests.mock.calls[0][0].q;
    expect(query).toBe('is:pr is:merged is:public author:testuser -user:testuser updated:>2025-05-31T00:00:00Z');
  });

  it('fetches all time when the watermark does not parse as a date (#1924)', async () => {
    const octokit = makeOctokit([]);

    await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' }, 'not-a-date');

    expect(octokit.search.issuesAndPullRequests.mock.calls[0][0].q).not.toContain('updated:');
  });

  it('returns nothing and stops after one request when the search matches more than the limit (#1924)', async () => {
    const octokit = makeOctokit([makeMergedItem('org', 'repo', '2025-06-15T12:00:00Z')], 1001);

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' }, '2025-06-01T00:00:00Z');

    expect(result).toEqual({ prs: [], truncated: true });
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
  });

  it('takes exactly the limit (#1924)', async () => {
    const octokit = makeSearchOver(makeMergedSeries(1000));

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' });

    expect(result.truncated).toBe(false);
    expect(result.prs).toHaveLength(1000);
  });

  it('continues past three pages from the last creation date instead of a deeper page (#1924)', async () => {
    const series = makeMergedSeries(450);
    const octokit = makeSearchOver(series);

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' });

    expect(result.truncated).toBe(false);
    expect(result.prs.map((pr) => pr.url)).toEqual(series.map((item) => item.html_url));
    const calls = octokit.search.issuesAndPullRequests.mock.calls.map(([args]: [SearchArgs]) => args);
    expect(calls.map((args: SearchArgs) => args.page)).toEqual([1, 2, 3, 1, 2]);
    expect(calls.every((args: SearchArgs) => args.sort === 'created' && args.order === 'asc')).toBe(true);
    expect(calls[3].q).toContain(`created:>=${series[299].created_at}`);
  });

  it('walks the whole history when the limit is Infinity (#1924)', async () => {
    const octokit = makeSearchOver(makeMergedSeries(1250));

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' }, undefined, Infinity);

    expect(result.truncated).toBe(false);
    const urls = new Set(result.prs.map((pr) => pr.url));
    expect(urls.size).toBe(1250);
    expect(result.prs).toHaveLength(1250);
  });

  it('reports truncated rather than looping when a full window shares one creation date (#1924)', async () => {
    const sameSecond = makeMergedSeries(301).map((item) => ({ ...item, created_at: '2025-01-01T00:00:00Z' }));
    const octokit = makeSearchOver(sameSecond);

    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' }, undefined, Infinity);

    expect(result).toEqual({ prs: [], truncated: true });
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(6);
  });

  it('rejects when a page fails, returning nothing partial (#1924)', async () => {
    const octokit = makeSearchOver(makeMergedSeries(250));
    octokit.search.issuesAndPullRequests.mockRejectedValueOnce(new Error('boom'));

    await expect(fetchMergedPRsSince(octokit, { githubUsername: 'testuser' })).rejects.toThrow('boom');
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

    expect(result.prs).toHaveLength(0);
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

    expect(result.prs).toHaveLength(1);
    expect(result.prs[0].mergedAt).toBe('2025-06-15T12:00:00Z');
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

    expect(result.prs[0].openedAt).toBe('2025-06-01T08:00:00Z');
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

    expect(result.prs[0].openedAt).toBeUndefined();
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

    expect(result.prs).toHaveLength(1);
    expect(result.prs[0].url).toBe('https://github.com/external-org/repo/pull/99');
    expect(result.prs[0].title).toBe('Rejected PR');
    expect(result.prs[0].closedAt).toBe('2025-07-01T10:00:00Z');
  });

  it('should return empty array when no username is configured', async () => {
    const octokit = makeOctokit([]);
    const result = await fetchClosedPRsSince(octokit, { githubUsername: '' });
    expect(result).toEqual({ prs: [], truncated: false });
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

    expect(result.prs).toHaveLength(0);
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

    expect(result.prs[0].openedAt).toBe('2025-06-20T08:00:00Z');
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

  it('should drop PRs from untrackedOrgs, case-insensitively', async () => {
    const closedAt = isoDaysAgo(1);
    const octokit = makeOctokit([
      { html_url: 'https://github.com/WorkOrg/api/pull/1', title: 'Work PR', closed_at: closedAt },
      { html_url: 'https://github.com/org/repo/pull/3', title: 'OSS PR', closed_at: closedAt },
    ]);

    const result = await fetchRecentlyClosedPRs(octokit, { githubUsername: 'testuser', untrackedOrgs: ['workorg'] }, 7);

    expect(result.map((pr) => pr.repo)).toEqual(['org/repo']);
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

describe('closingIssueUrl (#1824)', () => {
  const pr = 'https://github.com/owner/repo/pull/9';

  it.each([
    ['Fixes #12', 'https://github.com/owner/repo/issues/12'],
    ['closes: #3\n\nmore text', 'https://github.com/owner/repo/issues/3'],
    ['Resolved other/lib#44', 'https://github.com/other/lib/issues/44'],
    ['This fix resolves https://github.com/up/stream/issues/5 cleanly', 'https://github.com/up/stream/issues/5'],
    ['Fixes #1 and closes #2', 'https://github.com/owner/repo/issues/1'],
    ['Fixes:#8', 'https://github.com/owner/repo/issues/8'],
    ['<!-- Fixes #123 (template example) -->\nCloses #7', 'https://github.com/owner/repo/issues/7'],
    ['Use `fixes #1` to link.\n\nResolves #4', 'https://github.com/owner/repo/issues/4'],
    ['``Fixes #1`` closes #3', 'https://github.com/owner/repo/issues/3'],
    ['Fixes https://github.com/up/stream/issues/5#issuecomment-9', 'https://github.com/up/stream/issues/5'],
  ])('parses %j', (body, expected) => {
    expect(closingIssueUrl(body, pr)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['See #12 for context'],
    ['prefixes #12'],
    ['fixes #12abc'],
    ['<!-- Fixes #3 -->'],
  ])('returns undefined for %j', (body) => {
    expect(closingIssueUrl(body, pr)).toBeUndefined();
  });

  it('stays fast on an unterminated comment opener', () => {
    const start = Date.now();
    expect(closingIssueUrl('<!--'.repeat(100_000), pr)).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('carries the closing issue from the search item body onto merged records', async () => {
    const octokit = makeOctokit([
      {
        html_url: 'https://github.com/org/repo/pull/1',
        title: 'Ledger PR',
        body: 'Fixes #77',
        pull_request: { merged_at: '2025-06-15T12:00:00Z' },
        closed_at: '2025-06-15T12:00:00Z',
      },
    ]);
    const result = await fetchMergedPRsSince(octokit, { githubUsername: 'testuser' });
    expect(result.prs[0].issueUrl).toBe('https://github.com/org/repo/issues/77');
  });
});

describe('mentionedIssueUrls (#1863)', () => {
  const pr = 'https://github.com/owner/repo/pull/9';

  it.each([
    [
      'Supersedes #8',
      'Fixes #12',
      ['https://github.com/owner/repo/issues/8', 'https://github.com/owner/repo/issues/12'],
    ],
    [
      'Retry',
      'Another take on #12, see other/lib#44',
      ['https://github.com/owner/repo/issues/12', 'https://github.com/other/lib/issues/44'],
    ],
    ['Retry', 'Replaces https://github.com/owner/repo/pull/8 (#8)', ['https://github.com/owner/repo/issues/8']],
    [
      'Retry',
      'Context: https://github.com/up/stream/issues/5#issuecomment-9',
      ['https://github.com/up/stream/issues/5'],
    ],
    [
      'Retry',
      '(#3) and [#4] and #5.',
      [
        'https://github.com/owner/repo/issues/3',
        'https://github.com/owner/repo/issues/4',
        'https://github.com/owner/repo/issues/5',
      ],
    ],
  ])('parses title %j + body %j', (title, body, expected) => {
    expect(mentionedIssueUrls(title, body, pr)).toEqual(expected);
  });

  it.each([
    ['C#5 is a language', []],
    ['see example.com/page#5', []],
    ['#12abc is not a number', []],
    ['<!-- #123 template example -->', []],
    ['Use `#1` to link.', []],
    ['```\nFixes #2\n```', []],
    ['', []],
  ])('ignores %j', (body, expected) => {
    expect(mentionedIssueUrls('Title', body, pr)).toEqual(expected);
  });

  it('handles null and undefined title/body', () => {
    expect(mentionedIssueUrls(null, undefined, pr)).toEqual([]);
    expect(mentionedIssueUrls(undefined, 'See #7', pr)).toEqual(['https://github.com/owner/repo/issues/7']);
  });

  it('stays fast on an unterminated comment opener', () => {
    const start = Date.now();
    expect(mentionedIssueUrls('t', '<!--'.repeat(100_000), pr)).toEqual([]);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
