/**
 * executeDailyCheck() against a real in-memory StateManager: GitHub's
 * all-time closed-without-merge count from the count search reaches the
 * closed-ledger phases. A closed ledger left short of it (seeded ahead of its
 * history) is refetched from the start, and one still short afterwards is
 * reported. The merged mirror is in daily-orchestration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DailyDigest } from '../core/types.js';
import type { StateManager as StateManagerType } from '../core/state.js';

const h = vi.hoisted(() => ({
  sm: undefined as unknown as StateManagerType,
  fetchUserClosedPRCounts: undefined as unknown as ReturnType<typeof vi.fn>,
  search: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../core/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/state.js')>();
  return { ...actual, getStateManager: () => h.sm };
});

vi.mock('../core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/index.js')>();
  const empty = {
    repos: new Map(),
    monthlyCounts: {},
    monthlyOpenedCounts: {},
    dailyActivityCounts: {},
    searchedPRs: [],
    truncated: false,
  };
  h.fetchUserClosedPRCounts = vi.fn();
  h.search = vi.fn();

  class MockPRMonitor {
    fetchUserOpenPRs = vi.fn().mockResolvedValue({ prs: [], failures: [] });
    fetchUserMergedPRCounts = vi.fn().mockResolvedValue(empty);
    fetchUserClosedPRCounts = h.fetchUserClosedPRCounts;
    fetchRepoMetadata = vi.fn(
      async (repos: string[]) => new Map(repos.map((r) => [r, { stars: 1000, language: null }])),
    );
    fetchRecentlyClosedPRs = vi.fn().mockResolvedValue([]);
    fetchRecentlyMergedPRs = vi.fn().mockResolvedValue([]);
    fetchPRClosedBy = vi.fn();
    fetchMergedPRActivity = vi.fn();
    fetchReviewedOpenPRs = vi.fn().mockResolvedValue({ prs: [], warnings: [] });
    fetchReviewedPRActivity = vi.fn();
    fetchCompareStatus = vi.fn();
    generateDigest = (): DailyDigest => ({
      generatedAt: '2026-11-13T00:00:00Z',
      openPRs: [],
      needsAddressingPRs: [],
      waitingOnMaintainerPRs: [],
      recentlyClosedPRs: [],
      recentlyMergedPRs: [],
      shelvedPRs: [],
      autoUnshelvedPRs: [],
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
    });
  }

  class MockIssueConversationMonitor {
    fetchCommentedIssues = vi.fn().mockResolvedValue({ issues: [], failures: [], lookupFailures: 0, warnings: [] });
    hasUserCommentSince = vi.fn().mockResolvedValue(false);
  }

  return {
    ...actual,
    requireGitHubToken: vi.fn(() => 'test-token'),
    // The ledger gap fetches search through this client.
    getOctokit: () => ({ search: { issuesAndPullRequests: h.search } }),
    PRMonitor: MockPRMonitor,
    IssueConversationMonitor: MockIssueConversationMonitor,
  };
});

import { StateManager } from '../core/state.js';
import { executeDailyCheck } from './daily.js';

const CLOSED_BASE = 'is:pr is:closed is:unmerged is:public author:testuser -user:testuser';

/** A closed-without-merge search item, closed and last updated at `closedAt`. */
function closedItem(number: number, closedAt: string) {
  return {
    html_url: `https://github.com/org/repo/pull/${number}`,
    title: `Closed ${number}`,
    created_at: closedAt,
    updated_at: closedAt,
    closed_at: closedAt,
    pull_request: { merged_at: null },
  };
}

/** Older closes GitHub lists that a ledger seeded with one recent close lacks. */
const OLDER_CLOSES = [
  closedItem(1, '2025-02-01T00:00:00Z'),
  closedItem(2, '2025-06-01T00:00:00Z'),
  closedItem(3, '2025-09-01T00:00:00Z'),
];

/** A Search API stand-in over OLDER_CLOSES that honors the `updated:>` bound; merged searches find nothing. */
function answerSearch({ q }: { q: string }) {
  if (!q.includes('is:unmerged')) return Promise.resolve({ data: { total_count: 0, items: [] } });
  const since = Date.parse(/updated:>(\S+)/.exec(q)?.[1] ?? '') || 0;
  const items = OLDER_CLOSES.filter((item) => Date.parse(item.updated_at) > since);
  return Promise.resolve({ data: { total_count: items.length, items } });
}

/** The count search, reporting `totalCount` closed-without-merge PRs all time. */
function closedCounts(totalCount: number) {
  return {
    repos: new Map(),
    monthlyCounts: {},
    monthlyOpenedCounts: {},
    dailyActivityCounts: {},
    searchedPRs: [],
    truncated: false,
    totalCount,
  };
}

function closedQueries(): string[] {
  return h.search.mock.calls.map(([args]) => args.q).filter((q: string) => q.includes('is:unmerged'));
}

describe('executeDailyCheck() — a closed ledger short of the all-time count', () => {
  beforeEach(() => {
    h.sm = new StateManager(true);
    h.sm.updateConfig({ githubUsername: 'testuser' });
    // Seeded by the recent list ahead of its history: the watermark is this close.
    h.sm.addClosedPRs([{ url: 'https://github.com/org/repo/pull/9', title: 'Recent', closedAt: '2026-11-10T00:00:00Z' }]);
    h.search.mockReset();
    h.search.mockImplementation(answerSearch);
  });

  it('refetches the closed history from the start and stores it', async () => {
    h.fetchUserClosedPRCounts.mockResolvedValue(closedCounts(4));

    const result = await executeDailyCheck('test-token');

    expect(closedQueries()).toEqual([CLOSED_BASE]);
    expect(h.sm.getClosedPRs()).toHaveLength(4);
    expect(result.warnings).toEqual([]);
  });

  it('warns when the ledger is still short of the all-time closed count after the refetch', async () => {
    h.fetchUserClosedPRCounts.mockResolvedValue(closedCounts(6));

    const result = await executeDailyCheck('test-token');

    expect(h.sm.getClosedPRs()).toHaveLength(4);
    expect(result.warnings).toEqual([
      {
        phase: 'analytics',
        operation: 'check closed-PR ledger',
        message:
          'The closed-PR ledger holds 4 of the 6 closed PRs GitHub reports (2 missing). ' +
          'Run `ledger-backfill` to fetch them.',
      },
    ]);
  });

  it('keeps the watermark when the count is unknown', async () => {
    h.fetchUserClosedPRCounts.mockResolvedValue({ ...closedCounts(0), totalCount: undefined });

    await executeDailyCheck('test-token');

    expect(closedQueries()).toEqual([`${CLOSED_BASE} updated:>2026-11-09T00:00:00Z`]);
    expect(h.sm.getClosedPRs()).toHaveLength(1);
  });
});
