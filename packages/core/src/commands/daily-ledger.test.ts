/**
 * Merged-ledger gap filling in the daily run (#1924): a real StateManager in
 * the isolated test home, the real search walk, and a stand-in Search API.
 */

import type { Octokit } from '@octokit/rest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchMergedPRsSince } from '../core/github-stats.js';
import { StateManager } from '../core/state.js';
import type { MergedPR } from '../core/types.js';
import type { DailyWarning } from '../formatters/json.js';
import { fetchMergedLedgerGap, storeMergedLedger } from './daily-ledger.js';

// Calls through; wrapped only so a test can see which fetch daily goes to.
vi.mock('../core/github-stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/github-stats.js')>();
  return { ...actual, fetchMergedPRsSince: vi.fn(actual.fetchMergedPRsSince) };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-03-20T12:00:00Z');

/** ISO timestamp (second precision) `days` before the fixed "now". */
function daysAgo(days: number): string {
  const at = new Date(NOW - days * DAY_MS);
  return `${at.toISOString().slice(0, 19)}Z`;
}

const prUrl = (number: number) => `https://github.com/org/repo/pull/${number}`;

function searchItem(number: number, mergedAt: string) {
  return {
    html_url: prUrl(number),
    title: `PR ${number}`,
    created_at: mergedAt,
    updated_at: mergedAt,
    closed_at: mergedAt,
    pull_request: { merged_at: mergedAt },
  };
}

type SearchItem = ReturnType<typeof searchItem>;

/**
 * A Search API stand-in over the user's merged PRs: honors the `updated:>`
 * bound the gap fetch sends. `reportedTotal` overrides `total_count`.
 */
function makeSearch(items: SearchItem[], reportedTotal?: number) {
  const issuesAndPullRequests = vi.fn(({ q }: { q: string }) => {
    const since = /updated:>(\S+)/.exec(q)?.[1] ?? '';
    const matching = items.filter((item) => item.updated_at > since);
    return Promise.resolve({ data: { total_count: reportedTotal ?? matching.length, items: matching } });
  });
  return { octokit: { search: { issuesAndPullRequests } } as unknown as Octokit, issuesAndPullRequests };
}

/** The queries a search stand-in received. */
function queriesOf(search: ReturnType<typeof makeSearch>): string[] {
  return search.issuesAndPullRequests.mock.calls.map(([args]) => args.q);
}

/** One daily run's ledger step: fetch the gap, then store it with the recent list. */
async function runLedgerStep(
  sm: StateManager,
  octokit: Octokit,
  options: { recent?: MergedPR[]; allTimeCount?: number } = {},
): Promise<DailyWarning[]> {
  const warnings: DailyWarning[] = [];
  const gap = await fetchMergedLedgerGap(octokit, sm, warnings);
  storeMergedLedger(sm, {
    gap,
    warnings,
    recentlyMergedPRs: options.recent ?? [],
    previousDigest: undefined,
    allTimeCount: options.allTimeCount,
  });
  return warnings;
}

const storedUrls = (sm: StateManager) => sm.getMergedPRs().map((pr) => pr.url);

