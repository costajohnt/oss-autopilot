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

/** ISO stamp `n` days before now, for tests that sit relative to the search window or the ledger bound. */
function daysAgo(n: number): string {
  const stamp = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return stamp.toISOString();
}

/** A distinct, increasing stamp for synthetic comment `i` on page `page`. */
function pageStamp(page: number, i: number): string {
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, page, i));
  return stamp.toISOString();
}

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

const claimed = (updatedAt = PR_OPENED_AT) =>
  collectEngagedIssues({ ...emptyInput, claims: [{ updatedAt, url: ISSUE_URL, status: 'claimed' }] });

const linkedFromClosedPR = () =>
  collectEngagedIssues({
    ...emptyInput,
    recentlyClosedPRs: [{ url: PR_URL, issueUrl: ISSUE_URL, openedAt: PR_OPENED_AT, closedAt: '2026-02-10T00:00:00Z' }],
  });

const linkedFromOpenPR = () =>
  collectEngagedIssues({
    ...emptyInput,
    openPRs: [{ url: PR_URL, issueUrl: ISSUE_URL, createdAt: PR_OPENED_AT }],
  });

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function issueUrl(number: number): string {
  return `https://github.com/owner/repo/issues/${number}`;
}

/** `count` claims on issues 100.., stamped `updatedAt`. */
function manyClaims(count: number, updatedAt = PR_OPENED_AT) {
  return Array.from({ length: count }, (_, i) => ({
    updatedAt,
    url: issueUrl(100 + i),
    status: 'claimed' as const,
  }));
}

/** An issue node as the batched lookup returns it. */
function makeNode(overrides: Record<string, any> = {}) {
  return {
    __typename: 'Issue',
    url: ISSUE_URL,
    number: 42,
    title: 'Fetched issue',
    state: 'OPEN',
    updatedAt: YESTERDAY,
    author: { login: 'someone-else' },
    labels: { nodes: [{ name: 'enhancement' }] },
    ...overrides,
  };
}

/** An open node for issue `number`, updated at `updatedAt`. */
function openNode(number: number, updatedAt = YESTERDAY) {
  return makeNode({ number, updatedAt, url: issueUrl(number) });
}

/** The `[alias index, issue number]` pairs one lookup query asked about, from its variables. */
function numbersIn(vars: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(vars)
    .filter(([name]) => name.startsWith('n'))
    .map(([name, value]) => [name.slice(1), value as number]);
}

/** The aliased response for one query: `nodeFor(number)` under `i<alias>`. */
function lookupData(vars: Record<string, unknown>, nodeFor: (number: number) => unknown) {
  const data: Record<string, unknown> = {};
  for (const [alias, number] of numbersIn(vars)) data[`i${alias}`] = { issueOrPullRequest: nodeFor(number) };
  return data;
}

/** Resolve every lookup query with `nodeFor(number)` per alias; by default an open issue of that number, updated yesterday. */
function lookupReturns(nodeFor: (number: number) => unknown = (n) => openNode(n)) {
  mocks.octokit.graphql.mockImplementation((_query: string, vars: Record<string, unknown>) =>
    Promise.resolve(lookupData(vars, nodeFor)),
  );
}

/** Reject every lookup query the way octokit does on a partial response: the resolved aliases on `.data`, `errors` attached. */
function lookupPartiallyFails(nodeFor: (number: number) => unknown, errors: unknown[]) {
  mocks.octokit.graphql.mockImplementation((_query: string, vars: Record<string, unknown>) =>
    Promise.reject(Object.assign(new Error('partial response'), { data: lookupData(vars, nodeFor), errors })),
  );
}

/** Every issue number the lookup queries asked about, in query order. */
function lookedUpNumbers(): number[] {
  return mocks.octokit.graphql.mock.calls.flatMap((c: any[]) => numbersIn(c[1]).map(([, n]) => n));
}

