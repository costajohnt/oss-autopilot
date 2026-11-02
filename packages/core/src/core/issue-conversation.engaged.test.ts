/**
 * Tests for the engaged-issue rule in IssueConversationMonitor (#1862):
 * replies on issues the user claimed or linked from a PR, direct fetches
 * for engaged issues the comment search misses, and the cap / error paths.
 * The passing-comment (#343) tests stay in issue-conversation.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const defaultState = () => ({
  config: {
    githubUsername: 'testuser',
    excludeRepos: [] as string[],
    excludeOrgs: [] as string[],
    aiPolicyBlocklist: [] as string[],
  },
  activeIssues: [] as Array<{ repo: string; number: number; status: string }>,
});

function makeMemoryCache() {
  const store = new Map<string, { etag: string; url: string; body: unknown; cachedAt: string }>();
  const inflight = new Map<string, Promise<unknown>>();
  return {
    get: (url: string) => store.get(url) ?? null,
    set: (url: string, etag: string, body: unknown) => {
      const cachedAt = new Date();
      store.set(url, { etag, url, body, cachedAt: cachedAt.toISOString() });
    },
    getIfFresh: () => null,
    hasInflight: (url: string) => inflight.has(url),
    getInflight: (url: string) => inflight.get(url),
    setInflight: (url: string, promise: Promise<unknown>) => {
      inflight.set(url, promise);
      return () => inflight.delete(url);
    },
    store,
  };
}

/** Per-test doubles; reset by {@link resetMocks} so nothing leaks between tests. */
const mocks = {
  state: defaultState(),
  cache: makeMemoryCache(),
  octokit: undefined as any,
};

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => mocks.octokit),
}));

vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: () => mocks.state,
  })),
}));

vi.mock('./http-cache.js', async () => {
  const actual = await vi.importActual<typeof import('./http-cache.js')>('./http-cache.js');
  return {
    ...actual,
    getHttpCache: vi.fn(() => mocks.cache),
  };
});

const { IssueConversationMonitor, MAX_DIRECT_ENGAGED_FETCHES } = await import('./issue-conversation.js');
const { collectEngagedIssues } = await import('./engaged-issues.js');

const ISSUE_URL = 'https://github.com/owner/repo/issues/42';
const PR_URL = 'https://github.com/owner/repo/pull/50';
/** The PR behind the closed-PR engagement was opened here; replies after it count. */
const PR_OPENED_AT = '2026-02-01T00:00:00Z';
/** Inside the 30-day search window, so a directly fetched issue is not skipped as stale. */
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
const YESTERDAY = yesterday.toISOString();

function makeSearchItem() {
  return {
    html_url: ISSUE_URL,
    number: 42,
    title: 'Test issue',
    labels: [{ name: 'bug' }],
    pull_request: undefined,
    user: { login: 'someone-else' },
  };
}

function makeIssue(overrides: Record<string, any> = {}) {
  return {
    html_url: ISSUE_URL,
    number: 42,
    title: 'Fetched issue',
    labels: ['enhancement'],
    state: 'open',
    user: { login: 'someone-else' },
    updated_at: YESTERDAY,
    ...overrides,
  };
}

function makeComment(author: string, body: string, createdAt: string, authorAssociation = 'NONE') {
  return { body, user: { login: author }, created_at: createdAt, author_association: authorAssociation };
}

function searchReturns(items: unknown[]) {
  mocks.octokit.search.issuesAndPullRequests.mockResolvedValue({ data: { items, total_count: items.length } });
}

function commentsAre(comments: unknown[]) {
  mocks.octokit.issues.listComments.mockResolvedValue({ data: comments });
}

const emptyInput = {
  claims: [],
  openPRs: [],
  recentlyClosedPRs: [],
  recentlyMergedPRs: [],
  ledgerClosedPRs: [],
  ledgerMergedPRs: [],
};

const claimed = () => collectEngagedIssues({ ...emptyInput, claims: [{ url: ISSUE_URL, updatedAt: PR_OPENED_AT }] });

const linkedFromClosedPR = () =>
  collectEngagedIssues({
    ...emptyInput,
    recentlyClosedPRs: [{ url: PR_URL, issueUrl: ISSUE_URL, openedAt: PR_OPENED_AT, closedAt: '2026-02-10T00:00:00Z' }],
  });

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function resetMocks() {
  mocks.state = defaultState();
  mocks.cache = makeMemoryCache();
  mocks.octokit = {
    search: { issuesAndPullRequests: vi.fn().mockResolvedValue({ data: { items: [], total_count: 0 } }) },
    issues: {
      listComments: vi.fn().mockResolvedValue({ data: [] }),
      get: vi.fn().mockResolvedValue({ data: makeIssue() }),
    },
  };
}

