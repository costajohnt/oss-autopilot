/**
 * The GitHub fetches behind the review follow-ups phase (#1857): the two
 * searches and their exclusions, the per-PR activity fetch, and the compare
 * status mapping. PRMonitor's wrappers are covered in
 * pr-monitor.reviewed-prs.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import {
  PR_COMMITS_LIST_MAX,
  REVIEWED_PR_SEARCH_MAX_PAGES,
  fetchCompareStatus,
  fetchReviewedOpenPRs,
  fetchReviewedPRActivity,
} from './reviewed-prs-fetch.js';

const USER = 'testuser';
const PR_URL = 'https://github.com/owner/repo/pull/42';

type Stub = {
  search: Record<string, any>;
  issues: Record<string, any>;
  pulls: Record<string, any>;
  repos: Record<string, any>;
};
/** Octokit stub; `beforeEach` refills each namespace so tests can swap single endpoints. */
const octokit: Stub = { search: {}, issues: {}, pulls: {}, repos: {} };

/** A list endpoint stub returning `pageData` in order (each a full or partial page). */
function pages<T>(...pageData: T[][]) {
  const fn = vi.fn();
  for (const data of pageData) fn.mockResolvedValueOnce({ data });
  return fn;
}

function searchItem(url: string, author = 'someone', extra: Record<string, unknown> = {}) {
  return {
    html_url: url,
    title: `PR at ${url}`,
    updated_at: '2026-06-02T12:00:00Z',
    user: { login: author },
    pull_request: {},
    ...extra,
  };
}

function searchResponses(byQualifier: Record<string, { total_count: number; items: unknown[] }[]>) {
  return vi.fn(({ q, page }: { q: string; page: number }) => {
    const qualifier = q.includes('reviewed-by:') ? 'reviewed-by' : 'commenter';
    const responses = byQualifier[qualifier] ?? [{ total_count: 0, items: [] }];
    return Promise.resolve({ data: responses[page - 1] ?? { total_count: responses[0].total_count, items: [] } });
  });
}

const config = {
  githubUsername: USER,
  untrackedOrgs: ['employer'],
  excludeRepos: ['Noisy/Repo'],
  excludeOrgs: ['SkipOrg'],
};

beforeEach(() => {
  octokit.search = {};
  octokit.issues = {};
  octokit.pulls = {};
  octokit.repos = {};
});

