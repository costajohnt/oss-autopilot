/**
 * Commented-issue search and partial results (#1928): pagination up to the
 * cap, the truncation warning in the result, and the query exclusions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const search = vi.fn();
const listComments = vi.fn();

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => ({ search: { issuesAndPullRequests: search }, issues: { listComments } })),
}));

vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: () => ({ config: { githubUsername: 'testuser', excludeRepos: [], excludeOrgs: [] }, activeIssues: [] }),
  })),
}));

vi.mock('./http-cache.js', async () => {
  const actual = await vi.importActual<typeof import('./http-cache.js')>('./http-cache.js');
  // No ETag cache: every comment fetch goes straight to the mocked Octokit.
  const cachedRequest = async (
    _cache: unknown,
    _url: string,
    fetcher: (headers: object) => Promise<{ data: unknown }>,
  ) => {
    const { data } = await fetcher({});
    return data;
  };
  return { ...actual, cachedRequest, getHttpCache: vi.fn(() => ({})) };
});

const { IssueConversationMonitor } = await import('./issue-conversation.js');

function issueItems(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    html_url: `https://github.com/owner/repo/issues/${offset + i + 1}`,
    number: offset + i + 1,
    title: 'Issue',
    labels: [],
    user: { login: 'someone-else' },
  }));
}

function fetchCommentedIssues() {
  const monitor = new IssueConversationMonitor('token');
  return monitor.fetchCommentedIssues();
}

const PARTIAL = /^Commented-issue search is partial: read the \d+ most recently updated of \d+ result\(s\)/;

describe('fetchCommentedIssues on partial search results (#1928)', () => {
  beforeEach(() => {
    search.mockReset();
    listComments.mockReset();
    // The user commented, then a maintainer replied: every issue is a new response.
    listComments.mockResolvedValue({
      data: [
        { user: { login: 'testuser' }, body: 'Can I take this?', created_at: '2026-01-01T00:00:00Z' },
        {
          user: { login: 'maintainer' },
          body: 'Sure, go ahead with it.',
          created_at: '2026-01-02T00:00:00Z',
          author_association: 'MEMBER',
        },
      ],
    });
  });

  it('reads one page and adds no warning when it holds every result', async () => {
    search.mockResolvedValue({ data: { total_count: 2, incomplete_results: false, items: issueItems(2) } });

    const result = await fetchCommentedIssues();

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.issues).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it('reads and merges a second page when the first is full', async () => {
    search
      .mockResolvedValueOnce({ data: { total_count: 105, items: issueItems(100) } })
      .mockResolvedValueOnce({ data: { total_count: 105, items: issueItems(5, 100) } });

    const result = await fetchCommentedIssues();

    expect(search.mock.calls.map(([params]) => params.page)).toEqual([1, 2]);
    expect(result.issues).toHaveLength(105);
    expect(result.warnings).toEqual([]);
  });

  it('stops at three pages and returns a truncation warning', async () => {
    search.mockResolvedValue({ data: { total_count: 420, items: issueItems(100) } });

    const result = await fetchCommentedIssues();

    expect(search).toHaveBeenCalledTimes(3);
    expect(result.warnings).toEqual([
      'Commented-issue search is partial: read the 300 most recently updated of 420 result(s). Replies on the other issues you commented on are not checked this run.',
    ]);
  });

  it('returns the warning when GitHub flags the search incomplete', async () => {
    search.mockResolvedValue({ data: { total_count: 1, incomplete_results: true, items: issueItems(1) } });

    const result = await fetchCommentedIssues();

    expect(result.issues).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(PARTIAL);
  });

  it('excludes own repos and self-authored issues in the query', async () => {
    search.mockResolvedValue({ data: { total_count: 0, items: [] } });

    await fetchCommentedIssues();

    expect(search.mock.calls[0][0].q).toMatch(
      /^commenter:testuser type:issue state:open updated:>=\d{4}-\d{2}-\d{2} -user:testuser -author:testuser$/,
    );
  });
});
