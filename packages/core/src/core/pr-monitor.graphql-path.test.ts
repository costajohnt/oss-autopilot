/**
 * PRMonitor.fetchUserOpenPRs through the batched GraphQL path (#1941).
 *
 * Real `daily` runs enrich PRs from one aliased GraphQL query and use REST only
 * as a fallback, while most of pr-monitor.test.ts mocks an Octokit without
 * `graphql` and so runs the fallback. These tests drive the monitor with a
 * `graphql` mock: the signals a batch node carries into the assembled
 * FetchedPR, and each trigger that routes a PR back to REST.
 *
 * The last block guards the query string itself without a network call.
 * pr-graphql.test.ts covers normalizePRNode and batchFetchPRDetails in
 * isolation; this file covers the seam between them and the monitor.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./github.js', () => ({ getOctokit: vi.fn() }));
vi.mock('./state.js', () => ({ getStateManager: vi.fn() }));
// The mergeability re-query waits MERGEABLE_RETRY_DELAY_MS; skip the wait.
vi.mock('./concurrency.js', async () => ({
  ...(await vi.importActual<typeof import('./concurrency.js')>('./concurrency.js')),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { PRMonitor } from './pr-monitor.js';
import { buildBatchQuery, normalizePRNode, BATCH_SIZE, type PRRef } from './pr-graphql.js';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { makeStateManagerMock } from './test-utils.js';

/** The line the live daily e2e looks for on stderr (daily.e2e.test.ts). */
const FALLBACK_WARNING = 'falling back to REST';

const prUrl = (number: number) => `https://github.com/upstream/project/pull/${number}`;

type Fields = Record<string, unknown>;

/** HEAD commit of a GraphQL PR node. */
function makeCommit(overrides: Fields = {}): Fields {
  return {
    oid: 'sha1',
    authoredDate: '2026-02-04T00:00:00Z',
    committedDate: '2026-02-04T00:00:00Z',
    author: { user: { login: 'contributor' } },
    committer: { user: { login: 'contributor' } },
    status: null,
    statusCheckRollup: null,
    ...overrides,
  };
}

/** Well-formed GraphQL PR node: no comments, no reviews, no CI. */
function makeNode(number: number, overrides: Fields = {}, commit: Fields = makeCommit()): Fields {
  return {
    databaseId: 1000 + number,
    number,
    title: 'Add feature',
    url: prUrl(number),
    mergeable: 'MERGEABLE',
    body: '',
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-07T00:00:00Z',
    comments: { totalCount: 0, nodes: [] },
    reviews: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    timelineItems: { nodes: [] },
    commits: { nodes: [{ commit }] },
    ...overrides,
  };
}

/** Aliased batch response for PRs 1..n, in order; a null entry is an unresolved PR. */
function batchOf(...nodes: Array<Fields | null>): Fields {
  return Object.fromEntries(nodes.map((pullRequest, i) => [`pr${i}`, { pullRequest }]));
}

function rollup(...nodes: Fields[]): Fields {
  return { contexts: { totalCount: nodes.length, nodes } };
}

function checkRun(workflowId: number, conclusion: string, startedAt: string): Fields {
  return {
    conclusion,
    startedAt,
    __typename: 'CheckRun',
    name: 'build',
    status: 'COMPLETED',
    checkSuite: { workflowRun: { workflow: { databaseId: workflowId } } },
  };
}

function maintainerReview(state: string, submittedAt: string): Fields {
  return {
    totalCount: 1,
    nodes: [{ state, submittedAt, databaseId: 900, body: 'review', author: { login: 'maintainer' } }],
  };
}

function comment(login: string, createdAt: string): Fields {
  return { author: { login }, authorAssociation: 'NONE', body: 'Could you add a test for this?', createdAt };
}

/** REST enrichment mocks: a clean PR with no comments, reviews or CI. */
function restMocks() {
  const empty = () => vi.fn().mockResolvedValue({ data: [] });
  return {
    pulls: {
      get: vi.fn().mockImplementation(({ pull_number }: { pull_number: number }) =>
        Promise.resolve({
          data: {
            id: 2000 + pull_number,
            title: 'From REST',
            body: '',
            created_at: '2026-02-01T00:00:00Z',
            updated_at: '2026-02-07T00:00:00Z',
            head: { sha: 'abc123' },
            mergeable: true,
            mergeable_state: 'clean',
          },
        }),
      ),
      listReviews: empty(),
      listReviewComments: empty(),
      listCommits: empty(),
    },
    issues: { listComments: empty(), listEventsForTimeline: empty() },
    repos: { getCombinedStatusForRef: vi.fn().mockResolvedValue({ data: { state: 'success', statuses: [] } }) },
    checks: { listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }) },
  };
}

