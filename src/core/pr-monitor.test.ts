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
const { PRMonitor } = await import('./pr-monitor.js');

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
