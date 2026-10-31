/**
 * Tests for review-analysis.ts — review decision, comment detection, and self-reply filtering.
 */

import { describe, it, expect } from 'vitest';
import {
  determineReviewDecision,
  getLatestChangesRequestedDate,
  isAllSelfReplies,
  getInlineCommentBody,
  reviewHasInlineComments,
  checkUnrespondedComments,
  getFirstMaintainerResponseAt,
  getLastMaintainerActivity,
} from './review-analysis.js';

describe('getFirstMaintainerResponseAt (#1461)', () => {
  it('returns undefined when there are no comments or reviews', () => {
    expect(getFirstMaintainerResponseAt([], [], 'contributor')).toBeUndefined();
  });

  it('returns undefined when the only activity is from the contributor', () => {
    const comments = [{ user: { login: 'contributor' }, created_at: '2025-06-02T00:00:00Z' }];
    expect(getFirstMaintainerResponseAt(comments, [], 'contributor')).toBeUndefined();
  });

  it('returns the earliest maintainer comment timestamp', () => {
    const comments = [
      { user: { login: 'contributor' }, created_at: '2025-06-01T00:00:00Z' },
      { user: { login: 'maintainer' }, created_at: '2025-06-03T00:00:00Z' },
      { user: { login: 'maintainer' }, created_at: '2025-06-02T00:00:00Z' },
    ];
    expect(getFirstMaintainerResponseAt(comments, [], 'contributor')).toBe('2025-06-02T00:00:00Z');
  });

  it('considers reviews and picks the earliest across comments and reviews', () => {
    const comments = [{ user: { login: 'maintainer' }, created_at: '2025-06-05T00:00:00Z' }];
    const reviews = [{ user: { login: 'reviewer' }, submitted_at: '2025-06-04T00:00:00Z' }];
    expect(getFirstMaintainerResponseAt(comments, reviews, 'contributor')).toBe('2025-06-04T00:00:00Z');
  });

  it('skips bot authors', () => {
    const comments = [
      { user: { login: 'codecov[bot]' }, created_at: '2025-06-01T00:00:00Z' },
      { user: { login: 'maintainer' }, created_at: '2025-06-03T00:00:00Z' },
    ];
    expect(getFirstMaintainerResponseAt(comments, [], 'contributor')).toBe('2025-06-03T00:00:00Z');
  });

  it('skips entries with missing authors or timestamps', () => {
    const comments = [{ user: null, created_at: '2025-06-01T00:00:00Z' }];
    const reviews = [{ user: { login: 'reviewer' }, submitted_at: null }];
    expect(getFirstMaintainerResponseAt(comments, reviews, 'contributor')).toBeUndefined();
  });

  it('matches the contributor username case-insensitively', () => {
    const comments = [{ user: { login: 'Contributor' }, created_at: '2025-06-01T00:00:00Z' }];
    expect(getFirstMaintainerResponseAt(comments, [], 'contributor')).toBeUndefined();
  });
  it('uses the dormancy-clock maintainer rule: issue comments need a maintainer association, reviews do not', () => {
    const comments = [
      { user: { login: 'drive-by' }, author_association: 'NONE', created_at: '2025-06-01T00:00:00Z' },
      { user: { login: 'codeowner' }, author_association: 'CONTRIBUTOR', created_at: '2025-06-02T00:00:00Z' },
      { user: { login: 'maint' }, author_association: 'MEMBER', created_at: '2025-06-05T00:00:00Z' },
    ];
    const reviews = [
      { user: { login: 'codeowner' }, author_association: 'CONTRIBUTOR', submitted_at: '2025-06-03T00:00:00Z' },
    ];
    expect(getFirstMaintainerResponseAt(comments, reviews, 'contributor')).toBe('2025-06-03T00:00:00Z');
    expect(getFirstMaintainerResponseAt(comments, [], 'contributor')).toBe('2025-06-05T00:00:00Z');
    // Agrees with the dormancy clock on the same timeline.
    expect(getLastMaintainerActivity(comments.slice(0, 2), [], [], [], 'contributor', '2025-05-01T00:00:00Z')).toEqual({
      lastMaintainerActivityAt: '2025-05-01T00:00:00Z',
      authorPingsSinceMaintainerActivity: 0,
    });
  });

  it('skips bots identified only by user type', () => {
    const comments = [{ user: { login: 'helper', type: 'Bot' }, created_at: '2025-06-01T00:00:00Z' }];
    expect(getFirstMaintainerResponseAt(comments, [], 'contributor')).toBeUndefined();
  });
});

