/**
 * Tests for whose comments make a PR need a response (#1921): issue comments
 * count only from accounts with standing on the PR, on both transports.
 */

import { describe, it, expect } from 'vitest';
import { assembleFetchedPR, type PRSignals, type AssemblyConfig, type AssemblyComment } from './pr-assembly.js';
import { normalizePRNode } from './pr-graphql.js';
import { checkUnrespondedComments } from './review-analysis.js';

const CONFIG: AssemblyConfig = { githubUsername: 'contributor', dormantThresholdDays: 30, approachingDormantDays: 25 };
const NUDGE = 'Any update on this?';

function daysAgo(n: number): string {
  const date = new Date(Date.now() - n * 86_400_000);
  return date.toISOString();
}

function signals(overrides: Partial<PRSignals> = {}): PRSignals {
  return {
    prUrl: 'https://github.com/o/r/pull/7',
    owner: 'o',
    repo: 'r',
    number: 7,
    id: 7,
    title: 'Fix thing',
    body: '',
    createdAt: daysAgo(60),
    updatedAt: daysAgo(5),
    hasMergeConflict: false,
    comments: [],
    reviews: [],
    reviewComments: [],
    ciStatus: { status: 'passing', failingCheckNames: [], failingCheckConclusions: new Map() },
    ...overrides,
  };
}

/** An issue comment posted 5 days ago; `association` undefined leaves the field off. */
function commentBy(login: string, association?: string | null, body = NUDGE): AssemblyComment {
  return { body, user: { login }, author_association: association, created_at: daysAgo(5) };
}

function reviewBy(login: string, state: string, association = 'MEMBER') {
  return { state, user: { login }, author_association: association, body: '', submitted_at: daysAgo(10), id: 1 };
}

const APPROVAL = reviewBy('maintainer', 'APPROVED');

/** An approved, passing PR with one later issue comment. */
function approvedWith(comment: AssemblyComment, reviews = [APPROVAL]) {
  return assembleFetchedPR(signals({ reviews, comments: [comment] }), CONFIG, undefined);
}

