/**
 * Tests for status determination logic — determineStatus().
 * Migrated from pr-monitor.test.ts (#263).
 *
 * These are pure functions — no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import { determineStatus, STALE_CI_DEMOTION_DAYS } from './status-determination.js';
import type { DetermineStatusInput } from './types.js';

/** Shared helper — call determineStatus with sensible defaults, overriding only the fields under test. */
function callDetermineStatus(overrides: Partial<DetermineStatusInput> = {}) {
  const defaults: DetermineStatusInput = {
    ciStatus: 'passing',
    hasMergeConflict: false,
    hasUnrespondedComment: false,
    hasIncompleteChecklist: false,
    reviewDecision: 'review_required',
    daysSinceActivity: 2,
    dormantThreshold: 30,
    approachingThreshold: 25,
    latestCommitDate: undefined,
    lastMaintainerCommentDate: undefined,
    latestChangesRequestedDate: undefined,
  };
  return determineStatus({ ...defaults, ...overrides });
}

describe('determineStatus changes_addressed detection', () => {
  it('should return changes_addressed when commit is newer than maintainer comment', () => {
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-08T12:00:00Z', // newer
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z', // older
      }),
    ).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'changes_addressed',
      stalenessTier: 'active',
    });
  });

  it('should return needs_response when commit is older than maintainer comment', () => {
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-06T10:00:00Z', // older
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z', // newer
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_response',
      stalenessTier: 'active',
      actionReasons: ['needs_response'],
    });
  });

  it('should fall back to needs_response when commit date is unavailable', () => {
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        reviewDecision: 'changes_requested',
        latestCommitDate: undefined, // missing
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_response',
      stalenessTier: 'active',
      actionReasons: ['needs_response'],
    });
  });

  it('should not check commit date when hasUnrespondedComment is false and review is approved', () => {
    expect(
      callDetermineStatus({
        reviewDecision: 'approved',
        latestCommitDate: '2026-02-08T12:00:00Z',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({ status: 'waiting_on_maintainer', waitReason: 'pending_merge', stalenessTier: 'active' });
  });
});

describe('determineStatus commit author filtering (#547, #568)', () => {
  it('should return needs_response when HEAD commit is by a non-contributor', () => {
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-08T12:00:00Z',
        latestCommitAuthor: 'maintainer-user',
        contributorUsername: 'contributor-user',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_response',
      stalenessTier: 'active',
      actionReasons: ['needs_response'],
    });
  });

  it('should return changes_addressed when HEAD commit is by the contributor', () => {
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-08T12:00:00Z',
        latestCommitAuthor: 'contributor-user',
        contributorUsername: 'contributor-user',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'changes_addressed',
      stalenessTier: 'active',
    });
  });

  it('should return needs_response when commit is within 2 minutes of comment (race condition)', () => {
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        reviewDecision: 'changes_requested',
        // 44 seconds after comment — not enough time to address feedback
        latestCommitDate: '2026-02-07T10:00:44Z',
        latestCommitAuthor: 'contributor-user',
        contributorUsername: 'contributor-user',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_response',
      stalenessTier: 'active',
      actionReasons: ['needs_response'],
    });
  });

  it('should degrade gracefully when commit author is unknown', () => {
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-08T12:00:00Z',
        // No author info — degrade gracefully (treat as contributor)
        latestCommitAuthor: undefined,
        contributorUsername: 'contributor-user',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'changes_addressed',
      stalenessTier: 'active',
    });
  });

  it('should handle case-insensitive author comparison', () => {
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-08T12:00:00Z',
        latestCommitAuthor: 'ContributorUser',
        contributorUsername: 'contributoruser',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'changes_addressed',
      stalenessTier: 'active',
    });
  });

  it('should return needs_changes when non-contributor commit after changes_requested review', () => {
    // Non-contributor commit should not count — still needs_changes
    expect(
      callDetermineStatus({
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-09T10:00:00Z',
        latestCommitAuthor: 'maintainer-user',
        contributorUsername: 'contributor-user',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_changes',
      stalenessTier: 'active',
      actionReasons: ['needs_changes'],
    });
  });

  it('should return changes_addressed when HEAD commit is by a CI bot (#568)', () => {
    // Bot commits represent contributor work — should count as changes_addressed
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-08T12:00:00Z',
        latestCommitAuthor: 'autofix-ci[bot]',
        contributorUsername: 'contributor-user',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'changes_addressed',
      stalenessTier: 'active',
    });
  });

  it('should return changes_addressed when CI bot commit after changes_requested review (#568)', () => {
    // Bot commit after changes_requested review = contributor addressed changes
    expect(
      callDetermineStatus({
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-09T10:00:00Z',
        latestCommitAuthor: 'prettier-ci[bot]',
        contributorUsername: 'contributor-user',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'changes_addressed',
      stalenessTier: 'active',
    });
  });

  it('should return changes_addressed when pre-commit-ci[bot] commits after review (#568)', () => {
    expect(
      callDetermineStatus({
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-09T10:00:00Z',
        latestCommitAuthor: 'pre-commit-ci[bot]',
        contributorUsername: 'contributor-user',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'changes_addressed',
      stalenessTier: 'active',
    });
  });

  it('should NOT treat non-CI bot commits as contributor work (#568)', () => {
    // Non-CI bot commits should NOT count as addressing feedback
    expect(
      callDetermineStatus({
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-09T10:00:00Z',
        latestCommitAuthor: 'github-actions[bot]',
        contributorUsername: 'contributor-user',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_changes',
      stalenessTier: 'active',
      actionReasons: ['needs_changes'],
    });
  });
});

describe('determineStatus needs_changes detection', () => {
  it('should return needs_changes when changes_requested and no new commits', () => {
    expect(
      callDetermineStatus({
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-08T06:50:38Z', // before review
        latestChangesRequestedDate: '2026-02-08T11:52:22Z', // after commit
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_changes',
      stalenessTier: 'active',
      actionReasons: ['needs_changes'],
    });
  });

  it('should return changes_addressed when commits pushed after changes_requested review', () => {
    expect(
      callDetermineStatus({
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-09T10:00:00Z', // after review
        latestChangesRequestedDate: '2026-02-08T11:52:22Z', // before commit
      }),
    ).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'changes_addressed',
      stalenessTier: 'active',
    });
  });

  it('should return needs_changes when no commit date available', () => {
    expect(
      callDetermineStatus({
        reviewDecision: 'changes_requested',
        latestCommitDate: undefined, // missing
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_changes',
      stalenessTier: 'active',
      actionReasons: ['needs_changes'],
    });
  });

  it('should return pending_review when changes_requested but no review date available', () => {
    // No review date to compare against — fall through to pending_review
    expect(
      callDetermineStatus({
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-08T06:50:38Z',
      }),
    ).toEqual({ status: 'waiting_on_maintainer', waitReason: 'pending_review', stalenessTier: 'active' });
  });
});

describe('determineStatus — remaining paths', () => {
  it('should return failing_ci when CI is failing', () => {
    expect(callDetermineStatus({ ciStatus: 'failing' })).toEqual({
      status: 'needs_addressing',
      actionReason: 'failing_ci',
      stalenessTier: 'active',
      actionReasons: ['failing_ci'],
    });
  });

  it('should return merge_conflict when has merge conflict', () => {
    expect(callDetermineStatus({ hasMergeConflict: true })).toEqual({
      status: 'needs_addressing',
      actionReason: 'merge_conflict',
      stalenessTier: 'active',
      actionReasons: ['merge_conflict'],
    });
  });

  it('should return incomplete_checklist when checklist is incomplete', () => {
    expect(callDetermineStatus({ hasIncompleteChecklist: true })).toEqual({
      status: 'needs_addressing',
      actionReason: 'incomplete_checklist',
      stalenessTier: 'active',
      actionReasons: ['incomplete_checklist'],
    });
  });

  it('should return dormant stalenessTier when days exceed dormant threshold', () => {
    expect(callDetermineStatus({ daysSinceActivity: 35 })).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'pending_review',
      stalenessTier: 'dormant',
    });
  });

  it('should return approaching_dormant stalenessTier when days exceed approaching threshold', () => {
    expect(callDetermineStatus({ daysSinceActivity: 27 })).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'pending_review',
      stalenessTier: 'approaching_dormant',
    });
  });

  it('should return needs_addressing with dormant stalenessTier when dormant PR has maintainer comment', () => {
    // This is the motivating use case: a dormant PR gets new maintainer activity
    // and should show as needs_addressing (not hidden behind dormant status)
    expect(
      callDetermineStatus({
        daysSinceActivity: 35,
        hasUnrespondedComment: true,
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_response',
      stalenessTier: 'dormant',
      actionReasons: ['needs_response'],
    });
  });

  it('should demote dormant PR with failing CI to stale_ci_failure (#675)', () => {
    // Dormant PRs with stale CI failures are demoted — the CI failure is likely pre-existing
    expect(
      callDetermineStatus({
        daysSinceActivity: 35,
        ciStatus: 'failing',
      }),
    ).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'stale_ci_failure',
      stalenessTier: 'dormant',
      actionReasons: ['failing_ci'],
    });
  });

  it('should return waiting_on_maintainer when approved and CI passing', () => {
    expect(callDetermineStatus({ reviewDecision: 'approved' })).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'pending_merge',
      stalenessTier: 'active',
    });
  });

  it('should return waiting_on_maintainer when approved and CI unknown', () => {
    expect(callDetermineStatus({ reviewDecision: 'approved', ciStatus: 'unknown' })).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'pending_merge',
      stalenessTier: 'active',
    });
  });

  it('should return waiting_on_maintainer when CI is pending', () => {
    expect(callDetermineStatus({ ciStatus: 'pending' })).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'pending_review',
      stalenessTier: 'active',
    });
  });

  it('should return waiting_on_maintainer with pending_review as default for no issues', () => {
    expect(callDetermineStatus({})).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'pending_review',
      stalenessTier: 'active',
    });
  });

  it('should prioritize needs_response over failing_ci', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasUnrespondedComment: true,
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_response',
      stalenessTier: 'active',
      actionReasons: ['needs_response', 'failing_ci'],
    });
  });

  it('should prioritize failing_ci over merge_conflict', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasMergeConflict: true,
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'failing_ci',
      stalenessTier: 'active',
      actionReasons: ['failing_ci', 'merge_conflict'],
    });
  });

  it('should prioritize merge_conflict over incomplete_checklist', () => {
    expect(
      callDetermineStatus({
        hasMergeConflict: true,
        hasIncompleteChecklist: true,
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'merge_conflict',
      stalenessTier: 'active',
      actionReasons: ['merge_conflict', 'incomplete_checklist'],
    });
  });

  it('should return needs_response when CHANGES_REQUESTED review is after commit (#431)', () => {
    // Scenario: commit at 14:00, CHANGES_REQUESTED review at 14:02,
    // but lastMaintainerCommentDate points to an older comment (12:00)
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        latestCommitDate: '2026-03-01T14:00:00Z',
        lastMaintainerCommentDate: '2026-02-28T12:00:00Z', // stale — older comment
        latestChangesRequestedDate: '2026-03-01T14:02:00Z', // after commit
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_response',
      stalenessTier: 'active',
      actionReasons: ['needs_response'],
    });
  });

  it('should return changes_addressed when commit is after both comment and review (#431)', () => {
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        latestCommitDate: '2026-03-02T10:00:00Z', // after everything
        lastMaintainerCommentDate: '2026-03-01T12:00:00Z',
        latestChangesRequestedDate: '2026-03-01T14:02:00Z', // before commit
      }),
    ).toEqual({ status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier: 'active' });
  });
});