describe('determineReviewDecision', () => {
  it('should return review_required when no reviews exist', () => {
    expect(determineReviewDecision([])).toBe('review_required');
  });

  it('should return approved when latest review is APPROVED', () => {
    expect(determineReviewDecision([{ state: 'APPROVED', user: { login: 'reviewer1' } }])).toBe('approved');
  });

  it('should return changes_requested when latest review is CHANGES_REQUESTED', () => {
    expect(determineReviewDecision([{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } }])).toBe(
      'changes_requested',
    );
  });

  it('should prioritize changes_requested over approved from different users', () => {
    const result = determineReviewDecision([
      { state: 'APPROVED', user: { login: 'reviewer1' } },
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer2' } },
    ]);
    expect(result).toBe('changes_requested');
  });

  it('should use latest review per user', () => {
    const result = determineReviewDecision([
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } },
      { state: 'APPROVED', user: { login: 'reviewer1' } },
    ]);
    expect(result).toBe('approved');
  });

  it('keeps CHANGES_REQUESTED when the same reviewer later leaves a COMMENTED review', () => {
    const result = determineReviewDecision([
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } },
      { state: 'COMMENTED', user: { login: 'reviewer1' } },
    ]);
    expect(result).toBe('changes_requested');
  });

  it('keeps APPROVED when the same reviewer later leaves a COMMENTED review', () => {
    const result = determineReviewDecision([
      { state: 'APPROVED', user: { login: 'reviewer1' } },
      { state: 'COMMENTED', user: { login: 'reviewer1' } },
    ]);
    expect(result).toBe('approved');
  });

  it('clears a reviewer verdict when their review is DISMISSED', () => {
    const result = determineReviewDecision([
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } },
      { state: 'DISMISSED', user: { login: 'reviewer1' } },
    ]);
    expect(result).toBe('review_required');
  });

  it('should return review_required for COMMENTED-only reviews', () => {
    expect(determineReviewDecision([{ state: 'COMMENTED', user: { login: 'reviewer1' } }])).toBe('review_required');
  });

  // #1840: a bot (e.g. an AI review bot) approving is not a maintainer approval.
  it.each([
    ['[bot] suffix', { login: 'coderabbitai[bot]' }],
    ['REST user.type Bot', { login: 'Copilot', type: 'Bot' }],
    ['-bot suffix', { login: 'miq-bot' }],
    ['-robot suffix', { login: 'k8s-ci-robot' }],
  ])('ignores an APPROVED review from a bot (%s)', (_label, user) => {
    expect(determineReviewDecision([{ state: 'APPROVED', user }])).toBe('review_required');
  });

  it('ignores a CHANGES_REQUESTED review from a bot', () => {
    expect(determineReviewDecision([{ state: 'CHANGES_REQUESTED', user: { login: 'coderabbitai[bot]' } }])).toBe(
      'review_required',
    );
  });

  it('reports changes_requested when a bot approves but a human requests changes', () => {
    const result = determineReviewDecision([
      { state: 'APPROVED', user: { login: 'coderabbitai[bot]', type: 'Bot' } },
      { state: 'CHANGES_REQUESTED', user: { login: 'maintainer' } },
    ]);
    expect(result).toBe('changes_requested');
  });

  it('still reports a human approval alongside a bot approval', () => {
    const result = determineReviewDecision([
      { state: 'APPROVED', user: { login: 'coderabbitai[bot]' } },
      { state: 'APPROVED', user: { login: 'maintainer' } },
    ]);
    expect(result).toBe('approved');
  });
});