/** Run fetchUserOpenPRs for `prCount` open PRs (numbers 1..prCount) against a mocked Octokit. */
async function fetchOpenPRs(graphql: ReturnType<typeof vi.fn>, prCount = 1) {
  const urls = Array.from({ length: prCount }, (_, i) => prUrl(i + 1));
  const rest = restMocks();
  const octokit = {
    graphql,
    ...rest,
    search: {
      issuesAndPullRequests: vi.fn().mockResolvedValue({
        data: { total_count: urls.length, items: urls.map((url) => ({ html_url: url, pull_request: {} })) },
      }),
    },
  };
  vi.mocked(getStateManager).mockReturnValue(
    makeStateManagerMock({ config: { githubUsername: 'contributor', excludeRepos: [], excludeOrgs: [] } }),
  );
  vi.mocked(getOctokit).mockReturnValue(octokit as never);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const monitor = new PRMonitor('fake-token');
  const result = await monitor.fetchUserOpenPRs();
  const stderr = logged.mock.calls.map((args) => String(args[0])).join('\n');
  return { ...result, stderr, restGet: rest.pulls.get };
}

/** Fetch one PR whose batch node is `node`, asserting REST was never consulted. */
async function fetchViaGraphQL(node: Fields) {
  const graphql = vi.fn().mockResolvedValue(batchOf(node));
  const { prs, failures, stderr, restGet } = await fetchOpenPRs(graphql);
  expect(graphql).toHaveBeenCalledTimes(1);
  expect(restGet).not.toHaveBeenCalled();
  expect(stderr).not.toContain(FALLBACK_WARNING);
  expect(failures).toEqual([]);
  expect(prs).toHaveLength(1);
  return prs[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchUserOpenPRs status inputs from a successful GraphQL batch', () => {
  it('carries the review decision of a submitted review', async () => {
    const pr = await fetchViaGraphQL(makeNode(1, { reviews: maintainerReview('APPROVED', '2026-02-05T00:00:00Z') }));

    expect(pr.id).toBe(1001);
    expect(pr.reviewDecision).toBe('approved');
  });

  it('reports CI as failing when a same-named job fails in one workflow and passes later in another', async () => {
    const statusCheckRollup = rollup(
      checkRun(11, 'FAILURE', '2026-02-06T00:00:00Z'),
      checkRun(22, 'SUCCESS', '2026-02-06T00:01:00Z'),
    );

    const pr = await fetchViaGraphQL(makeNode(1, {}, makeCommit({ statusCheckRollup })));

    expect(pr.ciStatus).toBe('failing');
    expect(pr.failingCheckNames).toEqual(['build']);
  });

  it('reports CI as passing when the same workflow re-ran the failed job', async () => {
    const statusCheckRollup = rollup(
      checkRun(11, 'FAILURE', '2026-02-06T00:00:00Z'),
      checkRun(11, 'SUCCESS', '2026-02-06T00:01:00Z'),
    );

    const pr = await fetchViaGraphQL(makeNode(1, {}, makeCommit({ statusCheckRollup })));

    expect(pr.ciStatus).toBe('passing');
    expect(pr.failingCheckNames).toEqual([]);
  });

  it('reports CI as unknown when the only status is neither passed, pending nor failed', async () => {
    const status = { state: 'EXPECTED', contexts: [{ context: 'ci/legacy', state: 'EXPECTED', description: null }] };

    const pr = await fetchViaGraphQL(makeNode(1, {}, makeCommit({ status })));

    expect(pr.ciStatus).toBe('unknown');
  });

  it('flags a CONFLICTING PR as a merge conflict', async () => {
    const pr = await fetchViaGraphQL(makeNode(1, { mergeable: 'CONFLICTING' }));

    expect(pr.hasMergeConflict).toBe(true);
    expect(pr.actionReason).toBe('merge_conflict');
  });

  it('takes the conflict the UNKNOWN-mergeability re-query reveals', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(batchOf(makeNode(1, { mergeable: 'UNKNOWN' })))
      .mockResolvedValueOnce(batchOf(makeNode(1, { mergeable: 'CONFLICTING' })));

    const { prs, restGet } = await fetchOpenPRs(graphql);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(restGet).not.toHaveBeenCalled();
    expect(prs[0].hasMergeConflict).toBe(true);
  });

  it("dates the head commit by committer date when the contributor's own amend moved it", async () => {
    const commit = makeCommit({ authoredDate: '2026-02-02T00:00:00Z', committedDate: '2026-02-06T00:00:00Z' });

    const pr = await fetchViaGraphQL(makeNode(1, {}, commit));

    expect(pr.latestCommitDate).toBe('2026-02-06T00:00:00Z');
  });

  it('dates the head commit by author date when someone else rewrote it', async () => {
    const commit = makeCommit({
      authoredDate: '2026-02-02T00:00:00Z',
      committedDate: '2026-02-06T00:00:00Z',
      committer: { user: { login: 'maintainer' } },
    });

    const pr = await fetchViaGraphQL(makeNode(1, {}, commit));

    expect(pr.latestCommitDate).toBe('2026-02-02T00:00:00Z');
  });

  it('flags a maintainer comment the contributor has not answered', async () => {
    const comments = { totalCount: 1, nodes: [comment('maintainer', '2026-02-05T00:00:00Z')] };

    const pr = await fetchViaGraphQL(makeNode(1, { comments }));

    expect(pr.hasUnrespondedComment).toBe(true);
    expect(pr.lastMaintainerComment?.author).toBe('maintainer');
  });

  it('clears the flag once the contributor replied after the maintainer', async () => {
    const comments = {
      totalCount: 2,
      nodes: [comment('maintainer', '2026-02-05T00:00:00Z'), comment('contributor', '2026-02-06T00:00:00Z')],
    };

    const pr = await fetchViaGraphQL(makeNode(1, { comments }));

    expect(pr.hasUnrespondedComment).toBe(false);
  });
});