/** The issues whose comments were read, in request order, without page repeats. */
function commentFetchedNumbers(): number[] {
  const numbers = mocks.octokit.issues.listComments.mock.calls.map((c: any[]) => c[0].issue_number as number);
  return [...new Set<number>(numbers)];
}

/** One substantive community reply from yesterday on every issue whose comments are read. */
function replyYesterday() {
  commentsAre([makeComment('community-member', 'A long substantive reply about the design here.', YESTERDAY)]);
}

/** Update time for the cap-ordering tests: issue 7 is the stalest, claims get fresher with their number. */
function stalenessOf(number: number): string {
  return number === 7 ? daysAgo(9.5) : daysAgo(9 - (number - 100) * 0.05);
}

function resetMocks() {
  mocks.state = defaultState();
  mocks.cache = makeMemoryCache();
  mocks.octokit = {
    search: { issuesAndPullRequests: vi.fn().mockResolvedValue({ data: { items: [], total_count: 0 } }) },
    issues: { listComments: vi.fn().mockResolvedValue({ data: [] }) },
    graphql: vi.fn(),
  };
  lookupReturns();
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

describe('IssueConversationMonitor — engaged reply rule: baselines, nudges and noise (#1862)', () => {
  beforeEach(resetMocks);

  it('treats a claim stamped after a maintainer reply as the answer to it (acknowledged)', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'Is anyone on this?', '2026-01-10T10:00:00Z'),
      makeComment('maintainer', 'Nobody yet, feel free.', '2026-01-20T10:00:00Z', 'MEMBER'),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged: claimed('2026-02-01T00:00:00Z') });

    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe('acknowledged');
  });

  it('surfaces a maintainer "Any update?" on an engaged issue: directed at the user even though it is short', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'Picking this up, PR incoming.', '2026-02-02T10:00:00Z'),
      makeComment('maintainer', 'Any update?', '2026-03-20T10:00:00Z', 'MEMBER'),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged: linkedFromOpenPR() });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      status: 'new_response',
      lastResponseAuthor: 'maintainer',
      isFromMaintainer: true,
    });
  });

  it('surfaces anyone\'s "any update?" on a claimed issue: it asks the claimant', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'I can take this.', '2026-02-02T10:00:00Z'),
      makeComment('community-member', 'any update? 🙏', '2026-03-20T10:00:00Z'),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ status: 'new_response', lastResponseAuthor: 'community-member' });
  });

  it('surfaces a community "any update?" on an issue that is claimed and has an open PR: the claimant is still asked', async () => {
    // The open PR outranks the claim as the engagement reason; the nudge rule
    // must key on the claim itself, not on the reason that won.
    const engaged = collectEngagedIssues({
      ...emptyInput,
      claims: [{ url: ISSUE_URL, updatedAt: '2026-01-20T00:00:00Z', status: 'claimed' }],
      openPRs: [{ url: PR_URL, issueUrl: ISSUE_URL, createdAt: PR_OPENED_AT }],
    });
    expect(engaged.get('owner/repo#42')).toMatchObject({ reason: 'open_pr', claimed: true });
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'I can take this.', '2026-01-20T10:00:00Z'),
      makeComment('community-member', 'Any update on this?', '2026-03-20T10:00:00Z'),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      status: 'new_response',
      lastResponseAuthor: 'community-member',
      engagement: { reason: 'open_pr', prUrl: PR_URL, since: PR_OPENED_AT },
    });
    // The digest projection stays as it was: `claimed` is internal to the monitor.
    expect(issues[0].engagement).not.toHaveProperty('claimed');
  });

  it('keeps a community "any update?" out on an issue the user has an open PR for: the PR is the update', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'PR is up.', '2026-02-02T10:00:00Z'),
      makeComment('community-member', 'Any update?', '2026-03-20T10:00:00Z'),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged: linkedFromOpenPR() });

    expect(issues).toHaveLength(1);
    expect(issues[0].status).not.toBe('new_response');
  });

  it('ignores bot comments on an engaged issue however long they are', async () => {
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'I can take this.', '2026-02-02T10:00:00Z'),
      makeComment(
        'github-actions[bot]',
        'This issue has been automatically marked as stale because it has not had recent activity. It will be closed in 7 days.',
        '2026-03-20T10:00:00Z',
      ),
      makeComment(
        'renovate',
        'A dependency this issue depends on was updated to 4.1.0; see the changelog.',
        '2026-03-21T10:00:00Z',
      ),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe('acknowledged');
  });

  it('does not treat an issue a PR merely mentions as engaged, so an earlier maintainer reply still surfaces', async () => {
    // The user asked on #42 in January and a maintainer answered. In February
    // the user opened an unrelated PR whose body says "similar to #42". A
    // mention used to count as engagement dated from the PR, which hid the
    // January reply as "already answered by the PR".
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'Is the cache key supposed to include the locale?', '2026-01-10T10:00:00Z'),
      makeComment('maintainer', 'Yes, that is a bug; a fix would be welcome.', '2026-01-12T10:00:00Z', 'MEMBER'),
    ]);
    const unrelatedPR = {
      url: 'https://github.com/owner/repo/pull/60',
      issueUrl: 'https://github.com/owner/repo/issues/61',
      mentionedIssueUrls: [ISSUE_URL],
      createdAt: PR_OPENED_AT,
    };
    const engaged = collectEngagedIssues({ ...emptyInput, openPRs: [unrelatedPR] });
    expect(engaged.has('owner/repo#42')).toBe(false);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged });

    const reply = issues.find((i) => i.url === ISSUE_URL);
    expect(reply).toMatchObject({ status: 'new_response', lastResponseAuthor: 'maintainer' });
    expect(reply?.engagement).toBeUndefined();
  });

  it("falls back to the user's last comment as the baseline when a ledger link has no opening time", async () => {
    // Merged 20 days ago, inside the ledger bound, but with no openedAt. The
    // merge time is not when the user engaged: a reply from 25 days ago, after
    // the user's comment, must not read as answered by a merge that came later.
    const engaged = collectEngagedIssues({
      ...emptyInput,
      ledgerMergedPRs: [{ url: PR_URL, issueUrl: ISSUE_URL, mergedAt: daysAgo(20) }],
    });
    const userCommentedAt = daysAgo(30);
    searchReturns([makeSearchItem()]);
    commentsAre([
      makeComment('testuser', 'Fix is up in the PR, closing keyword included.', userCommentedAt),
      makeComment(
        'community-member',
        'The fix in the PR misses the CLI path; the same cache key is built in cli/render.ts too.',
        daysAgo(25),
      ),
    ]);

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      status: 'new_response',
      lastResponseAuthor: 'community-member',
      userLastCommentedAt: userCommentedAt,
      engagement: { reason: 'merged_pr', prUrl: PR_URL },
    });
    expect(issues[0].engagement).not.toHaveProperty('since');
  });

  it('warns, naming the issue, when its comment thread hit the pagination cap, and still returns it', async () => {
    searchReturns([makeSearchItem()]);
    // Every page full: the cap drops the newest comments.
    mocks.octokit.issues.listComments.mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({
        data: Array.from({ length: 100 }, (_, i) =>
          makeComment(
            i === 0 && page === 1 ? 'testuser' : `commenter-${page}-${i}`,
            'A long, substantive comment that definitely says something about the design.',
            pageStamp(page, i),
          ),
        ),
      }),
    );

    const monitor = new IssueConversationMonitor('token');
    const { issues, warnings } = await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(issues).toHaveLength(1);
    expect(warnings).toEqual([expect.stringContaining(`${ISSUE_URL}: comment thread longer than the pagination cap`)]);
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
    const { issues, failures, warnings } = await monitor.fetchCommentedIssues({
      engaged: linkedFromClosedPR(),
    });

    expect(mocks.octokit.graphql).toHaveBeenCalledTimes(1);
    expect(mocks.octokit.graphql.mock.calls[0][1]).toEqual({ o0: 'owner', r0: 'repo', n0: 42 });
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

    expect(mocks.octokit.graphql).not.toHaveBeenCalled();
  });

  it('does not fetch ledger-only links; they count only when the search finds the issue', async () => {
    const engaged = collectEngagedIssues({
      ...emptyInput,
      ledgerClosedPRs: [{ url: PR_URL, issueUrl: ISSUE_URL, closedAt: '2025-02-10T00:00:00Z' }],
    });

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged });

    expect(mocks.octokit.graphql).not.toHaveBeenCalled();
    expect(issues).toEqual([]);
  });

  it('reads a transferred issue where GitHub now has it, not where the engagement pointed', async () => {
    // The claim names owner/repo#42; the lookup follows the transfer and
    // returns the issue at its new home, with a new number.
    const movedUrl = 'https://github.com/new-org/new-repo/issues/7';
    lookupReturns(() => makeNode({ url: movedUrl, number: 7 }));
    replyYesterday();

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures, warnings } = await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(mocks.octokit.graphql.mock.calls[0][1]).toEqual({ o0: 'owner', r0: 'repo', n0: 42 });
    expect(mocks.octokit.issues.listComments).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'new-org', repo: 'new-repo', issue_number: 7 }),
    );
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      url: movedUrl,
      repo: 'new-org/new-repo',
      number: 7,
      status: 'new_response',
      engagement: { reason: 'claim' },
    });
  });

  it.each([
    ['a pull request number', { __typename: 'PullRequest' }],
    ['a closed issue', makeNode({ state: 'CLOSED' })],
    ['an issue the user authored', makeNode({ author: { login: 'TestUser' } })],
    ['an issue not updated inside the search window', makeNode({ updatedAt: '2020-01-01T00:00:00Z' })],
  ])('skips %s without fetching its comments', async (_label, node) => {
    lookupReturns(() => node);
    replyYesterday();

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures } = await monitor.fetchCommentedIssues({ engaged: linkedFromClosedPR() });

    expect(mocks.octokit.issues.listComments).not.toHaveBeenCalled();
    expect(issues).toEqual([]);
    expect(failures).toEqual([]);
  });
});

