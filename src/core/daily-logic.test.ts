/**
 * Tests for domain functions extracted to src/core/daily-logic.ts
 *
 * These tests verify the pure/near-pure domain functions directly from the core
 * module, complementing the existing tests in src/commands/daily.test.ts (which
 * import via the re-exports in daily.ts).
 */

import { describe, it, expect } from 'vitest';
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
  CRITICAL_STATUSES,
  ACTIVE_MAINTAINER_STATUSES,
  STALE_STATUSES,
} from './daily-logic.js';
import type { FetchedPR, DailyDigest, MaintainerActionHint } from './types.js';
import type { CapacityAssessment } from '../formatters/json.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePR(overrides: Partial<FetchedPR> & { repo: string }): FetchedPR {
  return {
    id: 1,
    url: `https://github.com/${overrides.repo}/pull/${overrides.number ?? 1}`,
    number: overrides.number ?? 1,
    title: 'Test PR',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    daysSinceActivity: 5,
    ciStatus: 'passing',
    failingCheckNames: [],
    classifiedChecks: [],
    hasMergeConflict: false,
    reviewDecision: 'approved',
    hasUnrespondedComment: false,
    hasIncompleteChecklist: false,
    maintainerActionHints: [],
    status: 'healthy',
    displayLabel: '[Healthy]',
    displayDescription: 'Everything looks good',
    ...overrides,
  };
}

function makeDigest(overrides: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: '2026-01-25T10:00:00Z',
    openPRs: [],
    prsNeedingResponse: [],
    ciFailingPRs: [],
    ciBlockedPRs: [],
    ciNotRunningPRs: [],
    mergeConflictPRs: [],
    needsRebasePRs: [],
    missingRequiredFilesPRs: [],
    incompleteChecklistPRs: [],
    needsChangesPRs: [],
    changesAddressedPRs: [],
    waitingOnMaintainerPRs: [],
    approachingDormant: [],
    dormantPRs: [],
    healthyPRs: [],
    recentlyClosedPRs: [],
    recentlyMergedPRs: [],
    shelvedPRs: [],
    autoUnshelvedPRs: [],
    summary: {
      totalActivePRs: 3,
      totalNeedingAttention: 1,
      totalMergedAllTime: 10,
      mergeRate: 80,
    },
    ...overrides,
  };
}

function makeCapacity(overrides: Partial<CapacityAssessment> = {}): CapacityAssessment {
  return {
    hasCapacity: true,
    activePRCount: 3,
    maxActivePRs: 10,
    shelvedPRCount: 0,
    criticalIssueCount: 0,
    reason: 'You have capacity',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('CRITICAL_STATUSES', () => {
  it('should contain exactly the four critical statuses', () => {
    expect(CRITICAL_STATUSES.has('needs_response')).toBe(true);
    expect(CRITICAL_STATUSES.has('needs_changes')).toBe(true);
    expect(CRITICAL_STATUSES.has('failing_ci')).toBe(true);
    expect(CRITICAL_STATUSES.has('merge_conflict')).toBe(true);
    expect(CRITICAL_STATUSES.size).toBe(4);
  });

  it('should not contain non-critical statuses', () => {
    expect(CRITICAL_STATUSES.has('healthy')).toBe(false);
    expect(CRITICAL_STATUSES.has('dormant')).toBe(false);
    expect(CRITICAL_STATUSES.has('waiting_on_maintainer')).toBe(false);
  });
});

describe('ACTIVE_MAINTAINER_STATUSES', () => {
  it('should contain expected active maintainer statuses', () => {
    expect(ACTIVE_MAINTAINER_STATUSES.has('healthy')).toBe(true);
    expect(ACTIVE_MAINTAINER_STATUSES.has('waiting_on_maintainer')).toBe(true);
    expect(ACTIVE_MAINTAINER_STATUSES.has('changes_addressed')).toBe(true);
    expect(ACTIVE_MAINTAINER_STATUSES.has('needs_response')).toBe(true);
    expect(ACTIVE_MAINTAINER_STATUSES.has('needs_changes')).toBe(true);
    expect(ACTIVE_MAINTAINER_STATUSES.size).toBe(5);
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
    const prs = [makePR({ repo: 'owner/repo', status: 'healthy' })];
    const result = assessCapacity(prs, 10, 0);

    expect(result.hasCapacity).toBe(true);
    expect(result.activePRCount).toBe(1);
    expect(result.maxActivePRs).toBe(10);
    expect(result.criticalIssueCount).toBe(0);
    expect(result.reason).toContain('You have capacity');
  });

  it('should report no capacity when at PR limit', () => {
    const prs = Array.from({ length: 5 }, (_, i) => makePR({ repo: 'owner/repo', number: i + 1, status: 'healthy' }));
    const result = assessCapacity(prs, 5, 0);

    expect(result.hasCapacity).toBe(false);
    expect(result.reason).toContain('at PR limit');
  });

  it('should report no capacity when critical issues exist', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'needs_response' })];
    const result = assessCapacity(prs, 10, 0);

    expect(result.hasCapacity).toBe(false);
    expect(result.criticalIssueCount).toBe(1);
    expect(result.reason).toContain('critical issue');
  });

  it('should report no capacity when both at limit and critical issues exist', () => {
    const prs = Array.from({ length: 5 }, (_, i) =>
      makePR({ repo: 'owner/repo', number: i + 1, status: i === 0 ? 'needs_response' : 'healthy' }),
    );
    const result = assessCapacity(prs, 5, 0);

    expect(result.hasCapacity).toBe(false);
    expect(result.reason).toContain('at PR limit');
    expect(result.reason).toContain('critical issue');
  });

  it('should count all four critical statuses', () => {
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'needs_response' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'needs_changes' }),
      makePR({ repo: 'owner/repo', number: 3, status: 'failing_ci' }),
      makePR({ repo: 'owner/repo', number: 4, status: 'merge_conflict' }),
    ];
    const result = assessCapacity(prs, 10, 0);

    expect(result.criticalIssueCount).toBe(4);
  });

  it('should include shelved PR count in reason when present', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'healthy' })];
    const result = assessCapacity(prs, 10, 3);

    expect(result.shelvedPRCount).toBe(3);
    expect(result.reason).toContain('3 shelved');
  });

  it('should not mention shelved when count is zero', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'healthy' })];
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
    const prs = [makePR({ repo: 'owner/repo', status: 'failing_ci' })];
    const result = assessCapacity(prs, 10, 0);

    expect(result.reason).toContain('1 critical issue need');
    expect(result.reason).not.toContain('1 critical issues');
  });

  it('should use plural "issues" for multiple critical issues', () => {
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'failing_ci' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'needs_response' }),
    ];
    const result = assessCapacity(prs, 10, 0);

    expect(result.reason).toContain('2 critical issues need');
  });
});

