/**
 * Tests for the batched GraphQL lookup of engaged issues (#1862): query
 * shape, chunking, the per-alias outcomes of full and partial responses, and
 * the errors that must rethrow.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildEngagedIssueQuery,
  lookupEngagedIssues,
  ENGAGED_LOOKUP_BATCH_SIZE,
  type EngagedIssueRef,
} from './engaged-issue-lookup.js';

function ref(number: number, owner = 'o', repo = 'r'): EngagedIssueRef {
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/issues/${number}` };
}

function issueNode(number: number) {
  return {
    number,
    __typename: 'Issue',
    url: `https://github.com/o/r/issues/${number}`,
    title: `Issue ${number}`,
    state: 'OPEN',
    updatedAt: '2026-03-01T00:00:00Z',
    author: { login: 'someone' },
    labels: { nodes: [{ name: 'bug' }] },
  };
}

/** A client whose single query resolves with `data`. */
function resolving(data: Record<string, unknown>) {
  const graphql = vi.fn().mockResolvedValue(data);
  return { octokit: { graphql } as any, graphql };
}

/** A client whose query rejects with `error`. */
function rejecting(error: unknown) {
  const graphql = vi.fn().mockRejectedValue(error);
  return { octokit: { graphql } as any, graphql };
}

/** octokit's GraphqlResponseError shape: the resolved aliases on `.data`, the per-alias errors on `.errors`. */
function partialError(data: Record<string, unknown>, errors: unknown[]) {
  return Object.assign(new Error('Request failed due to following response errors'), { data, errors });
}

describe('buildEngagedIssueQuery', () => {
  it('aliases one repository lookup per ref, parameterised rather than interpolated', () => {
    const { query, variables } = buildEngagedIssueQuery([ref(1), ref(2, 'other', 'repo')]);

    expect(variables).toEqual({ o0: 'o', r0: 'r', n0: 1, o1: 'other', r1: 'repo', n1: 2 });
    expect(query).toContain('$o0: String!, $r0: String!, $n0: Int!');
    expect(query).toContain('i0: repository(owner: $o0, name: $r0)');
    expect(query).toContain('i1: repository(owner: $o1, name: $r1)');
    expect(query).toContain('issueOrPullRequest(number: $n1)');
    expect(query).not.toContain('other');
  });

  it('asks for the fields the monitor reads: state, update time, author, title, labels', () => {
    const { query } = buildEngagedIssueQuery([ref(1)]);

    for (const field of ['__typename', 'state', 'updatedAt', 'author { login }', 'title', 'labels(first:']) {
      expect(query).toContain(field);
    }
  });
});

