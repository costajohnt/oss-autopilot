import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateManager } from '../core/state.js';

const mocks = vi.hoisted(() => ({
  graphql: vi.fn(),
  /** Search API behind the merged-history walk (#1924); unused while the state has no username. */
  search: vi.fn(),
  state: { current: undefined as unknown },
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => mocks.state.current,
    getOctokit: () => ({ graphql: mocks.graphql, search: { issuesAndPullRequests: mocks.search } }),
    requireGitHubToken: () => 'token',
  };
});
vi.mock('./locate-issue-list.js', () => ({ detectIssueListPath: () => undefined }));

const { runLedgerBackfill } = await import('./ledger-backfill.js');

const MERGED = 'https://github.com/o/r/pull/1';
const CLOSED = 'https://github.com/o/r/pull/2';
const ISSUE = 'https://github.com/o/r/issues/9';

const node = (extra: object = {}) => ({
  pullRequest: {
    createdAt: '2026-01-01T00:00:00Z',
    author: { __typename: 'User', login: 'me' },
    closingIssuesReferences: { nodes: [] },
    timelineItems: { nodes: [] },
    comments: { nodes: [] },
    ...extra,
  },
});

const PAGE_QUERY_MARK = 'repository(owner: $o, name: $r)';
const fans = (page: number) =>
  Array.from({ length: 10 }, (_, i) => ({
    author: { __typename: 'User', login: `fan${page}-${i}` },
    authorAssociation: 'NONE',
    createdAt: '2026-01-01T01:00:00Z',
  }));
const page = (nodes: object[], hasNextPage: boolean, endCursor: string) => ({
  firstComments: { pageInfo: { hasNextPage, endCursor }, nodes },
  reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
});
/** Batch queries get `batch`; follow-up page queries get `pages(n)` for the n-th follow-up. */
function route(batch: object, pages: (n: number) => object) {
  let n = 0;
  mocks.graphql.mockImplementation(async (query: string) => {
    if (!query.includes(PAGE_QUERY_MARK)) return batch;
    n += 1;
    return { repository: { pullRequest: pages(n) } };
  });
}

/** Follow-up page queries the mock received. */
const pageCalls = () => mocks.graphql.mock.calls.filter(([q]) => String(q).includes(PAGE_QUERY_MARK));

function writeList(entry: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-backfill-'));
  const list = path.join(dir, 'issues.md');
  fs.writeFileSync(list, '# Issues\n\n## Pursue\n\n');
  fs.writeFileSync(path.join(dir, 'issues-archive-2026-01-01.md'), `# Archive\n\n## Pursue\n\n${entry}`);
  return list;
}

/** Fresh state with one merged and one closed entry, none backfilled. */
function freshLedger(): StateManager {
  vi.clearAllMocks();
  const sm = new StateManager(true);
  mocks.state.current = sm;
  sm.addMergedPRs([{ url: MERGED, title: 'm', mergedAt: '2026-01-02T00:00:00Z' }]);
  sm.addClosedPRs([{ url: CLOSED, title: 'c', closedAt: '2026-01-03T00:00:00Z' }]);
  return sm;
}

