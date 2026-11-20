/**
 * Recent-PR fetchers and partial search results (#1928): pagination up to the
 * cap, the truncation message, and the own-repo exclusion in the query.
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchRecentlyClosedPRs, fetchRecentlyMergedPRs, type RecentListTruncation } from './github-stats.js';

const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const RECENT = twoDaysAgo.toISOString();

function mergedItem(number: number) {
  return {
    html_url: `https://github.com/org/repo/pull/${number}`,
    title: `PR ${number}`,
    pull_request: { merged_at: RECENT },
    closed_at: RECENT,
    created_at: RECENT,
  };
}

function mergedItems(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => mergedItem(offset + i + 1));
}

interface Page {
  total_count: number;
  incomplete_results?: boolean;
  items: unknown[];
}

function octokitFor(search: unknown) {
  return { search: { issuesAndPullRequests: search } } as never;
}

/** An Octokit whose search answers with `pages` in order. */
function octokitWithPages(pages: Page[]) {
  const search = vi.fn();
  for (const data of pages) search.mockResolvedValueOnce({ data });
  return { search, octokit: octokitFor(search) };
}

const config = { githubUsername: 'testuser' };

describe('recent-PR fetchers on partial search results (#1928)', () => {
  it('reads one page and reports nothing when it holds every result', async () => {
    const { search, octokit } = octokitWithPages([
      { total_count: 2, incomplete_results: false, items: mergedItems(2) },
    ]);
    const truncations: RecentListTruncation[] = [];

    const result = await fetchRecentlyMergedPRs(octokit, config, 7, truncations);

    expect(result).toHaveLength(2);
    expect(search).toHaveBeenCalledTimes(1);
    expect(truncations).toEqual([]);
  });

  it('reads and merges a second page when the first is full', async () => {
    const { search, octokit } = octokitWithPages([
      { total_count: 130, items: mergedItems(100) },
      { total_count: 130, items: mergedItems(30, 100) },
    ]);
    const truncations: RecentListTruncation[] = [];

    const result = await fetchRecentlyMergedPRs(octokit, config, 7, truncations);

    expect(result).toHaveLength(130);
    expect(result.at(-1)?.number).toBe(130);
    expect(search.mock.calls.map(([params]) => params.page)).toEqual([1, 2]);
    expect(truncations).toEqual([]);
  });

  it('stops at three pages and reports the list as partial', async () => {
    const { search, octokit } = octokitWithPages([
      { total_count: 450, items: mergedItems(100) },
      { total_count: 450, items: mergedItems(100, 100) },
      { total_count: 450, items: mergedItems(100, 200) },
      { total_count: 450, items: mergedItems(100, 300) },
    ]);
    const truncations: RecentListTruncation[] = [];

    const result = await fetchRecentlyMergedPRs(octokit, config, 7, truncations);

    expect(search).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(300);
    expect(truncations).toEqual([
      {
        label: 'recently merged PR search truncated (300 of 450)',
        message:
          'Recently merged PR search is partial: read the 300 most recently updated of 450 result(s). Some recently merged PRs may be missing this run.',
      },
    ]);
  });

  it('reports incomplete_results as partial even when the counts match', async () => {
    const { octokit } = octokitWithPages([{ total_count: 1, incomplete_results: true, items: mergedItems(1) }]);
    const truncations: RecentListTruncation[] = [];

    const result = await fetchRecentlyClosedPRs(octokit, config, 7, truncations);

    expect(result).toHaveLength(1);
    expect(truncations).toHaveLength(1);
    expect(truncations[0].label).toBe('recently closed PR search truncated (1 of 1)');
  });

  it('still returns the partial list when the caller passes no collector', async () => {
    const { octokit } = octokitWithPages([{ total_count: 1, incomplete_results: true, items: mergedItems(1) }]);

    await expect(fetchRecentlyMergedPRs(octokit, config)).resolves.toHaveLength(1);
  });

  it('keeps own repos out of both queries so they do not use page slots', async () => {
    const merged = octokitWithPages([{ total_count: 0, items: [] }]);
    const closed = octokitWithPages([{ total_count: 0, items: [] }]);

    await fetchRecentlyMergedPRs(merged.octokit, config);
    await fetchRecentlyClosedPRs(closed.octokit, config);

    expect(merged.search.mock.calls[0][0].q).toMatch(
      /^is:pr is:merged is:public author:testuser -user:testuser updated:>=\d{4}-\d{2}-\d{2}$/,
    );
    expect(closed.search.mock.calls[0][0].q).toMatch(
      /^is:pr is:closed is:unmerged is:public author:testuser -user:testuser updated:>=\d{4}-\d{2}-\d{2}$/,
    );
  });

  it('returns each PR once when an update moved it onto the next page as well', async () => {
    const { octokit } = octokitWithPages([
      { total_count: 120, items: mergedItems(100) },
      { total_count: 120, items: mergedItems(21, 99) },
    ]);
    const truncations: RecentListTruncation[] = [];

    const result = await fetchRecentlyMergedPRs(octokit, config, 7, truncations);

    expect(result.map((pr) => pr.number)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(truncations).toEqual([]);
  });

  it('keeps the first page and reports the list as partial when a later page fails', async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({ data: { total_count: 200, items: mergedItems(100) } })
      .mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { status: 502 }));
    const truncations: RecentListTruncation[] = [];

    const result = await fetchRecentlyMergedPRs(octokitFor(search), config, 7, truncations);

    expect(result).toHaveLength(100);
    expect(truncations).toEqual([
      {
        label: 'recently merged PR search failed on page 2 (100 read)',
        message:
          'Recently merged PR search failed on page 2 (HTTP 502: Bad Gateway); only the 100 result(s) from the page(s) before it were read. Some recently merged PRs may be missing this run.',
      },
    ]);
  });

  it('rethrows a first-page error', async () => {
    const error = new Error('socket hang up');
    const search = vi.fn().mockRejectedValue(error);

    await expect(fetchRecentlyMergedPRs(octokitFor(search), config)).rejects.toBe(error);
  });

  it('rethrows a rate-limit error from a later page', async () => {
    const error = Object.assign(new Error('API rate limit exceeded'), { status: 429 });
    const search = vi
      .fn()
      .mockResolvedValueOnce({ data: { total_count: 200, items: mergedItems(100) } })
      .mockRejectedValueOnce(error);

    await expect(fetchRecentlyMergedPRs(octokitFor(search), config)).rejects.toBe(error);
  });
});
