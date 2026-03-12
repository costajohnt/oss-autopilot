import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildLabelQuery, buildEffectiveLabels, interleaveArrays, batchRepos } from './search-phases.js';
import { SCOPE_LABELS } from './types.js';
import type { GitHubSearchItem } from './issue-filtering.js';
import { makeGitHubSearchItem, makeIssueCandidate } from './test-utils.js';

// ── Mocks for infrastructure function tests ──

/** Build a fresh http-cache mock with all cache misses (null returns) */
function makeCacheMock() {
  return {
    getIfFresh: vi.fn().mockReturnValue(null),
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    hasInflight: vi.fn().mockReturnValue(false),
    getInflight: vi.fn().mockReturnValue(undefined),
    setInflight: vi.fn().mockReturnValue(() => {}),
  };
}

vi.mock('./http-cache.js', () => ({
  getHttpCache: vi.fn().mockReturnValue(makeCacheMock()),
  cachedTimeBased: vi
    .fn()
    .mockImplementation(async (cache: any, _key: string, _maxAgeMs: number, fetcher: () => Promise<unknown>) => {
      const cached = cache.getIfFresh(_key, _maxAgeMs);
      if (cached) return cached;
      const result = await fetcher();
      cache.set(_key, '', result);
      return result;
    }),
}));

const { cachedSearchIssues, filterVetAndScore, searchInRepos } = await import('./search-phases.js');
const { getHttpCache, cachedTimeBased } = await import('./http-cache.js');

// ── Pure function tests (existing) ──

describe('buildLabelQuery', () => {
  it('returns empty string for no labels', () => {
    expect(buildLabelQuery([])).toBe('');
  });

  it('returns single label without OR wrapper', () => {
    expect(buildLabelQuery(['good first issue'])).toBe('label:"good first issue"');
  });

  it('returns OR-joined labels wrapped in parentheses', () => {
    const result = buildLabelQuery(['bug', 'enhancement']);
    expect(result).toBe('(label:"bug" OR label:"enhancement")');
  });

  it('handles three labels', () => {
    const result = buildLabelQuery(['a', 'b', 'c']);
    expect(result).toBe('(label:"a" OR label:"b" OR label:"c")');
  });
});

describe('buildEffectiveLabels', () => {
  it('should return scope labels for a single scope', () => {
    const result = buildEffectiveLabels(['beginner'], []);
    expect(result).toEqual(SCOPE_LABELS.beginner);
  });

  it('should merge labels from multiple scopes', () => {
    const result = buildEffectiveLabels(['beginner', 'intermediate'], []);
    for (const label of SCOPE_LABELS.beginner) {
      expect(result).toContain(label);
    }
    for (const label of SCOPE_LABELS.intermediate) {
      expect(result).toContain(label);
    }
  });

  it('should merge custom labels with scope labels', () => {
    const result = buildEffectiveLabels(['beginner'], ['custom-label']);
    expect(result).toContain('good first issue');
    expect(result).toContain('custom-label');
  });

  it('should deduplicate when custom labels overlap with scope labels', () => {
    const result = buildEffectiveLabels(['beginner'], ['good first issue', 'custom']);
    const gfiCount = result.filter((l) => l === 'good first issue').length;
    expect(gfiCount).toBe(1);
    expect(result).toContain('custom');
  });

  it('should return only custom labels when scopes is empty', () => {
    const result = buildEffectiveLabels([], ['my-label']);
    expect(result).toEqual(['my-label']);
  });
});

describe('interleaveArrays', () => {
  it('should interleave two equal-length arrays', () => {
    const result = interleaveArrays([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ]);
    expect(result).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  });

  it('should handle arrays of different lengths', () => {
    const result = interleaveArrays([
      ['a1', 'a2'],
      ['b1', 'b2', 'b3'],
    ]);
    expect(result).toEqual(['a1', 'b1', 'a2', 'b2', 'b3']);
  });

  it('should handle three arrays', () => {
    const result = interleaveArrays([['a1'], ['b1'], ['c1']]);
    expect(result).toEqual(['a1', 'b1', 'c1']);
  });

  it('should handle empty arrays', () => {
    expect(interleaveArrays([])).toEqual([]);
    expect(interleaveArrays([[], []])).toEqual([]);
  });

  it('should handle single array', () => {
    expect(interleaveArrays([['a', 'b']])).toEqual(['a', 'b']);
  });
});