describe('runLedgerBackfill (#1824)', () => {
  let sm: StateManager;

  beforeEach(() => {
    sm = freshLedger();
  });

  it('fills fields from one batched query, stamps entries, and skips them next run', async () => {
    mocks.graphql.mockResolvedValue({
      p0: node({ closingIssuesReferences: { nodes: [{ url: ISSUE }] } }),
      p1: node({
        timelineItems: { nodes: [{ actor: { __typename: 'User', login: 'maint' } }] },
        comments: { nodes: [{ author: { __typename: 'User', login: 'maint' }, body: 'Superseded by #5' }] },
      }),
    });

    const result = await runLedgerBackfill();

    expect(result).toMatchObject({
      queried: 2,
      unresolved: 0,
      warnings: ['no curated issue list found; list vet scores were not imported'],
      filled: { openedAt: 2, issueUrl: 1, closeReason: 1, pick: 0, firstMaintainerResponseAt: 0 },
    });
    expect(sm.getMergedPRs()[0]).toMatchObject({ openedAt: '2026-01-01T00:00:00Z', issueUrl: ISSUE });
    expect(sm.getMergedPRs()[0].backfilledAt).toBeDefined();
    expect(sm.getClosedPRs()[0].closeReason).toBe('superseded');

    expect((await runLedgerBackfill()).queried).toBe(0);
    expect(mocks.graphql).toHaveBeenCalledTimes(1);
  });

  it('re-fetches entries backfilled before firstMaintainerResponseAt, once', async () => {
    sm.addMergedPRs([{ url: MERGED, title: 'm', mergedAt: '2026-01-02T00:00:00Z', backfilledAt: 'x' }]);
    sm.addClosedPRs([
      { url: CLOSED, title: 'c', closedAt: '2026-01-03T00:00:00Z', backfilledAt: 'x', responseRule: 2 },
    ]);
    mocks.graphql.mockResolvedValue({
      p0: node({
        firstComments: {
          nodes: [
            { author: { __typename: 'Bot', login: 'ci-helper' }, createdAt: '2026-01-01T01:00:00Z' },
            { author: { __typename: 'User', login: 'me' }, createdAt: '2026-01-01T02:00:00Z' },
            { author: { __typename: 'User', login: 'maint' }, createdAt: '2026-01-03T00:00:00Z' },
          ],
        },
        reviews: { nodes: [{ author: { __typename: 'User', login: 'other' }, submittedAt: '2026-01-02T00:00:00Z' }] },
      }),
    });

    const result = await runLedgerBackfill();
    expect(result.queried).toBe(1);
    expect(result.filled.firstMaintainerResponseAt).toBe(1);
    expect(sm.getMergedPRs()[0].firstMaintainerResponseAt).toBe('2026-01-02T00:00:00Z');
    const rerun = await runLedgerBackfill();
    expect(rerun.queried).toBe(0);
  });

  it('counts issue comments only from maintainer associations', async () => {
    mocks.graphql.mockResolvedValue({
      p0: node({
        firstComments: {
          nodes: [
            {
              author: { __typename: 'User', login: 'fan' },
              authorAssociation: 'NONE',
              createdAt: '2026-01-01T01:00:00Z',
            },
            {
              author: { __typename: 'User', login: 'maint' },
              authorAssociation: 'OWNER',
              createdAt: '2026-01-04T00:00:00Z',
            },
          ],
        },
      }),
      p1: node(),
    });
    await runLedgerBackfill();
    expect(sm.getMergedPRs()[0].firstMaintainerResponseAt).toBe('2026-01-04T00:00:00Z');
  });

  it('stamps an unanswered PR so it is not re-queried', async () => {
    mocks.graphql.mockResolvedValue({ p0: node(), p1: node() });
    await runLedgerBackfill();
    expect(sm.getMergedPRs()[0].firstMaintainerResponseAt).toBeUndefined();
    expect(sm.getMergedPRs()[0].responseRule).toBe(2);
    const rerun = await runLedgerBackfill();
    expect(rerun.queried).toBe(0);
  });

  it('re-fetches self-closed entries recorded before selfCloseReason, once', async () => {
    sm.addMergedPRs([
      { url: MERGED, title: 'm', mergedAt: '2026-01-02T00:00:00Z', backfilledAt: 'x', responseRule: 2 },
    ]);
    sm.addClosedPRs([
      { url: CLOSED, title: 'c', closedAt: '2026-01-03T00:00:00Z', backfilledAt: 'x', closeReason: 'self-closed' },
    ]);
    mocks.graphql.mockResolvedValue({
      p0: node({
        timelineItems: { nodes: [{ actor: { __typename: 'User', login: 'me' } }] },
        comments: {
          nodes: [{ author: { __typename: 'User', login: 'me' }, body: 'Closing, #9 landed the same fix.' }],
        },
      }),
    });

    expect((await runLedgerBackfill()).queried).toBe(1);
    expect(sm.getClosedPRs()[0]).toMatchObject({ closeReason: 'self-closed', selfCloseReason: 'superseded' });
    expect((await runLedgerBackfill()).queried).toBe(0);
  });

  it('treats a bot closer as stale and leaves the reason unset without a closed event', async () => {
    mocks.graphql.mockResolvedValue({
      p0: node(),
      p1: node({ timelineItems: { nodes: [{ actor: { __typename: 'Bot', login: 'github-actions' } }] } }),
    });
    await runLedgerBackfill();
    expect(sm.getClosedPRs()[0].closeReason).toBe('stale');

    sm.addClosedPRs([{ url: 'https://github.com/o/r/pull/3', title: 'c', closedAt: '2026-01-04T00:00:00Z' }]);
    mocks.graphql.mockResolvedValue({ p0: node() });
    await runLedgerBackfill();
    expect(sm.getClosedPRs().find((e) => e.url.endsWith('/3'))?.closeReason).toBeUndefined();
  });

  it('reports partial errors by type and keeps the PRs that resolved', async () => {
    mocks.graphql.mockRejectedValueOnce(
      Object.assign(new Error('partial'), { data: { p0: node(), p1: null }, errors: [{ type: 'NOT_FOUND' }] }),
    );
    const result = await runLedgerBackfill();
    expect(result.unresolved).toBe(1);
    expect(result.warnings).toContain('PRs GitHub did not return: NOT_FOUND x1');
    expect(sm.getMergedPRs()[0].openedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('throws when every batch fails outright', async () => {
    mocks.graphql.mockRejectedValue(new Error('502 Bad Gateway'));
    await expect(runLedgerBackfill()).rejects.toThrow(
      /Every GitHub batch failed.*batch of 2 PRs failed: 502 Bad Gateway/,
    );
  });

  it('persists earlier batches before rethrowing a rate limit', async () => {
    for (let i = 3; i < 45; i++) {
      sm.addMergedPRs([{ url: `https://github.com/o/r/pull/${i}`, title: 'm', mergedAt: '2026-01-01T00:00:00Z' }]);
    }
    const first = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, node()]));
    mocks.graphql
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(Object.assign(new Error('limited'), { errors: [{ type: 'RATE_LIMITED' }] }));

    await expect(runLedgerBackfill()).rejects.toThrow('limited');
    const stamped = [...sm.getMergedPRs(), ...sm.getClosedPRs()].filter((e) => e.backfilledAt);
    expect(stamped).toHaveLength(40);
  });

  it('rejects an explicit list path that does not exist', async () => {
    await expect(runLedgerBackfill({ issueListPath: '/nope/list.md' })).rejects.toThrow('Issue list not found');
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it('imports the list score as a recommendation for a PR its status line links', async () => {
    mocks.graphql.mockResolvedValue({});
    const list = writeList(
      `- [o/r#9](${ISSUE}) - title\n  - **Pursue (7/10)** - good\n  - **Done** - PR [#1](${MERGED})\n`,
    );

    const result = await runLedgerBackfill({ issueListPath: list });

    expect(result.listFiles).toHaveLength(2);
    expect(result.filled.pick).toBe(1);
    expect(sm.getMergedPRs()[0]).toMatchObject({
      issueUrl: ISSUE,
      pick: { grade: 7, recommendation: 'approve', source: 'list', issueUrl: ISSUE },
    });
    expect(sm.getMergedPRs()[0].pick?.capturedAt).toBeUndefined();
  });

  it('prefers a vet-time snapshot over the list score', async () => {
    mocks.graphql.mockResolvedValue({ p0: node({ closingIssuesReferences: { nodes: [{ url: ISSUE }] } }), p1: node() });
    sm.recordPickSnapshots([{ issueUrl: ISSUE, grade: 9, recommendation: 'approve', source: 'vet', capturedAt: 'x' }]);
    const list = writeList(`- [o/r#9](${ISSUE}) - t\n  - **Pursue (6/10)** - ok\n  - **Done** - PR [#1](${MERGED})\n`);

    await runLedgerBackfill({ issueListPath: list });

    expect(sm.getMergedPRs()[0].pick).toMatchObject({ grade: 9, source: 'vet' });
  });

  it('ignores list entries whose own URL is a PR', async () => {
    mocks.graphql.mockResolvedValue({});
    const list = writeList(`- [o/r#1](${MERGED}) - t\n  - **Pursue (8/10)** - ok\n  - **Done** - PR [#1](${MERGED})\n`);
    expect((await runLedgerBackfill({ issueListPath: list })).filled.pick).toBe(0);
  });
});

/** A merged PR the ledger does not hold, older than its newest entry. */
const HOLE = 'https://github.com/o/r/pull/7';
const searchItem = (url: string, mergedAt: string) => ({
  html_url: url,
  title: 'from search',
  created_at: '2025-12-01T00:00:00Z',
  closed_at: mergedAt,
  pull_request: { merged_at: mergedAt },
});

describe('runLedgerBackfill merged history (#1924)', () => {
  let sm: StateManager;

  beforeEach(() => {
    sm = freshLedger();
    sm.updateConfig({ githubUsername: 'me' });
    mocks.graphql.mockResolvedValue({ p0: node(), p1: node(), p2: node() });
  });

  it('adds a merged PR older than the newest ledger entry and enriches it in the same run', async () => {
    const items = [searchItem(HOLE, '2025-12-20T00:00:00Z'), searchItem(MERGED, '2026-01-02T00:00:00Z')];
    mocks.search.mockResolvedValue({ data: { total_count: 2, items } });

    const result = await runLedgerBackfill();

    expect(result.mergedAdded).toBe(1);
    expect(result.queried).toBe(3);
    expect(sm.getMergedPRs().map((pr) => pr.url)).toEqual([MERGED, HOLE]);
    expect(sm.getMergedPRs()[1].backfilledAt).toBeDefined();
    // All time, no result limit: no date bound in the query.
    expect(mocks.search.mock.calls[0][0].q).toBe('is:pr is:merged is:public author:me -user:me');

    const rerun = await runLedgerBackfill();
    expect(rerun.mergedAdded).toBe(0);
  });

  it('moves a PR recorded as closed into the merged ledger when GitHub lists it as merged', async () => {
    mocks.search.mockResolvedValue({ data: { total_count: 1, items: [searchItem(CLOSED, '2026-01-03T00:00:00Z')] } });

    await runLedgerBackfill();

    expect(sm.getMergedPRs().map((pr) => pr.url)).toContain(CLOSED);
    expect(sm.getClosedPRs()).toEqual([]);
  });

  it('adds neither an untracked organisation PR nor a private repository PR', async () => {
    sm.updateConfig({ untrackedOrgs: ['acme'] });
    const employer = searchItem('https://github.com/Acme/internal/pull/1', '2025-12-21T00:00:00Z');
    const privateRepo = searchItem('https://github.com/o/secret/pull/2', '2025-12-22T00:00:00Z');
    // GitHub applies `is:public`; the stand-in does too, and ignores `-org:`.
    mocks.search.mockImplementation(({ q }: { q: string }) => {
      const items = q.includes('is:public') ? [employer] : [employer, privateRepo];
      return Promise.resolve({ data: { total_count: items.length, items } });
    });

    const result = await runLedgerBackfill();

    expect(mocks.search.mock.calls[0][0].q).toBe('is:pr is:merged is:public author:me -user:me -org:acme');
    expect(result.mergedAdded).toBe(0);
    expect(sm.getMergedPRs().map((pr) => pr.url)).toEqual([MERGED]);
  });

  it('adds nothing and warns when the history walk fails, and still backfills the entries it has', async () => {
    mocks.search.mockRejectedValue(new Error('search down'));

    const result = await runLedgerBackfill();

    expect(result.mergedAdded).toBe(0);
    expect(result.warnings).toContain('merged PR history fetch failed, no missing PRs were added: search down');
    expect(result.queried).toBe(2);
    expect(sm.getMergedPRs()).toHaveLength(1);
  });

  it('adds nothing and warns when the walk cannot get past a page cap', async () => {
    // 300 results of 301, none with a creation date to continue from.
    const items = Array.from({ length: 100 }, () => ({
      ...searchItem(HOLE, '2025-12-20T00:00:00Z'),
      created_at: null,
    }));
    mocks.search.mockResolvedValue({ data: { total_count: 301, items } });

    const result = await runLedgerBackfill();

    expect(result.mergedAdded).toBe(0);
    expect(result.warnings).toContain('merged PR history could not be walked to the end; no missing PRs were added');
  });

  it('rethrows a rate limit from the history walk', async () => {
    mocks.search.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));

    await expect(runLedgerBackfill()).rejects.toThrow('rate limited');
  });
});