describe('getLatestChangesRequestedDate', () => {
  it('should return undefined when no reviews', () => {
    expect(getLatestChangesRequestedDate([])).toBeUndefined();
  });

  it('should return undefined when no CHANGES_REQUESTED reviews', () => {
    expect(
      getLatestChangesRequestedDate([{ state: 'APPROVED', submitted_at: '2026-02-07T10:00:00Z' }]),
    ).toBeUndefined();
  });

  it('should return the date of a single CHANGES_REQUESTED review', () => {
    expect(getLatestChangesRequestedDate([{ state: 'CHANGES_REQUESTED', submitted_at: '2026-02-07T10:00:00Z' }])).toBe(
      '2026-02-07T10:00:00Z',
    );
  });

  it('should return the latest date when multiple CHANGES_REQUESTED reviews', () => {
    expect(
      getLatestChangesRequestedDate([
        { state: 'CHANGES_REQUESTED', submitted_at: '2026-02-06T10:00:00Z' },
        { state: 'CHANGES_REQUESTED', submitted_at: '2026-02-07T10:00:00Z' },
      ]),
    ).toBe('2026-02-07T10:00:00Z');
  });
});

describe('isAllSelfReplies', () => {
  it('should return false when review has no inline comments', () => {
    expect(isAllSelfReplies(999, [])).toBe(false);
  });

  it('should return false when comment starts a new thread', () => {
    const result = isAllSelfReplies(100, [
      {
        id: 1000,
        user: { login: 'maintainer' },
        body: 'New issue',
        created_at: '2026-02-07T10:00:00Z',
        pull_request_review_id: 100,
      },
    ]);
    expect(result).toBe(false);
  });

  it('should return true when all comments reply to same author', () => {
    const result = isAllSelfReplies(200, [
      {
        id: 1000,
        user: { login: 'maintainer' },
        body: 'Original',
        created_at: '2026-02-07T10:00:00Z',
        pull_request_review_id: 100,
      },
      {
        id: 1001,
        user: { login: 'maintainer' },
        body: 'Follow up',
        created_at: '2026-02-07T11:00:00Z',
        in_reply_to_id: 1000,
        pull_request_review_id: 200,
      },
    ]);
    expect(result).toBe(true);
  });

  it('should return false when self-reply contains a question mark (#498)', () => {
    const result = isAllSelfReplies(200, [
      {
        id: 1000,
        user: { login: 'maintainer' },
        body: "Shouldn't this be part of the previous condition only?",
        created_at: '2026-02-07T10:00:00Z',
        pull_request_review_id: 100,
      },
      {
        id: 1001,
        user: { login: 'maintainer' },
        body: 'Could you please elaborate on this?',
        created_at: '2026-02-25T10:00:00Z',
        in_reply_to_id: 1000,
        pull_request_review_id: 200,
      },
    ]);
    expect(result).toBe(false);
  });

  it('should return false when self-reply has null body (#498)', () => {
    const result = isAllSelfReplies(200, [
      {
        id: 1000,
        user: { login: 'maintainer' },
        body: 'Original comment',
        created_at: '2026-02-07T10:00:00Z',
        pull_request_review_id: 100,
      },
      {
        id: 1001,
        user: { login: 'maintainer' },
        body: null,
        created_at: '2026-02-07T11:00:00Z',
        in_reply_to_id: 1000,
        pull_request_review_id: 200,
      },
    ]);
    expect(result).toBe(false);
  });

  it('should return true when self-reply has no question mark', () => {
    const result = isAllSelfReplies(200, [
      {
        id: 1000,
        user: { login: 'maintainer' },
        body: 'Original comment',
        created_at: '2026-02-07T10:00:00Z',
        pull_request_review_id: 100,
      },
      {
        id: 1001,
        user: { login: 'maintainer' },
        body: 'Actually, I meant the other file too.',
        created_at: '2026-02-07T11:00:00Z',
        in_reply_to_id: 1000,
        pull_request_review_id: 200,
      },
    ]);
    expect(result).toBe(true);
  });

  it('should be case-insensitive when checking authors', () => {
    const result = isAllSelfReplies(200, [
      {
        id: 1000,
        user: { login: 'MikeMcQuaid' },
        body: 'Original',
        created_at: '2026-02-07T10:00:00Z',
        pull_request_review_id: 100,
      },
      {
        id: 1001,
        user: { login: 'mikemcquaid' },
        body: 'Follow up',
        created_at: '2026-02-07T11:00:00Z',
        in_reply_to_id: 1000,
        pull_request_review_id: 200,
      },
    ]);
    expect(result).toBe(true);
  });
});