describe('lookupEngagedIssues', () => {
  it('makes no request for no refs', async () => {
    const { octokit, graphql } = resolving({});

    const outcomes = await lookupEngagedIssues(octokit, []);

    expect(outcomes.size).toBe(0);
    expect(graphql).not.toHaveBeenCalled();
  });

  it('splits the refs into queries of the batch size, aliased from i0 within each', async () => {
    const refs = Array.from({ length: ENGAGED_LOOKUP_BATCH_SIZE + 10 }, (_, i) => ref(i + 1));
    const graphql = vi.fn().mockImplementation((_q: string, vars: Record<string, unknown>) => {
      const data: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(vars)) {
        if (name.startsWith('n')) data[`i${name.slice(1)}`] = { issueOrPullRequest: issueNode(value as number) };
      }
      return Promise.resolve(data);
    });

    const outcomes = await lookupEngagedIssues({ graphql } as any, refs);

    expect(graphql).toHaveBeenCalledTimes(2);
    const secondVars = graphql.mock.calls[1][1] as Record<string, unknown>;
    expect(Object.keys(secondVars)).toHaveLength(30);
    expect(secondVars.n0).toBe(ENGAGED_LOOKUP_BATCH_SIZE + 1);
    expect(outcomes.size).toBe(refs.length);
    const last = outcomes.get(refs.at(-1)!.url);
    expect(last).toMatchObject({ kind: 'found', node: { number: ENGAGED_LOOKUP_BATCH_SIZE + 10 } });
  });

  it('reports an issue node as found, a pull request node by type, and a null node as gone', async () => {
    const { octokit } = resolving({
      i0: { issueOrPullRequest: issueNode(1) },
      i1: { issueOrPullRequest: { __typename: 'PullRequest' } },
      i2: { issueOrPullRequest: null },
      i3: null,
    });

    const outcomes = await lookupEngagedIssues(octokit, [ref(1), ref(2), ref(3), ref(4)]);

    expect(outcomes.get(ref(1).url)).toMatchObject({ kind: 'found', node: { number: 1, state: 'OPEN' } });
    expect(outcomes.get(ref(2).url)).toEqual({ kind: 'pull_request' });
    expect(outcomes.get(ref(3).url)).toEqual({ kind: 'gone', reason: 'not returned by GitHub' });
    expect(outcomes.get(ref(4).url)).toEqual({ kind: 'gone', reason: 'not returned by GitHub' });
  });

  it('keeps the resolved aliases of a partial response and reads NOT_FOUND as gone, other errors as failed', async () => {
    const { octokit } = rejecting(
      partialError({ i0: { issueOrPullRequest: issueNode(1) }, i1: { issueOrPullRequest: null }, i2: null }, [
        {
          type: 'NOT_FOUND',
          path: ['i1', 'issueOrPullRequest'],
          message: 'Could not resolve to an issue or pull request with the number of 2.',
        },
        { type: 'FORBIDDEN', path: ['i2'], message: 'Resource protected by organization SAML enforcement.' },
      ]),
    );

    const outcomes = await lookupEngagedIssues(octokit, [ref(1), ref(2), ref(3)]);

    expect(outcomes.get(ref(1).url)).toMatchObject({ kind: 'found' });
    expect(outcomes.get(ref(2).url)).toEqual({
      kind: 'gone',
      reason: 'NOT_FOUND: Could not resolve to an issue or pull request with the number of 2.',
    });
    expect(outcomes.get(ref(3).url)).toEqual({
      kind: 'failed',
      error: 'FORBIDDEN: Resource protected by organization SAML enforcement.',
    });
  });

  it('fails a null node of a partial response whose errors carry no path, instead of calling it gone', async () => {
    const { octokit } = rejecting(
      partialError({ i0: { issueOrPullRequest: issueNode(1) }, i1: { issueOrPullRequest: null } }, [
        { message: 'Something went wrong while executing your query. This may be the result of a timeout.' },
      ]),
    );

    const outcomes = await lookupEngagedIssues(octokit, [ref(1), ref(2)]);

    expect(outcomes.get(ref(1).url)).toMatchObject({ kind: 'found' });
    expect(outcomes.get(ref(2).url)).toEqual({
      kind: 'failed',
      error: 'GraphQL: Something went wrong while executing your query. This may be the result of a timeout.',
    });
  });

  it('fails every ref of a query that errored without partial data, and goes on to the next query', async () => {
    const refs = Array.from({ length: ENGAGED_LOOKUP_BATCH_SIZE + 1 }, (_, i) => ref(i + 1));
    const graphql = vi
      .fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ i0: { issueOrPullRequest: issueNode(ENGAGED_LOOKUP_BATCH_SIZE + 1) } });

    const outcomes = await lookupEngagedIssues({ graphql } as any, refs);

    expect(outcomes.get(refs[0].url)).toEqual({ kind: 'failed', error: 'network blip' });
    expect(outcomes.get(refs[ENGAGED_LOOKUP_BATCH_SIZE - 1].url)).toEqual({ kind: 'failed', error: 'network blip' });
    expect(outcomes.get(refs[ENGAGED_LOOKUP_BATCH_SIZE].url)).toMatchObject({ kind: 'found' });
  });

  it.each([
    ['an HTTP 429', Object.assign(new Error('API rate limit exceeded'), { status: 429 })],
    ['an HTTP 401', Object.assign(new Error('Bad credentials'), { status: 401 })],
    ['a GraphQL RATE_LIMITED error', Object.assign(new Error('rate limited'), { errors: [{ type: 'RATE_LIMITED' }] })],
    [
      'a RATE_LIMITED error that arrived with partial data',
      partialError({ i0: { issueOrPullRequest: issueNode(1) } }, [{ type: 'RATE_LIMITED', path: ['i1'] }]),
    ],
  ])('rethrows %s instead of failing the refs quietly', async (_label, error) => {
    const { octokit } = rejecting(error);

    await expect(lookupEngagedIssues(octokit, [ref(1), ref(2)])).rejects.toBe(error);
  });
});
