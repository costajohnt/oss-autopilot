/**
 * Tests for daily command helper functions
 */

import { describe, it, expect } from 'vitest';
import { computeRepoSignals, computeActionMenu, groupPRsByRepo, toShelvedPRRef } from './daily.js';
import { deduplicateDigest, compactActionableIssues, compactRepoGroups } from '../formatters/json.js';
import type { FetchedPR, DailyDigest, CommentedIssue } from '../core/types.js';
import type { ActionableIssue, CapacityAssessment } from '../formatters/json.js';

/** Create a minimal FetchedPR for testing signal computation */
function makePR(overrides: Partial<FetchedPR> & { repo: string }): FetchedPR {
  return {
    id: 1,
    url: `https://github.com/${overrides.repo}/pull/1`,
    number: 1,
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
    displayDescription: 'Everything looks good — normal review cycle',
    ...overrides,
  };
}

/** Create a minimal CapacityAssessment for testing */
function makeCapacity(overrides: Partial<CapacityAssessment> = {}): CapacityAssessment {
  return {
    hasCapacity: true,
    activePRCount: 3,
    maxActivePRs: 10,
    shelvedPRCount: 0,
    criticalIssueCount: 0,
    reason: 'You have capacity: 3/10 active PRs, no critical issues',
    ...overrides,
  };
}

/** Create a minimal ActionableIssue for testing */
function makeActionableIssue(type: ActionableIssue['type'] = 'ci_failing'): ActionableIssue {
  return {
    type,
    pr: makePR({ repo: 'owner/repo' }),
    label: '[CI Failing]',
  };
}

