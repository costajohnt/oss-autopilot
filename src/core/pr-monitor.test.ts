/**
 * Tests for PRMonitor — CI deduplication, status determination, checklist analysis,
 * maintainer hint extraction, review decision, and comment detection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockOctokitInstance: any;

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => mockOctokitInstance),
}));

vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: () => ({ config: { githubUsername: 'testuser' } }),
  })),
}));

// Import after mocks are set up
const { PRMonitor, computeDisplayLabel, classifyCICheck, classifyFailingChecks } = await import('./pr-monitor.js');
const { getStateManager } = await import('./state.js');

describe('PRMonitor CI status deduplication', () => {
  const emptyCombinedStatus = {
    data: {
      state: 'success',
      statuses: [],
    },
  };

  it('should use latest check run when same check has multiple runs', async () => {
    // Simulate owncast scenario: "Validate PR checklist" ran 4 times,
    // 2 old failures followed by 2 newer successes
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue(emptyCombinedStatus),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              {
                name: 'Validate PR checklist',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-02-07T02:02:00Z',
              },
              {
                name: 'Validate PR checklist',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-02-07T19:47:00Z',
              },
              {
                name: 'Validate PR checklist',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-07T19:16:00Z',
              },
              {
                name: 'Validate PR checklist',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-08T03:32:00Z', // Most recent
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owncast', 'owncast', 'abc123');

    expect(result.status).toBe('passing');
    expect(result.failingCheckNames).toEqual([]);
  });

  it('should report failing when the latest run of a check is a failure', async () => {
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue(emptyCombinedStatus),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              {
                name: 'Build',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-07T10:00:00Z',
              },
              {
                name: 'Build',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-02-07T12:00:00Z', // More recent failure
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', 'abc123');

    expect(result.status).toBe('failing');
    expect(result.failingCheckNames).toEqual(['Build']);
  });

  it('should handle multiple different checks independently', async () => {
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue(emptyCombinedStatus),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              // "Lint" failed then passed
              {
                name: 'Lint',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-02-07T10:00:00Z',
              },
              {
                name: 'Lint',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-07T12:00:00Z',
              },
              // "Test" only has a passing run
              {
                name: 'Test',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-07T11:00:00Z',
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', 'abc123');

    expect(result.status).toBe('passing');
    expect(result.failingCheckNames).toEqual([]);
  });

  it('should report failing when one check passes but another still fails (multi-check)', async () => {
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue(emptyCombinedStatus),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              {
                name: 'Lint',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-07T12:00:00Z',
              },
              {
                name: 'Test',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-02-07T12:00:00Z',
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', 'abc123');

    expect(result.status).toBe('failing');
    expect(result.failingCheckNames).toEqual(['Test']);
  });
});

describe('PRMonitor changes_addressed detection', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return changes_addressed when commit is newer than maintainer comment', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',        // ciStatus
      false,            // hasMergeConflict
      true,             // hasUnrespondedComment
      false,            // hasIncompleteChecklist
      'changes_requested', // reviewDecision
      2,                // daysSinceActivity
      30,               // dormantThreshold
      25,               // approachingThreshold
      '2026-02-08T12:00:00Z',  // latestCommitDate (newer)
      '2026-02-07T10:00:00Z'   // lastMaintainerCommentDate (older)
    );

    expect(result).toBe('changes_addressed');
  });

  it('should return needs_response when commit is older than maintainer comment', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',
      false,
      true,             // hasUnrespondedComment
      false,
      'changes_requested',
      2,
      30,
      25,
      '2026-02-06T10:00:00Z',  // latestCommitDate (older)
      '2026-02-07T10:00:00Z'   // lastMaintainerCommentDate (newer)
    );

    expect(result).toBe('needs_response');
  });

  it('should fall back to needs_response when commit date is unavailable', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',
      false,
      true,             // hasUnrespondedComment
      false,
      'changes_requested',
      2,
      30,
      25,
      undefined,               // latestCommitDate (missing)
      '2026-02-07T10:00:00Z'  // lastMaintainerCommentDate
    );

    expect(result).toBe('needs_response');
  });

  it('should not check commit date when hasUnrespondedComment is false and review is approved', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',
      false,
      false,            // hasUnrespondedComment = false
      false,
      'approved',
      2,
      30,
      25,
      '2026-02-08T12:00:00Z',  // latestCommitDate
      '2026-02-07T10:00:00Z',  // lastMaintainerCommentDate
      undefined                 // latestChangesRequestedDate
    );

    expect(result).toBe('waiting_on_maintainer');
  });
});

describe('PRMonitor needs_changes detection', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return needs_changes when changes_requested and no new commits', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',
      false,
      false,            // hasUnrespondedComment = false (inline review comments)
      false,
      'changes_requested',
      2,
      30,
      25,
      '2026-02-08T06:50:38Z',   // latestCommitDate (before review)
      undefined,                  // lastMaintainerCommentDate
      '2026-02-08T11:52:22Z'    // latestChangesRequestedDate (after commit)
    );

    expect(result).toBe('needs_changes');
  });

  it('should return changes_addressed when commits pushed after changes_requested review', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',
      false,
      false,
      false,
      'changes_requested',
      2,
      30,
      25,
      '2026-02-09T10:00:00Z',   // latestCommitDate (after review)
      undefined,
      '2026-02-08T11:52:22Z'    // latestChangesRequestedDate (before commit)
    );

    expect(result).toBe('changes_addressed');
  });

  it('should return needs_changes when no commit date available', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',
      false,
      false,
      false,
      'changes_requested',
      2,
      30,
      25,
      undefined,                  // latestCommitDate (missing)
      undefined,
      '2026-02-08T11:52:22Z'    // latestChangesRequestedDate
    );

    expect(result).toBe('needs_changes');
  });

  it('should return healthy when changes_requested but no review date available', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',
      false,
      false,
      false,
      'changes_requested',
      2,
      30,
      25,
      '2026-02-08T06:50:38Z',
      undefined,
      undefined                   // latestChangesRequestedDate (missing)
    );

    // No review date to compare against — fall through to healthy
    expect(result).toBe('healthy');
  });
});

describe('PRMonitor determineStatus — remaining paths', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  // Helper to call determineStatus with defaults
  function callDetermineStatus(overrides: Partial<{
    ciStatus: string;
    hasMergeConflict: boolean;
    hasUnrespondedComment: boolean;
    hasIncompleteChecklist: boolean;
    reviewDecision: string;
    daysSinceActivity: number;
    dormantThreshold: number;
    approachingThreshold: number;
    latestCommitDate: string | undefined;
    lastMaintainerCommentDate: string | undefined;
    latestChangesRequestedDate: string | undefined;
  }> = {}) {
    const monitor = new PRMonitor('fake-token');
    const defaults = {
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
    const p = { ...defaults, ...overrides };
    return (monitor as any).determineStatus(
      p.ciStatus, p.hasMergeConflict, p.hasUnrespondedComment,
      p.hasIncompleteChecklist, p.reviewDecision, p.daysSinceActivity,
      p.dormantThreshold, p.approachingThreshold, p.latestCommitDate,
      p.lastMaintainerCommentDate, p.latestChangesRequestedDate
    );
  }

  it('should return failing_ci when CI is failing', () => {
    expect(callDetermineStatus({ ciStatus: 'failing' })).toBe('failing_ci');
  });

  it('should return merge_conflict when has merge conflict', () => {
    expect(callDetermineStatus({ hasMergeConflict: true })).toBe('merge_conflict');
  });

  it('should return incomplete_checklist when checklist is incomplete', () => {
    expect(callDetermineStatus({ hasIncompleteChecklist: true })).toBe('incomplete_checklist');
  });

  it('should return dormant when days exceed dormant threshold', () => {
    expect(callDetermineStatus({ daysSinceActivity: 35 })).toBe('dormant');
  });

  it('should return approaching_dormant when days exceed approaching threshold', () => {
    expect(callDetermineStatus({ daysSinceActivity: 27 })).toBe('approaching_dormant');
  });

  it('should return waiting_on_maintainer when approved and CI passing', () => {
    expect(callDetermineStatus({ reviewDecision: 'approved' })).toBe('waiting_on_maintainer');
  });

  it('should return waiting_on_maintainer when approved and CI unknown', () => {
    expect(callDetermineStatus({ reviewDecision: 'approved', ciStatus: 'unknown' })).toBe('waiting_on_maintainer');
  });

  it('should return waiting when CI is pending', () => {
    expect(callDetermineStatus({ ciStatus: 'pending' })).toBe('waiting');
  });

  it('should return healthy as default for no issues', () => {
    expect(callDetermineStatus({})).toBe('healthy');
  });

  it('should prioritize needs_response over failing_ci', () => {
    expect(callDetermineStatus({
      ciStatus: 'failing',
      hasUnrespondedComment: true,
    })).toBe('needs_response');
  });

  it('should prioritize failing_ci over merge_conflict', () => {
    expect(callDetermineStatus({
      ciStatus: 'failing',
      hasMergeConflict: true,
    })).toBe('failing_ci');
  });

  it('should prioritize merge_conflict over incomplete_checklist', () => {
    expect(callDetermineStatus({
      hasMergeConflict: true,
      hasIncompleteChecklist: true,
    })).toBe('merge_conflict');
  });
});

describe('PRMonitor analyzeChecklist', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return false for empty body', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).analyzeChecklist('');
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toBeUndefined();
  });

  it('should return false for body with no checkboxes', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).analyzeChecklist('This PR adds a new feature.');
    expect(result.hasIncompleteChecklist).toBe(false);
  });

  it('should return false when all checkboxes are checked', () => {
    const monitor = new PRMonitor('fake-token');
    const body = '- [x] Tests added\n- [x] Docs updated\n- [x] Linted';
    const result = (monitor as any).analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toEqual({ checked: 3, total: 3 });
  });

  it('should return true when some checkboxes are unchecked', () => {
    const monitor = new PRMonitor('fake-token');
    const body = '- [x] Tests added\n- [ ] Docs updated\n- [x] Linted';
    const result = (monitor as any).analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(true);
    expect(result.checklistStats).toEqual({ checked: 2, total: 3 });
  });

  it('should return true when all checkboxes are unchecked', () => {
    const monitor = new PRMonitor('fake-token');
    const body = '- [ ] Tests added\n- [ ] Docs updated';
    const result = (monitor as any).analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(true);
    expect(result.checklistStats).toEqual({ checked: 0, total: 2 });
  });

  it('should handle case-insensitive checked marks (- [X])', () => {
    const monitor = new PRMonitor('fake-token');
    const body = '- [X] Done\n- [ ] Not done';
    const result = (monitor as any).analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(true);
    expect(result.checklistStats).toEqual({ checked: 1, total: 2 });
  });
});

describe('PRMonitor extractMaintainerActionHints', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return changes_requested when reviewDecision is changes_requested', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).extractMaintainerActionHints(undefined, 'changes_requested');
    expect(result).toEqual(['changes_requested']);
  });

  it('should return empty array when no comment and no changes_requested', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).extractMaintainerActionHints(undefined, 'approved');
    expect(result).toEqual([]);
  });

  it('should detect demo_requested keywords', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).extractMaintainerActionHints(
      'Can you show a screenshot of the before/after?',
      'review_required'
    );
    expect(result).toContain('demo_requested');
  });

  it('should detect tests_requested keywords', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).extractMaintainerActionHints(
      'Please add test coverage for this feature',
      'review_required'
    );
    expect(result).toContain('tests_requested');
  });

  it('should detect docs_requested keywords', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).extractMaintainerActionHints(
      'Can you update the documentation for this API change?',
      'review_required'
    );
    expect(result).toContain('docs_requested');
  });

  it('should detect rebase_requested keywords', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).extractMaintainerActionHints(
      'This branch is behind main, could you rebase?',
      'review_required'
    );
    expect(result).toContain('rebase_requested');
  });

  it('should detect multiple hints in one comment', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).extractMaintainerActionHints(
      'Please add test coverage and a screenshot of the changes',
      'changes_requested'
    );
    expect(result).toContain('changes_requested');
    expect(result).toContain('tests_requested');
    expect(result).toContain('demo_requested');
  });
});

describe('PRMonitor determineReviewDecision', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return review_required when no reviews exist', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineReviewDecision([]);
    expect(result).toBe('review_required');
  });

  it('should return approved when latest review is APPROVED', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineReviewDecision([
      { state: 'APPROVED', user: { login: 'reviewer1' } },
    ]);
    expect(result).toBe('approved');
  });

  it('should return changes_requested when latest review is CHANGES_REQUESTED', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineReviewDecision([
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } },
    ]);
    expect(result).toBe('changes_requested');
  });

  it('should use latest review per user', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineReviewDecision([
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } },
      { state: 'APPROVED', user: { login: 'reviewer1' } }, // Same user, later approval
    ]);
    expect(result).toBe('approved');
  });

  it('should prioritize changes_requested over approved from different users', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineReviewDecision([
      { state: 'APPROVED', user: { login: 'reviewer1' } },
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer2' } },
    ]);
    expect(result).toBe('changes_requested');
  });

  it('should return review_required for COMMENTED-only reviews', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineReviewDecision([
      { state: 'COMMENTED', user: { login: 'reviewer1' } },
    ]);
    expect(result).toBe('review_required');
  });
});

describe('PRMonitor getLatestChangesRequestedDate', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return undefined when no reviews', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).getLatestChangesRequestedDate([]);
    expect(result).toBeUndefined();
  });

  it('should return undefined when no CHANGES_REQUESTED reviews', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).getLatestChangesRequestedDate([
      { state: 'APPROVED', submitted_at: '2026-02-07T10:00:00Z' },
    ]);
    expect(result).toBeUndefined();
  });

  it('should return the date of the single CHANGES_REQUESTED review', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).getLatestChangesRequestedDate([
      { state: 'CHANGES_REQUESTED', submitted_at: '2026-02-07T10:00:00Z' },
    ]);
    expect(result).toBe('2026-02-07T10:00:00Z');
  });

  it('should return the latest date when multiple CHANGES_REQUESTED reviews', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).getLatestChangesRequestedDate([
      { state: 'CHANGES_REQUESTED', submitted_at: '2026-02-05T10:00:00Z' },
      { state: 'APPROVED', submitted_at: '2026-02-06T10:00:00Z' },
      { state: 'CHANGES_REQUESTED', submitted_at: '2026-02-08T10:00:00Z' },
    ]);
    expect(result).toBe('2026-02-08T10:00:00Z');
  });
});

describe('PRMonitor hasMergeConflict', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return true when mergeable is false', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).hasMergeConflict(false, 'clean')).toBe(true);
  });

  it('should return true when mergeable_state is dirty', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).hasMergeConflict(null, 'dirty')).toBe(true);
  });

  it('should return false when mergeable is true and state is clean', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).hasMergeConflict(true, 'clean')).toBe(false);
  });

  it('should return false when mergeable is null and state is unknown', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).hasMergeConflict(null, 'unknown')).toBe(false);
  });
});

describe('PRMonitor checkUnrespondedComments', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return false when no comments or reviews', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).checkUnrespondedComments([], [], 'testuser');
    expect(result.hasUnrespondedComment).toBe(false);
    expect(result.lastMaintainerComment).toBeUndefined();
  });

  it('should return false when only user comments exist', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My comment', created_at: '2026-02-07T10:00:00Z' }],
      [],
      'testuser'
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should return true when maintainer commented after user', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Please fix X', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      'testuser'
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('maintainer');
  });

  it('should return false when user replied after maintainer', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).checkUnrespondedComments(
      [
        { user: { login: 'maintainer' }, body: 'Please fix X', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'testuser' }, body: 'Fixed', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      'testuser'
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should skip bot comments', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'dependabot[bot]' }, body: 'Dependency update', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      'testuser'
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should include review comments with body text in timeline', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).checkUnrespondedComments(
      [],
      [
        { user: { login: 'maintainer' }, body: 'Needs changes here', submitted_at: '2026-02-07T12:00:00Z' },
      ],
      'testuser'
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('maintainer');
  });

  it('should skip reviews with empty body', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).checkUnrespondedComments(
      [],
      [
        { user: { login: 'maintainer' }, body: '', submitted_at: '2026-02-07T12:00:00Z' },
      ],
      'testuser'
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should truncate long comment bodies to 200 chars', () => {
    const monitor = new PRMonitor('fake-token');
    const longBody = 'x'.repeat(300);
    const result = (monitor as any).checkUnrespondedComments(
      [
        { user: { login: 'maintainer' }, body: longBody, created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      'testuser'
    );
    expect(result.lastMaintainerComment?.body.length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it('should be case-insensitive for username matching', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).checkUnrespondedComments(
      [
        { user: { login: 'TestUser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Fix this', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      'testuser' // lowercase
    );
    expect(result.hasUnrespondedComment).toBe(true);
  });
});

describe('PRMonitor getCIStatus auth-gate filtering', () => {
  it('should filter out Vercel authorization-gate statuses', async () => {
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: {
            state: 'failure',
            statuses: [
              {
                state: 'failure',
                description: 'Authorization required to deploy',
                context: 'Vercel',
              },
            ],
          },
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: { check_runs: [] },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', 'abc123');

    expect(result.status).toBe('passing');
    expect(result.failingCheckNames).toEqual([]);
  });

  it('should still report real failures alongside auth gates', async () => {
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: {
            state: 'failure',
            statuses: [
              {
                state: 'failure',
                description: 'Authorization required to deploy',
                context: 'Vercel',
              },
              {
                state: 'failure',
                description: 'The Travis CI build failed',
                context: 'travis-ci',
              },
            ],
          },
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: { check_runs: [] },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', 'abc123');

    expect(result.status).toBe('failing');
    expect(result.failingCheckNames).toEqual(['travis-ci']);
  });

  it('should treat all-auth-gate statuses as success', async () => {
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: {
            state: 'failure',
            statuses: [
              {
                state: 'failure',
                description: 'Please authorize this app',
                context: 'Vercel',
              },
              {
                state: 'failure',
                description: 'Authorization required',
                context: 'Netlify',
              },
            ],
          },
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: { check_runs: [] },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', 'abc123');

    expect(result.status).toBe('passing');
    expect(result.failingCheckNames).toEqual([]);
  });

  it('should return unknown on 404 error', async () => {
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockRejectedValue({ status: 404 }),
      },
      checks: {
        listForRef: vi.fn().mockRejectedValue({ status: 404 }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', 'abc123');

    expect(result.status).toBe('unknown');
    expect(result.failingCheckNames).toEqual([]);
  });

  it('should return unknown when sha is empty', async () => {
    mockOctokitInstance = {};

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', '');

    expect(result.status).toBe('unknown');
    expect(result.failingCheckNames).toEqual([]);
  });
});

describe('PRMonitor generateDigest', () => {

  function makeFetchedPR(overrides: Partial<import('./types.js').FetchedPR> = {}): import('./types.js').FetchedPR {
    return {
      id: 1,
      url: 'https://github.com/owner/repo/pull/1',
      repo: 'owner/repo',
      number: 1,
      title: 'Test PR',
      status: 'healthy',
      displayLabel: '[Healthy]',
      displayDescription: 'Everything looks good — normal review cycle',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-07T00:00:00Z',
      daysSinceActivity: 1,
      ciStatus: 'passing',
      failingCheckNames: [],
      classifiedChecks: [],
      hasMergeConflict: false,
      reviewDecision: 'review_required',
      hasUnrespondedComment: false,
      hasIncompleteChecklist: false,
      maintainerActionHints: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    mockOctokitInstance = {};
    // Override the mock to include getStats
    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({ config: { githubUsername: 'testuser' } }),
      getStats: () => ({
        activePRs: 0,
        dormantPRs: 0,
        mergedPRs: 5,
        closedPRs: 2,
        activeIssues: 0,
        trustedProjects: 0,
        mergeRate: '71.4',
        totalTracked: 7,
        needsResponse: 0,
      }),
    } as any);
  });

  it('should categorize PRs by status', () => {
    const prs = [
      makeFetchedPR({ status: 'needs_response', number: 1 }),
      makeFetchedPR({ status: 'failing_ci', number: 2 }),
      makeFetchedPR({ status: 'merge_conflict', number: 3 }),
      makeFetchedPR({ status: 'healthy', number: 4 }),
      makeFetchedPR({ status: 'dormant', number: 5 }),
      makeFetchedPR({ status: 'approaching_dormant', number: 6 }),
      makeFetchedPR({ status: 'needs_changes', number: 7 }),
      makeFetchedPR({ status: 'changes_addressed', number: 8 }),
      makeFetchedPR({ status: 'waiting_on_maintainer', number: 9 }),
      makeFetchedPR({ status: 'incomplete_checklist', number: 10 }),
      makeFetchedPR({ status: 'waiting', number: 11 }),
    ];

    const monitor = new PRMonitor('fake-token');
    const digest = monitor.generateDigest(prs);

    expect(digest.prsNeedingResponse.map(p => p.number)).toEqual([1]);
    expect(digest.ciFailingPRs.map(p => p.number)).toEqual([2]);
    expect(digest.mergeConflictPRs.map(p => p.number)).toEqual([3]);
    expect(digest.healthyPRs.map(p => p.number)).toEqual([4, 11]); // healthy + waiting
    expect(digest.dormantPRs.map(p => p.number)).toEqual([5]);
    expect(digest.approachingDormant.map(p => p.number)).toEqual([6]);
    expect(digest.needsChangesPRs.map(p => p.number)).toEqual([7]);
    expect(digest.changesAddressedPRs.map(p => p.number)).toEqual([8]);
    expect(digest.waitingOnMaintainerPRs.map(p => p.number)).toEqual([9]);
    expect(digest.incompleteChecklistPRs.map(p => p.number)).toEqual([10]);
  });

  it('should calculate totalNeedingAttention correctly', () => {
    const prs = [
      makeFetchedPR({ status: 'needs_response', number: 1 }),
      makeFetchedPR({ status: 'needs_changes', number: 2 }),
      makeFetchedPR({ status: 'failing_ci', number: 3 }),
      makeFetchedPR({ status: 'merge_conflict', number: 4 }),
      makeFetchedPR({ status: 'needs_rebase', number: 5 }),
      makeFetchedPR({ status: 'missing_required_files', number: 6 }),
      makeFetchedPR({ status: 'incomplete_checklist', number: 7 }),
      // These should NOT count toward totalNeedingAttention
      makeFetchedPR({ status: 'healthy', number: 8 }),
      makeFetchedPR({ status: 'waiting', number: 9 }),
      makeFetchedPR({ status: 'dormant', number: 10 }),
      makeFetchedPR({ status: 'waiting_on_maintainer', number: 11 }),
    ];

    const monitor = new PRMonitor('fake-token');
    const digest = monitor.generateDigest(prs);

    expect(digest.summary.totalNeedingAttention).toBe(7);
    expect(digest.summary.totalActivePRs).toBe(11);
  });

  it('should handle empty PR list', () => {
    const monitor = new PRMonitor('fake-token');
    const digest = monitor.generateDigest([]);

    expect(digest.openPRs).toEqual([]);
    expect(digest.prsNeedingResponse).toEqual([]);
    expect(digest.ciFailingPRs).toEqual([]);
    expect(digest.mergeConflictPRs).toEqual([]);
    expect(digest.healthyPRs).toEqual([]);
    expect(digest.dormantPRs).toEqual([]);
    expect(digest.summary.totalActivePRs).toBe(0);
    expect(digest.summary.totalNeedingAttention).toBe(0);
    expect(digest.summary.totalMergedAllTime).toBe(5);
    expect(digest.summary.mergeRate).toBe(71.4);
  });

  it('should include recentlyClosedPRs', () => {
    const closedPRs: import('./types.js').ClosedPR[] = [
      {
        url: 'https://github.com/owner/repo/pull/100',
        repo: 'owner/repo',
        number: 100,
        title: 'Closed PR 1',
        closedAt: '2026-02-06T00:00:00Z',
      },
      {
        url: 'https://github.com/owner/repo/pull/101',
        repo: 'owner/repo',
        number: 101,
        title: 'Closed PR 2',
        closedAt: '2026-02-05T00:00:00Z',
      },
    ];

    const monitor = new PRMonitor('fake-token');
    const digest = monitor.generateDigest([], closedPRs);

    expect(digest.recentlyClosedPRs).toHaveLength(2);
    expect(digest.recentlyClosedPRs[0].number).toBe(100);
    expect(digest.recentlyClosedPRs[1].number).toBe(101);
  });
});

describe('PRMonitor CI failure overrides changes_addressed (Issue #68)', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  // Helper to call determineStatus with defaults
  function callDetermineStatus(overrides: Partial<{
    ciStatus: string;
    hasMergeConflict: boolean;
    hasUnrespondedComment: boolean;
    hasIncompleteChecklist: boolean;
    reviewDecision: string;
    daysSinceActivity: number;
    dormantThreshold: number;
    approachingThreshold: number;
    latestCommitDate: string | undefined;
    lastMaintainerCommentDate: string | undefined;
    latestChangesRequestedDate: string | undefined;
  }> = {}) {
    const monitor = new PRMonitor('fake-token');
    const defaults = {
      ciStatus: 'passing',
      hasMergeConflict: false,
      hasUnrespondedComment: false,
      hasIncompleteChecklist: false,
      reviewDecision: 'review_required',
      daysSinceActivity: 2,
      dormantThreshold: 30,
      approachingThreshold: 25,
      latestCommitDate: undefined as string | undefined,
      lastMaintainerCommentDate: undefined as string | undefined,
      latestChangesRequestedDate: undefined as string | undefined,
    };
    const p = { ...defaults, ...overrides };
    return (monitor as any).determineStatus(
      p.ciStatus, p.hasMergeConflict, p.hasUnrespondedComment,
      p.hasIncompleteChecklist, p.reviewDecision, p.daysSinceActivity,
      p.dormantThreshold, p.approachingThreshold, p.latestCommitDate,
      p.lastMaintainerCommentDate, p.latestChangesRequestedDate
    );
  }

  it('should return failing_ci when changes_addressed (comment path) and CI is failing', () => {
    expect(callDetermineStatus({
      ciStatus: 'failing',
      hasUnrespondedComment: true,
      latestCommitDate: '2026-02-08T12:00:00Z',
      lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
    })).toBe('failing_ci');
  });

  it('should return failing_ci when changes_addressed (review path) and CI is failing', () => {
    expect(callDetermineStatus({
      ciStatus: 'failing',
      reviewDecision: 'changes_requested',
      latestCommitDate: '2026-02-09T10:00:00Z',
      latestChangesRequestedDate: '2026-02-08T11:52:22Z',
    })).toBe('failing_ci');
  });

  it('should still return changes_addressed when CI is passing (comment path regression)', () => {
    expect(callDetermineStatus({
      ciStatus: 'passing',
      hasUnrespondedComment: true,
      latestCommitDate: '2026-02-08T12:00:00Z',
      lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
    })).toBe('changes_addressed');
  });

  it('should still return changes_addressed when CI is passing (review path regression)', () => {
    expect(callDetermineStatus({
      ciStatus: 'passing',
      reviewDecision: 'changes_requested',
      latestCommitDate: '2026-02-09T10:00:00Z',
      latestChangesRequestedDate: '2026-02-08T11:52:22Z',
    })).toBe('changes_addressed');
  });

  it('should still prioritize needs_response over failing_ci', () => {
    expect(callDetermineStatus({
      ciStatus: 'failing',
      hasUnrespondedComment: true,
      // No commit after maintainer comment → needs_response, not changes_addressed
    })).toBe('needs_response');
  });

  it('should still prioritize needs_changes over failing_ci', () => {
    expect(callDetermineStatus({
      ciStatus: 'failing',
      reviewDecision: 'changes_requested',
      latestCommitDate: '2026-02-07T06:50:38Z',
      latestChangesRequestedDate: '2026-02-08T11:52:22Z',
    })).toBe('needs_changes');
  });
});

describe('PRMonitor acknowledgment comment detection (Issue #69)', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should detect "thanks" as acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).isAcknowledgmentComment('thanks')).toBe(true);
  });

  it('should detect "Thank you!" as acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).isAcknowledgmentComment('Thank you!')).toBe(true);
  });

  it('should detect "LGTM" as acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).isAcknowledgmentComment('LGTM')).toBe(true);
  });

  it('should detect "Looks good, will review soon" as acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).isAcknowledgmentComment('Looks good, will review soon')).toBe(true);
  });

  it('should detect "we\'ll get to this shortly" as acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).isAcknowledgmentComment("we'll get to this shortly")).toBe(true);
  });

  it('should detect "noted" as acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).isAcknowledgmentComment('noted')).toBe(true);
  });

  it('should NOT detect actionable comment as acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).isAcknowledgmentComment('Please fix linting errors')).toBe(false);
  });

  it('should NOT detect empty string as acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).isAcknowledgmentComment('')).toBe(false);
  });

  it('should NOT detect comment with question mark as acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    expect((monitor as any).isAcknowledgmentComment('Thanks, can you add tests?')).toBe(false);
  });

  it('should NOT detect long comment with keyword as acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    const longComment = 'Thanks for this PR! ' + 'x'.repeat(100);
    expect((monitor as any).isAcknowledgmentComment(longComment)).toBe(false);
  });

  it('should not trigger hasUnrespondedComment for acknowledgment comments', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR description', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Thanks, will review soon', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      'testuser'
    );
    expect(result.hasUnrespondedComment).toBe(false);
    expect(result.lastMaintainerComment).toBeUndefined();
  });

  it('should still trigger hasUnrespondedComment for actionable comment after acknowledgment', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Thanks, will look at this', created_at: '2026-02-07T11:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Please fix the linting errors in src/main.ts', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      'testuser'
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('maintainer');
  });
});

describe('computeDisplayLabel (#79)', () => {
  function makePR(overrides: Partial<import('./types.js').FetchedPR> = {}): import('./types.js').FetchedPR {
    return {
      id: 1,
      url: 'https://github.com/owner/repo/pull/1',
      repo: 'owner/repo',
      number: 1,
      title: 'Test PR',
      status: 'healthy',
      displayLabel: '',
      displayDescription: '',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-07T00:00:00Z',
      daysSinceActivity: 1,
      ciStatus: 'passing',
      failingCheckNames: [],
      classifiedChecks: [],
      hasMergeConflict: false,
      reviewDecision: 'review_required',
      hasUnrespondedComment: false,
      hasIncompleteChecklist: false,
      maintainerActionHints: [],
      ...overrides,
    };
  }

  it('should return [Healthy] for healthy status', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(makePR({ status: 'healthy' }));
    expect(displayLabel).toBe('[Healthy]');
    expect(displayDescription).toBe('Everything looks good — normal review cycle');
  });

  it('should return [Needs Response] with author for needs_response', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(makePR({
      status: 'needs_response',
      lastMaintainerComment: { author: 'johndoe', body: 'Please fix', createdAt: '2026-02-07T10:00:00Z' },
    }));
    expect(displayLabel).toBe('[Needs Response]');
    expect(displayDescription).toBe('@johndoe commented');
  });

  it('should return fallback description for needs_response without comment', () => {
    const { displayDescription } = computeDisplayLabel(makePR({ status: 'needs_response' }));
    expect(displayDescription).toBe('Maintainer awaiting response');
  });

  it('should return [CI Failing] with actionable check count', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(makePR({
      status: 'failing_ci',
      failingCheckNames: ['Build', 'Lint', 'Vercel Deploy'],
      classifiedChecks: [
        { name: 'Build', category: 'actionable' },
        { name: 'Lint', category: 'actionable' },
        { name: 'Vercel Deploy', category: 'fork_limitation' },
      ],
    }));
    expect(displayLabel).toBe('[CI Failing]');
    expect(displayDescription).toBe('2 checks failed: Build, Lint');
  });

  it('should return generic description when no classified checks', () => {
    const { displayDescription } = computeDisplayLabel(makePR({
      status: 'failing_ci',
      failingCheckNames: [],
      classifiedChecks: [],
    }));
    expect(displayDescription).toBe('One or more CI checks are failing');
  });

  it('should return [Merge Conflict] for merge_conflict', () => {
    const { displayLabel } = computeDisplayLabel(makePR({ status: 'merge_conflict' }));
    expect(displayLabel).toBe('[Merge Conflict]');
  });

  it('should return [Incomplete Checklist] with stats', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(makePR({
      status: 'incomplete_checklist',
      checklistStats: { checked: 2, total: 5 },
    }));
    expect(displayLabel).toBe('[Incomplete Checklist]');
    expect(displayDescription).toBe('2/5 items checked');
  });

  it('should return [Changes Addressed] with author', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(makePR({
      status: 'changes_addressed',
      lastMaintainerComment: { author: 'reviewer', body: 'Changes needed', createdAt: '2026-02-07T10:00:00Z' },
    }));
    expect(displayLabel).toBe('[Changes Addressed]');
    expect(displayDescription).toBe('Waiting for @reviewer to re-review');
  });

  it('should return [Dormant] with days count', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(makePR({
      status: 'dormant',
      daysSinceActivity: 45,
    }));
    expect(displayLabel).toBe('[Dormant]');
    expect(displayDescription).toBe('No activity for 45 days');
  });

  it('should return [Approaching Dormant] with days count', () => {
    const { displayDescription } = computeDisplayLabel(makePR({
      status: 'approaching_dormant',
      daysSinceActivity: 27,
    }));
    expect(displayDescription).toBe('No activity for 27 days');
  });

  it('should return [Waiting on Maintainer] for approved PRs', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(makePR({ status: 'waiting_on_maintainer' }));
    expect(displayLabel).toBe('[Waiting on Maintainer]');
    expect(displayDescription).toBe('Approved and CI passes — waiting for merge');
  });

  it('should return [Needs Changes] for needs_changes status', () => {
    const { displayLabel } = computeDisplayLabel(makePR({ status: 'needs_changes' }));
    expect(displayLabel).toBe('[Needs Changes]');
  });

  it('should have an entry for every FetchedPRStatus', () => {
    // Ensure no status is missed — if a new status is added, this test will catch it
    const allStatuses: import('./types.js').FetchedPRStatus[] = [
      'needs_response', 'failing_ci', 'ci_blocked', 'ci_not_running',
      'merge_conflict', 'needs_rebase', 'missing_required_files', 'incomplete_checklist',
      'needs_changes', 'changes_addressed', 'waiting', 'waiting_on_maintainer',
      'healthy', 'approaching_dormant', 'dormant',
    ];
    for (const status of allStatuses) {
      const result = computeDisplayLabel(makePR({ status }));
      expect(result.displayLabel).toBeTruthy();
      expect(result.displayDescription).toBeTruthy();
    }
  });
});

describe('classifyCICheck (#81)', () => {
  it('should classify unknown check names as actionable', () => {
    expect(classifyCICheck('Build')).toBe('actionable');
    expect(classifyCICheck('Tests')).toBe('actionable');
    expect(classifyCICheck('Lint')).toBe('actionable');
    expect(classifyCICheck('CI / test (ubuntu-latest)')).toBe('actionable');
  });

  it('should classify Vercel as fork_limitation', () => {
    expect(classifyCICheck('Vercel')).toBe('fork_limitation');
    expect(classifyCICheck('Vercel Deploy')).toBe('fork_limitation');
    expect(classifyCICheck('vercel — Preview')).toBe('fork_limitation');
  });

  it('should classify Netlify as fork_limitation', () => {
    expect(classifyCICheck('Netlify')).toBe('fork_limitation');
    expect(classifyCICheck('netlify/build')).toBe('fork_limitation');
  });

  it('should classify deploy checks as fork_limitation', () => {
    expect(classifyCICheck('Deploy Preview')).toBe('fork_limitation');
    expect(classifyCICheck('deploy-storybook')).toBe('fork_limitation');
  });

  it('should classify preview checks as fork_limitation', () => {
    expect(classifyCICheck('Preview')).toBe('fork_limitation');
    expect(classifyCICheck('Chromatic - Visual Tests')).toBe('fork_limitation');
  });

  it('should classify Cloudflare Pages as fork_limitation', () => {
    expect(classifyCICheck('Cloudflare Pages')).toBe('fork_limitation');
  });

  it('should classify Percy as fork_limitation', () => {
    expect(classifyCICheck('Percy')).toBe('fork_limitation');
    expect(classifyCICheck('percy/finalize')).toBe('fork_limitation');
  });

  it('should classify CLA checks as auth_gate', () => {
    expect(classifyCICheck('license/cla')).toBe('auth_gate');
    expect(classifyCICheck('CLA Check')).toBe('auth_gate');
  });

  it('should classify authorization checks as auth_gate', () => {
    expect(classifyCICheck('Authorization Check')).toBe('auth_gate');
    expect(classifyCICheck('Authorize')).toBe('auth_gate');
  });

  it('should use description for classification when name is generic', () => {
    expect(classifyCICheck('status-check', 'Authorization required to deploy')).toBe('auth_gate');
    expect(classifyCICheck('some-check', 'Vercel deployment pending')).toBe('fork_limitation');
  });
});

describe('classifyFailingChecks (#81)', () => {
  it('should return empty array for no checks', () => {
    expect(classifyFailingChecks([])).toEqual([]);
  });

  it('should classify mixed checks correctly', () => {
    const result = classifyFailingChecks(['Build', 'Vercel Deploy', 'license/cla', 'Tests']);
    expect(result).toEqual([
      { name: 'Build', category: 'actionable' },
      { name: 'Vercel Deploy', category: 'fork_limitation' },
      { name: 'license/cla', category: 'auth_gate' },
      { name: 'Tests', category: 'actionable' },
    ]);
  });

  it('should preserve order of input checks', () => {
    const result = classifyFailingChecks(['Vercel', 'Build']);
    expect(result[0].name).toBe('Vercel');
    expect(result[1].name).toBe('Build');
  });
});