describe('fetchUserOpenPRs REST fallback triggers', () => {
  it('routes every PR to REST, with a warning, when the batch query is rejected', async () => {
    const graphql = vi.fn().mockRejectedValue(new Error('Field "mergeable" does not exist on type "PullRequest"'));

    const { prs, failures, stderr, restGet } = await fetchOpenPRs(graphql, 2);

    expect(restGet).toHaveBeenCalledTimes(2);
    expect(prs.map((pr) => pr.title)).toEqual(['From REST', 'From REST']);
    expect(failures).toEqual([]);
    expect(stderr).toContain(`GraphQL batch failed, ${FALLBACK_WARNING}`);
  });

  it.each([
    ['a REST-style rate limit', Object.assign(new Error('API rate limit exceeded'), { status: 429 })],
    ['an auth failure', Object.assign(new Error('Bad credentials'), { status: 401 })],
    [
      'a GraphQL-native RATE_LIMITED error',
      Object.assign(new Error('limited'), { errors: [{ type: 'RATE_LIMITED' }] }),
    ],
  ])('survives %s on the batch by routing every PR to REST, with a warning', async (_label, error) => {
    const graphql = vi.fn().mockRejectedValue(error);

    const { prs, failures, stderr, restGet } = await fetchOpenPRs(graphql, 2);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(restGet).toHaveBeenCalledTimes(2);
    expect(prs).toHaveLength(2);
    expect(failures).toEqual([]);
    expect(stderr).toContain(`GraphQL batch enrichment failed (${error.message}); ${FALLBACK_WARNING} for all PRs`);
  });

  it('sends only the PR whose node came back null to REST', async () => {
    const graphql = vi.fn().mockResolvedValue(batchOf(makeNode(1), null));

    const { prs, failures, restGet } = await fetchOpenPRs(graphql, 2);

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(restGet).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 2 }));
    expect(failures).toEqual([]);
    expect(prs.map((pr) => [pr.number, pr.title])).toEqual([
      [1, 'Add feature'],
      [2, 'From REST'],
    ]);
  });

  it('sends only the PR whose node cannot be normalized to REST, with a warning', async () => {
    const graphql = vi.fn().mockResolvedValue(batchOf(makeNode(1, { comments: null }), makeNode(2)));

    const { prs, failures, stderr, restGet } = await fetchOpenPRs(graphql, 2);

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(restGet).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 1 }));
    expect(failures).toEqual([]);
    expect(prs.map((pr) => [pr.number, pr.title])).toEqual([
      [2, 'Add feature'],
      [1, 'From REST'],
    ]);
    expect(stderr).toContain(`Failed to normalize ${prUrl(1)}, ${FALLBACK_WARNING}`);
  });

  it('records a failure, not a REST retry, for a PR whose resolved node cannot be assembled', async () => {
    // A non-string body passes normalization and breaks the checklist analysis.
    const graphql = vi.fn().mockResolvedValue(batchOf(makeNode(1, { body: 42 }), makeNode(2)));

    const { prs, failures, restGet } = await fetchOpenPRs(graphql, 2);

    expect(restGet).not.toHaveBeenCalled();
    expect(prs.map((pr) => pr.number)).toEqual([2]);
    expect(failures).toEqual([{ prUrl: prUrl(1), error: expect.any(String) }]);
  });
});