describe('computeActionMenu', () => {
  it('should include address_all when there are actionable issues', () => {
    const issues = [makeActionableIssue(), makeActionableIssue('needs_response')];
    const menu = computeActionMenu(issues, makeCapacity());

    expect(menu.items[0].key).toBe('address_all');
    expect(menu.items[0].label).toContain('2 issues');
    expect(menu.context.hasActionableIssues).toBe(true);
    expect(menu.context.actionableCount).toBe(2);
  });

  it('should use singular "issue" for count of 1', () => {
    const issues = [makeActionableIssue()];
    const menu = computeActionMenu(issues, makeCapacity());

    expect(menu.items[0].label).toContain('1 issue ');
    expect(menu.items[0].label).not.toContain('1 issues');
  });

  it('should not include address_all when there are no actionable issues', () => {
    const menu = computeActionMenu([], makeCapacity());

    expect(menu.items.find((i) => i.key === 'address_all')).toBeUndefined();
    expect(menu.context.hasActionableIssues).toBe(false);
    expect(menu.context.actionableCount).toBe(0);
  });

  it('should always include search regardless of capacity', () => {
    const withCapacity = computeActionMenu([], makeCapacity({ hasCapacity: true }));
    const withoutCapacity = computeActionMenu([], makeCapacity({ hasCapacity: false }));

    expect(withCapacity.items.find((i) => i.key === 'search')).toBeDefined();
    expect(withoutCapacity.items.find((i) => i.key === 'search')).toBeDefined();
  });

  it('should always include done as the last item', () => {
    const menu1 = computeActionMenu([], makeCapacity());
    const menu2 = computeActionMenu([makeActionableIssue()], makeCapacity({ hasCapacity: false }));

    expect(menu1.items[menu1.items.length - 1].key).toBe('done');
    expect(menu2.items[menu2.items.length - 1].key).toBe('done');
  });

  it('should have correct context flags', () => {
    const menu = computeActionMenu([makeActionableIssue()], makeCapacity({ hasCapacity: true }));

    expect(menu.context).toEqual({
      hasActionableIssues: true,
      actionableCount: 1,
      hasCapacity: true,
      hasIssueResponses: false,
      issueResponseCount: 0,
    });
  });

  it('should produce [address_all, search, done] when actionable issues exist', () => {
    const issues = [makeActionableIssue(), makeActionableIssue('needs_response')];
    const withCapacity = computeActionMenu(issues, makeCapacity({ hasCapacity: true }));
    const withoutCapacity = computeActionMenu(issues, makeCapacity({ hasCapacity: false }));

    expect(withCapacity.items.map((i) => i.key)).toEqual(['address_all', 'search', 'done']);
    expect(withoutCapacity.items.map((i) => i.key)).toEqual(['address_all', 'search', 'done']);
  });

  it('should produce [search, done] when no actionable issues exist', () => {
    const withCapacity = computeActionMenu([], makeCapacity({ hasCapacity: true }));
    const withoutCapacity = computeActionMenu([], makeCapacity({ hasCapacity: false }));

    expect(withCapacity.items.map((i) => i.key)).toEqual(['search', 'done']);
    expect(withoutCapacity.items.map((i) => i.key)).toEqual(['search', 'done']);
  });

  it('should include issue_replies item and context when issue responses exist', () => {
    const issueResponses: CommentedIssue[] = [
      {
        repo: 'owner/repo',
        number: 10,
        title: 'Test issue',
        url: 'https://github.com/owner/repo/issues/10',
        status: 'new_response',
        userLastCommentedAt: '2026-02-01T10:00:00Z',
        lastResponseAuthor: 'maintainer',
        lastResponseBody: 'Go for it!',
        lastResponseAt: '2026-02-02T10:00:00Z',
        labels: ['bug'],
        daysSinceUserComment: 3,
      },
    ];
    const menu = computeActionMenu([], makeCapacity(), issueResponses);

    expect(menu.items.map((i) => i.key)).toEqual(['issue_replies', 'search', 'done']);
    expect(menu.items[0].label).toBe('Review 1 issue reply');
    expect(menu.context).toEqual({
      hasActionableIssues: false,
      actionableCount: 0,
      hasCapacity: true,
      hasIssueResponses: true,
      issueResponseCount: 1,
    });
  });

  it('should order address_all before issue_replies when both present', () => {
    const issueResponses: CommentedIssue[] = [
      {
        repo: 'a/b',
        number: 1,
        title: 'T',
        url: 'u',
        status: 'new_response',
        userLastCommentedAt: '',
        lastResponseAuthor: 'm',
        lastResponseBody: 'x',
        lastResponseAt: '',
        labels: [],
        daysSinceUserComment: 0,
      },
    ];
    const menu = computeActionMenu([makeActionableIssue()], makeCapacity(), issueResponses);

    expect(menu.items.map((i) => i.key)).toEqual(['address_all', 'issue_replies', 'search', 'done']);
  });

  it('should use plural label for multiple issue responses', () => {
    const issueResponses: CommentedIssue[] = [
      {
        repo: 'a/b',
        number: 1,
        title: 'T',
        url: 'u',
        status: 'new_response',
        userLastCommentedAt: '',
        lastResponseAuthor: 'm',
        lastResponseBody: 'x',
        lastResponseAt: '',
        labels: [],
        daysSinceUserComment: 0,
      },
      {
        repo: 'c/d',
        number: 2,
        title: 'T',
        url: 'u',
        status: 'new_response',
        userLastCommentedAt: '',
        lastResponseAuthor: 'm',
        lastResponseBody: 'x',
        lastResponseAt: '',
        labels: [],
        daysSinceUserComment: 0,
      },
    ];
    const menu = computeActionMenu([], makeCapacity(), issueResponses);

    expect(menu.items[0].label).toBe('Review 2 issue replies');
  });
});