describe('runLedgerBackfill closed history (#1925)', () => {
  let sm: StateManager;

  beforeEach(() => {
    sm = freshLedger();
    sm.updateConfig({ githubUsername: 'me', untrackedOrgs: ['acme'] });
    mocks.graphql.mockResolvedValue({ p0: node(), p1: node(), p2: node() });
  });

  it('adds a closed PR older than the newest closed entry, with the shared scope and no date bound', async () => {
    const closedHole = { ...searchItem(HOLE, '2025-12-20T00:00:00Z'), pull_request: { merged_at: null } };
    mocks.search.mockImplementation(({ q }: { q: string }) => {
      const items = q.includes('is:unmerged') ? [closedHole] : [];
      return Promise.resolve({ data: { total_count: items.length, items } });
    });

    const result = await runLedgerBackfill();

    expect(mocks.search.mock.calls.map(([args]) => args.q)).toContain(
      'is:pr is:closed is:unmerged is:public author:me -user:me -org:acme',
    );
    expect(result.closedAdded).toBe(1);
    expect(result.mergedAdded).toBe(0);
    expect(sm.getClosedPRs().map((pr) => pr.url)).toEqual([CLOSED, HOLE]);
    const rerun = await runLedgerBackfill();
    expect(rerun.closedAdded).toBe(0);
  });

  it('adds no closed PRs and warns when the closed walk fails', async () => {
    mocks.search.mockImplementation(({ q }: { q: string }) =>
      q.includes('is:unmerged')
        ? Promise.reject(new Error('search down'))
        : Promise.resolve({ data: { total_count: 0, items: [] } }),
    );

    const result = await runLedgerBackfill();

    expect(result.closedAdded).toBe(0);
    expect(result.warnings).toContain('closed PR history fetch failed, no missing PRs were added: search down');
    expect(sm.getClosedPRs().map((pr) => pr.url)).toEqual([CLOSED]);
  });
});