// ── Structural guard on the query string ──────────────────────────────
//
// The `graphql` package is not a dependency of this workspace, so this is not
// a spec-level parse and knows nothing of GitHub's schema. It checks what can
// be checked offline: delimiters balance, the selection set has the shape the
// small parser below expects, every field normalizePRNode reads is selected,
// and every selected field is read. A field misspelled the same way in the
// query and in normalizePRNode, or one GitHub removes, passes here; only the
// live daily e2e (no "falling back to REST" on stderr) catches those.

/** A selection set: field name to sub-selection (null for a scalar); `...Type` keys are inline fragments. */
interface Selection {
  [field: string]: Selection | null;
}

/** Tokens of a query, held in reverse so the next one is popped off the end. */
type TokenStack = string[];

/** Take one field: `name`, `alias: name` (as "alias name") or `... on Type` (as "...Type"). */
function takeFieldName(tokens: TokenStack): string {
  const token = tokens.pop() ?? '';
  if (token === '...') {
    tokens.pop();
    return '...' + tokens.pop();
  }
  if (token.endsWith(':')) return token.slice(0, -1) + ' ' + tokens.pop();
  if (!/^\w+$/.test(token)) throw new Error(`expected a field name, got "${token}"`);
  return token;
}

/** Parse one selection set (its opening brace already taken), consuming its closing brace. */
function parseSelection(tokens: TokenStack): Selection {
  const selection: Selection = {};
  while (tokens.at(-1) !== '}') {
    const name = takeFieldName(tokens);
    selection[name] = tokens.at(-1) === '{' && tokens.pop() ? parseSelection(tokens) : null;
  }
  tokens.pop();
  return selection;
}

const ARGUMENTS = /\([^()]*\)/g;
const TOKEN = /\.\.\.|[{}]|[\w:]+/g;

/** Selection tree of a whole query. Arguments and the operation header are dropped. */
function parseQuery(query: string): Selection {
  const text = query.replaceAll(ARGUMENTS, ' ');
  const stray = text.replaceAll(TOKEN, '').trim();
  if (stray) throw new Error(`unexpected characters in query: "${stray}"`);
  const forward: string[] = text.match(TOKEN) ?? [];
  const tokens = forward.slice(forward.indexOf('{') + 1).toReversed();
  const root = parseSelection(tokens);
  if (tokens.length > 0) throw new Error(`tokens after the closing brace: "${tokens.toReversed().join(' ')}"`);
  return root;
}

const isFragment = (field: string) => field.startsWith('...');

/** Dotted paths of every scalar a selection requests, inline fragments merged into their parent. */
function leafPaths(selection: Selection, prefix = ''): string[] {
  return Object.entries(selection).flatMap(([field, sub]) => {
    if (isFragment(field)) return sub ? leafPaths(sub, prefix) : [];
    return sub ? leafPaths(sub, prefix + field + '.') : prefix + field;
  });
}

const NUMERIC_FIELDS = new Set(['databaseId', 'number', 'totalCount']);

/** List-valued fields: every connection's `nodes`, plus the legacy `status.contexts` (a plain list, no `nodes`). */
const isList = (field: string, sub: Selection) =>
  field === 'nodes' || (field === 'contexts' && sub.nodes === undefined);