describe('computeRepoSignals', () => {
  it('should return empty map for empty PR list', () => {
    const result = computeRepoSignals([]);
    expect(result.size).toBe(0);
  });

  it('should mark repo as responsive when PR has maintainer comment and is not dormant', () => {
    const prs = [
      makePR({
        repo: 'owner/responsive',
        status: 'healthy',
        lastMaintainerComment: { author: 'maintainer', body: 'LGTM', createdAt: '2026-01-15T00:00:00Z' },
      }),
    ];
    const result = computeRepoSignals(prs);
    expect(result.get('owner/responsive')!.isResponsive).toBe(true);
  });

  it('should NOT mark repo as responsive when PR is dormant despite having comment', () => {
    const prs = [
      makePR({
        repo: 'owner/dormant-repo',
        status: 'dormant',
        lastMaintainerComment: { author: 'maintainer', body: 'Will review', createdAt: '2025-06-01T00:00:00Z' },
      }),
    ];
    const result = computeRepoSignals(prs);
    expect(result.get('owner/dormant-repo')!.isResponsive).toBe(false);
  });

  it('should NOT mark repo as responsive when PR is approaching_dormant', () => {
    const prs = [
      makePR({
        repo: 'owner/stale-repo',
        status: 'approaching_dormant',
        lastMaintainerComment: { author: 'maintainer', body: 'Old comment', createdAt: '2025-11-01T00:00:00Z' },
      }),
    ];
    const result = computeRepoSignals(prs);
    expect(result.get('owner/stale-repo')!.isResponsive).toBe(false);
  });

  it('should NOT mark repo as responsive when PR has no maintainer comment', () => {
    const prs = [
      makePR({
        repo: 'owner/no-comment',
        status: 'healthy',
        lastMaintainerComment: undefined,
      }),
    ];
    const result = computeRepoSignals(prs);
    expect(result.get('owner/no-comment')!.isResponsive).toBe(false);
  });

  it('should mark repo as having active maintainers for healthy status', () => {
    const prs = [makePR({ repo: 'owner/active', status: 'healthy' })];
    const result = computeRepoSignals(prs);
    expect(result.get('owner/active')!.hasActiveMaintainers).toBe(true);
  });

  it('should mark repo as having active maintainers for review-related statuses', () => {
    const statuses = ['waiting_on_maintainer', 'changes_addressed', 'needs_response', 'needs_changes'] as const;
    for (const status of statuses) {
      const prs = [makePR({ repo: `owner/${status}`, status })];
      const result = computeRepoSignals(prs);
      expect(result.get(`owner/${status}`)!.hasActiveMaintainers).toBe(true);
    }
  });

  it('should NOT mark repo as having active maintainers for non-review statuses', () => {
    const inactiveStatuses = [
      'failing_ci',
      'merge_conflict',
      'dormant',
      'approaching_dormant',
      'incomplete_checklist',
    ] as const;
    for (const status of inactiveStatuses) {
      const prs = [makePR({ repo: `owner/${status}`, status })];
      const result = computeRepoSignals(prs);
      expect(result.get(`owner/${status}`)!.hasActiveMaintainers).toBe(false);
    }
  });

  it('should aggregate signals across multiple PRs in the same repo', () => {
    const prs = [
      makePR({
        repo: 'owner/multi',
        status: 'dormant',
        lastMaintainerComment: undefined,
      }),
      makePR({
        repo: 'owner/multi',
        number: 2,
        status: 'healthy',
        lastMaintainerComment: { author: 'maintainer', body: 'Looks good', createdAt: '2026-01-15T00:00:00Z' },
      }),
    ];
    const result = computeRepoSignals(prs);
    // Second PR is healthy with comment → responsive. Second PR is healthy → active maintainers.
    expect(result.get('owner/multi')!.isResponsive).toBe(true);
    expect(result.get('owner/multi')!.hasActiveMaintainers).toBe(true);
  });

  it('should skip PRs with empty repo field', () => {
    const prs = [
      makePR({
        repo: '' as any,
        status: 'healthy',
      }),
      makePR({
        repo: 'owner/valid',
        status: 'healthy',
      }),
    ];
    const result = computeRepoSignals(prs);
    expect(result.has('')).toBe(false);
    expect(result.has('owner/valid')).toBe(true);
  });

  it('should handle multiple repos independently', () => {
    const prs = [
      makePR({
        repo: 'owner/active-repo',
        status: 'healthy',
        lastMaintainerComment: { author: 'maintainer', body: 'LGTM', createdAt: '2026-01-15T00:00:00Z' },
      }),
      makePR({
        repo: 'owner/dead-repo',
        status: 'dormant',
        lastMaintainerComment: undefined,
      }),
    ];
    const result = computeRepoSignals(prs);
    expect(result.get('owner/active-repo')!.isResponsive).toBe(true);
    expect(result.get('owner/active-repo')!.hasActiveMaintainers).toBe(true);
    expect(result.get('owner/dead-repo')!.isResponsive).toBe(false);
    expect(result.get('owner/dead-repo')!.hasActiveMaintainers).toBe(false);
  });
});

