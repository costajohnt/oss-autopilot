/**
 * --json contract test for the `comments` command (#965, #986).
 *
 * Mocks Octokit's pulls.get / listReviewComments / listReviews and
 * issues.listComments, then snapshots the full shape that agents see
 * when reviewing a PR's conversation.
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/comments.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOctokit: vi.fn(),
  requireGitHubToken: vi.fn().mockReturnValue('fake-token'),
  stateManager: {
    getState: vi.fn().mockReturnValue({ config: { githubUsername: 'testuser' } }),
    addIssue: vi.fn(),
    isGistMode: () => false,
    getStateStaleness: vi.fn().mockReturnValue(null),
  },
  // Octokit endpoints
  pullsGet: vi.fn(),
  pullsListReviewComments: vi.fn(),
  pullsListReviews: vi.fn(),
  issuesListComments: vi.fn(),
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => mocks.stateManager,
    getOctokit: mocks.getOctokit,
    requireGitHubToken: mocks.requireGitHubToken,
  };
});

// paginateAll iterates pages; in our mocks the first call returns the
// full list and the function signals "done" by returning an empty page.
vi.mock('../core/pagination.js', () => ({
  paginateAll: async (fn: (page: number) => Promise<{ data: unknown[] }>) => {
    const { data } = await fn(1);
    return data;
  },
}));

import { runComments } from './comments.js';

const PR_URL = 'https://github.com/owner/repo/pull/42';

describe('comments --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireGitHubToken.mockReturnValue('fake-token');
    mocks.stateManager.getState.mockReturnValue({ config: { githubUsername: 'testuser' } });
    mocks.getOctokit.mockReturnValue({
      pulls: {
        get: mocks.pullsGet,
        listReviewComments: mocks.pullsListReviewComments,
        listReviews: mocks.pullsListReviews,
      },
      issues: { listComments: mocks.issuesListComments },
    });
  });

  it('PR with reviews + inline + discussion comments matches the golden shape', async () => {
    mocks.pullsGet.mockResolvedValue({
      data: {
        title: 'Fix error handling in foo()',
        state: 'open',
        mergeable: true,
        head: { ref: 'feature/fix-foo' },
        base: { ref: 'main' },
        html_url: PR_URL,
      },
    });
    mocks.pullsListReviewComments.mockResolvedValue({
      data: [
        {
          user: { login: 'reviewer1', type: 'User' },
          body: 'Consider using a guard clause here',
          path: 'src/foo.ts',
          created_at: '2026-04-18T10:00:00.000Z',
        },
        {
          user: { login: 'testuser', type: 'User' }, // own comment — filtered out
          body: 'Good point, updating',
          path: 'src/foo.ts',
          created_at: '2026-04-18T11:00:00.000Z',
        },
      ],
    });
    mocks.pullsListReviews.mockResolvedValue({
      data: [
        {
          user: { login: 'reviewer1', type: 'User' },
          state: 'CHANGES_REQUESTED',
          body: 'See inline comments',
          submitted_at: '2026-04-18T10:05:00.000Z',
        },
        {
          user: { login: 'reviewer2', type: 'User' },
          state: 'APPROVED',
          body: 'LGTM after fixing the one comment',
          submitted_at: '2026-04-18T12:00:00.000Z',
        },
      ],
    });
    mocks.issuesListComments.mockResolvedValue({
      data: [
        {
          user: { login: 'maintainer', type: 'User' },
          body: 'Thanks for the PR! Could you also update the CHANGELOG?',
          created_at: '2026-04-18T09:00:00.000Z',
        },
        {
          user: { login: 'dependabot[bot]', type: 'Bot' }, // filtered by default
          body: 'Your CI check has passed',
          created_at: '2026-04-18T09:30:00.000Z',
        },
      ],
    });

    const result = await runComments({ prUrl: PR_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/comments.active.json');
  });

  it('PR with no external activity matches the golden shape', async () => {
    mocks.pullsGet.mockResolvedValue({
      data: {
        title: 'Quiet PR',
        state: 'open',
        mergeable: null,
        head: { ref: 'feature/quiet' },
        base: { ref: 'main' },
        html_url: 'https://github.com/owner/repo/pull/99',
      },
    });
    mocks.pullsListReviewComments.mockResolvedValue({ data: [] });
    mocks.pullsListReviews.mockResolvedValue({ data: [] });
    mocks.issuesListComments.mockResolvedValue({ data: [] });

    const result = await runComments({ prUrl: 'https://github.com/owner/repo/pull/99' });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/comments.empty.json');
  });
});
