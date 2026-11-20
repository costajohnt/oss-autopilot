/**
 * PRMonitor.fetchUserOpenPRs through the batched GraphQL path (#1941).
 *
 * Real `daily` runs enrich PRs from one aliased GraphQL query and use REST only
 * as a fallback, while most of pr-monitor.test.ts mocks an Octokit without
 * `graphql` and so runs the fallback. These tests drive the monitor with a
 * `graphql` mock: proof that a batch node's signals reach the assembled
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
import {
  buildBatchQuery,
  normalizePRNode,
  BATCH_SIZE,
  PR_FETCH_LOG,
  type NormalizedPRData,
  type PRRef,
} from './pr-graphql.js';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { enableDebug } from './logger.js';
import { makeStateManagerMock } from './test-utils.js';
import type { FetchedPR } from './types.js';

// The live daily e2e reads the debug log to see which transport served the
// PRs (daily.e2e.test.ts), so these tests pin the same lines. Module state is
// per test file, so this does not leak.
enableDebug();

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
    title: 'From GraphQL',
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
  const { prs, failures } = await monitor.fetchUserOpenPRs();
  const stderr = logged.mock.calls.map((args) => String(args[0]));
  return {
    failures,
    stderr,
    restGet: rest.pulls.get,
    /** PR title by number: the title says which transport built the PR. */
    titles: Object.fromEntries(prs.map((pr) => [pr.number, pr.title])),
    byNumber: new Map(prs.map((pr) => [pr.number, pr])),
  };
}

const linesWith = (stderr: string[], marker: string) => stderr.filter((line) => line.includes(marker));

/** Fetch one PR whose batch node is `node`, asserting REST was never consulted. */
async function fetchViaGraphQL(node: Fields): Promise<FetchedPR> {
  const { byNumber, failures, stderr, restGet } = await fetchOpenPRs(vi.fn().mockResolvedValue(batchOf(node)));
  expect(restGet).not.toHaveBeenCalled();
  expect(linesWith(stderr, PR_FETCH_LOG.restFallback)).toEqual([]);
  expect(linesWith(stderr, 'falling back to REST')).toEqual([]);
  expect(failures).toEqual([]);
  const pr = byNumber.get(1);
  if (!pr) throw new Error('PR 1 was not returned');
  return pr;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchUserOpenPRs status inputs from a successful GraphQL batch', () => {
  it('carries the review decision of a submitted review', async () => {
    const review = { databaseId: 900, state: 'APPROVED', body: '', submittedAt: '2026-02-05T00:00:00Z' };
    const reviews = { totalCount: 1, nodes: [{ ...review, author: { login: 'maintainer' } }] };

    const pr = await fetchViaGraphQL(makeNode(1, { reviews }));

    expect(pr.id).toBe(1001);
    expect(pr.reviewDecision).toBe('approved');
  });

  it('reports CI as failing when a same-named job fails in one workflow and passes later in another', async () => {
    const nodes = [checkRun(11, 'FAILURE', '2026-02-06T00:00:00Z'), checkRun(22, 'SUCCESS', '2026-02-06T00:01:00Z')];
    const statusCheckRollup = { contexts: { nodes, totalCount: nodes.length } };

    const pr = await fetchViaGraphQL(makeNode(1, {}, makeCommit({ statusCheckRollup })));

    expect(pr.ciStatus).toBe('failing');
    expect(pr.failingCheckNames).toEqual(['build']);
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

    const { byNumber, restGet } = await fetchOpenPRs(graphql);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(restGet).not.toHaveBeenCalled();
    expect(byNumber.get(1)?.hasMergeConflict).toBe(true);
  });

  it("dates the head commit by committer date when the contributor's own amend moved it", async () => {
    const commit = makeCommit({ authoredDate: '2026-02-02T00:00:00Z', committedDate: '2026-02-06T00:00:00Z' });

    const pr = await fetchViaGraphQL(makeNode(1, {}, commit));

    expect(pr.latestCommitDate).toBe('2026-02-06T00:00:00Z');
  });

  it('flags a maintainer comment the contributor has not answered', async () => {
    const question = { authorAssociation: 'NONE', body: 'Could you add a test?', createdAt: '2026-02-05T00:00:00Z' };
    const comments = { totalCount: 1, nodes: [{ ...question, author: { login: 'maintainer' } }] };

    const pr = await fetchViaGraphQL(makeNode(1, { comments }));

    expect(pr.hasUnrespondedComment).toBe(true);
    expect(pr.lastMaintainerComment?.author).toBe('maintainer');
  });
});

