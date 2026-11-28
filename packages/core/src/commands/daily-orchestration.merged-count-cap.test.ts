/**
 * executeDailyCheck() against a real in-memory StateManager: the merged-count
 * search is capped at 300 PRs, so for a prolific user it undercounts. The
 * ledger is complete, and the all-time merged count must follow it (#1897).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DailyDigest, FetchedPR, StoredClosedPR, StoredMergedPR } from '../core/types.js';
import type { StateManager as StateManagerType } from '../core/state.js';

const h = vi.hoisted(() => ({
  sm: undefined as unknown as StateManagerType,
  fetchUserMergedPRCounts: undefined as unknown as ReturnType<typeof vi.fn>,
  fetchRecentlyMergedPRs: undefined as unknown as ReturnType<typeof vi.fn>,
  fetchUserClosedPRCounts: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../core/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/state.js')>();
  return { ...actual, getStateManager: () => h.sm };
});

vi.mock('../core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/index.js')>();
  h.fetchUserMergedPRCounts = vi.fn();
  h.fetchRecentlyMergedPRs = vi.fn();
  const empty = {
    repos: new Map(),
    monthlyCounts: {},
    monthlyOpenedCounts: {},
    dailyActivityCounts: {},
    searchedPRs: [],
  };
  h.fetchUserClosedPRCounts = vi.fn().mockResolvedValue({ ...empty, truncated: false });

  class MockPRMonitor {
    fetchUserOpenPRs = vi.fn().mockResolvedValue({ prs: [], failures: [] });
    fetchUserMergedPRCounts = h.fetchUserMergedPRCounts;
    fetchUserClosedPRCounts = h.fetchUserClosedPRCounts;
    fetchRepoMetadata = vi.fn(
      async (repos: string[]) =>
        new Map(repos.map((r) => [r, { stars: r === 'tiny/repo' ? 10 : 1000, language: null }])),
    );
    fetchRecentlyClosedPRs = vi.fn().mockResolvedValue([]);
    fetchRecentlyMergedPRs = h.fetchRecentlyMergedPRs;
    fetchPRClosedBy = vi.fn();
    fetchMergedPRActivity = vi.fn().mockResolvedValue({
      comments: [],
      reviews: [],
      reviewComments: [],
      commits: [],
      truncatedLists: [],
    });
    fetchReviewedOpenPRs = vi.fn().mockResolvedValue({ prs: [], warnings: [] });
    fetchReviewedPRActivity = vi.fn();
    fetchCompareStatus = vi.fn();
    // The real digest reads getStats() here; capture what it would report.
    generateDigest = (prs: FetchedPR[]): DailyDigest => ({
      generatedAt: '2026-11-13T00:00:00Z',
      openPRs: prs,
      needsAddressingPRs: [],
      waitingOnMaintainerPRs: [],
      recentlyClosedPRs: [],
      recentlyMergedPRs: [],
      shelvedPRs: [],
      autoUnshelvedPRs: [],
      summary: {
        totalActivePRs: 0,
        totalNeedingAttention: 0,
        totalMergedAllTime: h.sm.getStats().mergedPRs,
        mergeRate: 0,
      },
    });
  }

  class MockIssueConversationMonitor {
    fetchCommentedIssues = vi.fn().mockResolvedValue({ issues: [], failures: [], lookupFailures: 0, warnings: [] });
    hasUserCommentSince = vi.fn().mockResolvedValue(false);
  }

  return {
    ...actual,
    requireGitHubToken: vi.fn(() => 'test-token'),
    // The merged-ledger gap fetch (#1924) searches through this client.
    getOctokit: () => ({
      search: { issuesAndPullRequests: () => Promise.resolve({ data: { total_count: 0, items: [] } }) },
    }),
    PRMonitor: MockPRMonitor,
    IssueConversationMonitor: MockIssueConversationMonitor,
  };
});

import { StateManager } from '../core/state.js';
import { executeDailyCheck } from './daily.js';

function ledger(repo: string, count: number): StoredMergedPR[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://github.com/${repo}/pull/${i + 1}`,
    title: `PR ${i + 1}`,
    mergedAt: '2026-01-01T00:00:00Z',
  }));
}

/** `count` closed-without-merge ledger rows in `repo`. */
function closedLedger(repo: string, count: number): StoredClosedPR[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://github.com/${repo}/pull/${100 + i}`,
    title: `Closed ${i}`,
    closedAt: '2026-01-02T00:00:00Z',
  }));
}

/** The count searches for the #2045 runs: big/repo has `closedForBig` closed PRs. */
function searchCounts(closedForBig: number) {
  const base = { monthlyCounts: {}, monthlyOpenedCounts: {}, dailyActivityCounts: {}, searchedPRs: [], truncated: false };
  return {
    // tiny/repo is below minStars, so the star-filtered search leaves it out.
    merged: { ...base, repos: new Map([['big/repo', { count: 3, lastMergedAt: '2026-01-01T00:00:00Z' }]]) },
    // old/repo's closed PRs fall outside the search; its ledger holds 2.
    closed: { ...base, repos: new Map([['big/repo', closedForBig]]) },
  };
}

