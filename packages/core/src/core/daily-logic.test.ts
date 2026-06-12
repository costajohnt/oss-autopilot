/**
 * Tests for domain functions extracted to src/core/daily-logic.ts
 *
 * These tests verify the pure/near-pure domain functions directly from the core
 * module, complementing the existing tests in src/commands/daily.test.ts (which
 * import via the re-exports in daily.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assessCapacity,
  collectActionableIssues,
  formatActionHint,
  formatBriefSummary,
  formatSummary,
  toShelvedPRRef,
  computeRepoSignals,
  groupPRsByRepo,
  computeActionMenu,
  applyStatusOverrides,
  CRITICAL_STATUSES,
  STALE_STATUSES,
} from './daily-logic.js';
import { summarizeAttentionBuckets } from './pr-attention.js';
import type { FetchedPR, MaintainerActionHint, AgentState } from './types.js';
import {
  makeFetchedPR,
  makeDailyDigest,
  makeCapacityAssessment as makeCapacity,
  makeAgentState,
} from './test-utils.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePR(overrides: Partial<FetchedPR> & { repo: string }): FetchedPR {
  return makeFetchedPR({ daysSinceActivity: 5, ...overrides });
}

function makeDigest(overrides: Parameters<typeof makeDailyDigest>[0] = {}) {
  return makeDailyDigest({
    summary: { totalActivePRs: 3, totalNeedingAttention: 1, totalMergedAllTime: 10, mergeRate: 80 },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('CRITICAL_STATUSES', () => {
  it('should contain exactly the one critical status', () => {
    expect(CRITICAL_STATUSES.has('needs_addressing')).toBe(true);
    expect(CRITICAL_STATUSES.size).toBe(1);
  });

  it('should not contain non-critical statuses', () => {
    expect(CRITICAL_STATUSES.has('waiting_on_maintainer')).toBe(false);
  });
});

describe('STALE_STATUSES', () => {
  it('should contain dormant and approaching_dormant', () => {
    expect(STALE_STATUSES.has('dormant')).toBe(true);
    expect(STALE_STATUSES.has('approaching_dormant')).toBe(true);
    expect(STALE_STATUSES.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// assessCapacity
// ---------------------------------------------------------------------------

describe('assessCapacity', () => {
  it('should report capacity when under limit with no critical issues', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'waiting_on_maintainer' })];
    const result = assessCapacity(prs, 10, 0);

    expect(result.hasCapacity).toBe(true);
    expect(result.activePRCount).toBe(1);
    expect(result.maxActivePRs).toBe(10);
    expect(result.criticalIssueCount).toBe(0);
    expect(result.reason).toContain('You have capacity');
  });

  it('should report no capacity when at PR limit', () => {
    const prs = Array.from({ length: 5 }, (_, i) =>
      makePR({ repo: 'owner/repo', number: i + 1, status: 'waiting_on_maintainer' }),
    );
    const result = assessCapacity(prs, 5, 0);

    expect(result.hasCapacity).toBe(false);
    expect(result.reason).toContain('at PR limit');
  });

  it('should report no capacity when critical issues exist', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'needs_addressing', actionReason: 'needs_response' })];
    const result = assessCapacity(prs, 10, 0);

    expect(result.hasCapacity).toBe(false);
    expect(result.criticalIssueCount).toBe(1);
    expect(result.reason).toContain('critical issue');
  });

  it('should report no capacity when both at limit and critical issues exist', () => {
    const prs = Array.from({ length: 5 }, (_, i) =>
      makePR({
        repo: 'owner/repo',
        number: i + 1,
        ...(i === 0
          ? { status: 'needs_addressing' as const, actionReason: 'needs_response' as const }
          : { status: 'waiting_on_maintainer' as const }),
      }),
    );
    const result = assessCapacity(prs, 5, 0);

    expect(result.hasCapacity).toBe(false);
    expect(result.reason).toContain('at PR limit');
    expect(result.reason).toContain('critical issue');
  });

  it('should count needs_addressing as the critical status', () => {
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'needs_addressing', actionReason: 'needs_response' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'needs_addressing', actionReason: 'needs_changes' }),
      makePR({ repo: 'owner/repo', number: 3, status: 'needs_addressing', actionReason: 'failing_ci' }),
      makePR({ repo: 'owner/repo', number: 4, status: 'needs_addressing', actionReason: 'merge_conflict' }),
    ];
    const result = assessCapacity(prs, 10, 0);

    expect(result.criticalIssueCount).toBe(4);
  });

  it('should include shelved PR count in reason when present', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'waiting_on_maintainer' })];
    const result = assessCapacity(prs, 10, 3);

    expect(result.shelvedPRCount).toBe(3);
    expect(result.reason).toContain('3 shelved');
  });

  it('should not mention shelved when count is zero', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'waiting_on_maintainer' })];
    const result = assessCapacity(prs, 10, 0);

    expect(result.reason).not.toContain('shelved');
  });

  it('should handle empty PR list', () => {
    const result = assessCapacity([], 10, 0);

    expect(result.hasCapacity).toBe(true);
    expect(result.activePRCount).toBe(0);
    expect(result.criticalIssueCount).toBe(0);
  });

  it('should use singular "issue" for exactly 1 critical issue', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'needs_addressing', actionReason: 'failing_ci' })];
    const result = assessCapacity(prs, 10, 0);

    expect(result.reason).toContain('1 critical issue need');
    expect(result.reason).not.toContain('1 critical issues');
  });

  it('should use plural "issues" for multiple critical issues', () => {
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'needs_addressing', actionReason: 'failing_ci' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'needs_addressing', actionReason: 'needs_response' }),
    ];
    const result = assessCapacity(prs, 10, 0);

    expect(result.reason).toContain('2 critical issues need');
  });
});

// ---------------------------------------------------------------------------
// collectActionableIssues
// ---------------------------------------------------------------------------

describe('collectActionableIssues', () => {
  it('covers every needs_addressing PR — count matches the needs_attention bucket by construction (#1352)', () => {
    const prs = [
      makePR({ repo: 'o/r', number: 1, status: 'needs_addressing', actionReason: 'needs_changes' }),
      // Unmapped reason (not in reasonOrder) must still produce an entry, sorted last.
      makePR({ repo: 'o/r', number: 2, status: 'needs_addressing', actionReason: 'needs_rebase' }),
      // Missing actionReason (e.g. a hand-rolled override payload) falls back to needs_response.
      makePR({ repo: 'o/r', number: 3, status: 'needs_addressing', actionReason: undefined }),
      makePR({ repo: 'o/r', number: 4, status: 'waiting_on_maintainer' }),
    ];

    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(3);
    // Known reasons sort by priority; unmapped/missing reasons sort last in stable order.
    expect(result.map((i) => i.pr.number)).toEqual([1, 2, 3]);
    expect(result[1].label).toBe('[needs_rebase]');
    expect(result[2].label).toBe('[Needs Response]'); // missing reason falls back
    expect(result).toHaveLength(summarizeAttentionBuckets(prs).needsAttention);
  });

  it('should return empty array for empty PR list', () => {
    const result = collectActionableIssues([]);
    expect(result).toEqual([]);
  });

  it('should return empty array when no PRs need addressing', () => {
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'waiting_on_maintainer' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'waiting_on_maintainer' }),
    ];
    const result = collectActionableIssues(prs);
    expect(result).toHaveLength(0);
  });

  it('should collect needs_response issues', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'needs_addressing', actionReason: 'needs_response' })];
    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('needs_response');
    expect(result[0].label).toBe('[Needs Response]');
  });

  it('should collect needs_changes issues', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'needs_addressing', actionReason: 'needs_changes' })];
    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('needs_changes');
  });

  it('should collect ci_failing issues', () => {
    const prs = [
      makePR({
        repo: 'owner/repo',
        status: 'needs_addressing',
        actionReason: 'failing_ci',
        failingCheckNames: ['lint', 'build'],
      }),
    ];
    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('ci_failing');
    expect(result[0].label).toContain('lint');
    expect(result[0].label).toContain('build');
  });

  it('should collect merge_conflict issues', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'needs_addressing', actionReason: 'merge_conflict' })];
    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('merge_conflict');
  });

  it('should collect incomplete_checklist issues with stats', () => {
    const prs = [
      makePR({
        repo: 'owner/repo',
        status: 'needs_addressing',
        actionReason: 'incomplete_checklist',
        checklistStats: { checked: 2, total: 5 },
      }),
    ];
    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('incomplete_checklist');
    expect(result[0].label).toContain('2/5');
  });

  it('should order issues by priority: response > changes > ci > conflict > checklist', () => {
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'needs_addressing', actionReason: 'incomplete_checklist' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'needs_addressing', actionReason: 'needs_response' }),
      makePR({ repo: 'owner/repo', number: 3, status: 'needs_addressing', actionReason: 'merge_conflict' }),
      makePR({ repo: 'owner/repo', number: 4, status: 'needs_addressing', actionReason: 'failing_ci' }),
      makePR({ repo: 'owner/repo', number: 5, status: 'needs_addressing', actionReason: 'needs_changes' }),
    ];
    const result = collectActionableIssues(prs);

    expect(result.map((i) => i.type)).toEqual([
      'needs_response',
      'needs_changes',
      'ci_failing',
      'merge_conflict',
      'incomplete_checklist',
    ]);
  });

  it('should mark PR as new contribution when created after last digest', () => {
    const prs = [
      makePR({
        repo: 'owner/repo',
        status: 'needs_addressing',
        actionReason: 'needs_response',
        createdAt: '2026-03-05T00:00:00Z',
      }),
    ];
    const result = collectActionableIssues(prs, '2026-03-01T00:00:00Z');

    expect(result[0].isNewContribution).toBe(true);
  });

  it('should not mark PR as new contribution when created before last digest', () => {
    const prs = [
      makePR({
        repo: 'owner/repo',
        status: 'needs_addressing',
        actionReason: 'needs_response',
        createdAt: '2026-02-15T00:00:00Z',
      }),
    ];
    const result = collectActionableIssues(prs, '2026-03-01T00:00:00Z');

    expect(result[0].isNewContribution).toBe(false);
  });

  it('should not mark PR as new when created at exactly last digest time', () => {
    const prs = [
      makePR({
        repo: 'owner/repo',
        status: 'needs_addressing',
        actionReason: 'needs_response',
        createdAt: '2026-03-01T00:00:00Z',
      }),
    ];
    const result = collectActionableIssues(prs, '2026-03-01T00:00:00Z');

    expect(result[0].isNewContribution).toBe(false);
  });

  it('should mark all PRs as new contribution on first run (no last digest)', () => {
    const prs = [
      makePR({
        repo: 'owner/repo',
        status: 'needs_addressing',
        actionReason: 'needs_response',
        createdAt: '2026-02-15T00:00:00Z',
      }),
    ];
    const result = collectActionableIssues(prs, undefined);

    expect(result[0].isNewContribution).toBe(true);
  });

  it('should assume new contribution when createdAt is invalid', () => {
    const prs = [
      makePR({
        repo: 'owner/repo',
        status: 'needs_addressing',
        actionReason: 'needs_response',
        createdAt: 'invalid-date',
      }),
    ];
    const result = collectActionableIssues(prs, '2026-03-01T00:00:00Z');

    expect(result[0].isNewContribution).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatActionHint
// ---------------------------------------------------------------------------

describe('formatActionHint', () => {
  const cases: [MaintainerActionHint, string][] = [
    ['demo_requested', 'demo/screenshot requested'],
    ['tests_requested', 'tests requested'],
    ['changes_requested', 'code changes requested'],
    ['docs_requested', 'documentation requested'],
    ['rebase_requested', 'rebase requested'],
  ];

  for (const [hint, expected] of cases) {
    it(`should format "${hint}" as "${expected}"`, () => {
      expect(formatActionHint(hint)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// formatBriefSummary
// ---------------------------------------------------------------------------

describe('formatBriefSummary', () => {
  it('should include active PR count', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 5, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
    });
    const result = formatBriefSummary(digest, 0);
    expect(result).toContain('5 Active PRs');
  });

  it('should say "all on track" when no issues', () => {
    const digest = makeDigest();
    const result = formatBriefSummary(digest, 0);
    expect(result).toContain('all on track');
  });

  it('should show issue count with singular "needs"', () => {
    const digest = makeDigest();
    const result = formatBriefSummary(digest, 1);
    expect(result).toContain('1 needs attention');
  });

  it('should show issue count with plural "need"', () => {
    const digest = makeDigest();
    const result = formatBriefSummary(digest, 3);
    expect(result).toContain('3 need attention');
  });

  it('should include issue reply count when present', () => {
    const digest = makeDigest();
    const result = formatBriefSummary(digest, 0, 2);
    expect(result).toContain('2 issue replies');
  });

  it('should use singular reply for count of 1', () => {
    const digest = makeDigest();
    const result = formatBriefSummary(digest, 0, 1);
    expect(result).toContain('1 issue reply');
  });

  it('appends stuck CI and dormant follow-up counts when non-zero (#1352)', () => {
    const digest = makeDigest();
    const result = formatBriefSummary(digest, 2, 0, { stuckCI: 1, dormantFollowup: 2 });
    expect(result).toContain('2 need attention');
    expect(result).toContain('1 stuck CI');
    expect(result).toContain('2 dormant follow-ups');
  });

  it('uses singular dormant follow-up for count of 1 and omits zero buckets', () => {
    const digest = makeDigest();
    const result = formatBriefSummary(digest, 0, 0, { stuckCI: 0, dormantFollowup: 1 });
    expect(result).not.toContain('stuck CI');
    expect(result).toContain('1 dormant follow-up');
    expect(result).toContain('all on track');
  });

  it('should omit issue reply text when count is 0', () => {
    const digest = makeDigest();
    const result = formatBriefSummary(digest, 0, 0);
    expect(result).not.toContain('issue repl');
  });
});

// ---------------------------------------------------------------------------
// formatSummary
// ---------------------------------------------------------------------------

describe('formatSummary', () => {
  it('should include OSS Dashboard header', () => {
    const digest = makeDigest();
    const capacity = makeCapacity();
    const result = formatSummary(digest, capacity);
    expect(result).toContain('## OSS Dashboard');
  });

  it('should include active PR count, merged count, and merge rate', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 5, totalNeedingAttention: 1, totalMergedAllTime: 20, mergeRate: 90 },
    });
    const capacity = makeCapacity();
    const result = formatSummary(digest, capacity);
    expect(result).toContain('5 Active PRs');
    expect(result).toContain('20 Merged');
    expect(result).toContain('90% Merge Rate');
  });

  it('should include Needs Addressing section when present', () => {
    const pr = makePR({
      repo: 'owner/repo',
      status: 'needs_addressing',
      actionReason: 'failing_ci',
      failingCheckNames: ['test'],
    });
    const digest = makeDigest({ needsAddressingPRs: [pr] });
    const result = formatSummary(digest, makeCapacity());
    expect(result).toContain('Needs Addressing');
  });

  it('should include capacity status', () => {
    const result = formatSummary(makeDigest(), makeCapacity({ hasCapacity: true, activePRCount: 3, maxActivePRs: 10 }));
    expect(result).toContain('Ready for new work');
    expect(result).toContain('3/10 PRs');
  });

  it('should show focus on existing PRs when no capacity', () => {
    const result = formatSummary(makeDigest(), makeCapacity({ hasCapacity: false }));
    expect(result).toContain('Focus on existing PRs');
  });

  it('should include shelved PR count in capacity when present', () => {
    const result = formatSummary(makeDigest(), makeCapacity({ shelvedPRCount: 2 }));
    expect(result).toContain('2 shelved');
  });
});

// ---------------------------------------------------------------------------
// toShelvedPRRef (core module direct import)
// ---------------------------------------------------------------------------

describe('toShelvedPRRef (core)', () => {
  it('should project only display fields', () => {
    const pr = makePR({
      repo: 'owner/repo',
      number: 42,
      title: 'Fix bug',
      daysSinceActivity: 14,
      status: 'waiting_on_maintainer',
      stalenessTier: 'dormant',
    });
    const ref = toShelvedPRRef(pr);

    expect(ref).toEqual({
      number: 42,
      url: 'https://github.com/owner/repo/pull/42',
      title: 'Fix bug',
      repo: 'owner/repo',
      daysSinceActivity: 14,
      status: 'waiting_on_maintainer',
    });
  });

  it('should not include FetchedPR-specific fields', () => {
    const pr = makePR({ repo: 'owner/repo' });
    const ref = toShelvedPRRef(pr) as unknown as Record<string, unknown>;

    expect(ref).not.toHaveProperty('ciStatus');
    expect(ref).not.toHaveProperty('reviewDecision');
    expect(ref).not.toHaveProperty('classifiedChecks');
  });
});

// ---------------------------------------------------------------------------
// computeRepoSignals (core module direct import)
// ---------------------------------------------------------------------------

describe('computeRepoSignals (core)', () => {
  it('should return empty map for empty list', () => {
    expect(computeRepoSignals([]).size).toBe(0);
  });

  it('should mark responsive when maintainer commented on non-stale PR', () => {
    const prs = [
      makePR({
        repo: 'owner/repo',
        status: 'waiting_on_maintainer',
        lastMaintainerComment: { author: 'maint', body: 'LGTM', createdAt: '2026-01-15T00:00:00Z' },
      }),
    ];
    const result = computeRepoSignals(prs);
    expect(result.get('owner/repo')!.isResponsive).toBe(true);
  });

  it('should not mark responsive when PR is dormant', () => {
    const prs = [
      makePR({
        repo: 'owner/repo',
        status: 'waiting_on_maintainer',
        stalenessTier: 'dormant',
        lastMaintainerComment: { author: 'maint', body: 'old', createdAt: '2025-06-01T00:00:00Z' },
      }),
    ];
    const result = computeRepoSignals(prs);
    expect(result.get('owner/repo')!.isResponsive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groupPRsByRepo (core module direct import)
// ---------------------------------------------------------------------------

describe('groupPRsByRepo (core)', () => {
  it('should return empty array for no PRs', () => {
    expect(groupPRsByRepo([])).toEqual([]);
  });

  it('should group PRs from the same repo', () => {
    const prs = [makePR({ repo: 'owner/repo', number: 1 }), makePR({ repo: 'owner/repo', number: 2 })];
    const groups = groupPRsByRepo(prs);
    expect(groups).toHaveLength(1);
    expect(groups[0].prs).toHaveLength(2);
  });

  it('should separate PRs from different repos', () => {
    const prs = [makePR({ repo: 'owner/repo-a', number: 1 }), makePR({ repo: 'owner/repo-b', number: 2 })];
    const groups = groupPRsByRepo(prs);
    expect(groups).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// computeActionMenu (core module direct import)
// ---------------------------------------------------------------------------

describe('computeActionMenu (core)', () => {
  it('should use plural phrasing for multiple actionable issues', () => {
    const issues = [
      {
        type: 'ci_failing' as const,
        pr: makePR({ repo: 'owner/repo' }),
        label: '[CI Failing]',
        isNewContribution: false,
      },
      {
        type: 'needs_changes' as const,
        pr: makePR({ repo: 'owner/repo-b' }),
        label: '[Changes Requested]',
        isNewContribution: false,
      },
    ];
    const menu = computeActionMenu(issues, makeCapacity());
    expect(menu.items[0].key).toBe('address_all');
    expect(menu.items[0].label).toBe('Work through all 2 issues (Recommended)');
    expect(menu.items[0].description).toBe('Run maintenance in parallel, then address code changes one at a time');
  });

  it('should use singular phrasing for a single actionable issue', () => {
    const issues = [
      {
        type: 'ci_failing' as const,
        pr: makePR({ repo: 'owner/repo' }),
        label: '[CI Failing]',
        isNewContribution: false,
      },
    ];
    const menu = computeActionMenu(issues, makeCapacity());
    expect(menu.items[0].key).toBe('address_all');
    expect(menu.items[0].label).toBe('Address this issue (Recommended)');
    expect(menu.items[0].description).toBe('Fix the issue blocking your PR');
  });

  it('should always end with done', () => {
    const menu = computeActionMenu([], makeCapacity());
    expect(menu.items[menu.items.length - 1].key).toBe('done');
  });

  it('should always include search', () => {
    const menu = computeActionMenu([], makeCapacity());
    expect(menu.items.find((i) => i.key === 'search')).toBeDefined();
  });

  it('should add capacityWarning to search item when capacity.hasCapacity is false', () => {
    const capacity = makeCapacity({ hasCapacity: false, activePRCount: 5, maxActivePRs: 5 });
    const menu = computeActionMenu([], capacity);
    const searchItem = menu.items.find((i) => i.key === 'search');

    expect(searchItem).toBeDefined();
    expect(searchItem!.capacityWarning).toBe("You're at 5/5 active PRs. Claiming a new issue will exceed your limit.");
  });

  it('should not add capacityWarning to search item when capacity.hasCapacity is true', () => {
    const capacity = makeCapacity({ hasCapacity: true, activePRCount: 2, maxActivePRs: 5 });
    const menu = computeActionMenu([], capacity);
    const searchItem = menu.items.find((i) => i.key === 'search');

    expect(searchItem).toBeDefined();
    expect(searchItem!.capacityWarning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyStatusOverrides
// ---------------------------------------------------------------------------

// Mock getStateManager for applyStatusOverrides tests
const mockGetStatusOverride = vi.fn();
const mockSave = vi.fn();
vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getStatusOverride: mockGetStatusOverride,
    save: mockSave,
    batch: (fn: () => void) => fn(),
  })),
}));

describe('applyStatusOverrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStatusOverride.mockReturnValue(undefined);
  });

  function makeState(
    statusOverrides: Record<
      string,
      { status: 'needs_addressing' | 'waiting_on_maintainer'; setAt: string; lastActivityAt: string }
    > = {},
  ): Readonly<AgentState> {
    return makeAgentState({ config: { statusOverrides } });
  }

  it('should return PRs unchanged when no overrides exist', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'needs_addressing' })];
    const state = makeState();
    const result = applyStatusOverrides(prs, state);
    expect(result).toBe(prs); // Same reference — early return
  });

  it('should return PRs unchanged when statusOverrides is empty', () => {
    const prs = [makePR({ repo: 'owner/repo' })];
    const state = makeState({});
    const result = applyStatusOverrides(prs, state);
    expect(result).toBe(prs);
  });

  it('should override needs_addressing → waiting_on_maintainer with correct reason fields', () => {
    const prUrl = 'https://github.com/owner/repo/pull/1';
    const prs = [
      makePR({
        repo: 'owner/repo',
        number: 1,
        status: 'needs_addressing',
        actionReason: 'needs_response',
        waitReason: undefined,
      }),
    ];
    const state = makeState({
      [prUrl]: {
        status: 'waiting_on_maintainer',
        setAt: '2026-01-01T00:00:00Z',
        lastActivityAt: '2025-06-15T00:00:00Z',
      },
    });
    mockGetStatusOverride.mockReturnValue({
      status: 'waiting_on_maintainer',
      setAt: '2026-01-01T00:00:00Z',
      lastActivityAt: '2025-06-15T00:00:00Z',
    });

    const result = applyStatusOverrides(prs, state);

    expect(result[0].status).toBe('waiting_on_maintainer');
    expect(result[0].actionReason).toBeUndefined();
    expect(result[0].waitReason).toBe('pending_review');
  });

  it('should override waiting_on_maintainer → needs_addressing with correct reason fields', () => {
    const prUrl = 'https://github.com/owner/repo/pull/1';
    const prs = [
      makePR({
        repo: 'owner/repo',
        number: 1,
        status: 'waiting_on_maintainer',
        waitReason: 'pending_review',
        actionReason: undefined,
      }),
    ];
    const state = makeState({
      [prUrl]: { status: 'needs_addressing', setAt: '2026-01-01T00:00:00Z', lastActivityAt: '2025-06-15T00:00:00Z' },
    });
    mockGetStatusOverride.mockReturnValue({
      status: 'needs_addressing',
      setAt: '2026-01-01T00:00:00Z',
      lastActivityAt: '2025-06-15T00:00:00Z',
    });

    const result = applyStatusOverrides(prs, state);

    expect(result[0].status).toBe('needs_addressing');
    expect(result[0].waitReason).toBeUndefined();
    expect(result[0].actionReason).toBe('needs_response');
  });

  it('should auto-clear override when PR has new activity and persist', () => {
    const prUrl = 'https://github.com/owner/repo/pull/1';
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'needs_addressing', updatedAt: '2026-02-01T00:00:00Z' }),
    ];
    const state = makeState({
      [prUrl]: {
        status: 'waiting_on_maintainer',
        setAt: '2026-01-01T00:00:00Z',
        lastActivityAt: '2026-01-01T00:00:00Z',
      },
    });
    // getStatusOverride returns undefined when auto-cleared (updatedAt > lastActivityAt)
    mockGetStatusOverride.mockReturnValue(undefined);

    const result = applyStatusOverrides(prs, state);

    // PR should keep its original status since override was auto-cleared
    expect(result[0].status).toBe('needs_addressing');
    // Auto-clear persistence is handled by clearStatusOverride's autoSave()
    // inside the batch — the mock's getStatusOverride doesn't trigger it
  });

  it('should not change PR when override matches current status', () => {
    const prUrl = 'https://github.com/owner/repo/pull/1';
    const prs = [makePR({ repo: 'owner/repo', number: 1, status: 'waiting_on_maintainer' })];
    const state = makeState({
      [prUrl]: {
        status: 'waiting_on_maintainer',
        setAt: '2026-01-01T00:00:00Z',
        lastActivityAt: '2025-06-15T00:00:00Z',
      },
    });
    mockGetStatusOverride.mockReturnValue({
      status: 'waiting_on_maintainer',
      setAt: '2026-01-01T00:00:00Z',
      lastActivityAt: '2025-06-15T00:00:00Z',
    });

    const result = applyStatusOverrides(prs, state);

    expect(result[0].status).toBe('waiting_on_maintainer');
    expect(result[0]).toBe(prs[0]); // Same reference — no mutation
  });

  it('should not save when overrides are applied without auto-clears', () => {
    const prUrl = 'https://github.com/owner/repo/pull/1';
    const prs = [makePR({ repo: 'owner/repo', number: 1, status: 'needs_addressing' })];
    const state = makeState({
      [prUrl]: {
        status: 'waiting_on_maintainer',
        setAt: '2026-01-01T00:00:00Z',
        lastActivityAt: '2025-06-15T00:00:00Z',
      },
    });
    mockGetStatusOverride.mockReturnValue({
      status: 'waiting_on_maintainer',
      setAt: '2026-01-01T00:00:00Z',
      lastActivityAt: '2025-06-15T00:00:00Z',
    });

    const result = applyStatusOverrides(prs, state);

    // Override is applied (status changed)
    expect(result[0].status).toBe('waiting_on_maintainer');
    // No direct save() call — persistence is handled by autoSave() inside mutations
    expect(mockSave).not.toHaveBeenCalled();
  });
});