/** A plausible response value for one selected field. */
function fakeField(field: string, sub: Selection | null): unknown {
  if (sub === null) return NUMERIC_FIELDS.has(field) ? 1 : 'x';
  return isList(field, sub) ? fakeVariants(sub) : fakeVariants(sub)[0];
}

/** One response object per inline fragment (or a single one), holding exactly the selected fields. */
function fakeVariants(selection: Selection): Fields[] {
  const base: Fields = {};
  const fragments: Fields[] = [];
  for (const [field, sub] of Object.entries(selection)) {
    if (isFragment(field)) fragments.push({ ...fakeVariants(sub ?? {})[0], __typename: field.slice(3) });
    else base[field] = fakeField(field, sub);
  }
  return fragments.length > 0 ? fragments.map((fragment) => ({ ...base, ...fragment })) : [base];
}

/** Wrap a response so every property read is recorded by dotted path, and reads of absent fields are kept apart. */
function tracked(value: unknown, path: string, read: Set<string>, absent: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => tracked(item, path, read, absent));
  if (value === null || typeof value !== 'object') return value;
  return new Proxy(value, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      const fieldPath = path + prop;
      const seen = Reflect.has(target, prop) ? read : absent;
      seen.add(fieldPath);
      return tracked(Reflect.get(target, prop), fieldPath + '.', read, absent);
    },
  });
}

/** The `pullRequest { ... }` selection of the first alias in a built query. */
function pullRequestSelection(query: string): Selection {
  const pullRequest = parseQuery(query)['pr0 repository']?.pullRequest;
  if (!pullRequest) throw new Error('pr0 has no pullRequest selection');
  return pullRequest;
}

const refs = (size: number): PRRef[] =>
  Array.from({ length: size }, (_, i) => ({ owner: 'upstream', repo: 'project', number: i + 1, url: prUrl(i + 1) }));

const count = (text: string, char: string) => text.split(char).length - 1;

const variablesIn = (text: string) => new Set(text.match(/\$\w+/g));

/**
 * Fields the query selects that normalizePRNode never reads. `number` and
 * `url` are identity the caller already holds; the rollup's StatusContext
 * fields are unused because legacy statuses are read from `commit.status`.
 * Anything new here is a dead selection: drop it from PR_FIELDS or read it.
 */
const SELECTED_BUT_UNREAD = new Set([
  'number',
  'url',
  'commits.nodes.commit.statusCheckRollup.contexts.nodes.context',
  'commits.nodes.commit.statusCheckRollup.contexts.nodes.state',
  'commits.nodes.commit.statusCheckRollup.contexts.nodes.description',
]);

describe('buildBatchQuery structural guard', () => {
  it.each([1, BATCH_SIZE])('balances every delimiter for a batch of %i', (size) => {
    const { query } = buildBatchQuery(refs(size));

    expect(count(query, '{')).toBe(count(query, '}'));
    expect(count(query, '(')).toBe(count(query, ')'));
    expect(count(query, '[')).toBe(count(query, ']'));
  });

  it('gives every PR its own alias with the same selection, and declares exactly the variables it uses', () => {
    const { query, variables } = buildBatchQuery(refs(BATCH_SIZE));
    const root = parseQuery(query);
    const bodyStart = query.indexOf('{');
    const declared = variablesIn(query.slice(0, bodyStart));
    const distinctSelections = new Set(Object.values(root).map((alias) => JSON.stringify(alias)));

    expect(Object.keys(root)).toEqual(refs(BATCH_SIZE).map((_, i) => `pr${i} repository`));
    expect(distinctSelections.size).toBe(1);
    expect(declared).toEqual(variablesIn(query.slice(bodyStart)));
    expect(declared).toEqual(new Set(Object.keys(variables).map((name) => '$' + name)));
  });

  it('selects every field normalizePRNode reads, and reads every field it selects', () => {
    const selection = pullRequestSelection(buildBatchQuery(refs(1)).query);
    const read = new Set<string>();
    const absent = new Set<string>();

    const outcome = normalizePRNode(tracked(fakeVariants(selection)[0], '', read, absent) as never);

    expect(outcome.kind).toBe('ok');
    expect([...absent], 'read by normalizePRNode but missing from PR_FIELDS').toEqual([]);
    expect(new Set(leafPaths(selection).filter((path) => !read.has(path)))).toEqual(SELECTED_BUT_UNREAD);
  });
});
