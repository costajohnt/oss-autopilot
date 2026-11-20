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
import { applyRepoMetadata, fetchMergedLedgerGap, storeMergedLedger } from './daily-ledger.js';

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
    expect(queriesOf(search)).toEqual([`is:pr is:merged is:public author:me -user:me updated:>${daysAgo(13)}`]);
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

    expect(queriesOf(search)).toEqual(['is:pr is:merged is:public author:me -user:me']);
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

describe('untracked organisations and private repositories stay out of the ledger (#1924)', () => {
  const at = daysAgo(2);
  const employer = { ...searchItem(1, at), html_url: 'https://github.com/Acme/internal/pull/1' };
  const privateRepo = { ...searchItem(2, at), html_url: 'https://github.com/org/secret/pull/2' };
  const publicRepo = searchItem(3, at);
  let sm: StateManager;

  beforeEach(() => {
    sm = new StateManager(true);
    sm.updateConfig({ githubUsername: 'me', untrackedOrgs: ['acme'] });
  });

  it('daily stores neither: the query is public-only and an untracked row GitHub returns is dropped', async () => {
    // GitHub applies `is:public`; the stand-in does too, and ignores `-org:`
    // so the result filter is what keeps the employer PR out.
    const issuesAndPullRequests = vi.fn(({ q }: { q: string }) => {
      const items = q.includes('is:public') ? [employer, publicRepo] : [employer, privateRepo, publicRepo];
      return Promise.resolve({ data: { total_count: items.length, items } });
    });
    const octokit = { search: { issuesAndPullRequests } } as unknown as Octokit;

    await runLedgerStep(sm, octokit);

    expect(issuesAndPullRequests.mock.calls[0][0].q).toBe('is:pr is:merged is:public author:me -user:me -org:acme');
    expect(storedUrls(sm)).toEqual([publicRepo.html_url]);
  });

  describe('rows stored by earlier versions', () => {
    const row = (url: string) => ({ url, title: 'stored', mergedAt: at });
    const closedRow = { url: 'https://github.com/ACME/tools/pull/9', title: 'stored', closedAt: at };

    beforeEach(() => {
      sm.addMergedPRs([row(employer.html_url), row(publicRepo.html_url)]);
      sm.addClosedPRs([closedRow]);
      sm.updateRepoScore('Acme/internal', { stargazersCount: 500 });
      sm.updateRepoScore('ACME/tools', { stargazersCount: 500 });
      sm.updateRepoScore('org/repo', { stargazersCount: 500 });
    });

    it('are removed by the daily upkeep, with their scores, and the totals follow', () => {
      expect(sm.getStats()).toMatchObject({ mergedPRs: 2, closedPRs: 1 });

      applyRepoMetadata(sm, new Map(), []);

      expect(storedUrls(sm)).toEqual([publicRepo.html_url]);
      expect(sm.getClosedPRs()).toEqual([]);
      expect(Object.keys(sm.getState().repoScores)).toEqual(['org/repo']);
      expect(sm.getStats()).toMatchObject({ mergedPRs: 1, closedPRs: 0 });
    });

    it('stay removed on the next upkeep, which changes nothing more', () => {
      applyRepoMetadata(sm, new Map(), []);
      const after = structuredClone(sm.getState());

      expect(sm.evictExcludedRepos([])).toEqual({ untrackedOrgRows: 0, privateRows: 0, repos: 0 });
      applyRepoMetadata(sm, new Map(), []);

      expect(sm.getState()).toEqual(after);
    });

    it.each([
      ['empty', []],
      ['unset', undefined],
    ])('are all kept when untrackedOrgs is %s', (_label, untrackedOrgs) => {
      sm.updateConfig({ untrackedOrgs });

      applyRepoMetadata(sm, new Map(), []);

      expect(storedUrls(sm)).toHaveLength(2);
      expect(sm.getClosedPRs()).toHaveLength(1);
      expect(Object.keys(sm.getState().repoScores)).toContain('Acme/internal');
    });
  });
});