describe('determineStatus CI failure overrides changes_addressed (Issue #68)', () => {
  it('should return failing_ci when changes_addressed (comment path) and CI is failing', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasUnrespondedComment: true,
        latestCommitDate: '2026-02-08T12:00:00Z',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'failing_ci',
      stalenessTier: 'active',
      actionReasons: ['failing_ci'],
    });
  });

  it('should return failing_ci when changes_addressed (review path) and CI is failing', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-09T10:00:00Z',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'failing_ci',
      stalenessTier: 'active',
      actionReasons: ['failing_ci'],
    });
  });

  it('should still return changes_addressed when CI is passing (comment path regression)', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'passing',
        hasUnrespondedComment: true,
        latestCommitDate: '2026-02-08T12:00:00Z',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({ status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier: 'active' });
  });

  it('should still return changes_addressed when CI is passing (review path regression)', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'passing',
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-09T10:00:00Z',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toEqual({ status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier: 'active' });
  });

  it('should still prioritize needs_response over failing_ci', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasUnrespondedComment: true,
        // No commit after maintainer comment → needs_response, not changes_addressed
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_response',
      stalenessTier: 'active',
      actionReasons: ['needs_response', 'failing_ci'],
    });
  });

  it('should still prioritize needs_changes over failing_ci', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-07T06:50:38Z',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_changes',
      stalenessTier: 'active',
      actionReasons: ['needs_changes', 'failing_ci'],
    });
  });
});

