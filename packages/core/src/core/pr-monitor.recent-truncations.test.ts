/**
 * PRMonitor's recent-list wrappers hand the caller's `truncations` collector
 * through to the github-stats fetchers (#1928). Each side of that seam has
 * its own tests; these run a real PRMonitor over a stand-in Search API so a
 * wrapper that drops the argument fails here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RecentListTruncation } from './github-stats.js';

const mockOctokitInstance: { search: { issuesAndPullRequests: ReturnType<typeof vi.fn> } } = {
  search: { issuesAndPullRequests: vi.fn() },
};

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => mockOctokitInstance),
}));

vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: () => ({ config: { githubUsername: 'testuser' } }),
  })),
}));

const { PRMonitor } = await import('./pr-monitor.js');

const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

/** One page of a search that GitHub flagged incomplete: a partial list. */
function partialPage(mergedAt: string | null) {
  return {
    data: {
      total_count: 1,
      incomplete_results: true,
      items: [
        {
          html_url: 'https://github.com/org/repo/pull/1',
          title: 'PR 1',
          pull_request: { merged_at: mergedAt },
          closed_at: RECENT,
          created_at: RECENT,
        },
      ],
    },
  };
}

beforeEach(() => {
  mockOctokitInstance.search.issuesAndPullRequests = vi.fn();
});

describe('PRMonitor recent-list wrappers pass truncations through (#1928)', () => {
  it('fetchRecentlyMergedPRs reports a partial search to the caller', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue(partialPage(RECENT));
    const truncations: RecentListTruncation[] = [];

    const prs = await new PRMonitor('fake-token').fetchRecentlyMergedPRs(7, truncations);

    expect(prs).toHaveLength(1);
    expect(truncations).toHaveLength(1);
    expect(truncations[0].label).toBe('recently merged PR search truncated (1 of 1)');
  });

  it('fetchRecentlyClosedPRs reports a partial search to the caller', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue(partialPage(null));
    const truncations: RecentListTruncation[] = [];

    const prs = await new PRMonitor('fake-token').fetchRecentlyClosedPRs(7, truncations);

    expect(prs).toHaveLength(1);
    expect(truncations).toHaveLength(1);
    expect(truncations[0].label).toBe('recently closed PR search truncated (1 of 1)');
  });
});