// ---------------------------------------------------------------------------
// collectActionableIssues
// ---------------------------------------------------------------------------

describe('collectActionableIssues', () => {
  it('should return empty array for empty PR list', () => {
    const result = collectActionableIssues([]);
    expect(result).toEqual([]);
  });

  it('should return empty array when all PRs are healthy', () => {
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'healthy' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'waiting_on_maintainer' }),
    ];
    const result = collectActionableIssues(prs);
    expect(result).toHaveLength(0);
  });

  it('should collect needs_response issues', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'needs_response' })];
    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('needs_response');
    expect(result[0].label).toBe('[Needs Response]');
  });

  it('should collect needs_changes issues', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'needs_changes' })];
    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('needs_changes');
  });

  it('should collect ci_failing issues', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'failing_ci', failingCheckNames: ['lint', 'build'] })];
    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('ci_failing');
    expect(result[0].label).toContain('lint');
    expect(result[0].label).toContain('build');
  });

  it('should collect merge_conflict issues', () => {
    const prs = [makePR({ repo: 'owner/repo', status: 'merge_conflict' })];
    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('merge_conflict');
  });

  it('should collect incomplete_checklist issues with stats', () => {
    const prs = [
      makePR({ repo: 'owner/repo', status: 'incomplete_checklist', checklistStats: { checked: 2, total: 5 } }),
    ];
    const result = collectActionableIssues(prs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('incomplete_checklist');
    expect(result[0].label).toContain('2/5');
  });

  it('should order issues by priority: response > changes > ci > conflict > checklist', () => {
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'incomplete_checklist' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'needs_response' }),
      makePR({ repo: 'owner/repo', number: 3, status: 'merge_conflict' }),
      makePR({ repo: 'owner/repo', number: 4, status: 'failing_ci' }),
      makePR({ repo: 'owner/repo', number: 5, status: 'needs_changes' }),
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

  it('should skip snoozed PRs for ci_failing only', () => {
    const snoozedUrl = 'https://github.com/owner/repo/pull/1';
    const prs = [
      makePR({ repo: 'owner/repo', number: 1, status: 'failing_ci' }),
      makePR({ repo: 'owner/repo', number: 2, status: 'failing_ci' }),
    ];
    const snoozedUrls = new Set([snoozedUrl]);
    const result = collectActionableIssues(prs, snoozedUrls);

    expect(result).toHaveLength(1);
    expect(result[0].pr.number).toBe(2);
  });

  it('should not skip snoozed PRs for non-CI issue types', () => {
    const snoozedUrl = 'https://github.com/owner/repo/pull/1';
    const prs = [makePR({ repo: 'owner/repo', number: 1, status: 'needs_response' })];
    const snoozedUrls = new Set([snoozedUrl]);
    const result = collectActionableIssues(prs, snoozedUrls);

    expect(result).toHaveLength(1);
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

  it('should say "all healthy" when no issues', () => {
    const digest = makeDigest();
    const result = formatBriefSummary(digest, 0);
    expect(result).toContain('all healthy');
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

  it('should include CI Failing section when present', () => {
    const pr = makePR({ repo: 'owner/repo', status: 'failing_ci', failingCheckNames: ['test'] });
    const digest = makeDigest({ ciFailingPRs: [pr] });
    const result = formatSummary(digest, makeCapacity());
    expect(result).toContain('CI Failing');
    expect(result).toContain('Failing: test');
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
    const pr = makePR({ repo: 'owner/repo', number: 42, title: 'Fix bug', daysSinceActivity: 14, status: 'dormant' });
    const ref = toShelvedPRRef(pr);

    expect(ref).toEqual({
      number: 42,
      url: 'https://github.com/owner/repo/pull/42',
      title: 'Fix bug',
      repo: 'owner/repo',
      daysSinceActivity: 14,
      status: 'dormant',
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
        status: 'healthy',
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
        status: 'dormant',
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
  it('should include address_all when there are actionable issues', () => {
    const issues = [{ type: 'ci_failing' as const, pr: makePR({ repo: 'owner/repo' }), label: '[CI Failing]' }];
    const menu = computeActionMenu(issues, makeCapacity());
    expect(menu.items[0].key).toBe('address_all');
  });

  it('should always end with done', () => {
    const menu = computeActionMenu([], makeCapacity());
    expect(menu.items[menu.items.length - 1].key).toBe('done');
  });

  it('should always include search', () => {
    const menu = computeActionMenu([], makeCapacity());
    expect(menu.items.find((i) => i.key === 'search')).toBeDefined();
  });
});