describe('determineStatus non-actionable CI failures return ci_blocked (Issue #502)', () => {
  it('should return ci_blocked when CI is failing but no checks are actionable', () => {
    expect(callDetermineStatus({ ciStatus: 'failing', hasActionableCIFailure: false })).toEqual({
      status: 'waiting_on_maintainer',
      waitReason: 'ci_blocked',
      stalenessTier: 'active',
    });
  });

  it('should return failing_ci when CI is failing and checks are actionable', () => {
    expect(callDetermineStatus({ ciStatus: 'failing', hasActionableCIFailure: true })).toEqual({
      status: 'needs_addressing',
      actionReason: 'failing_ci',
      stalenessTier: 'active',
      actionReasons: ['failing_ci'],
    });
  });

  it('should return changes_addressed (comment path) when CI failing but not actionable', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasActionableCIFailure: false,
        hasUnrespondedComment: true,
        latestCommitDate: '2026-02-08T12:00:00Z',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toEqual({ status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier: 'active' });
  });

  it('should return changes_addressed (review path) when CI failing but not actionable', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasActionableCIFailure: false,
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-09T10:00:00Z',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toEqual({ status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier: 'active' });
  });

  it('should default hasActionableCIFailure to true for backward compatibility', () => {
    // hasActionableCIFailure intentionally omitted — determineStatus defaults it to true
    expect(callDetermineStatus({ ciStatus: 'failing' })).toEqual({
      status: 'needs_addressing',
      actionReason: 'failing_ci',
      stalenessTier: 'active',
      actionReasons: ['failing_ci'],
    });
  });
});