describe('fetchReviewedOpenPRs (#1857)', () => {
  it('runs both searches most recently updated first, dedupes by URL, maps each item and sorts across both searches', async () => {
    octokit.search.issuesAndPullRequests = searchResponses({
      'reviewed-by': [
        {
          total_count: 2,
          items: [
            searchItem('https://github.com/a/b/pull/1', 'someone', { updated_at: '2026-06-02T12:00:00Z' }),
            searchItem('https://github.com/a/b/pull/2', 'someone', { updated_at: '2026-06-01T12:00:00Z' }),
          ],
        },
      ],
      commenter: [
        {
          total_count: 2,
          items: [
            // A commenter-only PR updated after every reviewed-by PR sorts first.
            searchItem('https://github.com/c/d/pull/3', 'other', { updated_at: '2026-06-03T12:00:00Z' }),
            searchItem('https://github.com/a/b/pull/2', 'someone', { updated_at: '2026-06-01T12:00:00Z' }),
          ],
        },
      ],
    });
    const result = await fetchReviewedOpenPRs(octokit as unknown as Octokit, config);
    expect(result.warnings).toEqual([]);
    expect(result.prs).toEqual([
      {
        url: 'https://github.com/c/d/pull/3',
        repo: 'c/d',
        number: 3,
        title: 'PR at https://github.com/c/d/pull/3',
        author: 'other',
        updatedAt: '2026-06-03T12:00:00Z',
      },
      {
        url: 'https://github.com/a/b/pull/1',
        repo: 'a/b',
        number: 1,
        title: 'PR at https://github.com/a/b/pull/1',
        author: 'someone',
        updatedAt: '2026-06-02T12:00:00Z',
      },
      {
        url: 'https://github.com/a/b/pull/2',
        repo: 'a/b',
        number: 2,
        title: 'PR at https://github.com/a/b/pull/2',
        author: 'someone',
        updatedAt: '2026-06-01T12:00:00Z',
      },
    ]);
    expect(octokit.search.issuesAndPullRequests.mock.calls.map((call: [unknown]) => call[0])).toEqual([
      {
        q: `is:pr is:open is:public reviewed-by:${USER} -author:${USER}`,
        page: 1,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
      },
      {
        q: `is:pr is:open is:public commenter:${USER} -author:${USER}`,
        page: 1,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
      },
    ]);
  });

  it("drops the user's own PRs, own repos, untracked orgs, excluded repos and orgs, and non-PR items", async () => {
    octokit.search.issuesAndPullRequests = searchResponses({
      'reviewed-by': [
        {
          total_count: 7,
          items: [
            searchItem('https://github.com/a/b/pull/1', USER),
            searchItem(`https://github.com/${USER}/mine/pull/2`),
            searchItem('https://github.com/Employer/app/pull/3'),
            searchItem('https://github.com/noisy/repo/pull/4'),
            searchItem('https://github.com/skiporg/thing/pull/5'),
            searchItem('https://github.com/a/b/issues/6', 'someone', { pull_request: undefined }),
            searchItem('https://github.com/a/b/pull/7'),
          ],
        },
      ],
    });
    const result = await fetchReviewedOpenPRs(octokit as unknown as Octokit, config);
    expect(result.prs.map((pr) => pr.url)).toEqual(['https://github.com/a/b/pull/7']);
    expect(result.warnings).toEqual([]);
  });

  it('reads at most the page cap per search and warns once per truncated search, naming it', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => searchItem(`https://github.com/a/b/pull/${i}`));
    octokit.search.issuesAndPullRequests = searchResponses({
      'reviewed-by': Array.from({ length: REVIEWED_PR_SEARCH_MAX_PAGES + 1 }, () => ({
        total_count: 1500,
        items: fullPage,
      })),
      commenter: [{ total_count: 1, items: [searchItem('https://github.com/c/d/pull/9')] }],
    });
    const result = await fetchReviewedOpenPRs(octokit as unknown as Octokit, config);
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(REVIEWED_PR_SEARCH_MAX_PAGES + 1);
    expect(result.prs).toHaveLength(101);
    expect(result.warnings).toEqual([
      `GitHub Search API reports 1500 open PRs you reviewed (not authored), but only the ${REVIEWED_PR_SEARCH_MAX_PAGES * 100} most recently updated were read (${REVIEWED_PR_SEARCH_MAX_PAGES} page(s) of 100). Older reviewed PRs are not checked this run.`,
    ]);
  });

  it('keeps the pages read before a failed page, warns naming the search and the page, and still runs the other search', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => searchItem(`https://github.com/a/b/pull/${i}`));
    const badGateway = Object.assign(new Error('Bad Gateway'), { status: 502 });
    const responses = searchResponses({
      'reviewed-by': [{ total_count: 250, items: fullPage }],
      commenter: [{ total_count: 1, items: [searchItem('https://github.com/c/d/pull/9')] }],
    });
    octokit.search.issuesAndPullRequests = vi.fn((params: { q: string; page: number }) =>
      params.q.includes('reviewed-by:') && params.page === 2 ? Promise.reject(badGateway) : responses(params),
    );
    const result = await fetchReviewedOpenPRs(octokit as unknown as Octokit, config);
    expect(result.prs).toHaveLength(101);
    expect(result.prs.map((pr) => pr.url)).toContain('https://github.com/c/d/pull/9');
    expect(result.warnings).toEqual([
      'GitHub search for open PRs you reviewed (not authored) failed on page 2 (HTTP 502: Bad Gateway); only the 100 result(s) from the 1 page(s) before it were read this run.',
    ]);
  });

  it('returns nothing for a search whose first page fails, without a page-cap warning on top', async () => {
    const responses = searchResponses({
      commenter: [{ total_count: 1, items: [searchItem('https://github.com/c/d/pull/9')] }],
    });
    octokit.search.issuesAndPullRequests = vi.fn((params: { q: string; page: number }) =>
      params.q.includes('reviewed-by:') ? Promise.reject(new Error('socket hang up')) : responses(params),
    );
    const result = await fetchReviewedOpenPRs(octokit as unknown as Octokit, config);
    expect(result.prs.map((pr) => pr.url)).toEqual(['https://github.com/c/d/pull/9']);
    expect(result.warnings).toEqual([
      'GitHub search for open PRs you reviewed (not authored) failed on page 1 (socket hang up); only the 0 result(s) from the 0 page(s) before it were read this run.',
    ]);
  });

  it('lets a rate-limit error from a search page propagate', async () => {
    const rateLimited = Object.assign(new Error('API rate limit exceeded'), { status: 429 });
    octokit.search.issuesAndPullRequests = vi.fn().mockRejectedValue(rateLimited);
    await expect(fetchReviewedOpenPRs(octokit as unknown as Octokit, config)).rejects.toBe(rateLimited);
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
  });

  it('warns once per search when GitHub flags a page as incomplete, keeping its items', async () => {
    octokit.search.issuesAndPullRequests = searchResponses({
      'reviewed-by': [
        { total_count: 1, items: [searchItem('https://github.com/a/b/pull/1')], incomplete_results: true } as {
          total_count: number;
          items: unknown[];
        },
      ],
    });
    const result = await fetchReviewedOpenPRs(octokit as unknown as Octokit, config);
    expect(result.prs).toHaveLength(1);
    expect(result.warnings).toEqual([
      'GitHub Search API returned incomplete results for open PRs you reviewed (not authored) (the search timed out server-side); some reviewed PRs may be missing this run.',
    ]);
  });

  it('throws a ConfigurationError without searching when no username is configured', async () => {
    octokit.search.issuesAndPullRequests = vi.fn();
    await expect(fetchReviewedOpenPRs(octokit as unknown as Octokit, { githubUsername: '' })).rejects.toThrow(
      'No GitHub username configured',
    );
    expect(octokit.search.issuesAndPullRequests).not.toHaveBeenCalled();
  });
});