describe('batchRepos', () => {
  it('splits repos into batches of specified size', () => {
    const result = batchRepos(['a', 'b', 'c', 'd', 'e'], 2);
    expect(result).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('returns single batch when repos fit', () => {
    const result = batchRepos(['a', 'b'], 5);
    expect(result).toEqual([['a', 'b']]);
  });

  it('returns empty array for empty input', () => {
    expect(batchRepos([], 5)).toEqual([]);
  });

  it('handles batch size of 1', () => {
    const result = batchRepos(['a', 'b', 'c'], 1);
    expect(result).toEqual([['a'], ['b'], ['c']]);
  });

  it('handles exact multiple of batch size', () => {
    const result = batchRepos(['a', 'b', 'c', 'd'], 2);
    expect(result).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

// ── Infrastructure function tests ──

describe('cachedSearchIssues', () => {
  let mockOctokit: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOctokit = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: { total_count: 1, items: [makeGitHubSearchItem('owner/repo', 1)] },
        }),
      },
    };
    vi.mocked(getHttpCache).mockReturnValue(makeCacheMock() as any);
  });

  it('should call octokit.search with provided params', async () => {
    const params = { q: 'is:issue is:open', sort: 'created' as const, order: 'desc' as const, per_page: 10 };
    await cachedSearchIssues(mockOctokit, params);
    expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledWith(params);
  });

  it('should return data from octokit response', async () => {
    const result = await cachedSearchIssues(mockOctokit, {
      q: 'is:issue',
      sort: 'created',
      order: 'desc',
      per_page: 10,
    });
    expect(result).toHaveProperty('total_count', 1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].html_url).toContain('owner/repo');
  });

  it('should build cache key from query, sort, order, per_page', async () => {
    const params = { q: 'is:issue label:"bug"', sort: 'updated' as const, order: 'asc' as const, per_page: 25 };
    await cachedSearchIssues(mockOctokit, params);
    const calledKey = vi.mocked(cachedTimeBased).mock.calls[0][1];
    expect(calledKey).toBe('search:is:issue label:"bug":updated:asc:25');
  });

  it('should return cached result when cache has fresh data', async () => {
    const cachedData = { total_count: 5, items: [makeGitHubSearchItem('cached/repo', 99)] };
    const cache = makeCacheMock();
    cache.getIfFresh.mockReturnValue(cachedData);
    vi.mocked(getHttpCache).mockReturnValue(cache as any);

    const result = await cachedSearchIssues(mockOctokit, {
      q: 'is:issue',
      sort: 'created',
      order: 'desc',
      per_page: 10,
    });
    expect(result).toEqual(cachedData);
    expect(mockOctokit.search.issuesAndPullRequests).not.toHaveBeenCalled();
  });
});