describe('runLedgerBackfill first-response lookup', () => {
  let sm: StateManager;

  beforeEach(() => {
    sm = freshLedger();
  });

  describe('paging past a page with no maintainer response', () => {
    it('fetches later pages until a maintainer response turns up', async () => {
      const maint = {
        author: { __typename: 'User', login: 'maint' },
        authorAssociation: 'MEMBER',
        createdAt: '2026-01-05T00:00:00Z',
      };
      const first = node(page(fans(0), true, 'c1'));
      route({ p0: first, p1: node() }, () => page([maint], false, 'c2'));
      const result = await runLedgerBackfill();
      expect(sm.getMergedPRs()[0]).toMatchObject({
        firstMaintainerResponseAt: '2026-01-05T00:00:00Z',
        responseRule: 2,
      });
      expect(result.filled.firstMaintainerResponseAt).toBe(1);
      const [pageCall] = pageCalls();
      expect(pageCall?.[1]).toMatchObject({ o: 'o', r: 'r', n: 1, c: 'c1' });
    });

    it('records the PR as unanswered after the page bound', async () => {
      const first = node(page(fans(0), true, 'c0'));
      route({ p0: first, p1: node() }, (n) => page(fans(n), true, `c${n}`));
      await runLedgerBackfill();
      expect(pageCalls()).toHaveLength(4); // 5 pages in all
      expect(sm.getMergedPRs()[0].firstMaintainerResponseAt).toBeUndefined();
      expect(sm.getMergedPRs()[0].responseRule).toBe(2);
      const rerun = await runLedgerBackfill();
      expect(rerun.queried).toBe(0);
    });

    it('leaves the entry for the next run when a page fetch fails', async () => {
      let calls = 0;
      mocks.graphql.mockImplementation(async (query: string) => {
        calls += 1;
        if (!query.includes(PAGE_QUERY_MARK)) return { p0: node(page(fans(0), true, 'c0')), p1: node() };
        throw new Error('boom');
      });
      const result = await runLedgerBackfill();
      expect(calls).toBe(2);
      expect(result.warnings.some((w) => w.includes('response lookup for'))).toBe(true);
      expect(sm.getMergedPRs()[0].responseRule).toBeUndefined();
      expect(sm.getClosedPRs()[0].responseRule).toBe(2);
    });
  });

  it('recomputes a value recorded under the old maintainer rule once, then leaves it alone', async () => {
    sm.addMergedPRs([
      {
        url: MERGED,
        title: 'm',
        mergedAt: '2026-01-02T00:00:00Z',
        backfilledAt: 'x',
        firstMaintainerResponseAt: '2026-01-01T01:00:00Z', // a drive-by comment under rule 1
      },
    ]);
    sm.addClosedPRs([
      { url: CLOSED, title: 'c', closedAt: '2026-01-03T00:00:00Z', backfilledAt: 'x', responseRule: 2 },
    ]);
    mocks.graphql.mockResolvedValue({
      p0: node({
        firstComments: {
          nodes: [
            {
              author: { __typename: 'User', login: 'fan' },
              authorAssociation: 'NONE',
              createdAt: '2026-01-01T01:00:00Z',
            },
            {
              author: { __typename: 'User', login: 'maint' },
              authorAssociation: 'OWNER',
              createdAt: '2026-01-06T00:00:00Z',
            },
          ],
        },
      }),
    });
    const first = await runLedgerBackfill();
    expect(first.queried).toBe(1);
    expect(sm.getMergedPRs()[0]).toMatchObject({ firstMaintainerResponseAt: '2026-01-06T00:00:00Z', responseRule: 2 });
    const rerun = await runLedgerBackfill();
    expect(rerun.queried).toBe(0);
    expect(sm.getMergedPRs()[0].firstMaintainerResponseAt).toBe('2026-01-06T00:00:00Z');
  });
});