describe('issue comments count toward needs_response only from accounts with standing (#1921)', () => {
  it('a drive-by "any update?" from an account with no association leaves an approved PR pending_merge', async () => {
    const pr = await approvedWith(commentBy('passer-by', 'NONE'));
    expect(pr.hasUnrespondedComment).toBe(false);
    expect(pr.lastMaintainerComment).toBeUndefined();
    expect(pr.status).toBe('waiting_on_maintainer');
    expect(pr.waitReason).toBe('pending_merge');
    expect(pr.actionReasons).toBeUndefined();
  });

  it('the same comment from a MEMBER needs a response', async () => {
    const pr = await approvedWith(commentBy('other-maintainer', 'MEMBER'));
    expect(pr.lastMaintainerComment?.author).toBe('other-maintainer');
    expect(pr.actionReason).toBe('needs_response');
  });

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('a comment from a %s counts', async (association) => {
    const pr = await approvedWith(commentBy('someone', association));
    expect(pr.actionReason).toBe('needs_response');
  });

  it.each(['NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'CONTRIBUTOR', 'MANNEQUIN'])(
    'a comment from a %s who has not reviewed the PR does not count',
    async (association) => {
      const pr = await approvedWith(commentBy('someone', association));
      expect(pr.hasUnrespondedComment).toBe(false);
      expect(pr.waitReason).toBe('pending_merge');
    },
  );

  it.each([undefined, null])('a comment with no association data (%s) still counts', async (association) => {
    const pr = await approvedWith(commentBy('someone', association));
    expect(pr.actionReason).toBe('needs_response');
  });

  it.each(['APPROVED', 'CHANGES_REQUESTED'])(
    'a comment from a CONTRIBUTOR whose review on the PR is %s counts',
    async (state) => {
      const pr = await approvedWith(commentBy('codeowner', 'CONTRIBUTOR'), [
        APPROVAL,
        reviewBy('CodeOwner', state, 'CONTRIBUTOR'),
      ]);
      expect(pr.lastMaintainerComment?.author).toBe('codeowner');
      expect(pr.actionReasons).toContain('needs_response');
    },
  );

  it('a CONTRIBUTOR who only left a comment-only review gains no standing for issue comments', async () => {
    const pr = await approvedWith(commentBy('reader', 'CONTRIBUTOR'), [
      APPROVAL,
      { ...reviewBy('reader', 'COMMENTED', 'CONTRIBUTOR'), body: 'Thanks!', submitted_at: daysAgo(20) },
    ]);
    expect(pr.hasUnrespondedComment).toBe(false);
    expect(pr.waitReason).toBe('pending_merge');
  });

  it('a review from an account with no association still counts: reviews are unchanged', async () => {
    const question = { ...reviewBy('reader', 'COMMENTED', 'NONE'), body: 'Why not reuse the helper here?' };
    const pr = await assembleFetchedPR(
      signals({ reviews: [APPROVAL, { ...question, submitted_at: daysAgo(5), id: 2 }] }),
      CONFIG,
      undefined,
    );
    expect(pr.lastMaintainerComment?.author).toBe('reader');
    expect(pr.actionReason).toBe('needs_response');
  });

  it('bots stay excluded whatever their association', async () => {
    const pr = await approvedWith(commentBy('helper[bot]', 'MEMBER'));
    expect(pr.hasUnrespondedComment).toBe(false);
    expect(pr.waitReason).toBe('pending_merge');
  });

  it('a drive-by comment on an unreviewed PR leaves it pending_review', async () => {
    const pr = await approvedWith(commentBy('passer-by', 'NONE'), []);
    expect(pr.status).toBe('waiting_on_maintainer');
    expect(pr.waitReason).toBe('pending_review');
  });

  it('a later drive-by comment does not replace or hide a maintainer question', async () => {
    const pr = await assembleFetchedPR(
      signals({
        comments: [
          { ...commentBy('maintainer', 'MEMBER', 'Can you add a test for the empty case?'), created_at: daysAgo(8) },
          commentBy('passer-by', 'NONE'),
        ],
      }),
      CONFIG,
      undefined,
    );
    expect(pr.lastMaintainerComment?.author).toBe('maintainer');
    expect(pr.actionReason).toBe('needs_response');
  });

  it('the dormancy clock ignores the drive-by comment, as before', async () => {
    const pr = await assembleFetchedPR(signals({ comments: [commentBy('passer-by', 'NONE')] }), CONFIG, undefined);
    expect(pr.lastMaintainerActivityAt).toBe(pr.createdAt);
    expect(pr.stalenessTier).toBe('dormant');
  });
});

describe('checkUnrespondedComments lists only comments from accounts with standing (#1921)', () => {
  it('skips the passer-by and keeps the maintainer', () => {
    const result = checkUnrespondedComments(
      [
        { ...commentBy('maintainer', 'OWNER', 'Does this handle Windows paths?'), created_at: '2026-02-01T00:00:00Z' },
        { ...commentBy('passer-by', 'NONE'), created_at: '2026-02-02T00:00:00Z' },
      ],
      [],
      [],
      'contributor',
    );
    expect(result.unrespondedComments).toEqual([{ author: 'maintainer', createdAt: '2026-02-01T00:00:00Z' }]);
    expect(result.lastMaintainerComment?.author).toBe('maintainer');
  });

  it("a passer-by's comment after the author's reply does not reopen the thread", () => {
    const result = checkUnrespondedComments(
      [
        { ...commentBy('maintainer', 'OWNER', 'Does this handle Windows paths?'), created_at: '2026-02-01T00:00:00Z' },
        {
          ...commentBy('contributor', 'CONTRIBUTOR', 'Yes, covered by the new test.'),
          created_at: '2026-02-02T00:00:00Z',
        },
        { ...commentBy('passer-by', 'NONE'), created_at: '2026-02-03T00:00:00Z' },
      ],
      [],
      [],
      'contributor',
    );
    expect(result.hasUnrespondedComment).toBe(false);
    expect(result.unrespondedComments).toEqual([]);
  });
});

/** A GraphQL PR node approved by a MEMBER, with one later issue comment carrying `authorAssociation`. */
function graphqlNode(authorAssociation: string | null): Parameters<typeof normalizePRNode>[0] {
  return {
    databaseId: 7,
    number: 7,
    title: 'Fix thing',
    url: 'https://github.com/o/r/pull/7',
    mergeable: 'MERGEABLE',
    body: '',
    createdAt: daysAgo(60),
    updatedAt: daysAgo(5),
    comments: {
      totalCount: 1,
      nodes: [
        { authorAssociation, author: { login: 'someone', __typename: 'User' }, body: NUDGE, createdAt: daysAgo(5) },
      ],
    },
    reviews: {
      totalCount: 1,
      nodes: [
        {
          databaseId: 1,
          state: 'APPROVED',
          body: '',
          submittedAt: daysAgo(10),
          author: { login: 'maintainer', __typename: 'User' },
          authorAssociation: 'MEMBER',
        },
      ],
    },
    reviewThreads: { totalCount: 0, nodes: [] },
    commits: { nodes: [] },
  };
}

async function assembleFromGraphql(authorAssociation: string | null) {
  const outcome = normalizePRNode(graphqlNode(authorAssociation));
  if (outcome.kind !== 'ok') throw new Error('expected the node to normalize');
  const { hasMergeConflict, commitInfo, ...data } = outcome.data;
  return assembleFetchedPR(signals({ ...data, hasMergeConflict: hasMergeConflict === true }), CONFIG, commitInfo);
}

describe('GraphQL transport carries the association to the same rule (#1921)', () => {
  it('a drive-by comment (NONE) leaves an approved PR pending_merge', async () => {
    const pr = await assembleFromGraphql('NONE');
    expect(pr.reviewDecision).toBe('approved');
    expect(pr.hasUnrespondedComment).toBe(false);
    expect(pr.waitReason).toBe('pending_merge');
  });

  it('the same comment from a MEMBER needs a response', async () => {
    const pr = await assembleFromGraphql('MEMBER');
    expect(pr.actionReason).toBe('needs_response');
  });

  it('a comment whose association GitHub did not return still counts', async () => {
    const pr = await assembleFromGraphql(null);
    expect(pr.actionReason).toBe('needs_response');
  });
});