describe('filterVetAndScore', () => {
  let mockVetter: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVetter = {
      vetIssuesParallel: vi.fn().mockResolvedValue({
        candidates: [makeIssueCandidate()],
        allFailed: false,
        rateLimitHit: false,
      }),
    };
  });

  it('should remove spam repos detected by label farming', async () => {
    // Create items from a spammy repo (5+ beginner labels triggers farming detection)
    const spamItem = makeGitHubSearchItem('spam/repo', 1, {
      labels: [
        { name: 'good first issue' },
        { name: 'hacktoberfest' },
        { name: 'easy' },
        { name: 'beginner' },
        { name: 'starter' },
      ],
    });
    const legitItem = makeGitHubSearchItem('legit/repo', 2);

    await filterVetAndScore(mockVetter, [spamItem, legitItem], (items) => items, [], 10, 0, 'test');

    // Vetter should only receive the legit item's URL
    const vettedUrls = mockVetter.vetIssuesParallel.mock.calls[0][0];
    expect(vettedUrls).toEqual([legitItem.html_url]);
  });

  it('should apply caller-provided filterFn', async () => {
    const items = [
      makeGitHubSearchItem('owner/repo', 1),
      makeGitHubSearchItem('owner/repo', 2),
      makeGitHubSearchItem('owner/repo', 3),
    ];

    // Filter keeps only issue #2
    const filterFn = (items: GitHubSearchItem[]) => items.filter((i) => i.html_url.includes('/2'));

    await filterVetAndScore(mockVetter, items, filterFn, [], 10, 0, 'test');

    const vettedUrls = mockVetter.vetIssuesParallel.mock.calls[0][0];
    expect(vettedUrls).toHaveLength(1);
    expect(vettedUrls[0]).toContain('/issues/2');
  });

  it('should exclude items matching any excludedRepoSet', async () => {
    const items = [
      makeGitHubSearchItem('excluded/repo', 1),
      makeGitHubSearchItem('also-excluded/repo', 2),
      makeGitHubSearchItem('allowed/repo', 3),
    ];

    const excluded1 = new Set(['excluded/repo']);
    const excluded2 = new Set(['also-excluded/repo']);

    await filterVetAndScore(mockVetter, items, (i) => i, [excluded1, excluded2], 10, 0, 'test');

    const vettedUrls = mockVetter.vetIssuesParallel.mock.calls[0][0];
    expect(vettedUrls).toEqual(['https://github.com/allowed/repo/issues/3']);
  });

  it('should pass filtered URLs to vetter.vetIssuesParallel', async () => {
    const items = [makeGitHubSearchItem('owner/repo', 1), makeGitHubSearchItem('owner/repo', 2)];

    await filterVetAndScore(mockVetter, items, (i) => i, [], 5, 0, 'test');

    expect(mockVetter.vetIssuesParallel).toHaveBeenCalledWith(
      ['https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/issues/2'],
      5,
      'normal',
    );
  });

  it('should filter candidates below minStars', async () => {
    mockVetter.vetIssuesParallel.mockResolvedValue({
      candidates: [
        makeIssueCandidate({ projectHealth: { stargazersCount: 10, checkFailed: false } as any }),
        makeIssueCandidate({ projectHealth: { stargazersCount: 200, checkFailed: false } as any }),
      ],
      allFailed: false,
      rateLimitHit: false,
    });

    const items = [makeGitHubSearchItem('low/stars', 1), makeGitHubSearchItem('high/stars', 2)];
    const result = await filterVetAndScore(mockVetter, items, (i) => i, [], 10, 50, 'test');

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].projectHealth.stargazersCount).toBe(200);
  });

  it('should keep candidates when checkFailed is true regardless of stars', async () => {
    mockVetter.vetIssuesParallel.mockResolvedValue({
      candidates: [makeIssueCandidate({ projectHealth: { stargazersCount: 5, checkFailed: true } as any })],
      allFailed: false,
      rateLimitHit: false,
    });

    const items = [makeGitHubSearchItem('unknown/stars', 1)];
    const result = await filterVetAndScore(mockVetter, items, (i) => i, [], 10, 100, 'test');

    expect(result.candidates).toHaveLength(1);
  });

  it('should return empty when all items filtered before vetting', async () => {
    const items = [makeGitHubSearchItem('excluded/repo', 1)];
    const excluded = new Set(['excluded/repo']);

    const result = await filterVetAndScore(mockVetter, items, (i) => i, [excluded], 10, 0, 'test');

    expect(result.candidates).toEqual([]);
    expect(result.allVetFailed).toBe(false);
    expect(result.rateLimitHit).toBe(false);
    expect(mockVetter.vetIssuesParallel).not.toHaveBeenCalled();
  });

  it('should propagate allFailed and rateLimitHit from vetter', async () => {
    mockVetter.vetIssuesParallel.mockResolvedValue({
      candidates: [],
      allFailed: true,
      rateLimitHit: true,
    });

    const items = [makeGitHubSearchItem('owner/repo', 1)];
    const result = await filterVetAndScore(mockVetter, items, (i) => i, [], 10, 0, 'test');

    expect(result.allVetFailed).toBe(true);
    expect(result.rateLimitHit).toBe(true);
  });

  it('should cap items sent to vetter at remainingNeeded*2', async () => {
    // Create 10 items
    const items = Array.from({ length: 10 }, (_, i) => makeGitHubSearchItem('owner/repo', i + 1));

    await filterVetAndScore(mockVetter, items, (i) => i, [], 3, 0, 'test');

    // remainingNeeded=3, so max items to vet = 3*2 = 6
    const vettedUrls = mockVetter.vetIssuesParallel.mock.calls[0][0];
    expect(vettedUrls).toHaveLength(6);
  });
});

