/**
 * Tests for daily command helper functions
 */

import { describe, it, expect } from 'vitest';
import { computeRepoSignals } from './daily.js';
import type { FetchedPR } from '../core/types.js';

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
    hasMergeConflict: false,
    reviewDecision: 'approved',
    hasUnrespondedComment: false,
    hasIncompleteChecklist: false,
    maintainerActionHints: [],
    status: 'healthy',
    ...overrides,
  };
}

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
    const inactiveStatuses = ['failing_ci', 'merge_conflict', 'dormant', 'approaching_dormant', 'incomplete_checklist'] as const;
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