describe('fetchReviewedPRActivity (#1857)', () => {
  beforeEach(() => {
    octokit.pulls.get = vi.fn().mockResolvedValue({
      data: { head: { sha: 'headsha' }, state: 'open', user: { login: 'author' }, title: 'Title' },
    });
    octokit.issues.listComments = pages([{ id: 1 }]);
    octokit.pulls.listReviews = pages([{ id: 2 }]);
    octokit.pulls.listReviewComments = pages([{ id: 3 }]);
    octokit.pulls.listCommits = pages([{ sha: 'abc' }, { sha: 'headsha' }]);
  });

  it('fetches the PR plus the four paginated lists', async () => {
    const activity = await fetchReviewedPRActivity(octokit as unknown as Octokit, PR_URL);
    expect(activity).toEqual({
      pr: { headSha: 'headsha', state: 'open', author: 'author', title: 'Title' },
      comments: [{ id: 1 }],
      reviews: [{ id: 2 }],
      reviewComments: [{ id: 3 }],
      commits: [{ sha: 'abc' }, { sha: 'headsha' }],
      truncatedLists: [],
    });
    expect(octokit.pulls.get).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pull_number: 42 });
    const base = { owner: 'owner', repo: 'repo', per_page: 100, page: 1 };
    expect(octokit.issues.listComments).toHaveBeenCalledWith({ ...base, issue_number: 42 });
    expect(octokit.pulls.listReviews).toHaveBeenCalledWith({ ...base, pull_number: 42 });
    expect(octokit.pulls.listReviewComments).toHaveBeenCalledWith({ ...base, pull_number: 42 });
    expect(octokit.pulls.listCommits).toHaveBeenCalledWith({ ...base, pull_number: 42 });
  });

  it('names the lists that hit the page cap', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    octokit.pulls.listReviews = pages(...Array.from({ length: 10 }, () => fullPage));
    const activity = await fetchReviewedPRActivity(octokit as unknown as Octokit, PR_URL);
    expect(activity.truncatedLists).toEqual(['reviews']);
  });

  it("reports the commit list cut at GitHub's 250-commit cap although the last page came back short", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ sha: `c${i}` }));
    const lastPage = [...Array.from({ length: 49 }, (_, i) => ({ sha: `d${i}` })), { sha: 'headsha' }];
    octokit.pulls.listCommits = pages(fullPage, fullPage, lastPage);
    const activity = await fetchReviewedPRActivity(octokit as unknown as Octokit, PR_URL);
    expect(activity.commits).toHaveLength(PR_COMMITS_LIST_MAX);
    expect(activity.truncatedLists).toEqual(['commits']);
  });

  it('reports the commit list cut when it does not end at the PR head', async () => {
    octokit.pulls.listCommits = pages([{ sha: 'abc' }]);
    const activity = await fetchReviewedPRActivity(octokit as unknown as Octokit, PR_URL);
    expect(activity.truncatedLists).toEqual(['commits']);
  });

  it('reports an empty commit list as cut (an open PR always has its head commit)', async () => {
    octokit.pulls.listCommits = pages([]);
    const activity = await fetchReviewedPRActivity(octokit as unknown as Octokit, PR_URL);
    expect(activity.truncatedLists).toEqual(['commits']);
  });

  it('rejects non-PR URLs without calling the API and lets a 404 through unchanged', async () => {
    await expect(
      fetchReviewedPRActivity(octokit as unknown as Octokit, 'https://github.com/owner/repo/issues/42'),
    ).rejects.toThrow('Invalid PR URL');
    expect(octokit.pulls.get).not.toHaveBeenCalled();
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    octokit.pulls.get = vi.fn().mockRejectedValue(notFound);
    await expect(fetchReviewedPRActivity(octokit as unknown as Octokit, PR_URL)).rejects.toBe(notFound);
  });

  it('waits for all five calls and rethrows a rate-limit error ahead of an earlier 404', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    const rateLimited = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    octokit.pulls.get = vi.fn().mockRejectedValue(notFound);
    octokit.pulls.listCommits = vi.fn(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(rateLimited), 5)),
    );
    await expect(fetchReviewedPRActivity(octokit as unknown as Octokit, PR_URL)).rejects.toBe(rateLimited);
    expect(octokit.pulls.listReviews).toHaveBeenCalledTimes(1);
  });
});