describe('fetchUserOpenPRs REST fallback triggers', () => {
  it('routes every PR to REST, with a warning, when the batch query is rejected', async () => {
    const graphql = vi.fn().mockRejectedValue(new Error('Field "mergeable" does not exist on type "PullRequest"'));

    const { titles, failures, stderr } = await fetchOpenPRs(graphql, 2);

    expect(titles).toEqual({ 1: 'From REST', 2: 'From REST' });
    expect(failures).toEqual([]);
    expect(linesWith(stderr, PR_FETCH_LOG.batchFailed)).toHaveLength(1);
    // The two debug lines the live e2e counts: N from the timing label, one line per REST PR.
    expect(linesWith(stderr, `${PR_FETCH_LOG.fetchDetails} 2 PRs`)).toHaveLength(1);
    expect(linesWith(stderr, PR_FETCH_LOG.restFallback)).toHaveLength(2);
  });

  it.each([
    ['a REST-style rate limit', Object.assign(new Error('API rate limit exceeded'), { status: 429 })],
    ['an auth failure', Object.assign(new Error('Bad credentials'), { status: 401 })],
    [
      'a GraphQL-native RATE_LIMITED error',
      Object.assign(new Error('limited'), { errors: [{ type: 'RATE_LIMITED' }] }),
    ],
  ])('survives %s on the batch by routing every PR to REST, with a warning', async (_label, error) => {
    const { titles, failures, stderr } = await fetchOpenPRs(vi.fn().mockRejectedValue(error), 2);

    expect(titles).toEqual({ 1: 'From REST', 2: 'From REST' });
    expect(failures).toEqual([]);
    expect(linesWith(stderr, PR_FETCH_LOG.enrichmentFailed)).toHaveLength(1);
  });

  it('sends only the PR whose node came back null to REST', async () => {
    const graphql = vi.fn().mockResolvedValue(batchOf(makeNode(1), null));

    const { titles, failures, stderr } = await fetchOpenPRs(graphql, 2);

    expect(titles).toEqual({ 1: 'From GraphQL', 2: 'From REST' });
    expect(failures).toEqual([]);
    expect(linesWith(stderr, PR_FETCH_LOG.restFallback)).toEqual([expect.stringContaining(prUrl(2))]);
  });

  it('sends only the PR whose node cannot be normalized to REST, with a warning', async () => {
    const graphql = vi.fn().mockResolvedValue(batchOf(makeNode(1, { comments: null }), makeNode(2)));

    const { titles, failures, stderr } = await fetchOpenPRs(graphql, 2);

    expect(titles).toEqual({ 1: 'From REST', 2: 'From GraphQL' });
    expect(failures).toEqual([]);
    expect(linesWith(stderr, PR_FETCH_LOG.normalizeFailed)).toEqual([expect.stringContaining(prUrl(1))]);
  });

  it('records a failure, not a REST retry, for a resolved PR whose assembly throws', async () => {
    type Assemble = (this: unknown, ref: PRRef, data: NormalizedPRData) => Promise<FetchedPR>;
    const seam = PRMonitor.prototype as unknown as { assembleFromNormalized: Assemble };
    const assemble = seam.assembleFromNormalized;
    vi.spyOn(seam, 'assembleFromNormalized').mockImplementation(function (this: unknown, ref, data) {
      return ref.number === 1 ? Promise.reject(new Error('assembly broke')) : assemble.call(this, ref, data);
    });
    const graphql = vi.fn().mockResolvedValue(batchOf(makeNode(1), makeNode(2)));

    const { titles, failures, stderr, restGet } = await fetchOpenPRs(graphql, 2);

    expect(restGet).not.toHaveBeenCalled();
    expect(titles).toEqual({ 2: 'From GraphQL' });
    expect(failures).toEqual([{ prUrl: prUrl(1), error: 'assembly broke' }]);
    expect(linesWith(stderr, PR_FETCH_LOG.assembleFailed)).toEqual([expect.stringContaining(prUrl(1))]);
  });
});

// ── Structural guard on the query string ──────────────────────────────
//
// The `graphql` package is not a dependency of this workspace, so this is not
// a spec-level parse and knows nothing of GitHub's schema. It checks what can
// be checked offline: delimiters balance, declared variables are the used
// ones, and every field normalizePRNode reads is selected. A field misspelled
// the same way in the query and in normalizePRNode, or one GitHub removes,
// passes here; only the live daily e2e catches those. The parser handles the
// syntax PR_FIELDS uses today and says so by name when it meets anything else.

/** A selection set: field name to sub-selection (null for a scalar); `...Type` keys are inline fragments. */
interface Selection {
  [field: string]: Selection | null;
}

