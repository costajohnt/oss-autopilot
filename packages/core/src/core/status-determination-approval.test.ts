/**
 * Tests for determineStatus(): which unanswered maintainer comments an approval
 * settles (#1507, #1920), and the precedence of the status branches around it.
 */

import { describe, it, expect } from 'vitest';
import { determineStatus } from './status-determination.js';
import type { DetermineStatusInput } from './types.js';

const APPROVED_AT = '2026-02-07T10:00:00Z';
const BEFORE_APPROVAL = '2026-02-06T10:00:00Z';
const AFTER_APPROVAL = '2026-02-08T10:00:00Z';

/** An approved, passing PR with an unanswered maintainer comment; each test sets the dates. */
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
    latestApprovalDate: APPROVED_AT,
    ...overrides,
  });
}

const PENDING_MERGE = { status: 'waiting_on_maintainer', waitReason: 'pending_merge', stalenessTier: 'active' };
const NEEDS_RESPONSE = {
  status: 'needs_addressing',
  actionReason: 'needs_response',
  stalenessTier: 'active',
  actionReasons: ['needs_response'],
};

describe('determineStatus: an approval settles only comments no newer than it (#1920)', () => {
  it.each(['passing', 'unknown'] as const)(
    'a maintainer comment after the approval needs a response (CI %s)',
    (ciStatus) => {
      expect(approvedWithComment({ ciStatus, lastMaintainerCommentDate: AFTER_APPROVAL })).toEqual(NEEDS_RESPONSE);
    },
  );

  it.each(['passing', 'unknown'] as const)(
    'a comment older than the approval stays pending_merge (CI %s)',
    (ciStatus) => {
      expect(approvedWithComment({ ciStatus, lastMaintainerCommentDate: BEFORE_APPROVAL })).toEqual(PENDING_MERGE);
    },
  );

  it("the approving review's own note (same timestamp) stays pending_merge (#1507)", () => {
    expect(approvedWithComment({ lastMaintainerCommentDate: APPROVED_AT })).toEqual(PENDING_MERGE);
  });

  it('compares instants, not strings, across timezone offsets', () => {
    // 11:30+01:00 is 10:30Z: after the 10:00Z approval, though it sorts before "2026-02-07T10:..." as a string.
    expect(approvedWithComment({ lastMaintainerCommentDate: '2026-02-07T11:30:00+01:00' })).toEqual(NEEDS_RESPONSE);
    expect(approvedWithComment({ lastMaintainerCommentDate: '2026-02-07T10:30:00+01:00' })).toEqual(PENDING_MERGE);
  });

  it.each([
    ['no approval date', { latestApprovalDate: undefined, lastMaintainerCommentDate: BEFORE_APPROVAL }],
    ['an unparseable approval date', { latestApprovalDate: 'garbage', lastMaintainerCommentDate: BEFORE_APPROVAL }],
    ['no comment date', { lastMaintainerCommentDate: undefined }],
  ])('fails closed to needs_response with %s', (_name, overrides) => {
    expect(approvedWithComment(overrides)).toEqual(NEEDS_RESPONSE);
  });

  it('a commit pushed after the later comment still reads changes_addressed', () => {
    expect(
      approvedWithComment({ lastMaintainerCommentDate: AFTER_APPROVAL, latestCommitDate: '2026-02-09T10:00:00Z' }),
    ).toEqual({ status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier: 'active' });
  });

  it('a later comment and a merge conflict report both reasons, response first', () => {
    const result = approvedWithComment({ lastMaintainerCommentDate: AFTER_APPROVAL, hasMergeConflict: true });
    expect(result.actionReason).toBe('needs_response');
    expect(result.actionReasons).toEqual(['needs_response', 'merge_conflict']);
  });

  it('an older comment settled by the approval adds no needs_response beside a merge conflict', () => {
    const result = approvedWithComment({ lastMaintainerCommentDate: BEFORE_APPROVAL, hasMergeConflict: true });
    expect(result.actionReason).toBe('merge_conflict');
    expect(result.actionReasons).toEqual(['merge_conflict']);
  });
});

describe('determineStatus: precedence of the primary status', () => {
  const COMMENT = '2026-02-08T10:00:00Z';
  const COMMIT_AFTER = '2026-02-09T10:00:00Z';
  const commented = { hasUnrespondedComment: true, lastMaintainerCommentDate: COMMENT };
  const changesRequested = { reviewDecision: 'changes_requested', latestChangesRequestedDate: COMMENT } as const;
  const failing = { ciStatus: 'failing', hasActionableCIFailure: true } as const;

  const rows: Array<[string, Partial<DetermineStatusInput>, string]> = [
    [
      'comment addressed by a commit, CI failing',
      { ...commented, ...failing, latestCommitDate: COMMIT_AFTER },
      'failing_ci',
    ],
    ['comment addressed by a commit', { ...commented, latestCommitDate: COMMIT_AFTER }, 'changes_addressed'],
    ['comment settled by the approval', { ...commented, latestApprovalDate: COMMENT }, 'pending_merge'],
    ['comment newer than the approval', commented, 'needs_response'],
    ['comment newer than the approval beats failing CI', { ...commented, ...failing }, 'needs_response'],
    [
      'comment settled by the approval, but CI failing',
      { ...commented, ...failing, latestApprovalDate: COMMENT },
      'needs_response',
    ],
    ['comment beats a changes-requested review', { ...commented, ...changesRequested }, 'needs_response'],
    ['changes requested, no comment', { hasUnrespondedComment: false, ...changesRequested }, 'needs_changes'],
    [
      'changes requested beats failing CI',
      { hasUnrespondedComment: false, ...changesRequested, ...failing },
      'needs_changes',
    ],
    [
      'failing CI beats a merge conflict',
      { hasUnrespondedComment: false, ...failing, hasMergeConflict: true },
      'failing_ci',
    ],
    ['merge conflict beats approval', { hasUnrespondedComment: false, hasMergeConflict: true }, 'merge_conflict'],
    ['approved, nothing else', { hasUnrespondedComment: false }, 'pending_merge'],
    [
      'not approved, nothing else',
      { hasUnrespondedComment: false, reviewDecision: 'review_required' },
      'pending_review',
    ],
  ];

  it.each(rows)('%s', (_name, overrides, expected) => {
    const result = approvedWithComment({ latestApprovalDate: BEFORE_APPROVAL, ...overrides });
    expect(result.actionReason ?? result.waitReason).toBe(expected);
  });
});