describe('fetchCompareStatus (#1857)', () => {
  it('asks for the basehead range without commits and returns the status', async () => {
    octokit.repos.compareCommitsWithBasehead = vi.fn().mockResolvedValue({ data: { status: 'ahead', ahead_by: 2 } });
    await expect(fetchCompareStatus(octokit as unknown as Octokit, PR_URL, 'aaa', 'bbb')).resolves.toBe('ahead');
    expect(octokit.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      basehead: 'aaa...bbb',
      per_page: 1,
    });
  });

  it('maps a 404 to missing and lets other errors through', async () => {
    octokit.repos.compareCommitsWithBasehead = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    await expect(fetchCompareStatus(octokit as unknown as Octokit, PR_URL, 'gone', 'bbb')).resolves.toBe('missing');
    const rateLimited = Object.assign(new Error('API rate limit exceeded'), { status: 429 });
    octokit.repos.compareCommitsWithBasehead = vi.fn().mockRejectedValue(rateLimited);
    await expect(fetchCompareStatus(octokit as unknown as Octokit, PR_URL, 'aaa', 'bbb')).rejects.toBe(rateLimited);
    await expect(
      fetchCompareStatus(octokit as unknown as Octokit, 'https://github.com/owner/repo/issues/1', 'a', 'b'),
    ).rejects.toThrow('Invalid PR URL');
  });
});
