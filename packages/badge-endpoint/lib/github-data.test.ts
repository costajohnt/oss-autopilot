import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchContributionData, type ContributionData } from './github-data.js';

// Hoist shared mock references so they're available inside vi.mock factory
const { searchMock, pullsMock } = vi.hoisted(() => {
  const searchMock = vi.fn();
  const pullsMock = vi.fn();
  return { searchMock, pullsMock };
});

// Mock @octokit/rest using a regular function (not arrow) so `new Octokit()` works
vi.mock('@octokit/rest', () => {
  return {
    Octokit: vi.fn(function (this: any) {
      this.rest = {
        search: { issuesAndPullRequests: searchMock },
        pulls: { get: pullsMock },
      };
    }),
  };
});

describe('fetchContributionData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns contribution stats for a valid user', async () => {
    // Mock merged PRs query
    searchMock.mockResolvedValueOnce({
      data: {
        total_count: 42,
        items: [
          {
            number: 1,
            title: 'Fix bug',
            html_url: 'https://github.com/org/repo/pull/1',
            repository_url: 'https://api.github.com/repos/org/repo',
            closed_at: '2026-03-01T00:00:00Z',
            pull_request: { merged_at: '2026-03-01T00:00:00Z' },
          },
          {
            number: 2,
            title: 'Add feature',
            html_url: 'https://github.com/org/repo2/pull/2',
            repository_url: 'https://api.github.com/repos/org/repo2',
            closed_at: '2026-02-15T00:00:00Z',
            pull_request: { merged_at: '2026-02-15T00:00:00Z' },
          },
        ],
      },
    });
    // Mock open PRs query
    searchMock.mockResolvedValueOnce({ data: { total_count: 3, items: [] } });
    // Mock closed-unmerged PRs query
    searchMock.mockResolvedValueOnce({ data: { total_count: 5, items: [] } });

    const result = await fetchContributionData('testuser', 'fake-token');

    expect(result.merged).toBe(42);
    expect(result.open).toBe(3);
    expect(result.closedUnmerged).toBe(5);
    expect(result.mergeRate).toBeCloseTo(84, 0); // 42 / (42 + 3 + 5)
    expect(result.repoCount).toBe(2);
    expect(result.recentPRs).toHaveLength(2);
    expect(result.recentPRs[0].title).toBe('Fix bug');
    expect(result.cappedMerged).toBe(false);
  });

  it('flags capped results when total_count exceeds 1000', async () => {
    searchMock.mockResolvedValueOnce({
      data: { total_count: 1500, items: [] },
    });
    searchMock.mockResolvedValueOnce({ data: { total_count: 10, items: [] } });
    searchMock.mockResolvedValueOnce({ data: { total_count: 20, items: [] } });

    const result = await fetchContributionData('prolific-user', 'fake-token');

    expect(result.merged).toBe(1500);
    expect(result.cappedMerged).toBe(true);
  });

  it('returns error state for non-existent user', async () => {
    searchMock.mockRejectedValueOnce({ status: 422 });

    const result = await fetchContributionData('nonexistent', 'fake-token');

    expect(result.error).toBe('user_not_found');
  });

  it('returns error state on rate limit', async () => {
    searchMock.mockRejectedValueOnce({ status: 403 });

    const result = await fetchContributionData('anyuser', 'fake-token');

    expect(result.error).toBe('rate_limited');
  });

  it('paginates when user has more than 100 merged PRs', async () => {
    const items100 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `PR ${i + 1}`,
      html_url: `https://github.com/org/repo/pull/${i + 1}`,
      repository_url: 'https://api.github.com/repos/org/repo',
      closed_at: '2026-03-01T00:00:00Z',
      pull_request: { merged_at: '2026-03-01T00:00:00Z' },
    }));

    // First call: merged PRs page 1
    searchMock.mockResolvedValueOnce({
      data: { total_count: 150, items: items100 },
    });
    // Second call: merged PRs page 2 (50 more items with different repo)
    const items50 = Array.from({ length: 50 }, (_, i) => ({
      number: 100 + i + 1,
      title: `PR ${100 + i + 1}`,
      html_url: `https://github.com/org2/repo2/pull/${100 + i + 1}`,
      repository_url: 'https://api.github.com/repos/org2/repo2',
      closed_at: '2026-02-15T00:00:00Z',
      pull_request: { merged_at: '2026-02-15T00:00:00Z' },
    }));
    searchMock.mockResolvedValueOnce({
      data: { total_count: 150, items: items50 },
    });
    // Third call: open PRs
    searchMock.mockResolvedValueOnce({ data: { total_count: 5, items: [] } });
    // Fourth call: closed-unmerged PRs
    searchMock.mockResolvedValueOnce({ data: { total_count: 10, items: [] } });

    const result = await fetchContributionData('testuser', 'fake-token');

    expect(result.merged).toBe(150);
    expect(result.repoCount).toBe(2); // org/repo + org2/repo2
    expect(result.cappedMerged).toBe(false);
  });
});

describe('username validation', () => {
  it('accepts valid GitHub usernames', async () => {
    const { isValidUsername } = await import('./github-data.js');
    expect(isValidUsername('costajohnt')).toBe(true);
    expect(isValidUsername('some-user')).toBe(true);
    expect(isValidUsername('a')).toBe(true);
  });

  it('rejects invalid usernames', async () => {
    const { isValidUsername } = await import('./github-data.js');
    expect(isValidUsername('')).toBe(false);
    expect(isValidUsername('-starts-with-dash')).toBe(false);
    expect(isValidUsername('has spaces')).toBe(false);
    expect(isValidUsername('has--double-dash')).toBe(false);
    expect(isValidUsername('a'.repeat(40))).toBe(false);
  });
});
