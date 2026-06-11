/**
 * Tests for deterministic issue verification (#1353, #1354).
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyIssueAvailability, fetchIssueVerification, type VerifiedLinkedPR } from './issue-verification.js';
import type { Octokit } from '@octokit/rest';

const USER = 'octocat';

function pr(overrides: Partial<VerifiedLinkedPR>): VerifiedLinkedPR {
  return {
    number: 1,
    url: 'https://github.com/foo/bar/pull/1',
    title: 'a pr',
    state: 'open',
    isDraft: false,
    author: 'someone-else',
    isOwn: false,
    linkType: 'cross-referenced',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function classify(overrides: Partial<Parameters<typeof classifyIssueAvailability>[0]>) {
  return classifyIssueAvailability({
    state: 'open',
    stateReason: null,
    assignees: [],
    linkedPRs: [],
    userLogin: USER,
    ...overrides,
  });
}

describe('classifyIssueAvailability', () => {
  it('closed (completed) short-circuits everything else', () => {
    const result = classify({
      state: 'closed',
      stateReason: 'completed',
      linkedPRs: [pr({ linkType: 'closing', isOwn: true, author: USER })],
    });
    expect(result.verdict).toBe('closed');
    expect(result.verdictReason).toMatch(/mark it done/);
  });

  it('closed (not_planned) recommends permanent drop', () => {
    const result = classify({ state: 'closed', stateReason: 'not_planned' });
    expect(result.verdict).toBe('closed');
    expect(result.verdictReason).toMatch(/not planned.*permanently/);
  });

  it("the user's own open closing PR wins over a competitor's (#1354)", () => {
    const result = classify({
      linkedPRs: [
        pr({ linkType: 'closing', state: 'open', author: 'rival', isOwn: false }),
        pr({
          linkType: 'closing',
          state: 'open',
          author: 'OctoCat',
          isOwn: true,
          url: 'https://github.com/foo/bar/pull/9',
        }),
      ],
    });
    expect(result.verdict).toBe('own-open-pr');
    expect(result.verdictReason).toContain('pull/9');
  });

  it("someone else's open closing PR is taken", () => {
    const result = classify({
      linkedPRs: [pr({ linkType: 'closing', state: 'open', author: 'rival' })],
    });
    expect(result.verdict).toBe('taken');
    expect(result.verdictReason).toContain('rival');
  });

  it('an open cross-referenced PR is NOT taken — at-risk only (#1353)', () => {
    const result = classify({
      linkedPRs: [pr({ linkType: 'cross-referenced', state: 'open' })],
    });
    expect(result.verdict).toBe('at-risk');
    expect(result.verdictReason).toMatch(/mention only, not a claim/);
  });

  it('assignment to another user is taken', () => {
    const result = classify({ assignees: ['rival'] });
    expect(result.verdict).toBe('taken');
    expect(result.verdictReason).toContain('rival');
  });

  it('assignment to the user themself is not taken, and the reason says so', () => {
    const result = classify({ assignees: ['OctoCat'] });
    expect(result.verdict).toBe('available');
    expect(result.verdictReason).toMatch(/assigned to you/);
  });

  it('own open closing PR wins over assignment to someone else', () => {
    const result = classify({
      assignees: ['rival'],
      linkedPRs: [pr({ linkType: 'closing', state: 'open', author: USER, isOwn: true })],
    });
    expect(result.verdict).toBe('own-open-pr');
  });

  it('a reopened OPEN issue is available — never infer closed from stateReason', () => {
    const result = classify({ state: 'open', stateReason: 'reopened' });
    expect(result.verdict).toBe('available');
  });

  it("a rival's DRAFT closing PR still counts as taken (a draft is still a claim)", () => {
    const result = classify({
      linkedPRs: [pr({ linkType: 'closing', state: 'open', isDraft: true, author: 'rival' })],
    });
    expect(result.verdict).toBe('taken');
  });

  it('a merged closing PR on a still-open issue is at-risk', () => {
    const result = classify({
      linkedPRs: [pr({ linkType: 'closing', state: 'merged' })],
    });
    expect(result.verdict).toBe('at-risk');
    expect(result.verdictReason).toMatch(/merged.*awaiting issue close/);
  });

  it('closed and merged cross-referenced PRs do not affect availability', () => {
    const result = classify({
      linkedPRs: [
        pr({ linkType: 'cross-referenced', state: 'closed' }),
        pr({ linkType: 'cross-referenced', state: 'merged' }),
        pr({ linkType: 'closing', state: 'closed' }),
      ],
    });
    expect(result.verdict).toBe('available');
  });

  it('a ghost-authored open closing PR is taken (cannot be proven own)', () => {
    const result = classify({
      linkedPRs: [pr({ linkType: 'closing', state: 'open', author: null, isOwn: false })],
    });
    expect(result.verdict).toBe('taken');
    expect(result.verdictReason).toContain('unknown author');
  });

  it('clean open issue is available', () => {
    const result = classify({});
    expect(result.verdict).toBe('available');
  });
});

describe('fetchIssueVerification', () => {
  const ISSUE_NUMBER = 42;

  function graphqlResponse(issueOverrides: Record<string, unknown> = {}, viewerLogin = USER) {
    return {
      viewer: { login: viewerLogin },
      repository: {
        issue: {
          number: ISSUE_NUMBER,
          title: 'Fix the thing',
          url: `https://github.com/foo/bar/issues/${ISSUE_NUMBER}`,
          state: 'OPEN',
          stateReason: null,
          closedAt: null,
          assignees: { nodes: [] },
          timelineItems: { nodes: [] },
          ...issueOverrides,
        },
      },
    };
  }

  function fakeOctokit(response: unknown): Octokit {
    return { graphql: vi.fn().mockResolvedValue(response) } as unknown as Octokit;
  }

  const params = { owner: 'foo', repo: 'bar', number: ISSUE_NUMBER };

  it('classifies a closing reference to this issue in this repo as closing', async () => {
    const octokit = fakeOctokit(
      graphqlResponse({
        timelineItems: {
          nodes: [
            {
              source: {
                number: 7,
                url: 'https://github.com/foo/bar/pull/7',
                title: 'fixes it',
                state: 'OPEN',
                isDraft: false,
                updatedAt: '2026-06-01T00:00:00Z',
                author: { login: 'rival' },
                closingIssuesReferences: {
                  nodes: [{ number: ISSUE_NUMBER, repository: { nameWithOwner: 'Foo/Bar' } }],
                },
              },
            },
          ],
        },
      }),
    );

    const result = await fetchIssueVerification(octokit, params);
    expect(result.linkedPRs).toHaveLength(1);
    expect(result.linkedPRs[0].linkType).toBe('closing');
    expect(result.verdict).toBe('taken');
  });

  it('a closing reference to the same number in a DIFFERENT repo is only a mention', async () => {
    const octokit = fakeOctokit(
      graphqlResponse({
        timelineItems: {
          nodes: [
            {
              source: {
                number: 7,
                url: 'https://github.com/other/repo/pull/7',
                title: 'broader work',
                state: 'OPEN',
                isDraft: false,
                updatedAt: null,
                author: { login: 'rival' },
                closingIssuesReferences: {
                  nodes: [{ number: ISSUE_NUMBER, repository: { nameWithOwner: 'other/repo' } }],
                },
              },
            },
          ],
        },
      }),
    );

    const result = await fetchIssueVerification(octokit, params);
    expect(result.linkedPRs[0].linkType).toBe('cross-referenced');
    expect(result.verdict).toBe('at-risk');
  });

  it('detects the authenticated user as PR owner case-insensitively', async () => {
    const octokit = fakeOctokit(
      graphqlResponse(
        {
          timelineItems: {
            nodes: [
              {
                source: {
                  number: 8,
                  url: 'https://github.com/foo/bar/pull/8',
                  title: 'my fix',
                  state: 'OPEN',
                  isDraft: true,
                  updatedAt: null,
                  author: { login: 'OctoCat' },
                  closingIssuesReferences: {
                    nodes: [{ number: ISSUE_NUMBER, repository: { nameWithOwner: 'foo/bar' } }],
                  },
                },
              },
            ],
          },
        },
        'octocat',
      ),
    );

    const result = await fetchIssueVerification(octokit, params);
    expect(result.linkedPRs[0].isOwn).toBe(true);
    expect(result.verdict).toBe('own-open-pr');
    expect(result.userLogin).toBe('octocat');
  });

  it('dedupes the same PR appearing in multiple timeline events', async () => {
    const event = {
      source: {
        number: 7,
        url: 'https://github.com/foo/bar/pull/7',
        title: 'fixes it',
        state: 'MERGED',
        isDraft: false,
        updatedAt: null,
        author: { login: 'rival' },
        closingIssuesReferences: { nodes: [] },
      },
    };
    const octokit = fakeOctokit(graphqlResponse({ timelineItems: { nodes: [event, event] } }));

    const result = await fetchIssueVerification(octokit, params);
    expect(result.linkedPRs).toHaveLength(1);
    expect(result.linkedPRs[0].state).toBe('merged');
  });

  it('skips non-PR cross-reference sources (issues come back without state)', async () => {
    const octokit = fakeOctokit(
      graphqlResponse({
        timelineItems: { nodes: [{ source: {} }, { source: null }, null] },
      }),
    );

    const result = await fetchIssueVerification(octokit, params);
    expect(result.linkedPRs).toEqual([]);
    expect(result.verdict).toBe('available');
  });

  it('maps closed state, stateReason, closedAt, and assignees', async () => {
    const octokit = fakeOctokit(
      graphqlResponse({
        state: 'CLOSED',
        stateReason: 'NOT_PLANNED',
        closedAt: '2026-06-04T00:00:00Z',
        assignees: { nodes: [{ login: 'a' }, null, { login: 'b' }] },
      }),
    );

    const result = await fetchIssueVerification(octokit, params);
    expect(result.state).toBe('closed');
    expect(result.stateReason).toBe('not_planned');
    expect(result.closedAt).toBe('2026-06-04T00:00:00Z');
    expect(result.assignees).toEqual(['a', 'b']);
    expect(result.verdict).toBe('closed');
  });

  it('throws ValidationError when the issue does not exist', async () => {
    const octokit = fakeOctokit({ viewer: { login: USER }, repository: { issue: null } });
    await expect(fetchIssueVerification(octokit, params)).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringContaining('foo/bar#42'),
    });
  });

  it('paginates the timeline until hasNextPage is false and merges all pages', async () => {
    const mkEvent = (n: number, closing: boolean) => ({
      source: {
        number: n,
        url: `https://github.com/foo/bar/pull/${n}`,
        title: `pr ${n}`,
        state: 'OPEN',
        isDraft: false,
        updatedAt: null,
        author: { login: 'rival' },
        closingIssuesReferences: {
          nodes: closing ? [{ number: ISSUE_NUMBER, repository: { nameWithOwner: 'foo/bar' } }] : [],
        },
      },
    });
    const page1 = graphqlResponse({
      timelineItems: {
        pageInfo: { hasNextPage: true, endCursor: 'CURSOR-1' },
        nodes: [mkEvent(1, false)],
      },
    });
    const page2 = graphqlResponse({
      timelineItems: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [mkEvent(2, true)], // the claiming PR arrives on the LAST page
      },
    });
    const graphql = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const octokit = { graphql } as unknown as Octokit;

    const result = await fetchIssueVerification(octokit, params);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[0][1]).toMatchObject({ after: null });
    expect(graphql.mock.calls[1][1]).toMatchObject({ after: 'CURSOR-1' });
    expect(result.linkedPRs).toHaveLength(2);
    expect(result.verdict).toBe('taken');
  });

  it('fails loudly instead of verifying on a truncated timeline', async () => {
    const endlessPage = graphqlResponse({
      timelineItems: { pageInfo: { hasNextPage: true, endCursor: 'NEXT' }, nodes: [] },
    });
    const octokit = { graphql: vi.fn().mockResolvedValue(endlessPage) } as unknown as Octokit;
    await expect(fetchIssueVerification(octokit, params)).rejects.toThrow(/truncated timeline/);
  });

  it('does not convert a nested NOT_FOUND (deleted cross-referenced repo) into "issue not found"', async () => {
    const gqlError = Object.assign(new Error('nested not found'), {
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue', 'timelineItems', 'nodes', 3, 'source'] }],
    });
    const octokit = { graphql: vi.fn().mockRejectedValue(gqlError) } as unknown as Octokit;
    await expect(fetchIssueVerification(octokit, params)).rejects.toThrow('nested not found');
  });

  it('converts an all-NOT_FOUND GraphQL error into ValidationError', async () => {
    const gqlError = Object.assign(new Error('Could not resolve to an Issue with the number of 42.'), {
      errors: [
        {
          type: 'NOT_FOUND',
          path: ['repository', 'issue'],
          message: 'Could not resolve to an Issue with the number of 42.',
        },
      ],
    });
    const octokit = { graphql: vi.fn().mockRejectedValue(gqlError) } as unknown as Octokit;
    await expect(fetchIssueVerification(octokit, params)).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringContaining('foo/bar#42'),
    });
  });

  it('does not convert mixed or non-NOT_FOUND GraphQL errors', async () => {
    const gqlError = Object.assign(new Error('partial failure'), {
      errors: [{ type: 'NOT_FOUND' }, { type: 'RATE_LIMITED' }],
    });
    const octokit = { graphql: vi.fn().mockRejectedValue(gqlError) } as unknown as Octokit;
    await expect(fetchIssueVerification(octokit, params)).rejects.toThrow('partial failure');
  });

  it('propagates GraphQL errors instead of degrading', async () => {
    const boom = new Error('API rate limit exceeded');
    const octokit = { graphql: vi.fn().mockRejectedValue(boom) } as unknown as Octokit;
    await expect(fetchIssueVerification(octokit, params)).rejects.toThrow(/rate limit/);
  });
});