describe('merged-ledger gap filling (#1924)', () => {
  // Ledger complete through 12 days ago; then no run for 10 days.
  const WATERMARK = daysAgo(12);
  const gapMerges = [searchItem(2, daysAgo(11)), searchItem(3, daysAgo(10.5)), searchItem(4, daysAgo(10))];
  const recentMerge = searchItem(5, daysAgo(1));
  /** `recentMerge` as the seven-day list daily shows carries it. */
  const recentRow: MergedPR = { url: prUrl(5), repo: 'org/repo', number: 5, title: 'PR 5', mergedAt: daysAgo(1) };
  let sm: StateManager;

  beforeEach(() => {
    vi.mocked(fetchMergedPRsSince).mockClear();
    sm = new StateManager(true);
    sm.updateConfig({ githubUsername: 'me' });
    sm.addMergedPRs([{ url: prUrl(1), title: 'PR 1', mergedAt: WATERMARK }]);
  });

  it('ends with every merge in the ledger after a 10-day pause, not only the last seven days', async () => {
    const search = makeSearch([searchItem(1, WATERMARK), ...gapMerges, recentMerge]);

    const warnings = await runLedgerStep(sm, search.octokit, { recent: [recentRow] });

    expect(storedUrls(sm)).toEqual([prUrl(5), prUrl(4), prUrl(3), prUrl(2), prUrl(1)]);
    expect(warnings).toEqual([]);
    // One request, bounded one day before the newest entry the ledger had.
    expect(queriesOf(search)).toEqual([`is:pr is:merged author:me -user:me updated:>${daysAgo(13)}`]);
  });

  it('goes through fetchMergedPRsSince, the fetch the dashboard uses, with the ledger watermark', async () => {
    const search = makeSearch([]);

    await runLedgerStep(sm, search.octokit);

    expect(fetchMergedPRsSince).toHaveBeenCalledWith(search.octokit, sm.getState().config, WATERMARK);
  });

  it('fetches all time when the ledger is empty', async () => {
    const empty = new StateManager(true);
    empty.updateConfig({ githubUsername: 'me' });
    const search = makeSearch([...gapMerges, recentMerge]);

    await runLedgerStep(empty, search.octokit);

    expect(queriesOf(search)).toEqual(['is:pr is:merged author:me -user:me']);
    expect(storedUrls(empty)).toEqual([prUrl(5), prUrl(4), prUrl(3), prUrl(2)]);
  });

  it('leaves the watermark alone and warns when the gap is larger than one run fetches', async () => {
    const search = makeSearch([...gapMerges, recentMerge], 1001);

    const warnings = await runLedgerStep(sm, search.octokit, { recent: [recentRow], allTimeCount: 2000 });

    expect(storedUrls(sm)).toEqual([prUrl(1)]);
    expect(sm.getMergedPRWatermark()).toBe(WATERMARK);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ phase: 'fetch', operation: 'fetch merged PRs for the ledger' });
    expect(warnings[0].message).toContain('More than 1000 merged PRs');
    expect(warnings[0].message).toContain('Run `ledger-backfill`');
  });

  it('asks for the same range again on the run after a truncated one', async () => {
    const search = makeSearch([...gapMerges, recentMerge], 1001);

    await runLedgerStep(sm, search.octokit, { recent: [recentRow] });
    await runLedgerStep(sm, search.octokit, { recent: [recentRow] });

    const [first, second] = queriesOf(search);
    expect(first).toContain(`updated:>${daysAgo(13)}`);
    expect(second).toBe(first);
  });

  it('stores nothing when the gap fetch fails, then fills the whole gap on the next run', async () => {
    const search = makeSearch([...gapMerges, recentMerge]);
    search.issuesAndPullRequests.mockRejectedValueOnce(new Error('search down'));

    const warnings = await runLedgerStep(sm, search.octokit, { recent: [recentRow] });

    expect(storedUrls(sm)).toEqual([prUrl(1)]);
    expect(warnings).toEqual([
      { phase: 'fetch', operation: 'fetch merged PRs for the ledger', message: 'search down' },
    ]);

    await runLedgerStep(sm, search.octokit, { recent: [recentRow] });
    expect(storedUrls(sm)).toEqual([prUrl(5), prUrl(4), prUrl(3), prUrl(2), prUrl(1)]);
  });

  it('takes a merge out of the closed ledger when the gap fetch brings it in', async () => {
    sm.addClosedPRs([
      { url: prUrl(3), title: 'PR 3', closedAt: daysAgo(11) },
      { url: prUrl(9), title: 'PR 9', closedAt: daysAgo(11) },
    ]);
    const search = makeSearch(gapMerges);

    await runLedgerStep(sm, search.octokit);

    expect(storedUrls(sm)).toContain(prUrl(3));
    expect(sm.getClosedPRs().map((pr) => pr.url)).toEqual([prUrl(9)]);
  });

  describe('all-time count check', () => {
    it('warns with the difference when the ledger is short of the count', async () => {
      const search = makeSearch(gapMerges);

      const warnings = await runLedgerStep(sm, search.octokit, { allTimeCount: 9 });

      expect(warnings).toEqual([
        {
          phase: 'analytics',
          operation: 'check merged-PR ledger',
          message:
            'The merged-PR ledger holds 4 of the 9 merged PRs GitHub reports (5 missing). ' +
            'Run `ledger-backfill` to fetch them.',
        },
      ]);
    });

    it.each([
      ['equal to the count', 4],
      ['ahead of the count (a cached count, or PRs GitHub no longer lists)', 3],
      ['compared with an unknown count (the count search failed)', undefined],
    ])('says nothing when the ledger is %s', async (_label, allTimeCount) => {
      const search = makeSearch(gapMerges);

      const warnings = await runLedgerStep(sm, search.octokit, { allTimeCount });

      expect(warnings).toEqual([]);
    });
  });
});
