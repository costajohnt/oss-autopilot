/**
 * Tests for review-analysis.ts — review decision, comment detection, and self-reply filtering.
 */

import { describe, it, expect } from 'vitest';
import {
  determineReviewDecision,
  getLatestChangesRequestedDate,
  isAllSelfReplies,
  getInlineCommentBody,
  checkUnrespondedComments,
} from './review-analysis.js';

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

  it('should return review_required for COMMENTED-only reviews', () => {
    expect(determineReviewDecision([{ state: 'COMMENTED', user: { login: 'reviewer1' } }])).toBe('review_required');
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

  it('should be case-insensitive for username matching', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'TestUser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' }],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });
});
