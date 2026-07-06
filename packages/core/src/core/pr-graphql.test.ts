/**
 * Tests for the batched GraphQL PR enrichment path (pr-graphql.ts) and its
 * status parity with the REST path (pr-assembly.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { buildBatchQuery, normalizePRNode, batchFetchPRDetails, BATCH_SIZE, type PRRef } from './pr-graphql.js';
import { assembleFetchedPR, type PRSignals, type AssemblyConfig } from './pr-assembly.js';
import { computeCIStatus } from './ci-analysis.js';

const CONFIG: AssemblyConfig = {
  githubUsername: 'contributor',
  dormantThresholdDays: 30,
  approachingDormantDays: 25,
};

const ref = (owner: string, repo: string, number: number): PRRef => ({
  owner,
  repo,
  number,
  url: `https://github.com/${owner}/${repo}/pull/${number}`,
});

/** Minimal well-formed GraphQL PR node with sensible empty defaults. */
function makeNode(overrides: Record<string, unknown> = {}): any {
  return {
    databaseId: 12345,
    number: 7,
    title: 'Add feature',
    url: 'https://github.com/o/r/pull/7',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    body: '',
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-07T00:00:00Z',
    comments: { totalCount: 0, nodes: [] },
    reviews: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            oid: 'abc123',
            authoredDate: '2026-02-06T00:00:00Z',
            author: { user: { login: 'contributor' } },
            status: null,
            statusCheckRollup: null,
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('buildBatchQuery', () => {
  it('parameterizes owner/repo/number and aliases each PR', () => {
    const { query, variables } = buildBatchQuery([ref('facebook', 'react', 1), ref('vuejs', 'core', 42)]);

    // Aliases and variable references present
    expect(query).toContain('pr0: repository(owner: $o0, name: $r0)');
    expect(query).toContain('pullRequest(number: $n0)');
    expect(query).toContain('pr1: repository(owner: $o1, name: $r1)');
    expect(query).toContain('pullRequest(number: $n1)');
    expect(query).toContain('query batchPRDetails($o0: String!, $r0: String!, $n0: Int!');

    // Values travel as variables, never interpolated into the query body
    expect(variables).toEqual({
      o0: 'facebook',
      r0: 'react',
      n0: 1,
      o1: 'vuejs',
      r1: 'core',
      n1: 42,
    });
    expect(query).not.toContain('facebook');
    expect(query).not.toContain('vuejs');
  });
});

describe('normalizePRNode', () => {
  it('maps a clean node into REST-equivalent signals', () => {
    const node = makeNode({
      mergeable: 'CONFLICTING',
      body: 'Fixes #1',
      comments: {
        totalCount: 1,
        nodes: [{ author: { login: 'maintainer' }, body: 'please rebase', createdAt: '2026-02-03T00:00:00Z' }],
      },
      reviews: {
        totalCount: 1,
        nodes: [
          {
            databaseId: 900,
            state: 'CHANGES_REQUESTED',
            body: 'fix this',
            submittedAt: '2026-02-05T00:00:00Z',
            author: { login: 'maintainer' },
          },
        ],
      },
    });

    const outcome = normalizePRNode(node);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const d = outcome.data;

    expect(d.id).toBe(12345);
    expect(d.body).toBe('Fixes #1');
    expect(d.hasMergeConflict).toBe(true); // CONFLICTING
    expect(d.comments).toEqual([
      { user: { login: 'maintainer' }, body: 'please rebase', created_at: '2026-02-03T00:00:00Z' },
    ]);
    expect(d.reviews).toEqual([
      {
        user: { login: 'maintainer' },
        body: 'fix this',
        submitted_at: '2026-02-05T00:00:00Z',
        state: 'CHANGES_REQUESTED',
        id: 900,
      },
    ]);
    expect(d.commitInfo).toEqual({ date: '2026-02-06T00:00:00Z', author: 'contributor' });
    expect(d.headSha).toBe('abc123');
  });

  it('maps review threads to inline review comments with review + reply ids', () => {
    const node = makeNode({
      reviewThreads: {
        totalCount: 1,
        nodes: [
          {
            comments: {
              totalCount: 2,
              nodes: [
                {
                  databaseId: 1,
                  body: 'nit',
                  createdAt: '2026-02-04T00:00:00Z',
                  author: { login: 'maintainer' },
                  replyTo: null,
                  pullRequestReview: { databaseId: 900 },
                },
                {
                  databaseId: 2,
                  body: 'ack',
                  createdAt: '2026-02-04T01:00:00Z',
                  author: { login: 'contributor' },
                  replyTo: { databaseId: 1 },
                  pullRequestReview: { databaseId: 901 },
                },
              ],
            },
          },
        ],
      },
    });

    const outcome = normalizePRNode(node);
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.data.reviewComments).toEqual([
      {
        id: 1,
        user: { login: 'maintainer' },
        body: 'nit',
        created_at: '2026-02-04T00:00:00Z',
        in_reply_to_id: undefined,
        pull_request_review_id: 900,
      },
      {
        id: 2,
        user: { login: 'contributor' },
        body: 'ack',
        created_at: '2026-02-04T01:00:00Z',
        in_reply_to_id: 1,
        pull_request_review_id: 901,
      },
    ]);
  });

  it('drops PENDING (draft) reviews to match REST listReviews', () => {
    const node = makeNode({
      reviews: {
        totalCount: 2,
        nodes: [
          { databaseId: 1, state: 'PENDING', body: 'draft', submittedAt: null, author: { login: 'contributor' } },
          {
            databaseId: 2,
            state: 'APPROVED',
            body: '',
            submittedAt: '2026-02-05T00:00:00Z',
            author: { login: 'maintainer' },
          },
        ],
      },
    });
    const outcome = normalizePRNode(node);
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.data.reviews).toHaveLength(1);
    expect(outcome.data.reviews[0].state).toBe('APPROVED');
  });

  it('signals overflow when any connection exceeds its cap', () => {
    expect(normalizePRNode(makeNode({ comments: { totalCount: 101, nodes: [] } })).kind).toBe('overflow');
    expect(normalizePRNode(makeNode({ reviews: { totalCount: 51, nodes: [] } })).kind).toBe('overflow');
    expect(normalizePRNode(makeNode({ reviewThreads: { totalCount: 51, nodes: [] } })).kind).toBe('overflow');
    expect(
      normalizePRNode(
        makeNode({
          reviewThreads: { totalCount: 1, nodes: [{ comments: { totalCount: 21, nodes: [] } }] },
        }),
      ).kind,
    ).toBe('overflow');
  });

  it('signals overflow when the CI status-check rollup exceeds its cap', () => {
    // A failing check beyond the 100-context cap would otherwise be silently
    // dropped and mislabel the PR as passing — so overflow → REST.
    const node = makeNode({
      commits: {
        nodes: [
          {
            commit: {
              oid: 'abc',
              authoredDate: '2026-02-06T00:00:00Z',
              author: { user: { login: 'contributor' } },
              status: null,
              statusCheckRollup: { contexts: { totalCount: 101, nodes: [] } },
            },
          },
        ],
      },
    });
    expect(normalizePRNode(node).kind).toBe('overflow');
  });

  it('signals missing for a null node or a node without a databaseId', () => {
    expect(normalizePRNode(null).kind).toBe('missing');
    expect(normalizePRNode(undefined).kind).toBe('missing');
    expect(normalizePRNode(makeNode({ databaseId: null })).kind).toBe('missing');
  });

  it('maps check runs from the rollup and combined statuses from commit.status', () => {
    const node = makeNode({
      commits: {
        nodes: [
          {
            commit: {
              oid: 'abc',
              authoredDate: '2026-02-06T00:00:00Z',
              author: { user: { login: 'contributor' } },
              status: {
                state: 'SUCCESS',
                contexts: [{ context: 'ci/travis', state: 'SUCCESS', description: 'passed' }],
              },
              statusCheckRollup: {
                contexts: {
                  totalCount: 2,
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      name: 'build',
                      conclusion: 'FAILURE',
                      status: 'COMPLETED',
                      startedAt: '2026-02-06T00:00:00Z',
                    },
                    // StatusContext entries in the rollup are ignored here (read from commit.status)
                    { __typename: 'StatusContext', context: 'ci/travis', state: 'SUCCESS', description: 'passed' },
                  ],
                },
              },
            },
          },
        ],
      },
    });
    const outcome = normalizePRNode(node);
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    // Failing check run dominates -> failing
    expect(outcome.data.ciStatus.status).toBe('failing');
    expect(outcome.data.ciStatus.failingCheckNames).toEqual(['build']);
  });
});