describe('getInlineCommentBody', () => {
  it('should return undefined when no matching review comments', () => {
    expect(getInlineCommentBody(999, [])).toBeUndefined();
  });

  it('should return first non-empty body for the review', () => {
    const result = getInlineCommentBody(100, [
      { id: 1, user: null, body: '', created_at: '2026-02-07T10:00:00Z', pull_request_review_id: 100 },
      { id: 2, user: null, body: 'Actual comment', created_at: '2026-02-07T11:00:00Z', pull_request_review_id: 100 },
    ]);
    expect(result).toBe('Actual comment');
  });

  it('should not return comments from other reviews', () => {
    const result = getInlineCommentBody(100, [
      { id: 1, user: null, body: 'Wrong review', created_at: '2026-02-07T10:00:00Z', pull_request_review_id: 200 },
    ]);
    expect(result).toBeUndefined();
  });
});

describe('reviewHasInlineComments', () => {
  it('should return true when review has inline comments', () => {
    expect(
      reviewHasInlineComments(100, [
        { id: 1, user: null, body: 'Fix this', created_at: '2026-02-07T10:00:00Z', pull_request_review_id: 100 },
      ]),
    ).toBe(true);
  });

  it('should return false when review has no inline comments', () => {
    expect(reviewHasInlineComments(100, [])).toBe(false);
  });

  it('should return false when inline comments belong to different review', () => {
    expect(
      reviewHasInlineComments(100, [
        { id: 1, user: null, body: 'Fix this', created_at: '2026-02-07T10:00:00Z', pull_request_review_id: 200 },
      ]),
    ).toBe(false);
  });
});