describe('IssueConversationMonitor — reply rule on engaged issues (#1862)', () => {
  beforeEach(resetMocks);

  it('surfaces a non-maintainer reply without an @mention on a claimed issue, labelled with the engagement', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'Happy to implement this; I would add a flag.', '2026-02-02T10:00:00Z'),
      makeComment(
        'community-member',
        'Thanks for wanting to work on this feature! I think a flag is the wrong shape, it should be a config key.',
        '2026-03-20T10:00:00Z',
      ),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures } = await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(failures).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      status: 'new_response',
      lastResponseAuthor: 'community-member',
      isFromMaintainer: false,
      engagement: { reason: 'claim', since: PR_OPENED_AT },
    });
  });

  it('keeps the #343 filter on the same thread when the issue is not engaged', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'Happy to implement this; I would add a flag.', '2026-02-02T10:00:00Z'),
      makeComment(
        'community-member',
        'I think a flag is the wrong shape, it should be a config key.',
        '2026-03-20T10:00:00Z',
      ),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].status).not.toBe('new_response');
    expect(issues[0].engagement).toBeUndefined();
  });

  it('ignores "+1", emoji-only and short thanks on an engaged issue', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'I can take this.', '2026-02-02T10:00:00Z'),
      makeComment('a', '+1', '2026-02-03T10:00:00Z'),
      makeComment('b', '👍', '2026-02-04T10:00:00Z'),
      makeComment('c', 'Same here', '2026-02-05T10:00:00Z'),
      makeComment('d', 'Thanks for picking this up!', '2026-02-06T10:00:00Z'),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(issues).toHaveLength(1);
    expect(issues[0].status).not.toBe('new_response');
  });

  it('surfaces a quote reply from a community member on an issue the user only commented on', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'The root cause is the cache key missing the locale segment.', '2026-02-02T10:00:00Z'),
      makeComment(
        'community-member',
        '> the cache key missing the locale segment\n\nConfirmed, this probe reproduces it on 3.2.0:\n```\ncurl ...\n```',
        '2026-02-05T10:00:00Z',
      ),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ status: 'new_response', lastResponseAuthor: 'community-member' });
  });

  it('does not surface a reply the engagement step already answered (posted before the PR opened)', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'I will take this.', '2026-01-10T10:00:00Z'),
      makeComment('maintainer', 'Please keep the default behaviour.', '2026-01-12T10:00:00Z', 'MEMBER'),
    ]);

    const monitor = new IssueConversationMonitor('token');
    // The PR opened after the maintainer's note: the PR is the answer.
    const { issues } = await monitor.fetchCommentedIssues({ engaged: linkedFromClosedPR() });

    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe('acknowledged');
    expect(issues[0].engagement).toMatchObject({ reason: 'closed_pr', prUrl: PR_URL });
  });
});

