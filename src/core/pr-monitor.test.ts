/**
 * Tests for PRMonitor — CI deduplication, status determination, checklist analysis,
 * maintainer hint extraction, review decision, and comment detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
const {
  PRMonitor,
  computeDisplayLabel,
  classifyCICheck,
  classifyFailingChecks,
  isConditionalChecklistItem,
} = await import('./pr-monitor.js');
const { isBotAuthor, isAcknowledgmentComment } = await import('./comment-utils.js');
const { getStateManager } = await import('./state.js');

// Import extracted module functions (pure logic, no mocks needed)
const { analyzeChecklist } = await import('./checklist-analysis.js');
const { extractMaintainerActionHints } = await import('./maintainer-analysis.js');
const { determineReviewDecision, getLatestChangesRequestedDate, checkUnrespondedComments, isAllSelfReplies } =
  await import('./review-analysis.js');

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
    const result = (monitor as any).determineStatus({
      ciStatus: 'passing',
      hasMergeConflict: false,
      hasUnrespondedComment: true,
      hasIncompleteChecklist: false,
      reviewDecision: 'changes_requested',
      daysSinceActivity: 2,
      dormantThreshold: 30,
      approachingThreshold: 25,
      latestCommitDate: '2026-02-08T12:00:00Z', // newer
      lastMaintainerCommentDate: '2026-02-07T10:00:00Z', // older
    });

    expect(result).toBe('changes_addressed');
  });

  it('should return needs_response when commit is older than maintainer comment', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus({
      ciStatus: 'passing',
      hasMergeConflict: false,
      hasUnrespondedComment: true,
      hasIncompleteChecklist: false,
      reviewDecision: 'changes_requested',
      daysSinceActivity: 2,
      dormantThreshold: 30,
      approachingThreshold: 25,
      latestCommitDate: '2026-02-06T10:00:00Z', // older
      lastMaintainerCommentDate: '2026-02-07T10:00:00Z', // newer
    });

    expect(result).toBe('needs_response');
  });

  it('should fall back to needs_response when commit date is unavailable', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus({
      ciStatus: 'passing',
      hasMergeConflict: false,
      hasUnrespondedComment: true,
      hasIncompleteChecklist: false,
      reviewDecision: 'changes_requested',
      daysSinceActivity: 2,
      dormantThreshold: 30,
      approachingThreshold: 25,
      latestCommitDate: undefined, // missing
      lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
    });

    expect(result).toBe('needs_response');
  });

  it('should not check commit date when hasUnrespondedComment is false and review is approved', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus({
      ciStatus: 'passing',
      hasMergeConflict: false,
      hasUnrespondedComment: false,
      hasIncompleteChecklist: false,
      reviewDecision: 'approved',
      daysSinceActivity: 2,
      dormantThreshold: 30,
      approachingThreshold: 25,
      latestCommitDate: '2026-02-08T12:00:00Z',
      lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      latestChangesRequestedDate: undefined,
    });

    expect(result).toBe('waiting_on_maintainer');
  });
});

describe('PRMonitor needs_changes detection', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return needs_changes when changes_requested and no new commits', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus({
      ciStatus: 'passing',
      hasMergeConflict: false,
      hasUnrespondedComment: false,
      hasIncompleteChecklist: false,
      reviewDecision: 'changes_requested',
      daysSinceActivity: 2,
      dormantThreshold: 30,
      approachingThreshold: 25,
      latestCommitDate: '2026-02-08T06:50:38Z', // before review
      lastMaintainerCommentDate: undefined,
      latestChangesRequestedDate: '2026-02-08T11:52:22Z', // after commit
    });

    expect(result).toBe('needs_changes');
  });

  it('should return changes_addressed when commits pushed after changes_requested review', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus({
      ciStatus: 'passing',
      hasMergeConflict: false,
      hasUnrespondedComment: false,
      hasIncompleteChecklist: false,
      reviewDecision: 'changes_requested',
      daysSinceActivity: 2,
      dormantThreshold: 30,
      approachingThreshold: 25,
      latestCommitDate: '2026-02-09T10:00:00Z', // after review
      lastMaintainerCommentDate: undefined,
      latestChangesRequestedDate: '2026-02-08T11:52:22Z', // before commit
    });

    expect(result).toBe('changes_addressed');
  });

  it('should return needs_changes when no commit date available', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus({
      ciStatus: 'passing',
      hasMergeConflict: false,
      hasUnrespondedComment: false,
      hasIncompleteChecklist: false,
      reviewDecision: 'changes_requested',
      daysSinceActivity: 2,
      dormantThreshold: 30,
      approachingThreshold: 25,
      latestCommitDate: undefined, // missing
      lastMaintainerCommentDate: undefined,
      latestChangesRequestedDate: '2026-02-08T11:52:22Z',
    });

    expect(result).toBe('needs_changes');
  });

  it('should return healthy when changes_requested but no review date available', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus({
      ciStatus: 'passing',
      hasMergeConflict: false,
      hasUnrespondedComment: false,
      hasIncompleteChecklist: false,
      reviewDecision: 'changes_requested',
      daysSinceActivity: 2,
      dormantThreshold: 30,
      approachingThreshold: 25,
      latestCommitDate: '2026-02-08T06:50:38Z',
      lastMaintainerCommentDate: undefined,
      latestChangesRequestedDate: undefined, // missing
    });

    // No review date to compare against — fall through to healthy
    expect(result).toBe('healthy');
  });
});

describe('PRMonitor determineStatus — remaining paths', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  // Helper to call determineStatus with defaults
  function callDetermineStatus(
    overrides: Partial<{
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
    }> = {},
  ) {
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
    return (monitor as any).determineStatus({ ...defaults, ...overrides });
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
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasUnrespondedComment: true,
      }),
    ).toBe('needs_response');
  });

  it('should prioritize failing_ci over merge_conflict', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasMergeConflict: true,
      }),
    ).toBe('failing_ci');
  });

  it('should prioritize merge_conflict over incomplete_checklist', () => {
    expect(
      callDetermineStatus({
        hasMergeConflict: true,
        hasIncompleteChecklist: true,
      }),
    ).toBe('merge_conflict');
  });
});

describe('PRMonitor analyzeChecklist', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return false for empty body', () => {
    const result = analyzeChecklist('');
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toBeUndefined();
  });

  it('should return false for body with no checkboxes', () => {
    const result = analyzeChecklist('This PR adds a new feature.');
    expect(result.hasIncompleteChecklist).toBe(false);
  });

  it('should return false when all checkboxes are checked', () => {
    const body = '- [x] Tests added\n- [x] Docs updated\n- [x] Linted';
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toEqual({ checked: 3, total: 3 });
  });

  it('should return true when some checkboxes are unchecked', () => {
    const body = '- [x] Tests added\n- [ ] Docs updated\n- [x] Linted';
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(true);
    expect(result.checklistStats).toEqual({ checked: 2, total: 3 });
  });

  it('should return true when all checkboxes are unchecked', () => {
    const body = '- [ ] Tests added\n- [ ] Docs updated';
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(true);
    expect(result.checklistStats).toEqual({ checked: 0, total: 2 });
  });

  it('should handle case-insensitive checked marks (- [X])', () => {
    const body = '- [X] Done\n- [ ] Not done';
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(true);
    expect(result.checklistStats).toEqual({ checked: 1, total: 2 });
  });

  it('should not flag conditional checklist items as incomplete (#152)', () => {
    const body = [
      '- [x] PR title and summary are descriptive',
      '- [x] Docs updated or follow-up ticket created',
      '- [x] Tests included',
      '- [ ] PR Labeled with `release/backport` (if the PR is an urgent fix that needs to be backported)',
    ].join('\n');
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toEqual({ checked: 3, total: 4 });
  });

  it('should still flag non-conditional unchecked items alongside conditional ones (#152)', () => {
    const body = ['- [x] Tests included', '- [ ] Documentation updated', '- [ ] Changelog entry (if applicable)'].join(
      '\n',
    );
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(true);
    expect(result.checklistStats).toEqual({ checked: 1, total: 3 });
  });

  it('should handle multiple conditional patterns (#152)', () => {
    const body = [
      '- [x] Tests pass',
      '- [ ] Update CHANGELOG (if applicable)',
      '- [ ] Add migration (only if schema changes)',
      '- [ ] Backport label (if needed)',
    ].join('\n');
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toEqual({ checked: 1, total: 4 });
  });

  it('should handle "N/A" and "optional" patterns (#152)', () => {
    const body = [
      '- [x] Code review',
      '- [ ] Screenshots (N/A for backend changes)',
      '- [ ] Optional: update README',
    ].join('\n');
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toEqual({ checked: 1, total: 3 });
  });
});

describe('PRMonitor extractMaintainerActionHints', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return changes_requested when reviewDecision is changes_requested', () => {
    const result = extractMaintainerActionHints(undefined, 'changes_requested');
    expect(result).toEqual(['changes_requested']);
  });

  it('should return empty array when no comment and no changes_requested', () => {
    const result = extractMaintainerActionHints(undefined, 'approved');
    expect(result).toEqual([]);
  });

  it('should detect demo_requested keywords', () => {
    const result = extractMaintainerActionHints('Can you show a screenshot of the before/after?', 'review_required');
    expect(result).toContain('demo_requested');
  });

  it('should detect tests_requested keywords', () => {
    const result = extractMaintainerActionHints('Please add test coverage for this feature', 'review_required');
    expect(result).toContain('tests_requested');
  });

  it('should detect docs_requested keywords', () => {
    const result = extractMaintainerActionHints(
      'Can you update the documentation for this API change?',
      'review_required',
    );
    expect(result).toContain('docs_requested');
  });

  it('should detect rebase_requested keywords', () => {
    const result = extractMaintainerActionHints('This branch is behind main, could you rebase?', 'review_required');
    expect(result).toContain('rebase_requested');
  });

  it('should detect multiple hints in one comment', () => {
    const result = extractMaintainerActionHints(
      'Please add test coverage and a screenshot of the changes',
      'changes_requested',
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
    const result = determineReviewDecision([]);
    expect(result).toBe('review_required');
  });

  it('should return approved when latest review is APPROVED', () => {
    const result = determineReviewDecision([{ state: 'APPROVED', user: { login: 'reviewer1' } }]);
    expect(result).toBe('approved');
  });

  it('should return changes_requested when latest review is CHANGES_REQUESTED', () => {
    const result = determineReviewDecision([{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } }]);
    expect(result).toBe('changes_requested');
  });

  it('should use latest review per user', () => {
    const result = determineReviewDecision([
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } },
      { state: 'APPROVED', user: { login: 'reviewer1' } }, // Same user, later approval
    ]);
    expect(result).toBe('approved');
  });

  it('should prioritize changes_requested over approved from different users', () => {
    const result = determineReviewDecision([
      { state: 'APPROVED', user: { login: 'reviewer1' } },
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer2' } },
    ]);
    expect(result).toBe('changes_requested');
  });

  it('should return review_required for COMMENTED-only reviews', () => {
    const result = determineReviewDecision([{ state: 'COMMENTED', user: { login: 'reviewer1' } }]);
    expect(result).toBe('review_required');
  });
});

describe('PRMonitor getLatestChangesRequestedDate', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return undefined when no reviews', () => {
    const result = getLatestChangesRequestedDate([]);
    expect(result).toBeUndefined();
  });

  it('should return undefined when no CHANGES_REQUESTED reviews', () => {
    const result = getLatestChangesRequestedDate([{ state: 'APPROVED', submitted_at: '2026-02-07T10:00:00Z' }]);
    expect(result).toBeUndefined();
  });

  it('should return the date of the single CHANGES_REQUESTED review', () => {
    const result = getLatestChangesRequestedDate([
      { state: 'CHANGES_REQUESTED', submitted_at: '2026-02-07T10:00:00Z' },
    ]);
    expect(result).toBe('2026-02-07T10:00:00Z');
  });

  it('should return the latest date when multiple CHANGES_REQUESTED reviews', () => {
    const result = getLatestChangesRequestedDate([
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
    const result = checkUnrespondedComments([], [], [], 'testuser');
    expect(result.hasUnrespondedComment).toBe(false);
    expect(result.lastMaintainerComment).toBeUndefined();
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
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Please fix X', created_at: '2026-02-07T12:00:00Z' },
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
        { user: { login: 'maintainer' }, body: 'Please fix X', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'testuser' }, body: 'Fixed', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should skip bot comments with [bot] suffix', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'dependabot[bot]' }, body: 'Dependency update', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should skip known bot accounts without [bot] suffix', () => {
    const knownBots = ['CLAassistant', 'codecov-commenter', 'changeset-bot', 'netlify', 'sonarcloud'];
    for (const bot of knownBots) {
      const result = checkUnrespondedComments(
        [
          { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
          { user: { login: bot }, body: 'Automated check passed', created_at: '2026-02-07T12:00:00Z' },
        ],
        [],
        [],
        'testuser',
      );
      expect(result.hasUnrespondedComment).toBe(false);
    }
  });

  it('should still flag non-bot maintainer comments when bot comments also exist', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'CLAassistant' }, body: 'CLA signed', created_at: '2026-02-07T11:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Please add tests', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('maintainer');
  });

  it('should skip comments from deleted accounts (null user)', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: null, body: 'Ghost comment', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should include review comments with body text in timeline', () => {
    const result = checkUnrespondedComments(
      [],
      [{ user: { login: 'maintainer' }, body: 'Needs changes here', submitted_at: '2026-02-07T12:00:00Z' }],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('maintainer');
  });

  it('should skip reviews with empty body', () => {
    const result = checkUnrespondedComments(
      [],
      [{ user: { login: 'maintainer' }, body: '', submitted_at: '2026-02-07T12:00:00Z' }],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should truncate long comment bodies to 200 chars', () => {
    const longBody = 'x'.repeat(300);
    const result = checkUnrespondedComments(
      [{ user: { login: 'maintainer' }, body: longBody, created_at: '2026-02-07T12:00:00Z' }],
      [],
      [],
      'testuser',
    );
    expect(result.lastMaintainerComment?.body.length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it('should be case-insensitive for username matching', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'TestUser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Fix this', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      [],
      'testuser', // lowercase
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

    expect(digest.prsNeedingResponse.map((p) => p.number)).toEqual([1]);
    expect(digest.ciFailingPRs.map((p) => p.number)).toEqual([2]);
    expect(digest.mergeConflictPRs.map((p) => p.number)).toEqual([3]);
    expect(digest.healthyPRs.map((p) => p.number)).toEqual([4, 11]); // healthy + waiting
    expect(digest.dormantPRs.map((p) => p.number)).toEqual([5]);
    expect(digest.approachingDormant.map((p) => p.number)).toEqual([6]);
    expect(digest.needsChangesPRs.map((p) => p.number)).toEqual([7]);
    expect(digest.changesAddressedPRs.map((p) => p.number)).toEqual([8]);
    expect(digest.waitingOnMaintainerPRs.map((p) => p.number)).toEqual([9]);
    expect(digest.incompleteChecklistPRs.map((p) => p.number)).toEqual([10]);
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

  it('should include recentlyMergedPRs', () => {
    const mergedPRs: import('./types.js').MergedPR[] = [
      {
        url: 'https://github.com/owner/repo/pull/200',
        repo: 'owner/repo',
        number: 200,
        title: 'Merged PR 1',
        mergedAt: '2026-02-06T00:00:00Z',
      },
      {
        url: 'https://github.com/owner/repo/pull/201',
        repo: 'owner/repo',
        number: 201,
        title: 'Merged PR 2',
        mergedAt: '2026-02-05T00:00:00Z',
      },
    ];

    const monitor = new PRMonitor('fake-token');
    const digest = monitor.generateDigest([], [], mergedPRs);

    expect(digest.recentlyMergedPRs).toHaveLength(2);
    expect(digest.recentlyMergedPRs[0].number).toBe(200);
    expect(digest.recentlyMergedPRs[1].number).toBe(201);
  });

  it('should default recentlyMergedPRs to empty array', () => {
    const monitor = new PRMonitor('fake-token');
    const digest = monitor.generateDigest([]);

    expect(digest.recentlyMergedPRs).toEqual([]);
  });
});

describe('PRMonitor fetchRecentlyMergedPRs', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: ['excluded/repo'],
          excludeOrgs: ['excludedorg'],
        },
      }),
    } as any);
  });

  it('should fetch and return recently merged PRs', async () => {
    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                html_url: 'https://github.com/owner/repo/pull/42',
                title: 'Fix the thing',
                pull_request: { merged_at: '2026-02-15T12:00:00Z' },
                closed_at: '2026-02-15T12:00:00Z',
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchRecentlyMergedPRs();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      url: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
      number: 42,
      title: 'Fix the thing',
      mergedAt: '2026-02-15T12:00:00Z',
    });
  });

  it('should skip PRs to own repos', async () => {
    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                html_url: 'https://github.com/testuser/my-repo/pull/1',
                title: 'Self PR',
                pull_request: { merged_at: '2026-02-15T12:00:00Z' },
                closed_at: '2026-02-15T12:00:00Z',
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchRecentlyMergedPRs();

    expect(result).toHaveLength(0);
  });

  it('should skip excluded repos', async () => {
    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                html_url: 'https://github.com/excluded/repo/pull/1',
                title: 'Excluded repo PR',
                pull_request: { merged_at: '2026-02-15T12:00:00Z' },
                closed_at: '2026-02-15T12:00:00Z',
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchRecentlyMergedPRs();

    expect(result).toHaveLength(0);
  });

  it('should skip excluded orgs', async () => {
    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                html_url: 'https://github.com/excludedorg/repo/pull/1',
                title: 'Excluded org PR',
                pull_request: { merged_at: '2026-02-15T12:00:00Z' },
                closed_at: '2026-02-15T12:00:00Z',
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchRecentlyMergedPRs();

    expect(result).toHaveLength(0);
  });

  it('should return empty array when no username configured', async () => {
    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({ config: { githubUsername: '' } }),
    } as any);

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchRecentlyMergedPRs();

    expect(result).toEqual([]);
  });

  it('should use merged_at from pull_request field', async () => {
    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                html_url: 'https://github.com/owner/repo/pull/10',
                title: 'PR with merged_at',
                pull_request: { merged_at: '2026-02-14T08:00:00Z' },
                closed_at: '2026-02-14T09:00:00Z',
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchRecentlyMergedPRs();

    expect(result[0].mergedAt).toBe('2026-02-14T08:00:00Z');
  });

  it('should fall back to closed_at when merged_at is absent', async () => {
    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                html_url: 'https://github.com/owner/repo/pull/10',
                title: 'PR without merged_at',
                pull_request: {},
                closed_at: '2026-02-14T09:00:00Z',
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchRecentlyMergedPRs();

    expect(result[0].mergedAt).toBe('2026-02-14T09:00:00Z');
  });
});

describe('PRMonitor CI failure overrides changes_addressed (Issue #68)', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  // Helper to call determineStatus with defaults
  function callDetermineStatus(
    overrides: Partial<{
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
    }> = {},
  ) {
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
    return (monitor as any).determineStatus({ ...defaults, ...overrides });
  }

  it('should return failing_ci when changes_addressed (comment path) and CI is failing', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasUnrespondedComment: true,
        latestCommitDate: '2026-02-08T12:00:00Z',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toBe('failing_ci');
  });

  it('should return failing_ci when changes_addressed (review path) and CI is failing', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-09T10:00:00Z',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toBe('failing_ci');
  });

  it('should still return changes_addressed when CI is passing (comment path regression)', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'passing',
        hasUnrespondedComment: true,
        latestCommitDate: '2026-02-08T12:00:00Z',
        lastMaintainerCommentDate: '2026-02-07T10:00:00Z',
      }),
    ).toBe('changes_addressed');
  });

  it('should still return changes_addressed when CI is passing (review path regression)', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'passing',
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-09T10:00:00Z',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toBe('changes_addressed');
  });

  it('should still prioritize needs_response over failing_ci', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        hasUnrespondedComment: true,
        // No commit after maintainer comment → needs_response, not changes_addressed
      }),
    ).toBe('needs_response');
  });

  it('should still prioritize needs_changes over failing_ci', () => {
    expect(
      callDetermineStatus({
        ciStatus: 'failing',
        reviewDecision: 'changes_requested',
        latestCommitDate: '2026-02-07T06:50:38Z',
        latestChangesRequestedDate: '2026-02-08T11:52:22Z',
      }),
    ).toBe('needs_changes');
  });
});

describe('isAcknowledgmentComment (Issue #69)', () => {
  it('should detect "thanks" as acknowledgment', () => {
    expect(isAcknowledgmentComment('thanks')).toBe(true);
  });

  it('should detect "Thank you!" as acknowledgment', () => {
    expect(isAcknowledgmentComment('Thank you!')).toBe(true);
  });

  it('should detect "LGTM" as acknowledgment', () => {
    expect(isAcknowledgmentComment('LGTM')).toBe(true);
  });

  it('should detect "Looks good, will review soon" as acknowledgment', () => {
    expect(isAcknowledgmentComment('Looks good, will review soon')).toBe(true);
  });

  it('should detect "we\'ll get to this shortly" as acknowledgment', () => {
    expect(isAcknowledgmentComment("we'll get to this shortly")).toBe(true);
  });

  it('should detect "noted" as acknowledgment', () => {
    expect(isAcknowledgmentComment('noted')).toBe(true);
  });

  it('should NOT detect actionable comment as acknowledgment', () => {
    expect(isAcknowledgmentComment('Please fix linting errors')).toBe(false);
  });

  it('should NOT detect empty string as acknowledgment', () => {
    expect(isAcknowledgmentComment('')).toBe(false);
  });

  it('should NOT detect comment with question mark as acknowledgment', () => {
    expect(isAcknowledgmentComment('Thanks, can you add tests?')).toBe(false);
  });

  it('should NOT detect long comment with keyword as acknowledgment', () => {
    const longComment = 'Thanks for this PR! ' + 'x'.repeat(100);
    expect(isAcknowledgmentComment(longComment)).toBe(false);
  });

  it('should not trigger hasUnrespondedComment for acknowledgment comments', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR description', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Thanks, will review soon', created_at: '2026-02-07T12:00:00Z' },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
    expect(result.lastMaintainerComment).toBeUndefined();
  });

  it('should still trigger hasUnrespondedComment for actionable comment after acknowledgment', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Thanks, will look at this', created_at: '2026-02-07T11:00:00Z' },
        {
          user: { login: 'maintainer' },
          body: 'Please fix the linting errors in src/main.ts',
          created_at: '2026-02-07T12:00:00Z',
        },
      ],
      [],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('maintainer');
  });

  it('should detect inline-only COMMENTED reviews as unresponded (#151)', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' }],
      [
        // Review with inline comments only (no top-level body)
        { user: { login: 'reviewer' }, body: '', submitted_at: '2026-02-07T12:00:00Z', state: 'COMMENTED' },
      ],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('reviewer');
  });

  it('should skip reviews with null/undefined state and no body (#151)', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' }],
      [{ user: { login: 'reviewer' }, body: '', submitted_at: '2026-02-07T12:00:00Z' }],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should skip CHANGES_REQUESTED reviews with empty body (#151)', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' }],
      [{ user: { login: 'reviewer' }, body: '', submitted_at: '2026-02-07T12:00:00Z', state: 'CHANGES_REQUESTED' }],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should ignore user own COMMENTED reviews (#151)', () => {
    const result = checkUnrespondedComments(
      [],
      [
        // User's own inline review — should not trigger needs_response
        { user: { login: 'testuser' }, body: '', submitted_at: '2026-02-07T12:00:00Z', state: 'COMMENTED' },
      ],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should use synthetic body for inline-only COMMENTED reviews (#151)', () => {
    const result = checkUnrespondedComments(
      [],
      [{ user: { login: 'reviewer' }, body: '', submitted_at: '2026-02-07T12:00:00Z', state: 'COMMENTED' }],
      [],
      'testuser',
    );
    expect(result.lastMaintainerComment?.body).toBe('(posted inline review comments)');
  });

  it('should still skip APPROVED reviews with no body (#151)', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-07T10:00:00Z' }],
      [{ user: { login: 'reviewer' }, body: '', submitted_at: '2026-02-07T12:00:00Z', state: 'APPROVED' }],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should detect new inline review after commit as needs_response (#151)', () => {
    // Scenario: maintainer comments → user pushes commit → different reviewer posts inline review
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-13T00:00:00Z' },
        { user: { login: 'fregante' }, body: 'Please fix X', created_at: '2026-02-13T00:37:25Z' },
      ],
      [
        // Inline-only review posted after the user's commit
        { user: { login: 'SunsetTechuila' }, body: '', submitted_at: '2026-02-14T05:14:49Z', state: 'COMMENTED' },
      ],
      [],
      'testuser',
    );
    expect(result.hasUnrespondedComment).toBe(true);
    // The most recent maintainer comment should be the inline review, not the older comment
    expect(result.lastMaintainerComment?.author).toBe('SunsetTechuila');
    expect(result.lastMaintainerComment?.createdAt).toBe('2026-02-14T05:14:49Z');
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
    const { displayLabel, displayDescription } = computeDisplayLabel(
      makePR({
        status: 'needs_response',
        lastMaintainerComment: { author: 'johndoe', body: 'Please fix', createdAt: '2026-02-07T10:00:00Z' },
      }),
    );
    expect(displayLabel).toBe('[Needs Response]');
    expect(displayDescription).toBe('@johndoe commented');
  });

  it('should return fallback description for needs_response without comment', () => {
    const { displayDescription } = computeDisplayLabel(makePR({ status: 'needs_response' }));
    expect(displayDescription).toBe('Maintainer awaiting response');
  });

  it('should return [CI Failing] with actionable check count', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(
      makePR({
        status: 'failing_ci',
        failingCheckNames: ['Build', 'Lint', 'Vercel Deploy'],
        classifiedChecks: [
          { name: 'Build', category: 'actionable' },
          { name: 'Lint', category: 'actionable' },
          { name: 'Vercel Deploy', category: 'fork_limitation' },
        ],
      }),
    );
    expect(displayLabel).toBe('[CI Failing]');
    expect(displayDescription).toBe('2 checks failed: Build, Lint');
  });

  it('should return singular form for exactly 1 actionable check', () => {
    const { displayDescription } = computeDisplayLabel(
      makePR({
        status: 'failing_ci',
        failingCheckNames: ['Build'],
        classifiedChecks: [{ name: 'Build', category: 'actionable' }],
      }),
    );
    expect(displayDescription).toBe('1 check failed: Build');
  });

  it('should fall back to failingCheckNames count when all checks are non-actionable', () => {
    const { displayDescription } = computeDisplayLabel(
      makePR({
        status: 'failing_ci',
        failingCheckNames: ['Vercel Deploy', 'Netlify Build'],
        classifiedChecks: [
          { name: 'Vercel Deploy', category: 'fork_limitation' },
          { name: 'Netlify Build', category: 'fork_limitation' },
        ],
      }),
    );
    expect(displayDescription).toBe('2 checks failed');
  });

  it('should indicate infrastructure failures when all checks are infrastructure (#145)', () => {
    const { displayDescription } = computeDisplayLabel(
      makePR({
        status: 'failing_ci',
        failingCheckNames: ['Build', 'Lint'],
        classifiedChecks: [
          { name: 'Build', category: 'infrastructure', conclusion: 'cancelled' },
          { name: 'Lint', category: 'infrastructure', conclusion: 'timed_out' },
        ],
      }),
    );
    expect(displayDescription).toBe('2 checks cancelled/timed out (infrastructure)');
  });

  it('should indicate single infrastructure failure (#145)', () => {
    const { displayDescription } = computeDisplayLabel(
      makePR({
        status: 'failing_ci',
        failingCheckNames: ['Build'],
        classifiedChecks: [{ name: 'Build', category: 'infrastructure', conclusion: 'cancelled' }],
      }),
    );
    expect(displayDescription).toBe('1 check cancelled/timed out (infrastructure)');
  });

  it('should return generic description when no classified checks', () => {
    const { displayDescription } = computeDisplayLabel(
      makePR({
        status: 'failing_ci',
        failingCheckNames: [],
        classifiedChecks: [],
      }),
    );
    expect(displayDescription).toBe('One or more CI checks are failing');
  });

  it('should return [Merge Conflict] for merge_conflict', () => {
    const { displayLabel } = computeDisplayLabel(makePR({ status: 'merge_conflict' }));
    expect(displayLabel).toBe('[Merge Conflict]');
  });

  it('should return [Incomplete Checklist] with stats', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(
      makePR({
        status: 'incomplete_checklist',
        checklistStats: { checked: 2, total: 5 },
      }),
    );
    expect(displayLabel).toBe('[Incomplete Checklist]');
    expect(displayDescription).toBe('2/5 items checked');
  });

  it('should return fallback for incomplete_checklist without stats', () => {
    const { displayDescription } = computeDisplayLabel(
      makePR({
        status: 'incomplete_checklist',
      }),
    );
    expect(displayDescription).toBe('PR body has unchecked required checkboxes');
  });

  it('should return [Missing Files] with file list', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(
      makePR({
        status: 'missing_required_files',
        missingRequiredFiles: ['CHANGELOG.md', 'LICENSE'],
      }),
    );
    expect(displayLabel).toBe('[Missing Files]');
    expect(displayDescription).toBe('Missing: CHANGELOG.md, LICENSE');
  });

  it('should return fallback for missing_required_files without file list', () => {
    const { displayDescription } = computeDisplayLabel(
      makePR({
        status: 'missing_required_files',
      }),
    );
    expect(displayDescription).toBe('Required files are missing');
  });

  it('should return [Changes Addressed] with author', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(
      makePR({
        status: 'changes_addressed',
        lastMaintainerComment: { author: 'reviewer', body: 'Changes needed', createdAt: '2026-02-07T10:00:00Z' },
      }),
    );
    expect(displayLabel).toBe('[Changes Addressed]');
    expect(displayDescription).toBe('Waiting for @reviewer to re-review');
  });

  it('should return fallback for changes_addressed without comment', () => {
    const { displayDescription } = computeDisplayLabel(
      makePR({
        status: 'changes_addressed',
      }),
    );
    expect(displayDescription).toBe('Waiting for maintainer re-review');
  });

  it('should return [Dormant] with days count', () => {
    const { displayLabel, displayDescription } = computeDisplayLabel(
      makePR({
        status: 'dormant',
        daysSinceActivity: 45,
      }),
    );
    expect(displayLabel).toBe('[Dormant]');
    expect(displayDescription).toBe('No activity for 45 days');
  });

  it('should return [Approaching Dormant] with days count', () => {
    const { displayDescription } = computeDisplayLabel(
      makePR({
        status: 'approaching_dormant',
        daysSinceActivity: 27,
      }),
    );
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
      'needs_response',
      'failing_ci',
      'ci_blocked',
      'ci_not_running',
      'merge_conflict',
      'needs_rebase',
      'missing_required_files',
      'incomplete_checklist',
      'needs_changes',
      'changes_addressed',
      'waiting',
      'waiting_on_maintainer',
      'healthy',
      'approaching_dormant',
      'dormant',
    ];
    for (const status of allStatuses) {
      const result = computeDisplayLabel(makePR({ status }));
      expect(result.displayLabel).toBeTruthy();
      expect(result.displayDescription).toBeTruthy();
    }
  });

  it('should return fallback for unknown status', () => {
    const pr = makePR({ status: 'unknown_future_status' as any });
    const result = computeDisplayLabel(pr);
    expect(result.displayLabel).toBe('[unknown_future_status]');
    expect(result.displayDescription).toBe('Unknown status');
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

  it('should classify deploy preview checks as fork_limitation', () => {
    expect(classifyCICheck('Deploy Preview')).toBe('fork_limitation');
    expect(classifyCICheck('preview deploy')).toBe('fork_limitation');
  });

  it('should classify storybook checks as fork_limitation', () => {
    expect(classifyCICheck('deploy-storybook')).toBe('fork_limitation');
    expect(classifyCICheck('Storybook')).toBe('fork_limitation');
  });

  it('should classify standalone deploy/preview as actionable', () => {
    expect(classifyCICheck('Preview')).toBe('actionable');
    expect(classifyCICheck('Deploy validation')).toBe('actionable');
  });

  it('should classify Chromatic as fork_limitation', () => {
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

  it('should prioritize auth_gate over fork_limitation when both match', () => {
    // "Vercel" matches fork_limitation, "CLA" matches auth_gate — auth_gate wins
    expect(classifyCICheck('Vercel CLA check')).toBe('auth_gate');
  });

  it('should classify cancelled jobs as infrastructure (#145)', () => {
    expect(classifyCICheck('pytest on macOS', undefined, 'cancelled')).toBe('infrastructure');
    expect(classifyCICheck('Build', undefined, 'cancelled')).toBe('infrastructure');
  });

  it('should classify timed_out jobs as infrastructure (#145)', () => {
    expect(classifyCICheck('CI / test (ubuntu-latest)', undefined, 'timed_out')).toBe('infrastructure');
  });

  it('should classify infrastructure-related check names (#145)', () => {
    expect(classifyCICheck('Install OS dependencies')).toBe('infrastructure');
    expect(classifyCICheck('Runner setup failed')).toBe('infrastructure');
    expect(classifyCICheck('Service unavailable')).toBe('infrastructure');
  });

  it('should not false-positive on legitimate check names containing runner/timeout/hang (#145)', () => {
    expect(classifyCICheck('Test runner')).toBe('actionable');
    expect(classifyCICheck('Jest runner')).toBe('actionable');
    expect(classifyCICheck('API timeout handling tests')).toBe('actionable');
    expect(classifyCICheck('Connection timeout tests')).toBe('actionable');
    expect(classifyCICheck('Hang detection tests')).toBe('actionable');
  });

  it('should not false-positive on check names containing setup/install substrings (#145)', () => {
    expect(classifyCICheck('Setup test to fail gracefully')).toBe('actionable');
    expect(classifyCICheck('Setup failover tests')).toBe('actionable');
    expect(classifyCICheck('Install deprecated packages')).toBe('actionable');
  });

  it('should correctly match tightened infrastructure patterns (#145)', () => {
    expect(classifyCICheck('Install dependencies')).toBe('infrastructure');
    expect(classifyCICheck('Install OS dependencies')).toBe('infrastructure');
    expect(classifyCICheck('Install deps')).toBe('infrastructure');
    expect(classifyCICheck('Setup failed')).toBe('infrastructure');
    expect(classifyCICheck('Setup failure')).toBe('infrastructure');
  });

  it('should prioritize conclusion over name patterns (#145)', () => {
    // Even if name looks actionable, cancelled conclusion means infrastructure
    expect(classifyCICheck('Tests', undefined, 'cancelled')).toBe('infrastructure');
    // But a failed conclusion with actionable name stays actionable
    expect(classifyCICheck('Tests', undefined, 'failure')).toBe('actionable');
  });
});

describe('classifyFailingChecks (#81, #145)', () => {
  it('should return empty array for no checks', () => {
    expect(classifyFailingChecks([])).toEqual([]);
  });

  it('should classify mixed checks correctly', () => {
    const result = classifyFailingChecks(['Build', 'Vercel Deploy', 'license/cla', 'Tests']);
    expect(result).toEqual([
      { name: 'Build', category: 'actionable', conclusion: undefined },
      { name: 'Vercel Deploy', category: 'fork_limitation', conclusion: undefined },
      { name: 'license/cla', category: 'auth_gate', conclusion: undefined },
      { name: 'Tests', category: 'actionable', conclusion: undefined },
    ]);
  });

  it('should use conclusion data for classification (#145)', () => {
    const conclusions = new Map([
      ['Build', 'cancelled'],
      ['Tests', 'failure'],
    ]);
    const result = classifyFailingChecks(['Build', 'Tests'], conclusions);
    expect(result).toEqual([
      { name: 'Build', category: 'infrastructure', conclusion: 'cancelled' },
      { name: 'Tests', category: 'actionable', conclusion: 'failure' },
    ]);
  });

  it('should preserve order of input checks', () => {
    const result = classifyFailingChecks(['Vercel', 'Build']);
    expect(result[0].name).toBe('Vercel');
    expect(result[1].name).toBe('Build');
  });
});

describe('isConditionalChecklistItem (#152)', () => {
  it('should detect "(if ...)" pattern', () => {
    expect(isConditionalChecklistItem('- [ ] PR Labeled with `release/backport` (if the PR is an urgent fix)')).toBe(
      true,
    );
  });

  it('should detect "if applicable"', () => {
    expect(isConditionalChecklistItem('- [ ] Update CHANGELOG (if applicable)')).toBe(true);
    expect(isConditionalChecklistItem('- [ ] Changelog entry if applicable')).toBe(true);
  });

  it('should detect "if needed" and "if necessary"', () => {
    expect(isConditionalChecklistItem('- [ ] Add migration if needed')).toBe(true);
    expect(isConditionalChecklistItem('- [ ] Update docs if necessary')).toBe(true);
  });

  it('should detect "only if"', () => {
    expect(isConditionalChecklistItem('- [ ] Add migration only if schema changes')).toBe(true);
  });

  it('should detect "N/A" and "not applicable"', () => {
    expect(isConditionalChecklistItem('- [ ] Screenshots (N/A for backend changes)')).toBe(true);
    expect(isConditionalChecklistItem('- [ ] Demo - not applicable')).toBe(true);
  });

  it('should detect "optional" in parentheses or at start of item', () => {
    expect(isConditionalChecklistItem('- [ ] Optional: update README')).toBe(true);
    expect(isConditionalChecklistItem('- [ ] Screenshots (optional)')).toBe(true);
  });

  it('should NOT flag "optional" in the middle of a meaningful item', () => {
    expect(isConditionalChecklistItem('- [ ] Add optional parameters to API')).toBe(false);
    expect(isConditionalChecklistItem('- [ ] Support optional chaining in parser')).toBe(false);
  });

  it('should detect "if required" and "when applicable"', () => {
    expect(isConditionalChecklistItem('- [ ] Update API docs if required')).toBe(true);
    expect(isConditionalChecklistItem('- [ ] Migration script when applicable')).toBe(true);
  });

  it('should NOT flag unconditional items', () => {
    expect(isConditionalChecklistItem('- [ ] Tests added')).toBe(false);
    expect(isConditionalChecklistItem('- [ ] Documentation updated')).toBe(false);
    expect(isConditionalChecklistItem('- [ ] Lint passes')).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isConditionalChecklistItem('- [ ] IF APPLICABLE: update docs')).toBe(true);
    expect(isConditionalChecklistItem('- [ ] Optional README update')).toBe(true);
  });
});

describe('fetchUserOpenPRs excludeRepos/excludeOrgs exempts shelved PRs (#175)', () => {
  const makeSearchItem = (url: string) => ({
    html_url: url,
    title: 'Test PR',
    pull_request: { html_url: url },
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-07T00:00:00Z',
  });

  // Minimal mock for fetchPRDetails — just enough for the PR to pass through
  const makePRDetailMocks = (prUrl: string) => {
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) throw new Error(`Bad URL: ${prUrl}`);
    const [, _owner, _repo, num] = match;
    return {
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            id: Number(num),
            title: 'Test PR',
            created_at: '2026-02-01T00:00:00Z',
            updated_at: '2026-02-07T00:00:00Z',
            head: { sha: 'abc123' },
            mergeable: true,
            mergeable_state: 'clean',
            body: '',
            draft: false,
            review_comments: 0,
            commits: 1,
          },
        }),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
        listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [] }),
      },
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: { state: 'success', statuses: [] },
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
      },
    };
  };

  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should include shelved PR from excluded repo', async () => {
    const shelvedUrl = 'https://github.com/excluded/repo/pull/42';

    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: ['excluded/repo'],
          excludeOrgs: [],
          shelvedPRUrls: [shelvedUrl],
          dormantThresholdDays: 30,
          approachingDormantDays: 25,
        },
      }),
    } as any);

    const detailMocks = makePRDetailMocks(shelvedUrl);
    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 1,
            items: [makeSearchItem(shelvedUrl)],
          },
        }),
      },
      ...detailMocks,
    };

    const monitor = new PRMonitor('fake-token');
    const { prs } = await monitor.fetchUserOpenPRs();

    expect(prs).toHaveLength(1);
    expect(prs[0].url).toBe(shelvedUrl);
  });

  it('should include shelved PR from excluded org', async () => {
    const shelvedUrl = 'https://github.com/excludedorg/somerepo/pull/10';

    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: [],
          excludeOrgs: ['excludedorg'],
          shelvedPRUrls: [shelvedUrl],
          dormantThresholdDays: 30,
          approachingDormantDays: 25,
        },
      }),
    } as any);

    const detailMocks = makePRDetailMocks(shelvedUrl);
    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 1,
            items: [makeSearchItem(shelvedUrl)],
          },
        }),
      },
      ...detailMocks,
    };

    const monitor = new PRMonitor('fake-token');
    const { prs } = await monitor.fetchUserOpenPRs();

    expect(prs).toHaveLength(1);
    expect(prs[0].url).toBe(shelvedUrl);
  });

  it('should still exclude non-shelved PR from excluded repo', async () => {
    const excludedUrl = 'https://github.com/excluded/repo/pull/99';

    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: ['excluded/repo'],
          excludeOrgs: [],
          shelvedPRUrls: [],
          dormantThresholdDays: 30,
          approachingDormantDays: 25,
        },
      }),
    } as any);

    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 1,
            items: [makeSearchItem(excludedUrl)],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const { prs } = await monitor.fetchUserOpenPRs();

    expect(prs).toHaveLength(0);
  });

  it('should still exclude non-shelved PR from excluded org', async () => {
    const excludedUrl = 'https://github.com/excludedorg/somerepo/pull/77';

    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: [],
          excludeOrgs: ['excludedorg'],
          shelvedPRUrls: [],
          dormantThresholdDays: 30,
          approachingDormantDays: 25,
        },
      }),
    } as any);

    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 1,
            items: [makeSearchItem(excludedUrl)],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const { prs } = await monitor.fetchUserOpenPRs();

    expect(prs).toHaveLength(0);
  });
});

describe('PRMonitor status with inline review after commit (#151)', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return needs_response when inline review arrives after commit that addressed old comment', () => {
    const monitor = new PRMonitor('fake-token');
    const status = (monitor as any).determineStatus({
      ciStatus: 'passing',
      hasMergeConflict: false,
      hasUnrespondedComment: true,
      hasIncompleteChecklist: false,
      reviewDecision: 'review_required',
      daysSinceActivity: 1,
      dormantThreshold: 30,
      approachingThreshold: 25,
      latestCommitDate: '2026-02-13T06:35:00Z', // before inline review
      lastMaintainerCommentDate: '2026-02-14T05:14:49Z', // inline review
    });

    expect(status).toBe('needs_response');
  });
});

describe('isBotAuthor (#143)', () => {
  it('should identify [bot] suffix accounts', () => {
    expect(isBotAuthor('dependabot[bot]')).toBe(true);
    expect(isBotAuthor('github-actions[bot]')).toBe(true);
    expect(isBotAuthor('n8n-assistant[bot]')).toBe(true);
  });

  it('should identify known bot accounts without [bot] suffix', () => {
    expect(isBotAuthor('CLAassistant')).toBe(true);
    expect(isBotAuthor('codecov-commenter')).toBe(true);
    expect(isBotAuthor('changeset-bot')).toBe(true);
    expect(isBotAuthor('netlify')).toBe(true);
    expect(isBotAuthor('sonarcloud')).toBe(true);
    expect(isBotAuthor('renovate')).toBe(true);
    expect(isBotAuthor('imgbot')).toBe(true);
    expect(isBotAuthor('snyk-bot')).toBe(true);
  });

  it('should be case-insensitive for known bots', () => {
    expect(isBotAuthor('claassistant')).toBe(true);
    expect(isBotAuthor('CLAASSISTANT')).toBe(true);
    expect(isBotAuthor('Netlify')).toBe(true);
  });

  it('should not flag human users', () => {
    expect(isBotAuthor('maintainer')).toBe(false);
    expect(isBotAuthor('sindresorhus')).toBe(false);
    expect(isBotAuthor('costajohnt')).toBe(false);
  });
});

describe('getCIStatus error handling (#182)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  /** Create an error with an HTTP status code, matching Octokit's error shape */
  function httpError(message: string, status: number): Error {
    return Object.assign(new Error(message), { status });
  }

  /** Build a mockOctokitInstance where both API methods reject with the same error */
  function mockBothEndpointsRejecting(error: Error): void {
    mockOctokitInstance = {
      repos: { getCombinedStatusForRef: vi.fn().mockRejectedValue(error) },
      checks: { listForRef: vi.fn().mockRejectedValue(error) },
    };
  }

  /** Call getCIStatus on a fresh PRMonitor with a standard test SHA */
  async function callGetCIStatus(sha = 'abc123def'): Promise<any> {
    const monitor = new PRMonitor('fake-token');
    return (monitor as any).getCIStatus('owner', 'repo', sha);
  }

  const emptyCombinedStatus = {
    data: { state: 'success', statuses: [] },
  };

  beforeEach(() => {
    mockOctokitInstance = {};
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('should return unknown status on 401 unauthorized and log AUTH ERROR', async () => {
    mockBothEndpointsRejecting(httpError('Unauthorized', 401));

    const result = await callGetCIStatus();

    expect(result.status).toBe('unknown');
    expect(result.failingCheckNames).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('CI check failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid token'));
  });

  it('should return unknown status on 403 rate limit and log RATE LIMIT', async () => {
    mockBothEndpointsRejecting(httpError('Forbidden', 403));

    const result = await callGetCIStatus();

    expect(result.status).toBe('unknown');
    expect(result.failingCheckNames).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('CI check failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limit exceeded'));
  });

  it('should return unknown status on 404 without logging an error', async () => {
    mockBothEndpointsRejecting(httpError('Not Found', 404));

    const result = await callGetCIStatus();

    expect(result.status).toBe('unknown');
    expect(result.failingCheckNames).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('should return unknown status on 500 generic error and log CI ERROR', async () => {
    mockBothEndpointsRejecting(httpError('Internal Server Error', 500));

    const result = await callGetCIStatus();

    expect(result.status).toBe('unknown');
    expect(result.failingCheckNames).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to check CI'));
  });

  it('should return unknown status on network timeout error and log CI ERROR', async () => {
    mockBothEndpointsRejecting(new Error('connect ETIMEDOUT'));

    const result = await callGetCIStatus();

    expect(result.status).toBe('unknown');
    expect(result.failingCheckNames).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to check CI'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ETIMEDOUT'));
  });

  it('should log non-404 error from listForRef but continue with status check', async () => {
    mockOctokitInstance = {
      repos: { getCombinedStatusForRef: vi.fn().mockResolvedValue(emptyCombinedStatus) },
      checks: { listForRef: vi.fn().mockRejectedValue(httpError('Server Error', 500)) },
    };

    const result = await callGetCIStatus();

    expect(result).toBeDefined();
    expect(result.status).not.toBe('failing');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Non-404 error fetching check runs'));
  });

  it('should silently handle 404 from listForRef without logging', async () => {
    mockOctokitInstance = {
      repos: { getCombinedStatusForRef: vi.fn().mockResolvedValue(emptyCombinedStatus) },
      checks: { listForRef: vi.fn().mockRejectedValue(httpError('Not Found', 404)) },
    };

    const result = await callGetCIStatus();

    expect(result).toBeDefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('should return unknown with empty sha', async () => {
    mockOctokitInstance = {
      repos: { getCombinedStatusForRef: vi.fn() },
      checks: { listForRef: vi.fn() },
    };

    const result = await callGetCIStatus('');

    expect(result.status).toBe('unknown');
    expect(result.failingCheckNames).toEqual([]);
    expect(mockOctokitInstance.repos.getCombinedStatusForRef).not.toHaveBeenCalled();
    expect(mockOctokitInstance.checks.listForRef).not.toHaveBeenCalled();
  });
});