describe('checkUnrespondedComments', () => {
  it('should return false when no comments or reviews', () => {
    const result = checkUnrespondedComments([], [], [], 'testuser');
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should return false when only user comments exist', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My comment', created_at: '2026-02-07T10:00:00Z' }],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should return true when maintainer commented after user', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T09:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Please fix this', created_at: '2026-02-07T10:00:00Z' },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('maintainer');
  });

  it('should return false when user replied after maintainer', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'maintainer' }, body: 'Fix this', created_at: '2026-02-07T09:00:00Z' },
        { user: { login: 'testuser' }, body: 'Fixed!', created_at: '2026-02-07T10:00:00Z' },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should skip bot comments', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T09:00:00Z' },
        { user: { login: 'codecov[bot]' }, body: 'Coverage report', created_at: '2026-02-07T10:00:00Z' },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should include CHANGES_REQUESTED review with empty body as actionable (#431)', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' }],
      [{ user: { login: 'reviewer' }, body: '', submitted_at: '2026-02-07T12:00:00Z', state: 'CHANGES_REQUESTED' }],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('reviewer');
    expect(result.lastMaintainerComment?.body).toBe('(requested changes via inline review comments)');
  });

  it('should detect maintainer self-reply with question as needing response (#498)', () => {
    const reviewComments = [
      {
        id: 1000,
        user: { login: 'stefan6419846' },
        body: "Shouldn't this be part of the previous condition only?",
        created_at: '2026-02-08T10:00:00Z',
        pull_request_review_id: 100,
      },
      {
        id: 1001,
        user: { login: 'stefan6419846' },
        body: 'Could you please elaborate on this?',
        created_at: '2026-02-25T10:00:00Z',
        in_reply_to_id: 1000,
        pull_request_review_id: 300,
      },
    ];
    const result = checkUnrespondedComments(
      [],
      [
        {
          user: { login: 'stefan6419846' },
          body: '',
          submitted_at: '2026-02-25T10:00:00Z',
          state: 'COMMENTED',
          id: 300,
        },
      ],
      reviewComments,
      'prauthor',
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('stefan6419846');
  });

  it('should be case-insensitive for username matching', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'TestUser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' }],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should NOT filter as acknowledgment when review has inline comments (#829)', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' }],
      [
        {
          user: { login: 'reviewer' },
          body: 'Looks good so far, some comments, thanks!',
          submitted_at: '2026-02-07T12:00:00Z',
          state: 'COMMENTED',
          id: 100,
        },
      ],
      [
        {
          id: 1000,
          user: { login: 'reviewer' },
          body: 'Please rename this variable for clarity',
          created_at: '2026-02-07T12:00:00Z',
          pull_request_review_id: 100,
        },
        {
          id: 1001,
          user: { login: 'reviewer' },
          body: 'This needs error handling',
          created_at: '2026-02-07T12:00:00Z',
          pull_request_review_id: 100,
        },
      ],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('reviewer');
  });

  it('should still filter pure acknowledgment review without inline comments (#829)', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' }],
      [
        {
          user: { login: 'reviewer' },
          body: 'Looks good, thanks!',
          submitted_at: '2026-02-07T12:00:00Z',
          state: 'APPROVED',
          id: 100,
        },
      ],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should still filter acknowledgment issue comments without review context (#829)', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Thanks, will review', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should filter ack review when inline comments belong to a different review (#829)', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' }],
      [
        {
          user: { login: 'reviewer' },
          body: 'Thanks for this!',
          submitted_at: '2026-02-07T12:00:00Z',
          state: 'COMMENTED',
          id: 100,
        },
      ],
      [
        {
          id: 1000,
          user: { login: 'reviewer' },
          body: 'Fix this',
          created_at: '2026-02-07T11:00:00Z',
          pull_request_review_id: 200,
        },
      ],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });
});