describe('groupPRsByRepo (#80)', () => {
  it('should return empty array for no PRs', () => {
    expect(groupPRsByRepo([])).toEqual([]);
  });

  it('should group single PR into one group', () => {
    const prs = [makePR({ repo: 'owner/repo' })];
    const groups = groupPRsByRepo(prs);
    expect(groups).toHaveLength(1);
    expect(groups[0].repo).toBe('owner/repo');
    expect(groups[0].prs).toHaveLength(1);
  });

  it('should group multiple PRs in same repo together', () => {
    const prs = [
      makePR({ repo: 'owner/repo', number: 1 }),
      makePR({ repo: 'owner/repo', number: 2 }),
      makePR({ repo: 'owner/repo', number: 3 }),
    ];
    const groups = groupPRsByRepo(prs);
    expect(groups).toHaveLength(1);
    expect(groups[0].repo).toBe('owner/repo');
    expect(groups[0].prs).toHaveLength(3);
  });

  it('should separate PRs in different repos', () => {
    const prs = [makePR({ repo: 'owner/repo-a', number: 1 }), makePR({ repo: 'owner/repo-b', number: 2 })];
    const groups = groupPRsByRepo(prs);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.repo).sort()).toEqual(['owner/repo-a', 'owner/repo-b']);
  });

  it('should correctly group mixed PRs from multiple repos', () => {
    const prs = [
      makePR({ repo: 'vadimdemedes/ink', number: 855, status: 'needs_response' }),
      makePR({ repo: 'shadcn-ui/ui', number: 9263, status: 'healthy' }),
      makePR({ repo: 'vadimdemedes/ink', number: 856, status: 'failing_ci' }),
      makePR({ repo: 'refined-github/refined-github', number: 8965, status: 'needs_response' }),
    ];
    const groups = groupPRsByRepo(prs);
    expect(groups).toHaveLength(3);

    const inkGroup = groups.find((g) => g.repo === 'vadimdemedes/ink');
    expect(inkGroup).toBeDefined();
    expect(inkGroup!.prs).toHaveLength(2);
    expect(inkGroup!.prs.map((p) => p.number).sort()).toEqual([855, 856]);

    const uiGroup = groups.find((g) => g.repo === 'shadcn-ui/ui');
    expect(uiGroup).toBeDefined();
    expect(uiGroup!.prs).toHaveLength(1);
  });

  it('should skip PRs with empty repo field', () => {
    const prs = [makePR({ repo: '' as any }), makePR({ repo: 'owner/valid', number: 2 })];
    const groups = groupPRsByRepo(prs);
    expect(groups).toHaveLength(1);
    expect(groups[0].repo).toBe('owner/valid');
  });
});