describe('repositories GitHub reports private leave the ledger (#1924)', () => {
  const at = daysAgo(2);
  const SECRET = 'org/secret';
  const secretRow = { url: `https://github.com/${SECRET}/pull/2`, title: 'stored', mergedAt: at };
  const secretClosed = { url: `https://github.com/${SECRET}/pull/4`, title: 'stored', closedAt: at };
  const publicRow = { url: prUrl(3), title: 'stored', mergedAt: at };
  let sm: StateManager;

  beforeEach(() => {
    sm = new StateManager(true);
    sm.updateConfig({ githubUsername: 'me' });
    sm.addMergedPRs([secretRow, publicRow]);
    sm.addClosedPRs([secretClosed]);
    sm.updateRepoScore(SECRET, { stargazersCount: 500 });
    sm.updateRepoScore('org/repo', { stargazersCount: 500 });
  });

  it('removes the rows and the score of a repository read as private, and the totals follow', () => {
    expect(sm.getStats()).toMatchObject({ mergedPRs: 2, closedPRs: 1 });
    const metadata = new Map([
      [SECRET, { stars: 500, language: 'Go', isPrivate: true }],
      ['org/repo', { stars: 500, language: 'Go', isPrivate: false }],
    ]);

    applyRepoMetadata(sm, metadata, []);

    expect(storedUrls(sm)).toEqual([publicRow.url]);
    expect(sm.getClosedPRs()).toEqual([]);
    expect(Object.keys(sm.getState().repoScores)).toEqual(['org/repo']);
    expect(sm.getStats()).toMatchObject({ mergedPRs: 1, closedPRs: 0 });

    // A second pass with the same read finds nothing more to remove. (The
    // public repository's score is rewritten each pass, so compare what the
    // eviction owns, not timestamps.)
    applyRepoMetadata(sm, metadata, []);
    expect(storedUrls(sm)).toEqual([publicRow.url]);
    expect(Object.keys(sm.getState().repoScores)).toEqual(['org/repo']);
    expect(sm.evictExcludedRepos([SECRET])).toEqual({ untrackedOrgRows: 0, privateRows: 0, repos: 0 });
  });

  it.each([
    [
      'could not be read (404 or error: absent from the result)',
      new Map([['org/repo', { stars: 500, language: null }]]),
    ],
    ['came back without a visibility flag', new Map([[SECRET, { stars: 500, language: 'Go' }]])],
    ['is public', new Map([[SECRET, { stars: 500, language: 'Go', isPrivate: false }]])],
    ['was not read at all because the whole fetch failed', new Map()],
  ])('keeps everything when the repository %s', (_label, metadata) => {
    applyRepoMetadata(sm, metadata, []);

    expect(storedUrls(sm)).toHaveLength(2);
    expect(sm.getClosedPRs()).toHaveLength(1);
    expect(Object.keys(sm.getState().repoScores)).toContain(SECRET);
    expect(sm.getStats()).toMatchObject({ mergedPRs: 2, closedPRs: 1 });
  });

  it('writes stars and language, and records a warning when an update throws', () => {
    const warnings: DailyWarning[] = [];
    const updateRepoScore = vi.fn((repo: string) => {
      if (repo === 'org/bad') throw new Error('corrupt');
    });
    const evictExcludedRepos = vi.fn(() => ({ untrackedOrgRows: 0, privateRows: 0, repos: 0 }));
    const metadata = new Map([
      ['org/good', { stars: 7, language: 'Go' }],
      ['org/bad', { stars: 1, language: null }],
    ]);

    applyRepoMetadata({ updateRepoScore, evictExcludedRepos }, metadata, warnings);

    expect(updateRepoScore).toHaveBeenCalledWith('org/good', { stargazersCount: 7, language: 'Go' });
    expect(evictExcludedRepos).toHaveBeenCalledWith([]);
    expect(warnings).toEqual([
      {
        phase: 'repo-scores',
        operation: 'update repo metadata',
        message: '1 of 2 metadata update(s) failed. This may indicate corrupted state.',
      },
    ]);
  });
});