describe('IssueConversationMonitor — direct fetch of engaged issues missing from the search (#1862)', () => {
  beforeEach(resetMocks);

  it('fetches an issue linked only from a closed PR, with no user comment, and surfaces a later reply', async () => {
    commentsAre([
      makeComment('someone-else', 'Original report details', '2026-01-01T10:00:00Z'),
      makeComment(
        'community-member',
        'Thanks for wanting to work on this feature! I would rather see a config key than a flag, so that the setting survives restarts and can be managed by the admin UI too.',
        '2026-03-20T10:00:00Z',
      ),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures, warnings } = await monitor.fetchCommentedIssues({ engaged: linkedFromClosedPR() });

    expect(mocks.octokit.issues.get).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'owner', repo: 'repo', issue_number: 42 }),
    );
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      url: ISSUE_URL,
      title: 'Fetched issue',
      labels: ['enhancement'],
      status: 'new_response',
      lastResponseAuthor: 'community-member',
      userLastCommentedAt: PR_OPENED_AT,
      userLastCommentBody: '',
      engagement: { reason: 'closed_pr', prUrl: PR_URL, since: PR_OPENED_AT },
    });
  });

  it('lists nothing for a fetched issue with no reply after the engagement, and records no failure', async () => {
    commentsAre([makeComment('a', '+1', '2026-02-03T10:00:00Z')]);

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures } = await monitor.fetchCommentedIssues({ engaged: linkedFromClosedPR() });

    expect(issues).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('does not fetch an engaged issue the search already returned', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([makeComment('testuser', 'On it.', '2026-02-02T10:00:00Z')]);

    const monitor = new IssueConversationMonitor('token');
    await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(mocks.octokit.issues.get).not.toHaveBeenCalled();
  });

  it('does not fetch ledger-only links; they count only when the search finds the issue', async () => {
    const engaged = collectEngagedIssues({
      ...emptyInput,
      ledgerClosedPRs: [{ url: PR_URL, issueUrl: ISSUE_URL, closedAt: '2025-02-10T00:00:00Z' }],
    });

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged });

    expect(mocks.octokit.issues.get).not.toHaveBeenCalled();
    expect(issues).toEqual([]);
  });

  it.each([
    ['a pull request number', makeIssue({ pull_request: { url: 'x' } })],
    ['a closed issue', makeIssue({ state: 'closed' })],
    ['an issue the user authored', makeIssue({ user: { login: 'TestUser' } })],
    ['an issue not updated inside the search window', makeIssue({ updated_at: '2020-01-01T00:00:00Z' })],
  ])('skips %s without fetching its comments', async (_label, issue) => {
    mocks.octokit.issues.get.mockResolvedValue({ data: issue });
    commentsAre([makeComment('community-member', 'A long substantive reply about the design.', YESTERDAY)]);

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures } = await monitor.fetchCommentedIssues({ engaged: linkedFromClosedPR() });

    expect(mocks.octokit.issues.listComments).not.toHaveBeenCalled();
    expect(issues).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('applies the repo exclusions to direct fetches', async () => {
    mocks.state.config.excludeRepos = ['owner/repo'];

    const monitor = new IssueConversationMonitor('token');
    await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(mocks.octokit.issues.get).not.toHaveBeenCalled();
  });

  it('caps direct fetches, keeps the strongest engagements, and warns', async () => {
    const total = MAX_DIRECT_ENGAGED_FETCHES + 2;
    const engaged = collectEngagedIssues({
      ...emptyInput,
      claims: Array.from({ length: total }, (_, i) => ({
        url: `https://github.com/owner/repo/issues/${100 + i}`,
        updatedAt: PR_OPENED_AT,
      })),
      openPRs: [{ url: PR_URL, issueUrl: 'https://github.com/owner/repo/issues/7', createdAt: PR_OPENED_AT }],
    });
    mocks.octokit.issues.get.mockImplementation(({ issue_number }: { issue_number: number }) =>
      Promise.resolve({
        data: makeIssue({ number: issue_number, html_url: `https://github.com/owner/repo/issues/${issue_number}` }),
      }),
    );

    const monitor = new IssueConversationMonitor('token');
    const { warnings } = await monitor.fetchCommentedIssues({ engaged });

    const fetched = mocks.octokit.issues.get.mock.calls.map((c: any[]) => c[0].issue_number as number);
    expect(fetched).toHaveLength(MAX_DIRECT_ENGAGED_FETCHES);
    expect(fetched[0]).toBe(7); // the open-PR issue comes first
    expect(warnings).toEqual([
      expect.stringContaining(`${total + 1} engaged issues were missing from the comment search`),
    ]);
    expect(warnings[0]).toContain(`only the first ${MAX_DIRECT_ENGAGED_FETCHES}`);
  });

  it('drops an issue that is gone (404/410) with a warning naming the status, not a failure', async () => {
    mocks.octokit.issues.get.mockRejectedValue(httpError(404, 'Not Found'));

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures, warnings } = await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(issues).toEqual([]);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([`${ISSUE_URL}: issue no longer reachable (HTTP 404: Not Found); dropped`]);
  });

  it('records other per-issue errors with their HTTP status and continues', async () => {
    const other = 'https://github.com/owner/repo/issues/43';
    const engaged = collectEngagedIssues({
      ...emptyInput,
      claims: [
        { url: ISSUE_URL, updatedAt: PR_OPENED_AT },
        { url: other, updatedAt: PR_OPENED_AT },
      ],
    });
    mocks.octokit.issues.get.mockImplementation(({ issue_number }: { issue_number: number }) =>
      issue_number === 42
        ? Promise.reject(httpError(500, 'Server Error'))
        : Promise.resolve({ data: makeIssue({ number: 43, html_url: other }) }),
    );
    commentsAre([makeComment('community-member', 'A substantive reply about the approach here.', YESTERDAY)]);

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures } = await monitor.fetchCommentedIssues({ engaged });

    expect(failures).toEqual([{ issueUrl: ISSUE_URL, error: 'HTTP 500: Server Error' }]);
    expect(issues.map((i) => i.url)).toEqual([other]);
  });

  it('rejects on a rate limit from a direct fetch instead of degrading to fewer results', async () => {
    mocks.octokit.issues.get.mockRejectedValue(httpError(429, 'API rate limit exceeded'));

    const monitor = new IssueConversationMonitor('token');
    await expect(monitor.fetchCommentedIssues({ engaged: claimed() })).rejects.toThrow('rate limit');
  });
});