describe('Maintainer self-reply detection (#199)', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should skip COMMENTED review when all inline comments are self-replies', () => {
    // Scenario from issue #199: MikeMcQuaid submits review, contributor pushes commit,
    // MikeMcQuaid self-replies to own inline comment
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-22T10:00:00Z' }],
      [
        // Original review with inline comments
        { user: { login: 'MikeMcQuaid' }, body: '', submitted_at: '2026-02-22T12:00:00Z', state: 'COMMENTED', id: 100 },
        // Self-reply review after contributor's commit
        { user: { login: 'MikeMcQuaid' }, body: '', submitted_at: '2026-02-24T08:29:00Z', state: 'COMMENTED', id: 200 },
      ],
      [
        // Original inline comment from the first review
        {
          id: 1000,
          user: { login: 'MikeMcQuaid' },
          body: 'Can you see if T.untyped can use T.anything?',
          created_at: '2026-02-22T12:00:00Z',
          pull_request_review_id: 100,
        },
        // Self-reply to own comment in the second review
        {
          id: 1001,
          user: { login: 'MikeMcQuaid' },
          body: "Unfortunately seems like they can't all be changed",
          created_at: '2026-02-24T08:29:00Z',
          in_reply_to_id: 1000,
          pull_request_review_id: 200,
        },
      ],
      'testuser',
    );

    // The self-reply review (id=200) should be skipped, but the original review (id=100)
    // which has a new comment thread (no in_reply_to_id) should still trigger needs_response
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('MikeMcQuaid');
    // The original review's inline text should be used
    expect(result.lastMaintainerComment?.body).toContain('T.untyped');
  });

  it('should not flag needs_response when only self-reply exists after user comment', () => {
    const result = checkUnrespondedComments(
      [
        { user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-22T10:00:00Z' },
        // User comments again after original review
        { user: { login: 'testuser' }, body: 'Addressed the review', created_at: '2026-02-24T00:37:00Z' },
      ],
      [
        // Original review
        { user: { login: 'maintainer' }, body: '', submitted_at: '2026-02-22T12:00:00Z', state: 'COMMENTED', id: 100 },
        // Self-reply after user's response
        { user: { login: 'maintainer' }, body: '', submitted_at: '2026-02-24T08:29:00Z', state: 'COMMENTED', id: 200 },
      ],
      [
        // Original inline comment
        {
          id: 1000,
          user: { login: 'maintainer' },
          body: 'Please fix this',
          created_at: '2026-02-22T12:00:00Z',
          pull_request_review_id: 100,
        },
        // Self-reply
        {
          id: 1001,
          user: { login: 'maintainer' },
          body: 'Never mind, looks like this is fine',
          created_at: '2026-02-24T08:29:00Z',
          in_reply_to_id: 1000,
          pull_request_review_id: 200,
        },
      ],
      'testuser',
    );

    // Self-reply after user's comment should NOT trigger needs_response
    expect(result.hasUnrespondedComment).toBe(false);
  });

  it('should still flag when maintainer replies to DIFFERENT author comment', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-22T10:00:00Z' }],
      [
        // Review from reviewer-A
        { user: { login: 'reviewer-A' }, body: '', submitted_at: '2026-02-22T12:00:00Z', state: 'COMMENTED', id: 100 },
        // Review from reviewer-B replying to reviewer-A (NOT a self-reply)
        { user: { login: 'reviewer-B' }, body: '', submitted_at: '2026-02-24T08:00:00Z', state: 'COMMENTED', id: 200 },
      ],
      [
        // reviewer-A's original comment
        {
          id: 1000,
          user: { login: 'reviewer-A' },
          body: 'Looks good to me',
          created_at: '2026-02-22T12:00:00Z',
          pull_request_review_id: 100,
        },
        // reviewer-B replies to reviewer-A's comment (different author = NOT self-reply)
        {
          id: 1001,
          user: { login: 'reviewer-B' },
          body: 'Actually I disagree, needs changes',
          created_at: '2026-02-24T08:00:00Z',
          in_reply_to_id: 1000,
          pull_request_review_id: 200,
        },
      ],
      'testuser',
    );

    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('reviewer-B');
  });

  it('should still flag when review has mix of self-reply and new thread', () => {
    const result = checkUnrespondedComments(
      [{ user: { login: 'testuser' }, body: 'My PR', created_at: '2026-02-22T10:00:00Z' }],
      [
        // Original review
        { user: { login: 'maintainer' }, body: '', submitted_at: '2026-02-22T12:00:00Z', state: 'COMMENTED', id: 100 },
        // Second review with mixed content
        { user: { login: 'maintainer' }, body: '', submitted_at: '2026-02-24T08:00:00Z', state: 'COMMENTED', id: 200 },
      ],
      [
        // Original inline comment
        {
          id: 1000,
          user: { login: 'maintainer' },
          body: 'Fix this',
          created_at: '2026-02-22T12:00:00Z',
          pull_request_review_id: 100,
        },
        // Self-reply in review 200
        {
          id: 1001,
          user: { login: 'maintainer' },
          body: 'Update on this',
          created_at: '2026-02-24T08:00:00Z',
          in_reply_to_id: 1000,
          pull_request_review_id: 200,
        },
        // NEW comment thread in same review 200 (no in_reply_to_id)
        {
          id: 1002,
          user: { login: 'maintainer' },
          body: 'Also found another issue here',
          created_at: '2026-02-24T08:01:00Z',
          pull_request_review_id: 200,
        },
      ],
      'testuser',
    );

    // Mixed review (self-reply + new thread) should still flag
    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.author).toBe('maintainer');
  });

  it('should use actual inline text instead of synthetic placeholder', () => {
    const result = checkUnrespondedComments(
      [],
      [
        // COMMENTED review with no body and no review.id → falls back to synthetic
        { user: { login: 'reviewer' }, body: '', submitted_at: '2026-02-07T12:00:00Z', state: 'COMMENTED' },
      ],
      [],
      'testuser',
    );

    // Without review.id, can't look up inline comments — falls back to synthetic
    expect(result.lastMaintainerComment?.body).toBe('(posted inline review comments)');
  });

  it('should use actual inline comment text when review has id and reviewComments exist', () => {
    const result = checkUnrespondedComments(
      [],
      [{ user: { login: 'reviewer' }, body: '', submitted_at: '2026-02-07T12:00:00Z', state: 'COMMENTED', id: 100 }],
      [
        {
          id: 1000,
          user: { login: 'reviewer' },
          body: 'Please add error handling here',
          created_at: '2026-02-07T12:00:00Z',
          pull_request_review_id: 100,
        },
      ],
      'testuser',
    );

    expect(result.hasUnrespondedComment).toBe(true);
    expect(result.lastMaintainerComment?.body).toBe('Please add error handling here');
  });

  it('should return false from isAllSelfReplies when review has no inline comments', () => {
    const result = isAllSelfReplies(999, []);
    expect(result).toBe(false);
  });

  it('should return false from isAllSelfReplies when comment starts a new thread', () => {
    const result = isAllSelfReplies(100, [
      // New thread (no in_reply_to_id)
      {
        id: 1000,
        user: { login: 'maintainer' },
        body: 'New issue found',
        created_at: '2026-02-07T10:00:00Z',
        pull_request_review_id: 100,
      },
    ]);
    expect(result).toBe(false);
  });

  it('should return true from isAllSelfReplies when all comments reply to same author', () => {
    const result = isAllSelfReplies(200, [
      // Parent comment from review 100
      {
        id: 1000,
        user: { login: 'maintainer' },
        body: 'Original comment',
        created_at: '2026-02-07T10:00:00Z',
        pull_request_review_id: 100,
      },
      // Self-reply in review 200
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

  it('should be case-insensitive when checking self-reply authors', () => {
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

describe('fetchUserMergedPRCounts — historical stats filtering', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function makeMergedPRItem(owner: string, repo: string, mergedAt: string) {
    return {
      html_url: `https://github.com/${owner}/${repo}/pull/1`,
      pull_request: { merged_at: mergedAt },
      closed_at: mergedAt,
      created_at: mergedAt,
    };
  }

  it('should count merged PRs from excluded repos', async () => {
    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: ['someorg/excluded-repo'],
          excludeOrgs: [],
        },
      }),
    } as any);

    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 2,
            items: [
              makeMergedPRItem('someorg', 'excluded-repo', '2025-06-01T00:00:00Z'),
              makeMergedPRItem('otherorg', 'normal-repo', '2025-07-01T00:00:00Z'),
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchUserMergedPRCounts();

    // Both PRs should be counted — excludeRepos should NOT filter historical stats
    expect(result.repos.size).toBe(2);
    expect(result.repos.get('someorg/excluded-repo')).toEqual({ count: 1, lastMergedAt: '2025-06-01T00:00:00Z' });
    expect(result.repos.get('otherorg/normal-repo')).toEqual({ count: 1, lastMergedAt: '2025-07-01T00:00:00Z' });
  });

  it('should count merged PRs from excluded orgs', async () => {
    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: [],
          excludeOrgs: ['excludedorg'],
        },
      }),
    } as any);

    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 2,
            items: [
              makeMergedPRItem('excludedorg', 'their-repo', '2025-06-01T00:00:00Z'),
              makeMergedPRItem('otherorg', 'normal-repo', '2025-07-01T00:00:00Z'),
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchUserMergedPRCounts();

    // Both PRs should be counted — excludeOrgs should NOT filter historical stats
    expect(result.repos.size).toBe(2);
    expect(result.repos.get('excludedorg/their-repo')).toEqual({ count: 1, lastMergedAt: '2025-06-01T00:00:00Z' });
    expect(result.repos.get('otherorg/normal-repo')).toEqual({ count: 1, lastMergedAt: '2025-07-01T00:00:00Z' });
  });

  it('should still filter out self-repo PRs', async () => {
    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: [],
          excludeOrgs: [],
        },
      }),
    } as any);

    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 2,
            items: [
              makeMergedPRItem('testuser', 'my-own-repo', '2025-06-01T00:00:00Z'),
              makeMergedPRItem('otherorg', 'their-repo', '2025-07-01T00:00:00Z'),
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchUserMergedPRCounts();

    // Self-repo PR should be filtered out, only the other one counted
    expect(result.repos.size).toBe(1);
    expect(result.repos.has('testuser/my-own-repo')).toBe(false);
    expect(result.repos.get('otherorg/their-repo')).toEqual({ count: 1, lastMergedAt: '2025-07-01T00:00:00Z' });
  });
});