describe('searchInRepos', () => {
  let mockOctokit: any;
  let mockVetter: any;
  const passthrough = (items: GitHubSearchItem[]) => items;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOctokit = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: { total_count: 1, items: [makeGitHubSearchItem('owner/repo', 1)] },
        }),
      },
    };
    mockVetter = {
      vetIssuesParallel: vi.fn().mockResolvedValue({
        candidates: [makeIssueCandidate()],
        allFailed: false,
        rateLimitHit: false,
      }),
    };
    vi.mocked(getHttpCache).mockReturnValue(makeCacheMock() as any);
  });

  it('should batch repos and search each batch', async () => {
    // 7 repos with batch size 5 = 2 batches
    const repos = ['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6', 'a/7'];
    await searchInRepos(mockOctokit, mockVetter, repos, 'is:issue', 20, 'normal', passthrough);

    // Should have made 2 search calls (batches of 5)
    expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(2);

    // First batch query should contain repos 1-5
    const firstQuery = mockOctokit.search.issuesAndPullRequests.mock.calls[0][0].q;
    expect(firstQuery).toContain('repo:a/1');
    expect(firstQuery).toContain('repo:a/5');

    // Second batch query should contain repos 6-7
    const secondQuery = mockOctokit.search.issuesAndPullRequests.mock.calls[1][0].q;
    expect(secondQuery).toContain('repo:a/6');
    expect(secondQuery).toContain('repo:a/7');
  });

  it('should stop searching when maxResults reached', async () => {
    // Return 3 candidates from first batch
    mockVetter.vetIssuesParallel.mockResolvedValue({
      candidates: [makeIssueCandidate(), makeIssueCandidate(), makeIssueCandidate()],
      allFailed: false,
      rateLimitHit: false,
    });

    const repos = Array.from({ length: 15 }, (_, i) => `org/repo${i}`);
    const result = await searchInRepos(mockOctokit, mockVetter, repos, 'is:issue', 3, 'normal', passthrough);

    // Should have stopped after first batch since we got 3 candidates (= maxResults)
    expect(result.candidates.length).toBeGreaterThanOrEqual(3);
    expect(mockOctokit.search.issuesAndPullRequests.mock.calls.length).toBeLessThan(3);
  });

  it('should handle per-batch errors and continue', async () => {
    // First batch fails, second succeeds
    mockOctokit.search.issuesAndPullRequests.mockRejectedValueOnce(new Error('Server error')).mockResolvedValueOnce({
      data: { total_count: 1, items: [makeGitHubSearchItem('org/repo6', 1)] },
    });

    const repos = Array.from({ length: 10 }, (_, i) => `org/repo${i}`);
    const result = await searchInRepos(mockOctokit, mockVetter, repos, 'is:issue', 10, 'normal', passthrough);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.allBatchesFailed).toBe(false);
  });

  it('should set allBatchesFailed when all batches fail', async () => {
    mockOctokit.search.issuesAndPullRequests.mockRejectedValue(new Error('Server error'));

    const repos = ['org/repo1', 'org/repo2'];
    const result = await searchInRepos(mockOctokit, mockVetter, repos, 'is:issue', 10, 'normal', passthrough);

    expect(result.allBatchesFailed).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it('should track rateLimitHit on rate limit error', async () => {
    const rateLimitError = new Error('API rate limit exceeded');
    (rateLimitError as any).status = 403;
    mockOctokit.search.issuesAndPullRequests.mockRejectedValue(rateLimitError);

    const repos = ['org/repo1'];
    const result = await searchInRepos(mockOctokit, mockVetter, repos, 'is:issue', 10, 'normal', passthrough);

    expect(result.rateLimitHit).toBe(true);
    expect(result.allBatchesFailed).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it('should track rateLimitHit with 429 status code', async () => {
    const rateLimitError = new Error('Too Many Requests');
    (rateLimitError as any).status = 429;
    mockOctokit.search.issuesAndPullRequests.mockRejectedValue(rateLimitError);

    const repos = ['org/repo1'];
    const result = await searchInRepos(mockOctokit, mockVetter, repos, 'is:issue', 10, 'normal', passthrough);

    expect(result.rateLimitHit).toBe(true);
    expect(result.allBatchesFailed).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it('should return empty candidates for empty repos list', async () => {
    const result = await searchInRepos(mockOctokit, mockVetter, [], 'is:issue', 10, 'normal', passthrough);

    expect(result.candidates).toEqual([]);
    expect(result.allBatchesFailed).toBe(false);
    expect(result.rateLimitHit).toBe(false);
    expect(mockOctokit.search.issuesAndPullRequests).not.toHaveBeenCalled();
  });
});
