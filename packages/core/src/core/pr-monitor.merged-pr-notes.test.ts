/**
 * PRMonitor.fetchMergedPRActivity (#1861). Kept out of pr-monitor.test.ts,
 * which sits past the file-size lint ceiling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Octokit stub; `beforeEach` refills it so tests can swap single endpoints. */
const mockOctokitInstance: { issues: Record<string, any>; pulls: Record<string, any> } = { issues: {}, pulls: {} };

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => mockOctokitInstance),
}));

vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: () => ({ config: { githubUsername: 'testuser' } }),
  })),
}));

const { PRMonitor } = await import('./pr-monitor.js');

const PR_URL = 'https://github.com/owner/repo/pull/42';

/** A list endpoint stub returning `pageData` in order (each a full or partial page). */
function pages<T>(...pageData: T[][]) {
  const fn = vi.fn();
  for (const data of pageData) fn.mockResolvedValueOnce({ data });
  return fn;
}

beforeEach(() => {
  mockOctokitInstance.issues = { listComments: pages([{ id: 1 }]) };
  mockOctokitInstance.pulls = {
    listReviews: pages([{ id: 2 }]),
    listReviewComments: pages([{ id: 3 }]),
    listCommits: pages([{ sha: 'abc' }]),
  };
});

describe('PRMonitor fetchMergedPRActivity (#1861)', () => {
  it('fetches comments, reviews, inline review comments and commits for the PR', async () => {
    const monitor = new PRMonitor('fake-token');
    const activity = await monitor.fetchMergedPRActivity(PR_URL);
    expect(activity).toEqual({
      comments: [{ id: 1 }],
      reviews: [{ id: 2 }],
      reviewComments: [{ id: 3 }],
      commits: [{ sha: 'abc' }],
      truncatedLists: [],
    });
    const base = { owner: 'owner', repo: 'repo', per_page: 100, page: 1 };
    expect(mockOctokitInstance.issues.listComments).toHaveBeenCalledWith({ ...base, issue_number: 42 });
    expect(mockOctokitInstance.pulls.listReviews).toHaveBeenCalledWith({ ...base, pull_number: 42 });
    expect(mockOctokitInstance.pulls.listReviewComments).toHaveBeenCalledWith({ ...base, pull_number: 42 });
    expect(mockOctokitInstance.pulls.listCommits).toHaveBeenCalledWith({ ...base, pull_number: 42 });
  });

  it('paginates each list and names the lists that hit the page cap', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    mockOctokitInstance.issues.listComments = pages(fullPage, [{ id: 100 }]);
    // 10 full pages: the cap.
    const tenFullPages = Array.from({ length: 10 }, () => fullPage);
    mockOctokitInstance.pulls.listCommits = pages(...tenFullPages);
    mockOctokitInstance.pulls.listReviewComments = pages(...tenFullPages);
    const monitor = new PRMonitor('fake-token');
    const activity = await monitor.fetchMergedPRActivity(PR_URL);
    expect(activity.comments).toHaveLength(101);
    expect(mockOctokitInstance.issues.listComments).toHaveBeenCalledTimes(2);
    expect(activity.commits).toHaveLength(1000);
    expect(activity.truncatedLists).toEqual(['review comments', 'commits']);
  });

  it('rejects non-PR URLs without calling the API and lets API errors through unchanged', async () => {
    const monitor = new PRMonitor('fake-token');
    await expect(monitor.fetchMergedPRActivity('https://github.com/owner/repo/issues/42')).rejects.toThrow(
      'Invalid PR URL',
    );
    expect(mockOctokitInstance.issues.listComments).not.toHaveBeenCalled();

    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    mockOctokitInstance.pulls.listReviews = vi.fn().mockRejectedValue(notFound);
    await expect(monitor.fetchMergedPRActivity(PR_URL)).rejects.toMatchObject({ status: 404 });
  });

  it('waits for all four calls and rethrows a rate-limit error ahead of an earlier 404', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    const rateLimited = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    // The 404 rejects first; the rate limit arrives from a later call.
    mockOctokitInstance.issues.listComments = vi.fn().mockRejectedValue(notFound);
    mockOctokitInstance.pulls.listCommits = vi.fn(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(rateLimited), 5)),
    );
    const monitor = new PRMonitor('fake-token');
    await expect(monitor.fetchMergedPRActivity(PR_URL)).rejects.toBe(rateLimited);
    expect(mockOctokitInstance.pulls.listReviews).toHaveBeenCalledTimes(1);
    expect(mockOctokitInstance.pulls.listReviewComments).toHaveBeenCalledTimes(1);
  });

  it('rethrows the first rejection when none is a rate-limit or auth error', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    const badGateway = Object.assign(new Error('Bad Gateway'), { status: 502 });
    mockOctokitInstance.pulls.listReviews = vi.fn().mockRejectedValue(notFound);
    mockOctokitInstance.pulls.listCommits = vi.fn().mockRejectedValue(badGateway);
    const monitor = new PRMonitor('fake-token');
    await expect(monitor.fetchMergedPRActivity(PR_URL)).rejects.toBe(notFound);
  });
});