/** Each scored repo's lastEvaluatedAt. */
function evaluatedAt(): Record<string, string> {
  return Object.fromEntries(Object.values(h.sm.getState().repoScores).map((rs) => [rs.repo, rs.lastEvaluatedAt]));
}

describe('executeDailyCheck() — merged count past the search pagination cap (#1897)', () => {
  beforeEach(() => {
    h.sm = new StateManager(true);
    h.sm.updateConfig({ githubUsername: 'testuser', minStars: 100 });
    // 340 + 25 merges in starred repos, 5 in a repo below minStars.
    h.sm.addMergedPRs([...ledger('big/repo', 340), ...ledger('small/repo', 25), ...ledger('tiny/repo', 5)]);
    for (const [repo, count, stars] of [
      ['big/repo', 340, 1000],
      ['small/repo', 25, 1000],
      ['tiny/repo', 5, 10],
    ] as const) {
      h.sm.updateRepoScore(repo, { mergedPRCount: count, stargazersCount: stars });
    }
  });

  it('reports the star-filtered ledger count, never the capped search count', async () => {
    const before = h.sm.getStats().mergedPRs;
    expect(before).toBe(365);

    // The search saw only the 300 most recently updated PRs: small/repo fell off the end.
    h.fetchUserMergedPRCounts.mockResolvedValue({
      repos: new Map([['big/repo', { count: 280, lastMergedAt: '2026-11-12T00:00:00Z' }]]),
      monthlyCounts: {},
      monthlyOpenedCounts: {},
      dailyActivityCounts: {},
      searchedPRs: [],
      truncated: true,
    });
    // Two merges today, not yet in the ledger.
    h.fetchRecentlyMergedPRs.mockResolvedValue(
      [341, 342].map((n) => ({
        url: `https://github.com/big/repo/pull/${n}`,
        repo: 'big/repo',
        number: n,
        title: `PR ${n}`,
        mergedAt: '2026-11-12T00:00:00Z',
      })),
    );

    const result = await executeDailyCheck('test-token');

    expect(h.sm.getStats().mergedPRs).toBe(367);
    expect(result.digest.summary.totalMergedAllTime).toBe(367);
    expect(h.sm.getState().repoScores['small/repo'].mergedPRCount).toBe(25);
  });
});

describe('executeDailyCheck() — a repo whose counts net to no change is not re-evaluated (#2045)', () => {
  const T0 = '2026-11-01T00:00:00.000Z';

  async function runDaily(at: string, closedForBig = 1) {
    vi.setSystemTime(at);
    const { merged, closed } = searchCounts(closedForBig);
    h.fetchUserMergedPRCounts.mockResolvedValue(merged);
    h.fetchUserClosedPRCounts.mockResolvedValue(closed);
    await executeDailyCheck('test-token');
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    h.sm = new StateManager(true);
    h.sm.updateConfig({ githubUsername: 'testuser', minStars: 100 });
    h.sm.addMergedPRs([...ledger('big/repo', 3), ...ledger('tiny/repo', 5)]);
    h.sm.addClosedPRs([...closedLedger('big/repo', 1), ...closedLedger('old/repo', 2)]);
    h.sm.updateRepoScore('big/repo', {
      mergedPRCount: 3,
      closedWithoutMergeCount: 1,
      lastMergedAt: '2026-01-01T00:00:00Z',
      stargazersCount: 1000,
    });
    h.sm.updateRepoScore('tiny/repo', { mergedPRCount: 5, stargazersCount: 10 });
    h.sm.updateRepoScore('old/repo', { closedWithoutMergeCount: 2, stargazersCount: 1000 });
    h.fetchRecentlyMergedPRs.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves lastEvaluatedAt where it was across two identical runs', async () => {
    const before = evaluatedAt();
    expect(Object.values(before)).toEqual([T0, T0, T0]);

    await runDaily('2026-11-10T00:00:00.000Z');
    await runDaily('2026-11-20T00:00:00.000Z');

    expect(evaluatedAt()).toEqual(before);
    // The counts were zeroed and raised back each run, and end where they started.
    expect(h.sm.getState().repoScores['tiny/repo'].mergedPRCount).toBe(5);
    expect(h.sm.getState().repoScores['old/repo'].closedWithoutMergeCount).toBe(2);
  });

  it('still moves lastEvaluatedAt for a repo whose outcome did change', async () => {
    await runDaily('2026-11-10T00:00:00.000Z', 4);

    expect(evaluatedAt()).toEqual({
      'big/repo': '2026-11-10T00:00:00.000Z',
      'tiny/repo': T0,
      'old/repo': T0,
    });
  });
});
