/**
 * PRMonitor's reviewed-PR wrappers (#1857) hand the Octokit instance and
 * the config to reviewed-prs-fetch.ts. Kept out of pr-monitor.test.ts,
 * which sits past the file-size lint ceiling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOctokitInstance: { search: Record<string, any>; pulls: Record<string, any>; repos: Record<string, any> } = {
  search: {},
  pulls: {},
  repos: {},
};

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => mockOctokitInstance),
}));

vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: () => ({ config: { githubUsername: 'testuser', untrackedOrgs: [], excludeRepos: ['skip/me'] } }),
  })),
}));

const mockFetchReviewedOpenPRs = vi.fn();
const mockFetchReviewedPRActivity = vi.fn();
const mockFetchCompareStatus = vi.fn();
vi.mock('./reviewed-prs-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reviewed-prs-fetch.js')>();
  return {
    ...actual,
    fetchReviewedOpenPRs: mockFetchReviewedOpenPRs,
    fetchReviewedPRActivity: mockFetchReviewedPRActivity,
    fetchCompareStatus: mockFetchCompareStatus,
  };
});

const { PRMonitor } = await import('./pr-monitor.js');

const PR_URL = 'https://github.com/owner/repo/pull/42';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PRMonitor reviewed-PR wrappers (#1857)', () => {
  it('fetchReviewedOpenPRs passes the Octokit instance and the config', async () => {
    const result = { prs: [], warnings: [] };
    mockFetchReviewedOpenPRs.mockResolvedValue(result);
    const monitor = new PRMonitor('fake-token');
    await expect(monitor.fetchReviewedOpenPRs()).resolves.toBe(result);
    expect(mockFetchReviewedOpenPRs).toHaveBeenCalledWith(mockOctokitInstance, {
      githubUsername: 'testuser',
      untrackedOrgs: [],
      excludeRepos: ['skip/me'],
    });
  });

  it('fetchReviewedPRActivity and fetchCompareStatus pass the Octokit instance and the arguments', async () => {
    const activity = {
      pr: { headSha: 'h', state: 'open' },
      comments: [],
      reviews: [],
      reviewComments: [],
      commits: [],
    };
    mockFetchReviewedPRActivity.mockResolvedValue(activity);
    mockFetchCompareStatus.mockResolvedValue('diverged');
    const monitor = new PRMonitor('fake-token');
    await expect(monitor.fetchReviewedPRActivity(PR_URL)).resolves.toBe(activity);
    expect(mockFetchReviewedPRActivity).toHaveBeenCalledWith(mockOctokitInstance, PR_URL);
    await expect(monitor.fetchCompareStatus(PR_URL, 'aaa', 'bbb')).resolves.toBe('diverged');
    expect(mockFetchCompareStatus).toHaveBeenCalledWith(mockOctokitInstance, PR_URL, 'aaa', 'bbb');
  });
});