describe('toShelvedPRRef', () => {
  it('should project only the display fields from a FetchedPR', () => {
    const pr = makePR({
      repo: 'owner/repo',
      number: 42,
      title: 'Fix bug',
      url: 'https://github.com/owner/repo/pull/42',
      daysSinceActivity: 14,
      status: 'dormant',
    });
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

  it('should not include full FetchedPR fields not needed for display', () => {
    const pr = makePR({ repo: 'owner/repo' });
    const ref = toShelvedPRRef(pr) as unknown as Record<string, unknown>;
    expect(ref).not.toHaveProperty('ciStatus');
    expect(ref).not.toHaveProperty('maintainerActionHints');
    expect(ref).not.toHaveProperty('failingCheckNames');
    expect(ref).not.toHaveProperty('hasMergeConflict');
  });
});

// ---------------------------------------------------------------------------
// JSON output deduplication (#287)
// ---------------------------------------------------------------------------

/** Build a minimal DailyDigest for deduplication testing */
function makeDigest(prs: FetchedPR[]): DailyDigest {
  return {
    generatedAt: '2026-01-25T10:00:00Z',
    openPRs: prs,
    prsNeedingResponse: prs.filter((p) => p.status === 'needs_response'),
    ciFailingPRs: prs.filter((p) => p.status === 'failing_ci'),
    ciBlockedPRs: [],
    ciNotRunningPRs: [],
    mergeConflictPRs: prs.filter((p) => p.status === 'merge_conflict'),
    needsRebasePRs: [],
    missingRequiredFilesPRs: [],
    incompleteChecklistPRs: [],
    needsChangesPRs: prs.filter((p) => p.status === 'needs_changes'),
    changesAddressedPRs: prs.filter((p) => p.status === 'changes_addressed'),
    waitingOnMaintainerPRs: [],
    approachingDormant: [],
    dormantPRs: [],
    healthyPRs: prs.filter((p) => p.status === 'healthy'),
    recentlyClosedPRs: [],
    recentlyMergedPRs: [],
    shelvedPRs: [],
    autoUnshelvedPRs: [],
    summary: {
      totalActivePRs: prs.length,
      totalNeedingAttention: 0,
      totalMergedAllTime: 5,
      mergeRate: 83.3,
    },
  };
}

describe('deduplicateDigest (#287)', () => {
  it('should convert category arrays from FetchedPR[] to URL string[]', () => {
    const pr1 = makePR({ repo: 'owner/repo', number: 1, status: 'healthy' });
    const pr2 = makePR({ repo: 'owner/repo', number: 2, status: 'failing_ci' });
    const pr3 = makePR({ repo: 'owner/repo', number: 3, status: 'needs_response' });
    const digest = makeDigest([pr1, pr2, pr3]);

    const compact = deduplicateDigest(digest);

    // Full objects only in openPRs
    expect(compact.openPRs).toHaveLength(3);
    expect(compact.openPRs[0]).toHaveProperty('url');
    expect(compact.openPRs[0]).toHaveProperty('ciStatus');

    // Category arrays contain PR URLs, not objects
    expect(compact.healthyPRs).toEqual([pr1.url]);
    expect(compact.ciFailingPRs).toEqual([pr2.url]);
    expect(compact.prsNeedingResponse).toEqual([pr3.url]);
  });

  it('should preserve non-PR fields unchanged', () => {
    const digest = makeDigest([]);
    digest.recentlyClosedPRs = [{ url: 'u', repo: 'r', number: 10, title: 't', closedAt: 'c' }];
    digest.recentlyMergedPRs = [{ url: 'u', repo: 'r', number: 11, title: 't', mergedAt: 'm' }];

    const compact = deduplicateDigest(digest);

    expect(compact.generatedAt).toBe(digest.generatedAt);
    expect(compact.summary).toEqual(digest.summary);
    expect(compact.recentlyClosedPRs).toEqual(digest.recentlyClosedPRs);
    expect(compact.recentlyMergedPRs).toEqual(digest.recentlyMergedPRs);
  });

  it('should produce smaller JSON than the original digest', () => {
    // Create PRs with realistic data to show size reduction
    const prs = Array.from({ length: 10 }, (_, i) =>
      makePR({
        repo: `owner/repo-${i}`,
        number: i + 1,
        status: i % 2 === 0 ? 'healthy' : 'failing_ci',
      }),
    );
    const digest = makeDigest(prs);

    const originalSize = JSON.stringify(digest).length;
    const compactSize = JSON.stringify(deduplicateDigest(digest)).length;

    expect(compactSize).toBeLessThan(originalSize);
  });

  it('should return empty arrays for empty category arrays', () => {
    const digest = makeDigest([]);
    const compact = deduplicateDigest(digest);

    expect(compact.healthyPRs).toEqual([]);
    expect(compact.ciFailingPRs).toEqual([]);
    expect(compact.prsNeedingResponse).toEqual([]);
    expect(compact.mergeConflictPRs).toEqual([]);
  });
});

describe('compactActionableIssues (#287)', () => {
  it('should replace pr object with prUrl', () => {
    const pr42 = makePR({ repo: 'owner/repo', number: 42 });
    const pr99 = makePR({ repo: 'owner/repo', number: 99 });
    const issues: ActionableIssue[] = [
      { type: 'ci_failing', pr: pr42, label: '[CI Failing]' },
      { type: 'needs_response', pr: pr99, label: '[Needs Response]' },
    ];

    const compact = compactActionableIssues(issues);

    expect(compact).toHaveLength(2);
    expect(compact[0]).toEqual({ type: 'ci_failing', prUrl: pr42.url, label: '[CI Failing]' });
    expect(compact[1]).toEqual({ type: 'needs_response', prUrl: pr99.url, label: '[Needs Response]' });
    // Should NOT have a pr field
    expect(compact[0]).not.toHaveProperty('pr');
  });

  it('should return empty array for empty input', () => {
    expect(compactActionableIssues([])).toEqual([]);
  });
});

describe('compactRepoGroups (#287)', () => {
  it('should replace prs array with prUrls array', () => {
    const prA1 = makePR({ repo: 'owner/repo-a', number: 1 });
    const prA2 = makePR({ repo: 'owner/repo-a', number: 2 });
    const prB3 = makePR({ repo: 'owner/repo-b', number: 3 });
    const groups = [
      { repo: 'owner/repo-a', prs: [prA1, prA2] },
      { repo: 'owner/repo-b', prs: [prB3] },
    ];

    const compact = compactRepoGroups(groups);

    expect(compact).toHaveLength(2);
    expect(compact[0]).toEqual({ repo: 'owner/repo-a', prUrls: [prA1.url, prA2.url] });
    expect(compact[1]).toEqual({ repo: 'owner/repo-b', prUrls: [prB3.url] });
    // Should NOT have a prs field
    expect(compact[0]).not.toHaveProperty('prs');
  });

  it('should return empty array for empty input', () => {
    expect(compactRepoGroups([])).toEqual([]);
  });
});