describe('fetchUserClosedPRCounts — historical stats filtering', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function makeClosedPRItem(owner: string, repo: string, closedAt: string) {
    return {
      html_url: `https://github.com/${owner}/${repo}/pull/1`,
      closed_at: closedAt,
      created_at: closedAt,
    };
  }

  it('should count closed PRs from excluded repos', async () => {
    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: ['someorg/excluded-repo'],
          excludeOrgs: [],
        },
      }),
    } as any);

    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 2,
            items: [
              makeClosedPRItem('someorg', 'excluded-repo', '2025-06-01T00:00:00Z'),
              makeClosedPRItem('otherorg', 'normal-repo', '2025-07-01T00:00:00Z'),
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchUserClosedPRCounts();

    // Both PRs should be counted — excludeRepos should NOT filter historical stats
    expect(result.repos.size).toBe(2);
    expect(result.repos.get('someorg/excluded-repo')).toBe(1);
    expect(result.repos.get('otherorg/normal-repo')).toBe(1);
  });

  it('should count closed PRs from excluded orgs', async () => {
    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: [],
          excludeOrgs: ['excludedorg'],
        },
      }),
    } as any);

    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 2,
            items: [
              makeClosedPRItem('excludedorg', 'their-repo', '2025-06-01T00:00:00Z'),
              makeClosedPRItem('otherorg', 'normal-repo', '2025-07-01T00:00:00Z'),
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchUserClosedPRCounts();

    // Both PRs should be counted — excludeOrgs should NOT filter historical stats
    expect(result.repos.size).toBe(2);
    expect(result.repos.get('excludedorg/their-repo')).toBe(1);
    expect(result.repos.get('otherorg/normal-repo')).toBe(1);
  });

  it('should still filter out self-repo PRs', async () => {
    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: [],
          excludeOrgs: [],
        },
      }),
    } as any);

    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 2,
            items: [
              makeClosedPRItem('testuser', 'my-own-repo', '2025-06-01T00:00:00Z'),
              makeClosedPRItem('otherorg', 'their-repo', '2025-07-01T00:00:00Z'),
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchUserClosedPRCounts();

    // Self-repo PR should be filtered out, only the other one counted
    expect(result.repos.size).toBe(1);
    expect(result.repos.has('testuser/my-own-repo')).toBe(false);
    expect(result.repos.get('otherorg/their-repo')).toBe(1);
  });
});

