/**
 * The daily run's recent-PR lists on a failed or partial search (#1928):
 * what is kept, what lands in `warnings[]`, and when a merged successor
 * could be missing (the reason Phase 3.6 withholds a claim release).
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchRecentlyClosedPRs, fetchRecentlyMergedPRs, type RecentListTruncation } from '../core/github-stats.js';
import type { DailyWarning } from '../formatters/json.js';
import { fetchRecentPRLists } from './daily-recent-prs.js';

const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const RECENT = twoDaysAgo.toISOString();
const config = { githubUsername: 'testuser' };

function prItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    html_url: `https://github.com/org/repo/pull/${i + 1}`,
    title: `PR ${i + 1}`,
    pull_request: { merged_at: RECENT },
    closed_at: RECENT,
    created_at: RECENT,
  }));
}

/** A search that answers page 1 with the first 100 of 250 results, then fails page 2 with `error`. */
function searchFailingAfterPageOne(error: Error) {
  return vi
    .fn()
    .mockResolvedValueOnce({ data: { total_count: 250, items: prItems(100) } })
    .mockRejectedValueOnce(error);
}

const emptySearch = () => vi.fn().mockResolvedValue({ data: { total_count: 0, items: [] } });

function octokitFor(search: unknown) {
  return { search: { issuesAndPullRequests: search } } as never;
}

/** A monitor running the real fetchers against the given search mocks. */
function monitorWith(searches: { merged: unknown; closed: unknown }) {
  return {
    fetchRecentlyMergedPRs: (days?: number, truncations?: RecentListTruncation[]) =>
      fetchRecentlyMergedPRs(octokitFor(searches.merged), config, days, truncations),
    fetchRecentlyClosedPRs: (days?: number, truncations?: RecentListTruncation[]) =>
      fetchRecentlyClosedPRs(octokitFor(searches.closed), config, days, truncations),
  };
}

const badGateway = Object.assign(new Error('Bad Gateway'), { status: 502 });
const GAP = /^the recently-merged list was truncated; release the claim by hand/;

describe('fetchRecentPRLists (#1928)', () => {
  it('returns whole lists with no warning and no successor gap', async () => {
    const warnings: DailyWarning[] = [];
    const merged = vi.fn().mockResolvedValue({ data: { total_count: 2, items: prItems(2) } });

    const lists = await fetchRecentPRLists(monitorWith({ merged, closed: emptySearch() }), warnings);

    expect(lists.recentlyMergedPRs).toHaveLength(2);
    expect(lists).toMatchObject({ recentlyClosedPRs: [], recentlyMergedFetchFailed: false, successorGapReasons: [] });
    expect(warnings).toEqual([]);
  });

  it('keeps the merged PRs read before a failed later page, warns, and names a successor gap', async () => {
    const warnings: DailyWarning[] = [];
    const merged = searchFailingAfterPageOne(badGateway);

    const lists = await fetchRecentPRLists(monitorWith({ merged, closed: emptySearch() }), warnings);

    expect(lists.recentlyMergedPRs).toHaveLength(100);
    expect(lists.recentlyMergedFetchFailed).toBe(false);
    expect(lists.successorGapReasons).toHaveLength(1);
    expect(lists.successorGapReasons[0]).toMatch(GAP);
    expect(warnings).toEqual([
      {
        phase: 'fetch',
        operation: 'fetch recent PRs (truncated)',
        message:
          'Recently merged PR search failed on page 2 (HTTP 502: Bad Gateway); only the 100 result(s) from the page(s) before it were read. Some recently merged PRs may be missing this run.',
      },
    ]);
  });

  it('warns about a closed-only truncation without naming a successor gap', async () => {
    const warnings: DailyWarning[] = [];
    const closed = searchFailingAfterPageOne(badGateway);

    const lists = await fetchRecentPRLists(monitorWith({ closed, merged: emptySearch() }), warnings);

    expect(lists.recentlyClosedPRs).toHaveLength(100);
    expect(lists.successorGapReasons).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('Recently closed PR search failed on page 2');
  });

  it('degrades a failed merged fetch to a warning, an empty list and a successor gap', async () => {
    const warnings: DailyWarning[] = [];
    const merged = vi.fn().mockRejectedValue(new Error('socket hang up'));

    const lists = await fetchRecentPRLists(monitorWith({ merged, closed: emptySearch() }), warnings);

    expect(lists).toMatchObject({
      recentlyMergedPRs: [],
      recentlyMergedFetchFailed: true,
      successorGapReasons: ['the recently-merged fetch failed'],
    });
    expect(warnings).toEqual([{ phase: 'fetch', operation: 'fetch recently merged PRs', message: 'socket hang up' }]);
  });

  it('still degrades, as before, when a later page hits the rate limit: the pages read are not kept', async () => {
    const warnings: DailyWarning[] = [];
    const rateLimited = Object.assign(new Error('API rate limit exceeded'), { status: 429 });
    const merged = searchFailingAfterPageOne(rateLimited);

    const lists = await fetchRecentPRLists(monitorWith({ merged, closed: emptySearch() }), warnings);

    expect(lists).toMatchObject({ recentlyMergedPRs: [], recentlyMergedFetchFailed: true });
    expect(warnings).toEqual([
      { phase: 'fetch', operation: 'fetch recently merged PRs', message: 'API rate limit exceeded' },
    ]);
  });
});