describe('determineStatus with inline review after commit (#151)', () => {
  it('should return needs_response when inline review arrives after commit that addressed old comment', () => {
    expect(
      callDetermineStatus({
        hasUnrespondedComment: true,
        daysSinceActivity: 1,
        latestCommitDate: '2026-02-13T06:35:00Z', // before inline review
        lastMaintainerCommentDate: '2026-02-14T05:14:49Z', // inline review
      }),
    ).toEqual({
      status: 'needs_addressing',
      actionReason: 'needs_response',
      stalenessTier: 'active',
      actionReasons: ['needs_response'],
    });
  });
});

describe('determineStatus staleness-based CI demotion (#675)', () => {
  it('should demote to stale_ci_failure when CI failing for 5+ days', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasActionableCIFailure: true,
        daysSinceActivity: 6,
      }),
    ).toMatchObject({
      status: 'waiting_on_maintainer',
      waitReason: 'stale_ci_failure',
    });
  });

  it('should return failing_ci when CI failing for less than 5 days', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasActionableCIFailure: true,
        daysSinceActivity: 4,
      }),
    ).toMatchObject({
      status: 'needs_addressing',
      actionReason: 'failing_ci',
    });
  });

  it('should demote at exactly STALE_CI_DEMOTION_DAYS boundary', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasActionableCIFailure: true,
        daysSinceActivity: STALE_CI_DEMOTION_DAYS,
      }),
    ).toMatchObject({
      status: 'waiting_on_maintainer',
      waitReason: 'stale_ci_failure',
    });
  });

  it('should still return ci_blocked for non-actionable CI regardless of staleness', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasActionableCIFailure: false,
        daysSinceActivity: 10,
      }),
    ).toMatchObject({
      status: 'waiting_on_maintainer',
      waitReason: 'ci_blocked',
    });
  });

  it('should still capture failing_ci in actionReasons when demoted to stale', () => {
    const result = callDetermineStatus({
      ciStatus: 'failing',
      hasActionableCIFailure: true,
      daysSinceActivity: 6,
    });
    expect(result.actionReasons).toContain('failing_ci');
  });
});

describe('determineStatus multiple action reasons (#675)', () => {
  it('should collect CI + merge conflict in actionReasons', () => {
    const result = callDetermineStatus({
      ciStatus: 'failing',
      hasActionableCIFailure: true,
      hasMergeConflict: true,
      daysSinceActivity: 2,
    });
    expect(result.actionReasons).toEqual(['failing_ci', 'merge_conflict']);
    // Primary reason is still failing_ci (higher priority)
    expect(result.actionReason).toBe('failing_ci');
  });

  it('should collect CI + merge conflict + incomplete checklist', () => {
    const result = callDetermineStatus({
      ciStatus: 'failing',
      hasActionableCIFailure: true,
      hasMergeConflict: true,
      hasIncompleteChecklist: true,
      daysSinceActivity: 2,
    });
    expect(result.actionReasons).toEqual(['failing_ci', 'merge_conflict', 'incomplete_checklist']);
  });

  it('should return single-element actionReasons for single issue', () => {
    const result = callDetermineStatus({
      ciStatus: 'failing',
      hasActionableCIFailure: true,
      daysSinceActivity: 2,
    });
    expect(result.actionReasons).toEqual(['failing_ci']);
  });

  it('should return undefined actionReasons when waiting on maintainer with no issues', () => {
    const result = callDetermineStatus({});
    expect(result.actionReasons).toBeUndefined();
  });

  it('should collect needs_response + failing_ci + merge_conflict', () => {
    const result = callDetermineStatus({
      ciStatus: 'failing',
      hasActionableCIFailure: true,
      hasUnrespondedComment: true,
      hasMergeConflict: true,
      daysSinceActivity: 1,
    });
    // Primary is needs_response (highest priority)
    expect(result.actionReason).toBe('needs_response');
    expect(result.actionReasons).toEqual(['needs_response', 'failing_ci', 'merge_conflict']);
  });
});