// ── fetchRepoStarCounts (#216) ──────────────────────────────────────────────

describe('fetchRepoStarCounts (#216)', () => {
  it('should fetch star counts for repos', async () => {
    mockOctokitInstance = {
      repos: {
        get: vi
          .fn()
          .mockResolvedValueOnce({ data: { stargazers_count: 5000 } })
          .mockResolvedValueOnce({ data: { stargazers_count: 200 } }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchRepoStarCounts(['org/big-repo', 'org/small-repo']);

    expect(result.size).toBe(2);
    expect(result.get('org/big-repo')).toBe(5000);
    expect(result.get('org/small-repo')).toBe(200);
  });

  it('should return empty map for empty repo list', async () => {
    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchRepoStarCounts([]);
    expect(result.size).toBe(0);
  });

  it('should skip repos that fail to fetch (deleted/private)', async () => {
    mockOctokitInstance = {
      repos: {
        get: vi
          .fn()
          .mockResolvedValueOnce({ data: { stargazers_count: 1000 } })
          .mockRejectedValueOnce(new Error('Not Found')),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await monitor.fetchRepoStarCounts(['org/exists', 'org/deleted']);

    expect(result.size).toBe(1);
    expect(result.get('org/exists')).toBe(1000);
    expect(result.has('org/deleted')).toBe(false);
  });
});

describe('review comment fetch error handling (#229)', () => {
  const prUrl = 'https://github.com/owner/repo/pull/1';

  const makeSearchItem = (url: string) => ({
    html_url: url,
    title: 'Test PR',
    pull_request: { html_url: url },
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-07T00:00:00Z',
  });

  const makeMocksWithReviewCommentError = (error: { status?: number; message?: string }) => {
    const err = Object.assign(new Error(error.message ?? 'Request failed'), { status: error.status });
    return {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: { total_count: 1, items: [makeSearchItem(prUrl)] },
        }),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            id: 1,
            title: 'Test PR',
            created_at: '2026-02-01T00:00:00Z',
            updated_at: '2026-02-07T00:00:00Z',
            head: { sha: 'abc123' },
            mergeable: true,
            mergeable_state: 'clean',
            body: '',
            draft: false,
            review_comments: 0,
            commits: 1,
          },
        }),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
        listReviewComments: vi.fn().mockRejectedValue(err),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [] }),
      },
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: { state: 'success', statuses: [] },
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
      },
    };
  };

  beforeEach(() => {
    vi.mocked(getStateManager).mockReturnValue({
      getState: () => ({
        config: {
          githubUsername: 'testuser',
          excludeRepos: [],
          excludeOrgs: [],
          shelvedPRUrls: [],
          dormantThresholdDays: 30,
          approachingDormantDays: 25,
        },
      }),
    } as any);
  });

  it('should return empty data on 404 error (expected for some repos)', async () => {
    mockOctokitInstance = makeMocksWithReviewCommentError({ status: 404, message: 'Not Found' });

    const monitor = new PRMonitor('fake-token');
    const { prs } = await monitor.fetchUserOpenPRs();

    // PR should still be returned — 404 is gracefully degraded
    expect(prs).toHaveLength(1);
    expect(prs[0].url).toBe(prUrl);
  });

  it('should re-throw 429 rate limit error (surfaces in failures)', async () => {
    mockOctokitInstance = makeMocksWithReviewCommentError({ status: 429, message: 'rate limit exceeded' });

    const monitor = new PRMonitor('fake-token');
    const { prs, failures } = await monitor.fetchUserOpenPRs();

    // Rate limit error should propagate out of fetchPRDetails and appear in failures
    expect(prs).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toContain('rate limit exceeded');
  });

  it('should re-throw 403 rate limit error (surfaces in failures)', async () => {
    mockOctokitInstance = makeMocksWithReviewCommentError({ status: 403, message: 'API rate limit exceeded' });

    const monitor = new PRMonitor('fake-token');
    const { prs, failures } = await monitor.fetchUserOpenPRs();

    // Rate limit error should propagate out of fetchPRDetails and appear in failures
    expect(prs).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toContain('API rate limit exceeded');
  });

  it('should degrade gracefully on non-rate-limit 403 (e.g. private repo)', async () => {
    mockOctokitInstance = makeMocksWithReviewCommentError({
      status: 403,
      message: 'Resource not accessible by integration',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const monitor = new PRMonitor('fake-token');
    const { prs } = await monitor.fetchUserOpenPRs();

    // Non-rate-limit 403 should NOT re-throw — PR still returned
    expect(prs).toHaveLength(1);
    expect(prs[0].url).toBe(prUrl);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('403 fetching review comments'));

    errorSpy.mockRestore();
  });

  it('should return empty data on 500 server error with warning', async () => {
    mockOctokitInstance = makeMocksWithReviewCommentError({ status: 500, message: 'Internal Server Error' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const monitor = new PRMonitor('fake-token');
    const { prs } = await monitor.fetchUserOpenPRs();

    // PR should still be returned — 500 is gracefully degraded
    expect(prs).toHaveLength(1);
    expect(prs[0].url).toBe(prUrl);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch review comments'));

    errorSpy.mockRestore();
  });
});