describe('batchFetchPRDetails', () => {
  it('routes every PR to REST when the client has no graphql method', async () => {
    const octokit = {} as any;
    const refs = [ref('o', 'r', 1), ref('o', 'r', 2)];
    const result = await batchFetchPRDetails(octokit, refs);
    expect(result.resolved.size).toBe(0);
    expect(result.restFallbackUrls).toEqual(refs.map((r) => r.url));
  });

  it('resolves PRs returned by a successful batch query', async () => {
    const graphql = vi.fn().mockResolvedValue({
      pr0: { pullRequest: makeNode({ databaseId: 1 }) },
      pr1: { pullRequest: makeNode({ databaseId: 2 }) },
    });
    const octokit = { graphql } as any;
    const refs = [ref('o', 'r', 1), ref('o', 'r', 2)];

    const result = await batchFetchPRDetails(octokit, refs);
    expect(result.resolved.size).toBe(2);
    expect(result.resolved.get(refs[0].url)?.id).toBe(1);
    expect(result.restFallbackUrls).toEqual([]);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('falls back only the failed PR on a partial-data GraphQL error', async () => {
    // octokit's GraphqlResponseError attaches resolved aliases to `.data`.
    const err = Object.assign(new Error('one node errored'), {
      data: { pr0: { pullRequest: makeNode({ databaseId: 1 }) }, pr1: { pullRequest: null } },
    });
    const graphql = vi.fn().mockRejectedValue(err);
    const octokit = { graphql } as any;
    const refs = [ref('o', 'r', 1), ref('o', 'r', 2)];

    const result = await batchFetchPRDetails(octokit, refs);
    expect(result.resolved.size).toBe(1);
    expect(result.resolved.get(refs[0].url)?.id).toBe(1);
    expect(result.restFallbackUrls).toEqual([refs[1].url]);
  });

  it('falls back the whole batch on a non-partial GraphQL error', async () => {
    const graphql = vi.fn().mockRejectedValue(new Error('network blip'));
    const octokit = { graphql } as any;
    const refs = [ref('o', 'r', 1), ref('o', 'r', 2)];

    const result = await batchFetchPRDetails(octokit, refs);
    expect(result.resolved.size).toBe(0);
    expect(result.restFallbackUrls).toEqual(refs.map((r) => r.url));
  });

  it('routes cap-overflow PRs to REST while keeping clean PRs', async () => {
    const graphql = vi.fn().mockResolvedValue({
      pr0: { pullRequest: makeNode({ databaseId: 1, comments: { totalCount: 200, nodes: [] } }) },
      pr1: { pullRequest: makeNode({ databaseId: 2 }) },
    });
    const octokit = { graphql } as any;
    const refs = [ref('o', 'r', 1), ref('o', 'r', 2)];

    const result = await batchFetchPRDetails(octokit, refs);
    expect(result.resolved.size).toBe(1);
    expect(result.resolved.has(refs[1].url)).toBe(true);
    expect(result.restFallbackUrls).toEqual([refs[0].url]);
  });

  it('rethrows fatal (rate-limit / auth) errors', async () => {
    const err = Object.assign(new Error('Bad credentials'), { status: 401 });
    const graphql = vi.fn().mockRejectedValue(err);
    const octokit = { graphql } as any;

    await expect(batchFetchPRDetails(octokit, [ref('o', 'r', 1)])).rejects.toThrow('Bad credentials');
  });

  it('rethrows a GraphQL-native RATE_LIMITED error (HTTP 200, no status, errors[])', async () => {
    // GitHub's primary GraphQL rate limit: HTTP 200 with an errors[] entry and no
    // numeric status — must NOT be silently absorbed into the REST fallback.
    const err = Object.assign(new Error('API rate limit exceeded'), {
      errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for installation' }],
      data: null,
    });
    const graphql = vi.fn().mockRejectedValue(err);
    const octokit = { graphql } as any;

    await expect(batchFetchPRDetails(octokit, [ref('o', 'r', 1)])).rejects.toThrow('rate limit exceeded');
  });

  it('rethrows RATE_LIMITED even when partial data is attached', async () => {
    const err = Object.assign(new Error('rate limited mid-batch'), {
      errors: [{ type: 'RATE_LIMITED' }],
      data: { pr0: { pullRequest: makeNode({ databaseId: 1 }) }, pr1: { pullRequest: null } },
    });
    const graphql = vi.fn().mockRejectedValue(err);
    const octokit = { graphql } as any;

    await expect(batchFetchPRDetails(octokit, [ref('o', 'r', 1), ref('o', 'r', 2)])).rejects.toThrow(
      'rate limited mid-batch',
    );
  });

  it('splits large ref sets into multiple batches', async () => {
    const graphql = vi.fn().mockImplementation((_q: string, vars: Record<string, unknown>) => {
      // Echo back a node per alias present in the variables.
      const resp: Record<string, unknown> = {};
      let i = 0;
      while (`o${i}` in vars) {
        resp[`pr${i}`] = { pullRequest: makeNode({ databaseId: 1000 + i }) };
        i++;
      }
      return Promise.resolve(resp);
    });
    const octokit = { graphql } as any;
    const refs = Array.from({ length: BATCH_SIZE * 2 + 1 }, (_, i) => ref('o', 'r', i + 1));

    const result = await batchFetchPRDetails(octokit, refs);
    expect(result.resolved.size).toBe(refs.length);
    expect(graphql).toHaveBeenCalledTimes(3); // ceil(21/10)
  });
});

describe('GraphQL vs REST status parity', () => {
  /**
   * Same underlying PR, expressed once as a GraphQL node and once as
   * hand-written REST-equivalent signals. Both go through assembleFetchedPR;
   * the resulting FetchedPR must be identical. This is the acceptance criterion:
   * the transport must not change the computed status.
   */
  async function assembleFromGraphQL(node: any) {
    const outcome = normalizePRNode(node);
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    const d = outcome.data;
    const signals: PRSignals = {
      prUrl: 'https://github.com/o/r/pull/7',
      owner: 'o',
      repo: 'r',
      number: 7,
      id: d.id,
      title: d.title === '' ? 'PR' : d.title,
      body: d.body,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      hasMergeConflict: d.hasMergeConflict,
      comments: d.comments,
      reviews: d.reviews,
      reviewComments: d.reviewComments,
      ciStatus: d.ciStatus,
    };
    return assembleFetchedPR(signals, CONFIG, async () => d.commitInfo);
  }

  it('produces identical results for a changes-requested + failing-CI PR', async () => {
    const node = makeNode({
      title: 'PR',
      comments: {
        totalCount: 1,
        nodes: [{ author: { login: 'contributor' }, body: 'ready', createdAt: '2026-02-01T00:00:00Z' }],
      },
      reviews: {
        totalCount: 1,
        nodes: [
          {
            databaseId: 900,
            state: 'CHANGES_REQUESTED',
            body: 'please fix',
            submittedAt: '2026-02-05T00:00:00Z',
            author: { login: 'maintainer' },
          },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              oid: 'sha1',
              authoredDate: '2026-02-04T00:00:00Z', // before the review -> not addressed
              author: { user: { login: 'contributor' } },
              status: null,
              statusCheckRollup: {
                contexts: {
                  totalCount: 1,
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      name: 'test',
                      conclusion: 'FAILURE',
                      status: 'COMPLETED',
                      startedAt: '2026-02-05T01:00:00Z',
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    });

    const prGraphql = await assembleFromGraphQL(node);

    // Hand-written REST-equivalent signals for the SAME PR.
    const restSignals: PRSignals = {
      prUrl: 'https://github.com/o/r/pull/7',
      owner: 'o',
      repo: 'r',
      number: 7,
      id: 12345,
      title: 'PR',
      body: '',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-07T00:00:00Z',
      hasMergeConflict: false,
      comments: [{ user: { login: 'contributor' }, body: 'ready', created_at: '2026-02-01T00:00:00Z' }],
      reviews: [
        {
          user: { login: 'maintainer' },
          body: 'please fix',
          submitted_at: '2026-02-05T00:00:00Z',
          state: 'CHANGES_REQUESTED',
          id: 900,
        },
      ],
      reviewComments: [],
      ciStatus: computeCIStatus(
        [{ name: 'test', conclusion: 'failure', status: 'completed', started_at: '2026-02-05T01:00:00Z' }],
        { state: 'success', statuses: [] },
      ),
    };
    const prRest = await assembleFetchedPR(restSignals, CONFIG, async () => ({
      date: '2026-02-04T00:00:00Z',
      author: 'contributor',
    }));

    expect(prGraphql).toEqual(prRest);
    expect(prGraphql.status).toBe('needs_addressing');
    // The changes-requested review body also counts as an unresponded maintainer
    // comment, so needs_response is the primary reason; needs_changes/failing_ci
    // are secondary.
    expect(prGraphql.actionReason).toBe('needs_response');
    expect(prGraphql.actionReasons).toEqual(['needs_response', 'needs_changes', 'failing_ci']);
    expect(prGraphql.ciStatus).toBe('failing');
    expect(prGraphql.reviewDecision).toBe('changes_requested');
  });

  it('produces identical results for an approved + passing PR (merge conflict)', async () => {
    const node = makeNode({
      title: 'PR',
      mergeable: 'CONFLICTING',
      reviews: {
        totalCount: 1,
        nodes: [
          {
            databaseId: 5,
            state: 'APPROVED',
            body: 'lgtm',
            submittedAt: '2026-02-06T00:00:00Z',
            author: { login: 'maintainer' },
          },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              oid: 'sha2',
              authoredDate: '2026-02-06T00:00:00Z',
              author: { user: { login: 'contributor' } },
              status: { state: 'SUCCESS', contexts: [{ context: 'ci', state: 'SUCCESS', description: null }] },
              statusCheckRollup: null,
            },
          },
        ],
      },
    });
    const prGraphql = await assembleFromGraphQL(node);

    const restSignals: PRSignals = {
      prUrl: 'https://github.com/o/r/pull/7',
      owner: 'o',
      repo: 'r',
      number: 7,
      id: 12345,
      title: 'PR',
      body: '',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-07T00:00:00Z',
      hasMergeConflict: true,
      comments: [],
      reviews: [
        { user: { login: 'maintainer' }, body: 'lgtm', submitted_at: '2026-02-06T00:00:00Z', state: 'APPROVED', id: 5 },
      ],
      reviewComments: [],
      ciStatus: computeCIStatus([], {
        state: 'success',
        statuses: [{ context: 'ci', state: 'success', description: null }],
      }),
    };
    const prRest = await assembleFetchedPR(restSignals, CONFIG, async () => undefined);

    expect(prGraphql).toEqual(prRest);
    // Merge conflict takes priority in the needs_addressing tree.
    expect(prGraphql.status).toBe('needs_addressing');
    expect(prGraphql.actionReason).toBe('merge_conflict');
    expect(prGraphql.hasMergeConflict).toBe(true);
  });
});