/** Tokens of a query, held in reverse so the next one is popped off the end. */
type TokenStack = string[];

/** GraphQL syntax the parser does not handle, by the token that introduces it, or undefined when it does. */
function unsupportedSyntax(token: string, next: string | undefined): string | undefined {
  if (token === '...') return next === 'on' ? undefined : 'named fragment spreads';
  if (token.endsWith(':')) return 'aliases';
  if (token.startsWith('@')) return 'directives';
  if (token === 'edges') return '`edges` connections';
  return /^\w+$/.test(token) ? undefined : 'this token';
}

/** Take one field: `name`, or `... on Type` (as "...Type"). */
function takeFieldName(tokens: TokenStack): string {
  const token = tokens.pop() ?? '';
  const unsupported = unsupportedSyntax(token, tokens.at(-1));
  if (unsupported) throw new Error(`structural guard parser does not support ${unsupported} (at "${token}")`);
  if (token !== '...') return token;
  tokens.pop();
  return '...' + tokens.pop();
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
/** The per-PR aliases buildBatchQuery adds (`pr0: repository`); the only aliases the guard expects. */
const BATCH_ALIAS = /\bpr\d+:/g;
const TOKEN = /\.\.\.|[{}]|@?[\w:]+/g;

/** The `pullRequest { ... }` selection of a built query. Arguments, the operation header and batch aliases are dropped. */
function pullRequestSelection(query: string): Selection {
  const text = query.replaceAll(ARGUMENTS, ' ').replaceAll(BATCH_ALIAS, ' ');
  const stray = text.replaceAll(TOKEN, '').trim();
  if (stray) throw new Error(`structural guard parser does not support these characters: "${stray}"`);
  const forward: string[] = text.match(TOKEN) ?? [];
  const tokens = forward.slice(forward.indexOf('{') + 1).toReversed();
  const pullRequest = parseSelection(tokens).repository?.pullRequest;
  if (!pullRequest) throw new Error('structural guard parser found no repository { pullRequest } selection');
  return pullRequest;
}

const isFragment = (field: string) => field.startsWith('...');

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

/** Wrap a response so a read of any field it does not hold is recorded by dotted path. */
function tracked(value: unknown, path: string, absent: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => tracked(item, path, absent));
  if (value === null || typeof value !== 'object') return value;
  return new Proxy(value, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      if (!Reflect.has(target, prop)) absent.add(path + prop);
      return tracked(Reflect.get(target, prop), path + prop + '.', absent);
    },
  });
}

const refs = (size: number): PRRef[] =>
  Array.from({ length: size }, (_, i) => ({ owner: 'upstream', repo: 'project', number: i + 1, url: prUrl(i + 1) }));

const count = (text: string, char: string) => text.split(char).length - 1;

const variablesIn = (text: string) => new Set(text.match(/\$\w+/g));

describe('buildBatchQuery structural guard', () => {
  it.each([1, BATCH_SIZE])('balances every delimiter for a batch of %i', (size) => {
    const { query } = buildBatchQuery(refs(size));

    expect(count(query, '{')).toBe(count(query, '}'));
    expect(count(query, '(')).toBe(count(query, ')'));
    expect(count(query, '[')).toBe(count(query, ']'));
  });

  it('declares exactly the variables it uses and is given', () => {
    const { query, variables } = buildBatchQuery(refs(BATCH_SIZE));
    const bodyStart = query.indexOf('{');
    const declared = variablesIn(query.slice(0, bodyStart));

    expect(declared).toEqual(variablesIn(query.slice(bodyStart)));
    expect(declared).toEqual(new Set(Object.keys(variables).map((name) => '$' + name)));
  });

  it('selects every field normalizePRNode reads', () => {
    const selection = pullRequestSelection(buildBatchQuery(refs(1)).query);
    const absent = new Set<string>();

    const outcome = normalizePRNode(tracked(fakeVariants(selection)[0], '', absent) as never);

    expect(outcome.kind).toBe('ok');
    expect([...absent], 'read by normalizePRNode but missing from PR_FIELDS').toEqual([]);
  });

  it.each([
    ['aliases', '{ repository { pullRequest { first: title } } }'],
    ['named fragment spreads', '{ repository { pullRequest { ...prFields } } }'],
    ['directives', '{ repository { pullRequest { title @include(if: $x) } } }'],
    ['`edges` connections', '{ repository { pullRequest { comments { edges { node { body } } } } } }'],
  ])('names the parser as the limit when a query uses %s', (syntax, query) => {
    expect(() => pullRequestSelection(query)).toThrow(`structural guard parser does not support ${syntax}`);
  });
});
