/**
 * Tests for determineStatus(): which unanswered maintainer comments their
 * author's approval settles (#1507, #1920), and the precedence of the status
 * branches around it.
 */

import { describe, it, expect } from 'vitest';
import { determineStatus } from './status-determination.js';
import type { DetermineStatusInput } from './types.js';

const APPROVED_AT = '2026-02-07T10:00:00Z';
const BEFORE_APPROVAL = '2026-02-06T10:00:00Z';
const AFTER_APPROVAL = '2026-02-08T10:00:00Z';

/** An approved, passing PR with an unanswered maintainer comment. */
function approvedWithComment(overrides: Partial<DetermineStatusInput> = {}) {
  return determineStatus({
    ciStatus: 'passing',
    hasMergeConflict: false,
    hasUnrespondedComment: true,
    hasIncompleteChecklist: false,
    reviewDecision: 'approved',
    daysSinceActivity: 2,
    dormantThreshold: 30,
    approachingThreshold: 25,
    ...overrides,
  });
}

/** One unanswered comment posted at `createdAt` whose author's standing approval is dated `authorApprovalDate`. */
function comment(createdAt: string, authorApprovalDate = APPROVED_AT) {
  return { lastMaintainerCommentDate: createdAt, unansweredComments: [{ createdAt, authorApprovalDate }] };
}

const PENDING_MERGE = { status: 'waiting_on_maintainer', waitReason: 'pending_merge', stalenessTier: 'active' };
const NEEDS_RESPONSE = {
  status: 'needs_addressing',
  actionReason: 'needs_response',
  stalenessTier: 'active',
  actionReasons: ['needs_response'],
};

describe("determineStatus: only the commenter's own later approval settles a comment (#1920)", () => {
  it.each(['passing', 'unknown'] as const)(
    "a comment after its author's approval needs a response (CI %s)",
    (ciStatus) => {
      expect(approvedWithComment({ ciStatus, ...comment(AFTER_APPROVAL) })).toEqual(NEEDS_RESPONSE);
    },
  );

  it.each(['passing', 'unknown'] as const)(
    "a comment older than its author's approval stays pending_merge (CI %s)",
    (ciStatus) => {
      expect(approvedWithComment({ ciStatus, ...comment(BEFORE_APPROVAL) })).toEqual(PENDING_MERGE);
    },
  );

  it("the approving review's own note (same timestamp) stays pending_merge (#1507)", () => {
    expect(approvedWithComment(comment(APPROVED_AT))).toEqual(PENDING_MERGE);
  });

  it('compares instants, not strings, across timezone offsets', () => {
    // 11:30+01:00 is 10:30Z: after the 10:00Z approval, though it sorts before "2026-02-07T10:..." as a string.
    expect(approvedWithComment(comment('2026-02-07T11:30:00+01:00'))).toEqual(NEEDS_RESPONSE);
    expect(approvedWithComment(comment('2026-02-07T10:30:00+01:00'))).toEqual(PENDING_MERGE);
  });

  it('one comment whose author did not approve keeps the rest from settling', () => {
    const unansweredComments = [
      { createdAt: BEFORE_APPROVAL },
      { createdAt: BEFORE_APPROVAL, authorApprovalDate: APPROVED_AT },
    ];
    expect(approvedWithComment({ unansweredComments, lastMaintainerCommentDate: BEFORE_APPROVAL })).toEqual(
      NEEDS_RESPONSE,
    );
  });

  it('several comments all followed by their authors approving stay pending_merge', () => {
    const unansweredComments = [
      { createdAt: BEFORE_APPROVAL, authorApprovalDate: APPROVED_AT },
      { createdAt: APPROVED_AT, authorApprovalDate: APPROVED_AT },
    ];
    expect(approvedWithComment({ unansweredComments, lastMaintainerCommentDate: APPROVED_AT })).toEqual(PENDING_MERGE);
  });

  it.each([
    ['no approval by the commenter', { unansweredComments: [{ createdAt: BEFORE_APPROVAL }] }],
    ['an unparseable approval date', comment(BEFORE_APPROVAL, 'garbage')],
    ['an unparseable comment date', comment('garbage')],
    ['no list of unanswered comments', { lastMaintainerCommentDate: BEFORE_APPROVAL }],
    ['an empty list of unanswered comments', { unansweredComments: [] }],
  ])('fails closed to needs_response with %s', (_name, overrides) => {
    expect(approvedWithComment(overrides)).toEqual(NEEDS_RESPONSE);
  });

  it('a commit pushed after the unsettled comment still reads changes_addressed', () => {
    expect(approvedWithComment({ ...comment(AFTER_APPROVAL), latestCommitDate: '2026-02-09T10:00:00Z' })).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'changes_addressed',
      stalenessTier: 'active',
    });
  });

  it('an unsettled comment and a merge conflict report both reasons, response first', () => {
    const result = approvedWithComment({ ...comment(AFTER_APPROVAL), hasMergeConflict: true });
    expect(result.actionReason).toBe('needs_response');
    expect(result.actionReasons).toEqual(['needs_response', 'merge_conflict']);
  });

  it('a settled comment adds no needs_response beside a merge conflict', () => {
    const result = approvedWithComment({ ...comment(BEFORE_APPROVAL), hasMergeConflict: true });
    expect(result.actionReason).toBe('merge_conflict');
    expect(result.actionReasons).toEqual(['merge_conflict']);
  });
});

describe('determineStatus: precedence of the primary status', () => {
  const COMMIT_AFTER = '2026-02-09T10:00:00Z';
  const unsettled = { hasUnrespondedComment: true, ...comment(AFTER_APPROVAL) };
  const settled = { hasUnrespondedComment: true, ...comment(BEFORE_APPROVAL) };
  const changesRequested = { reviewDecision: 'changes_requested', latestChangesRequestedDate: AFTER_APPROVAL } as const;
  const failing = { ciStatus: 'failing', hasActionableCIFailure: true } as const;
  const quiet = { hasUnrespondedComment: false };

  const rows: Array<[string, Partial<DetermineStatusInput>, string]> = [
    [
      'comment addressed by a commit, CI failing',
      { ...unsettled, ...failing, latestCommitDate: COMMIT_AFTER },
      'failing_ci',
    ],
    ['comment addressed by a commit', { ...unsettled, latestCommitDate: COMMIT_AFTER }, 'changes_addressed'],
    ['comment settled by its author approving', settled, 'pending_merge'],
    ['comment not settled by an approval', unsettled, 'needs_response'],
    ['unsettled comment beats failing CI', { ...unsettled, ...failing }, 'needs_response'],
    ['settled comment, but CI failing', { ...settled, ...failing }, 'needs_response'],
    ['comment beats a changes-requested review', { ...unsettled, ...changesRequested }, 'needs_response'],
    ['changes requested, no comment', { ...quiet, ...changesRequested }, 'needs_changes'],
    ['changes requested beats failing CI', { ...quiet, ...changesRequested, ...failing }, 'needs_changes'],
    ['failing CI beats a merge conflict', { ...quiet, ...failing, hasMergeConflict: true }, 'failing_ci'],
    ['merge conflict beats approval', { ...quiet, hasMergeConflict: true }, 'merge_conflict'],
    ['approved, nothing else', quiet, 'pending_merge'],
    ['not approved, nothing else', { ...quiet, reviewDecision: 'review_required' }, 'pending_review'],
  ];

  it.each(rows)('%s', (_name, overrides, expected) => {
    const result = approvedWithComment(overrides);
    expect(result.actionReason ?? result.waitReason).toBe(expected);
  });
});