describe('IssueConversationMonitor — direct fetch: exclusions, the batched lookup and the comment-fetch cap (#1862)', () => {
  beforeEach(resetMocks);

  it('applies the repo exclusions to direct fetches', async () => {
    mocks.state.config.excludeRepos = ['owner/repo'];

    const monitor = new IssueConversationMonitor('token');
    await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(mocks.octokit.graphql).not.toHaveBeenCalled();
  });

  it("does not fetch a claimed issue in the user's own repo", async () => {
    const engaged = collectEngagedIssues({
      ...emptyInput,
      claims: [{ url: 'https://github.com/TestUser/own-project/issues/3', updatedAt: PR_OPENED_AT, status: 'claimed' }],
    });

    const monitor = new IssueConversationMonitor('token');
    const { issues, warnings } = await monitor.fetchCommentedIssues({ engaged });

    expect(mocks.octokit.graphql).not.toHaveBeenCalled();
    expect(issues).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('skips an issue not touched since the claim, even inside the search window, without reading its comments', async () => {
    // Claimed two days ago; the issue last changed five days ago. Nothing on
    // it can be a reply to the claim, so the comment pages are not fetched.
    lookupReturns(() => makeNode({ updatedAt: daysAgo(5) }));

    const monitor = new IssueConversationMonitor('token');
    const { issues } = await monitor.fetchCommentedIssues({ engaged: claimed(daysAgo(2)) });

    expect(mocks.octokit.issues.listComments).not.toHaveBeenCalled();
    expect(issues).toEqual([]);
  });

  it('looks up 60 missing engaged issues in two queries and reads comments only for the ones updated since the claim', async () => {
    const claims = manyClaims(60, daysAgo(10));
    const numbers = claims.map((_, i) => 100 + i);
    // 20 of the 60 changed after the claim; the rest were last touched before it.
    const updated = numbers.filter((n) => n % 3 === 0);
    lookupReturns((n) => openNode(n, updated.includes(n) ? YESTERDAY : daysAgo(20)));
    replyYesterday();

    const monitor = new IssueConversationMonitor('token');
    const { issues, warnings } = await monitor.fetchCommentedIssues({
      engaged: collectEngagedIssues({ ...emptyInput, claims }),
    });

    expect(mocks.octokit.graphql).toHaveBeenCalledTimes(2);
    const chunkSizes = mocks.octokit.graphql.mock.calls.map((c: any[]) => numbersIn(c[1]).length);
    expect(chunkSizes).toEqual([50, 10]);
    expect(lookedUpNumbers()).toEqual(numbers);
    const read = commentFetchedNumbers();
    read.sort((a, b) => a - b);
    expect(read).toEqual(updated);
    expect(issues).toHaveLength(updated.length);
    expect(warnings).toEqual([]);
  });

  it('when more than the cap have new activity, reads the most recently updated and warns naming the rest, whatever their engagement rank', async () => {
    // Issue 7 is the open-PR issue: strongest engagement, first in the map,
    // and the stalest. Under the old insertion-order cap it was always read
    // and the last claims never were.
    const engaged = collectEngagedIssues({
      ...emptyInput,
      claims: manyClaims(MAX_DIRECT_ENGAGED_FETCHES + 5, daysAgo(10)),
      openPRs: [{ url: PR_URL, issueUrl: issueUrl(7), createdAt: daysAgo(10) }],
    });
    lookupReturns((n) => openNode(n, stalenessOf(n)));
    replyYesterday();

    const monitor = new IssueConversationMonitor('token');
    const { warnings, failures, lookupFailures } = await monitor.fetchCommentedIssues({ engaged });

    expect(lookedUpNumbers()).toHaveLength(MAX_DIRECT_ENGAGED_FETCHES + 6);
    const read = commentFetchedNumbers();
    expect(read).toHaveLength(MAX_DIRECT_ENGAGED_FETCHES);
    const deferred = [7, 100, 101, 102, 103, 104];
    for (const n of deferred) expect(read).not.toContain(n);
    // A real warning, not a notice: this many busy engaged issues means the
    // deferred ones can wait indefinitely, and the user should know which.
    expect(failures).toEqual([]);
    expect(lookupFailures).toBe(0);
    expect(warnings).toEqual([expect.stringContaining('6 engaged issues with new activity were not scanned this run')]);
    expect(warnings[0]).toContain(`cap of ${MAX_DIRECT_ENGAGED_FETCHES} comment fetches`);
    for (const n of deferred) expect(warnings[0]).toContain(issueUrl(n));
  });

  it('reads exactly the cap without a warning when that many have new activity', async () => {
    const engaged = collectEngagedIssues({
      ...emptyInput,
      claims: manyClaims(MAX_DIRECT_ENGAGED_FETCHES, daysAgo(10)),
    });
    replyYesterday();

    const monitor = new IssueConversationMonitor('token');
    const { warnings } = await monitor.fetchCommentedIssues({ engaged });

    expect(commentFetchedNumbers()).toHaveLength(MAX_DIRECT_ENGAGED_FETCHES);
    expect(warnings).toEqual([]);
  });

  it('moves an issue the cap deferred to the front once it is updated again', async () => {
    const claims = manyClaims(MAX_DIRECT_ENGAGED_FETCHES + 1, daysAgo(10));
    const engaged = collectEngagedIssues({ ...emptyInput, claims });
    // One more active issue than the cap, 100 the stalest: deferred on the first run.
    const freshness = new Map<number, string>();
    for (const [i] of claims.entries()) freshness.set(100 + i, daysAgo(9 - i * 0.05));
    lookupReturns((n) => openNode(n, freshness.get(n)));
    replyYesterday();
    const monitor = new IssueConversationMonitor('token');

    const first = await monitor.fetchCommentedIssues({ engaged });
    expect(commentFetchedNumbers()).not.toContain(100);
    expect(first.warnings).toEqual([expect.stringContaining(issueUrl(100))]);

    // A new comment lands on 100: now the freshest of them all.
    freshness.set(100, YESTERDAY);
    mocks.octokit.issues.listComments.mockClear();
    const second = await monitor.fetchCommentedIssues({ engaged });
    expect(commentFetchedNumbers()).toContain(100);
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).not.toContain(issueUrl(100));
  });

  it('looks up only the issues the search missed, so a search hit costs no lookup', async () => {
    const claims = manyClaims(MAX_DIRECT_ENGAGED_FETCHES + 1);
    const engaged = collectEngagedIssues({ ...emptyInput, claims });
    // The search returns the first claimed issue (the user commented there).
    searchReturns([{ ...makeSearchItem(), html_url: claims[0].url, number: 100 }]);
    commentsAre([makeComment('testuser', 'On it.', '2026-02-02T10:00:00Z')]);

    const monitor = new IssueConversationMonitor('token');
    const { warnings } = await monitor.fetchCommentedIssues({ engaged });

    expect(lookedUpNumbers()).toHaveLength(MAX_DIRECT_ENGAGED_FETCHES);
    expect(lookedUpNumbers()).not.toContain(100);
    expect(warnings).toEqual([]);
  });
});

describe('IssueConversationMonitor — direct fetch: gone issues and errors (#1862)', () => {
  beforeEach(resetMocks);

  it('drops a claimed issue the lookup reports NOT_FOUND with a warning naming the reason, not a failure', async () => {
    lookupPartiallyFails(
      () => null,
      [
        {
          type: 'NOT_FOUND',
          path: ['i0', 'issueOrPullRequest'],
          message: 'Could not resolve to an issue or pull request with the number of 42.',
        },
      ],
    );

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures, warnings } = await monitor.fetchCommentedIssues({ engaged: claimed() });

    expect(issues).toEqual([]);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([
      `${ISSUE_URL}: issue no longer reachable (NOT_FOUND: Could not resolve to an issue or pull request with the number of 42.); dropped`,
    ]);
  });

  it("drops a gone issue linked only from a closed PR quietly: nothing of the user's still points at it", async () => {
    lookupReturns(() => null);

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures, warnings } = await monitor.fetchCommentedIssues({ engaged: linkedFromClosedPR() });

    expect(issues).toEqual([]);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('warns when the user never commented and the engagement time does not parse', async () => {
    replyYesterday();

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures, warnings } = await monitor.fetchCommentedIssues({ engaged: claimed('not a date') });

    expect(issues).toEqual([]);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([
      `${ISSUE_URL}: skipped; the user never commented and the engagement time "not a date" does not parse`,
    ]);
  });

  it('records a per-issue lookup error other than NOT_FOUND as a failure and goes on with the rest', async () => {
    const other = issueUrl(43);
    const engaged = collectEngagedIssues({
      ...emptyInput,
      claims: [
        { url: ISSUE_URL, updatedAt: PR_OPENED_AT, status: 'claimed' },
        { url: other, updatedAt: PR_OPENED_AT, status: 'claimed' },
      ],
    });
    lookupPartiallyFails(
      (n) => (n === 42 ? null : openNode(n)),
      [{ type: 'FORBIDDEN', path: ['i0'], message: 'Resource protected by organization SAML enforcement.' }],
    );
    replyYesterday();

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures } = await monitor.fetchCommentedIssues({ engaged });

    expect(failures).toEqual([
      { issueUrl: ISSUE_URL, error: 'FORBIDDEN: Resource protected by organization SAML enforcement.' },
    ]);
    expect(issues.map((i) => i.url)).toEqual([other]);
  });

  it('records a comment fetch error on a looked-up issue with its HTTP status and continues', async () => {
    const other = issueUrl(43);
    const engaged = collectEngagedIssues({
      ...emptyInput,
      claims: [
        { url: ISSUE_URL, updatedAt: PR_OPENED_AT, status: 'claimed' },
        { url: other, updatedAt: PR_OPENED_AT, status: 'claimed' },
      ],
    });
    const reply = makeComment('community-member', 'A substantive reply about the approach here.', YESTERDAY);
    mocks.octokit.issues.listComments.mockImplementation(({ issue_number }: { issue_number: number }) =>
      issue_number === 42 ? Promise.reject(httpError(500, 'Server Error')) : Promise.resolve({ data: [reply] }),
    );

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures } = await monitor.fetchCommentedIssues({ engaged });

    expect(failures).toEqual([{ issueUrl: ISSUE_URL, error: 'HTTP 500: Server Error' }]);
    expect(issues.map((i) => i.url)).toEqual([other]);
  });

  it('fails every issue of a lookup query that errored outright and on retry, counts them as lookup failures, and keeps the search results', async () => {
    const engaged = collectEngagedIssues({
      ...emptyInput,
      claims: [
        { url: issueUrl(43), updatedAt: PR_OPENED_AT, status: 'claimed' },
        { url: issueUrl(44), updatedAt: PR_OPENED_AT, status: 'claimed' },
      ],
    });
    searchReturns([makeSearchItem()]);
    commentsAre([makeComment('testuser', 'On it.', '2026-02-02T10:00:00Z')]);
    mocks.octokit.graphql.mockRejectedValue(httpError(502, 'Bad Gateway'));

    const monitor = new IssueConversationMonitor('token');
    const { issues, failures, lookupFailures } = await monitor.fetchCommentedIssues({ engaged });

    // The pair, then each half once more.
    expect(mocks.octokit.graphql).toHaveBeenCalledTimes(3);
    expect(failures).toEqual([
      { issueUrl: issueUrl(43), error: 'Bad Gateway' },
      { issueUrl: issueUrl(44), error: 'Bad Gateway' },
    ]);
    expect(lookupFailures).toBe(2);
    expect(issues.map((i) => i.url)).toEqual([ISSUE_URL]);
  });

  it('counts only the lookups among the failures, not a comment fetch that failed afterwards', async () => {
    const engaged = collectEngagedIssues({
      ...emptyInput,
      claims: [
        { url: ISSUE_URL, updatedAt: PR_OPENED_AT, status: 'claimed' },
        { url: issueUrl(43), updatedAt: PR_OPENED_AT, status: 'claimed' },
      ],
    });
    lookupPartiallyFails(
      (n) => (n === 42 ? null : openNode(n)),
      [{ type: 'FORBIDDEN', path: ['i0'], message: 'Resource protected by organization SAML enforcement.' }],
    );
    mocks.octokit.issues.listComments.mockRejectedValue(httpError(500, 'Server Error'));

    const monitor = new IssueConversationMonitor('token');
    const { failures, lookupFailures } = await monitor.fetchCommentedIssues({ engaged });

    expect(failures.map((f) => f.issueUrl)).toEqual([ISSUE_URL, issueUrl(43)]);
    expect(lookupFailures).toBe(1);
  });

  it.each([
    ['an HTTP 429', httpError(429, 'API rate limit exceeded')],
    [
      'a GraphQL RATE_LIMITED error',
      Object.assign(new Error('API rate limit exceeded'), { errors: [{ type: 'RATE_LIMITED' }] }),
    ],
  ])('rejects on %s from the lookup instead of degrading to fewer results', async (_label, error) => {
    mocks.octokit.graphql.mockRejectedValue(error);

    const monitor = new IssueConversationMonitor('token');
    await expect(monitor.fetchCommentedIssues({ engaged: claimed() })).rejects.toThrow('rate limit');
  });
});