describe('getLastMaintainerActivity', () => {
  const created = '2026-01-01T00:00:00Z';

  it('falls back to createdAt when only the contributor has commented', () => {
    const comments = [
      { user: { login: 'contributor' }, created_at: '2026-02-01T00:00:00Z' },
      { user: { login: 'contributor' }, created_at: '2026-03-01T00:00:00Z' },
    ];
    expect(getLastMaintainerActivity(comments, [], [], [], 'contributor', created)).toEqual({
      lastMaintainerActivityAt: created,
      authorPingsSinceMaintainerActivity: 2,
    });
  });

  it("does not let the contributor's own ping reset the clock", () => {
    const comments = [
      { user: { login: 'maintainer' }, created_at: '2026-01-05T00:00:00Z' },
      { user: { login: 'Contributor' }, created_at: '2026-03-01T00:00:00Z' },
    ];
    const result = getLastMaintainerActivity(comments, [], [], [], 'contributor', created);
    expect(result.lastMaintainerActivityAt).toBe('2026-01-05T00:00:00Z');
    expect(result.authorPingsSinceMaintainerActivity).toBe(1);
  });

  it('ignores bots and counts reviews and inline review comments', () => {
    const comments = [{ user: { login: 'miq-bot' }, created_at: '2026-04-01T00:00:00Z' }];
    const reviews = [{ user: { login: 'maintainer' }, submitted_at: '2026-02-01T00:00:00Z' }];
    const reviewComments = [{ user: { login: 'reviewer' }, created_at: '2026-02-10T00:00:00Z' }];
    expect(
      getLastMaintainerActivity(comments, reviews, reviewComments, [], 'contributor', created).lastMaintainerActivityAt,
    ).toBe('2026-02-10T00:00:00Z');
  });

  it('counts maintainer commits and force-pushes as maintainer activity', () => {
    const events = [
      { login: 'contributor', at: '2026-09-01T00:00:00Z' },
      { login: 'maintainer', at: '2026-08-26T00:00:00Z' }, // maintainer commit
      { login: 'maintainer', type: 'User', at: '2026-10-26T00:00:00Z' }, // force-push
      { login: 'github-actions[bot]', type: 'Bot', at: '2026-10-28T00:00:00Z' },
    ];
    expect(getLastMaintainerActivity([], [], [], events, 'contributor', created).lastMaintainerActivityAt).toBe(
      '2026-10-26T00:00:00Z',
    );
  });

  it('only counts OWNER / MEMBER / COLLABORATOR issue comments when the association is known', () => {
    const comments = [
      { user: { login: 'maintainer' }, author_association: 'MEMBER', created_at: '2026-02-01T00:00:00Z' },
      { user: { login: 'drive-by' }, author_association: 'NONE', created_at: '2026-03-01T00:00:00Z' },
      { user: { login: 'other' }, author_association: 'CONTRIBUTOR', created_at: '2026-03-02T00:00:00Z' },
    ];
    expect(getLastMaintainerActivity(comments, [], [], [], 'contributor', created).lastMaintainerActivityAt).toBe(
      '2026-02-01T00:00:00Z',
    );
  });

  it('counts reviews and inline comments from CONTRIBUTOR-association reviewers (codeowners)', () => {
    // home-assistant/core#188805 shape: codeowner shown as CONTRIBUTOR.
    const reviews = [
      {
        user: { login: 'codeowner' },
        author_association: 'CONTRIBUTOR',
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-03-03T00:00:00Z',
      },
    ];
    const reviewComments = [
      { user: { login: 'codeowner' }, author_association: 'CONTRIBUTOR', created_at: '2026-03-04T00:00:00Z' },
    ];
    expect(getLastMaintainerActivity([], reviews, [], [], 'contributor', created).lastMaintainerActivityAt).toBe(
      '2026-03-03T00:00:00Z',
    );
    expect(
      getLastMaintainerActivity([], reviews, reviewComments, [], 'contributor', created).lastMaintainerActivityAt,
    ).toBe('2026-03-04T00:00:00Z');
  });

  it("counts pushes by a maintainer's own GitHub App but not auto-fixer or dependency bots", () => {
    // sooperset/mcp-atlassian#1597 shape: the author pinged, then the
    // maintainer's App pushed fixes; the clock must not fall back to createdAt.
    const comments = [{ user: { login: 'contributor' }, created_at: '2026-03-01T00:00:00Z' }];
    const events = [
      { login: 'mcp-atlassian-maintainer[bot]', type: 'Bot', at: '2026-03-01T01:30:00Z', isPush: true },
      { login: 'pre-commit-ci[bot]', type: 'Bot', at: '2026-03-05T00:00:00Z', isPush: true },
      { login: 'dependabot[bot]', type: 'Bot', at: '2026-03-06T00:00:00Z', isPush: true },
      { login: 'web-flow', at: '2026-03-07T00:00:00Z', isPush: true },
      { login: 'contributor', at: '2026-03-08T00:00:00Z', isPush: true },
    ];
    const result = getLastMaintainerActivity(comments, [], [], events, 'contributor', created);
    expect(result.lastMaintainerActivityAt).toBe('2026-03-01T01:30:00Z');
    expect(result.authorPingsSinceMaintainerActivity).toBe(0);
  });

  it('still ignores bots for non-push events such as labels and review requests', () => {
    const events = [{ login: 'triage-app[bot]', type: 'Bot', at: '2026-03-01T00:00:00Z' }];
    expect(getLastMaintainerActivity([], [], [], events, 'contributor', created).lastMaintainerActivityAt).toBe(
      created,
    );
  });

  it('falls back to any non-contributor non-bot author when the association is missing', () => {
    const comments = [{ user: { login: 'someone' }, created_at: '2026-03-01T00:00:00Z' }];
    expect(getLastMaintainerActivity(comments, [], [], [], 'contributor', created).lastMaintainerActivityAt).toBe(
      '2026-03-01T00:00:00Z',
    );
  });

  it('ignores REST user.type Bot and -robot accounts (Copilot, k8s-ci-robot)', () => {
    const reviewComments = [{ user: { login: 'Copilot', type: 'Bot' }, created_at: '2026-03-01T00:00:00Z' }];
    const comments = [{ user: { login: 'k8s-ci-robot', type: 'User' }, created_at: '2026-03-02T00:00:00Z' }];
    expect(
      getLastMaintainerActivity(comments, [], reviewComments, [], 'contributor', created).lastMaintainerActivityAt,
    ).toBe(created);
  });

  it('does not count a same-day reply to a maintainer as a ping', () => {
    // Maintainer comments, contributor replies 4h later (conversation), then
    // nudges once 10 days later: one real ping, not two.
    const comments = [
      { user: { login: 'maintainer' }, created_at: '2026-01-10T00:00:00Z' },
      { user: { login: 'contributor' }, created_at: '2026-01-10T04:00:00Z' },
      { user: { login: 'contributor' }, created_at: '2026-01-20T04:00:00Z' },
    ];
    expect(
      getLastMaintainerActivity(comments, [], [], [], 'contributor', created).authorPingsSinceMaintainerActivity,
    ).toBe(1);
  });

  it('requires a 7-day gap between consecutive pings', () => {
    const comments = [
      { user: { login: 'contributor' }, created_at: '2026-01-10T00:00:00Z' },
      { user: { login: 'contributor' }, created_at: '2026-01-12T00:00:00Z' },
      { user: { login: 'contributor' }, created_at: '2026-01-25T00:00:00Z' },
    ];
    expect(
      getLastMaintainerActivity(comments, [], [], [], 'contributor', created).authorPingsSinceMaintainerActivity,
    ).toBe(2);
  });

  it('only counts contributor pings after the last maintainer activity', () => {
    const comments = [
      { user: { login: 'contributor' }, created_at: '2026-01-02T00:00:00Z' },
      { user: { login: 'maintainer' }, created_at: '2026-01-03T00:00:00Z' },
      { user: { login: 'contributor' }, created_at: '2026-02-01T00:00:00Z' },
    ];
    expect(
      getLastMaintainerActivity(comments, [], [], [], 'contributor', created).authorPingsSinceMaintainerActivity,
    ).toBe(1);
  });
});

describe('checkUnrespondedComments bot filtering', () => {
  it('does not flag a needs-response for a user-account bot like miq-bot', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T09:00:00Z' },
        { user: { login: 'miq-bot' }, body: 'Checked commits: 1 offense detected', created_at: '2026-02-07T10:00:00Z' },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('does not flag a needs-response for a REST user.type Bot reviewer', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T09:00:00Z' }],
      [
        {
          user: { login: 'Copilot', type: 'Bot' },
          body: 'Consider renaming this',
          submitted_at: '2026-02-07T10:00:00Z',
          state: 'COMMENTED',
          id: 1,
        },
      ],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });
});

describe('checkUnrespondedComments REST bot type', () => {
  it('does not flag a needs-response for a REST user.type Bot reviewer', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T09:00:00Z' }],
      [
        {
          user: { login: 'Copilot', type: 'Bot' },
          body: 'Consider renaming this',
          submitted_at: '2026-02-07T10:00:00Z',
          state: 'COMMENTED',
          id: 1,
        },
      ],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });
});
