/**
 * executeDailyCheck() Phase 3.8: review follow-ups on PRs the user reviewed
 * (#1857). Same harness shape as daily-orchestration.merged-pr-notes.test.ts,
 * trimmed to the mocks this phase touches. Dismiss persistence is covered
 * against a real StateManager in daily-reviewed-prs.dismiss.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DailyDigest } from '../core/types.js';
import type { ReviewedPRActivity, ReviewedPRActivityList, ReviewedPRRef } from '../core/reviewed-prs.js';
import type { CompareStatus, ReviewedPRSearchResult } from '../core/reviewed-prs-fetch.js';
import { wrapUntrustedContent } from '../core/untrusted-content.js';
import { makeFetchedPR } from '../core/test-utils.js';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any import of the mocked modules
// ---------------------------------------------------------------------------

type ActivityResult = ReviewedPRActivity & { truncatedLists: ReviewedPRActivityList[] };

const mockFetchUserOpenPRs = vi.fn();
const mockFetchUserMergedPRCounts = vi.fn();
const mockFetchUserClosedPRCounts = vi.fn();
const mockFetchRepoMetadata = vi.fn();
const mockFetchRecentlyClosedPRs = vi.fn();
const mockFetchRecentlyMergedPRs = vi.fn();
const mockFetchPRClosedBy = vi.fn();
const mockFetchMergedPRActivity = vi.fn();
const mockFetchReviewedOpenPRs = vi.fn<() => Promise<ReviewedPRSearchResult>>();
const mockFetchReviewedPRActivity = vi.fn<(prUrl: string) => Promise<ActivityResult>>();
const mockFetchCompareStatus = vi.fn<(prUrl: string, base: string, head: string) => Promise<CompareStatus>>();
const mockGenerateDigest = vi.fn();
const mockFetchCommentedIssues = vi.fn();
const mockHasUserCommentSince = vi.fn();

const mockGetState = vi.fn();
const mockIsGistMode = vi.fn(() => false);
const mockSetLastDigest = vi.fn();
const mockReloadIfChanged = vi.fn(() => false);
const mockGetIssueDismissedAt = vi.fn<(url: string) => string | undefined>();
const mockGetStatusOverride = vi.fn();

vi.mock('../core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/index.js')>();

  class MockPRMonitor {
    fetchUserOpenPRs = mockFetchUserOpenPRs;
    fetchUserMergedPRCounts = mockFetchUserMergedPRCounts;
    fetchUserClosedPRCounts = mockFetchUserClosedPRCounts;
    fetchRepoMetadata = mockFetchRepoMetadata;
    fetchRecentlyClosedPRs = mockFetchRecentlyClosedPRs;
    fetchRecentlyMergedPRs = mockFetchRecentlyMergedPRs;
    fetchPRClosedBy = mockFetchPRClosedBy;
    fetchMergedPRActivity = mockFetchMergedPRActivity;
    fetchReviewedOpenPRs = mockFetchReviewedOpenPRs;
    fetchReviewedPRActivity = mockFetchReviewedPRActivity;
    fetchCompareStatus = mockFetchCompareStatus;
    generateDigest = mockGenerateDigest;
  }

  class MockIssueConversationMonitor {
    fetchCommentedIssues = mockFetchCommentedIssues;
    hasUserCommentSince = mockHasUserCommentSince;
  }

  return {
    ...actual,
    getStateManager: vi.fn(() => ({
      getState: mockGetState,
      updateRepoScore: vi.fn(),
      addTrustedProject: vi.fn(),
      setMonthlyMergedCounts: vi.fn(),
      setMonthlyClosedCounts: vi.fn(),
      setMonthlyOpenedCounts: vi.fn(),
      setLastDigest: mockSetLastDigest,
      addMergedPRs: vi.fn(() => ({ added: 0, dropped: 0 })),
      addClosedPRs: vi.fn(() => ({ added: 0, dropped: 0 })),
      getMergedPRs: vi.fn(() => []),
      getClosedPRs: vi.fn(() => []),
      releaseIssue: vi.fn(() => 'not_tracked'),
      renameRepo: vi.fn(),
      setLastStrategyAt: vi.fn(),
      save: vi.fn(),
      isPRShelved: vi.fn(() => false),
      unshelvePR: vi.fn(() => true),
      getStats: vi.fn(),
      getIssueDismissedAt: mockGetIssueDismissedAt,
      dismissIssue: vi.fn(),
      undismissIssue: vi.fn(),
      getStatusOverride: mockGetStatusOverride,
      getStateStaleness: vi.fn(() => null),
      getLoadRecovery: vi.fn(() => null),
      isGistMode: mockIsGistMode,
      isGistDegraded: vi.fn(() => false),
      getGistHealth: vi.fn(() => ({ mode: 'local', degraded: null })),
      batch: (fn: () => void) => fn(),
      reloadIfChanged: mockReloadIfChanged,
    })),
    requireGitHubToken: vi.fn(() => 'test-token'),
    formatRelativeTime: vi.fn(() => '2 days ago'),
    PRMonitor: MockPRMonitor,
    IssueConversationMonitor: MockIssueConversationMonitor,
  };
});

vi.mock('../core/state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: mockGetState,
    getStatusOverride: mockGetStatusOverride,
    save: vi.fn(),
    batch: (fn: () => void) => fn(),
    reloadIfChanged: mockReloadIfChanged,
  })),
}));

// Import AFTER all mocks are declared
import { executeDailyCheck } from './daily.js';
import { REVIEWED_PR_MAX_PER_RUN } from './daily-reviewed-prs.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = 'testuser';
const AUTHOR = 'author';
const REVIEWED_AT = '2026-06-02T12:00:00Z';
const REVIEWED_MS = Date.parse(REVIEWED_AT);
const HOUR_MS = 60 * 60 * 1000;

function iso(offsetMs: number): string {
  const date = new Date(REVIEWED_MS + offsetMs);
  return date.toISOString();
}

function reviewedPR(number: number, overrides: Partial<ReviewedPRRef> = {}): ReviewedPRRef {
  return {
    number,
    url: `https://github.com/org/repo/pull/${number}`,
    repo: 'org/repo',
    title: `PR ${number}`,
    author: AUTHOR,
    updatedAt: iso(2 * HOUR_MS),
    ...overrides,
  };
}

function userReview() {
  return {
    id: 100,
    user: { login: USER },
    body: 'Please split the retry helper out of the handler, it is doing two jobs now.',
    submitted_at: REVIEWED_AT,
    state: 'CHANGES_REQUESTED',
    commit_id: 'rev0000',
  };
}

function authorCommit(date: string, sha: string) {
  return {
    sha,
    author: { login: AUTHOR },
    committer: { login: AUTHOR },
    commit: { message: `Split helper (${sha})`, author: { date }, committer: { date } },
    parents: [{ sha: 'p' }],
  };
}

function activity(overrides: Partial<ReviewedPRActivity> = {}): ActivityResult {
  return {
    pr: { headSha: 'head000', state: 'open', author: AUTHOR },
    comments: [],
    reviews: [],
    reviewComments: [],
    commits: [],
    truncatedLists: [],
    ...overrides,
  };
}

/** The issue's concrete case: review, then the author replied and pushed. */
function pushedAndReplied(): ActivityResult {
  return activity({
    reviews: [userReview()],
    reviewComments: [
      {
        id: 500,
        user: { login: USER },
        body: 'This loop never backs off on a 503 response.',
        created_at: REVIEWED_AT,
        commit_id: 'rev0000',
      },
      {
        id: 501,
        user: { login: AUTHOR },
        body: 'Would exponential backoff with a 30s cap be enough, or do you want jitter too?',
        created_at: iso(HOUR_MS),
        in_reply_to_id: 500,
        html_url: 'https://github.com/org/repo/pull/1#discussion_r501',
      },
    ],
    commits: [authorCommit(iso(-HOUR_MS), 'old1'), authorCommit(iso(2 * HOUR_MS), 'new1')],
  });
}

function makeDigest(): DailyDigest {
  return {
    generatedAt: '2026-06-03T10:00:00Z',
    openPRs: [],
    needsAddressingPRs: [],
    waitingOnMaintainerPRs: [],
    recentlyClosedPRs: [],
    recentlyMergedPRs: [],
    shelvedPRs: [],
    autoUnshelvedPRs: [],
    summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 5, mergeRate: 83.3 },
  };
}

function makeDefaultState(configOverrides: Record<string, unknown> = {}) {
  return {
    version: 3,
    activeIssues: [],
    mergedPRs: [],
    closedPRs: [],
    repoScores: {},
    config: {
      setupComplete: true,
      githubUsername: USER,
      maxActivePRs: 10,
      languages: ['TypeScript'],
      labels: [],
      excludeRepos: [],
      trustedProjects: [],
      shelvedPRUrls: [],
      dismissedIssues: {},
      ...configOverrides,
    },
    lastRunAt: '2026-06-02T10:00:00Z',
  };
}

function emptyCounts() {
  return { repos: new Map(), monthlyCounts: {}, monthlyOpenedCounts: {}, dailyActivityCounts: {}, searchedPRs: [] };
}

function phaseWarnings(result: { warnings: Array<{ phase: string; operation: string; message: string }> }) {
  return result.warnings.filter((w) => w.phase === 'reviewed-prs');
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function menuItem(result: Awaited<ReturnType<typeof executeDailyCheck>>) {
  return result.actionMenu.items.find((i) => i.key === 'review_follow_ups');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetState.mockReturnValue(makeDefaultState());
  mockFetchUserOpenPRs.mockResolvedValue({ prs: [], failures: [] });
  mockFetchUserMergedPRCounts.mockResolvedValue(emptyCounts());
  mockFetchUserClosedPRCounts.mockResolvedValue(emptyCounts());
  mockFetchRepoMetadata.mockResolvedValue(new Map());
  mockFetchRecentlyClosedPRs.mockResolvedValue([]);
  mockFetchRecentlyMergedPRs.mockResolvedValue([]);
  mockFetchMergedPRActivity.mockResolvedValue({
    comments: [],
    reviews: [],
    reviewComments: [],
    commits: [],
    truncatedLists: [],
  });
  mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [], warnings: [] });
  mockFetchReviewedPRActivity.mockResolvedValue(activity());
  mockFetchCompareStatus.mockResolvedValue('ahead');
  mockGenerateDigest.mockReturnValue(makeDigest());
  mockFetchCommentedIssues.mockResolvedValue({ issues: [], failures: [], warnings: [] });
  mockHasUserCommentSince.mockResolvedValue(false);
  mockFetchPRClosedBy.mockResolvedValue(USER);
  mockGetIssueDismissedAt.mockReturnValue(undefined);
  mockGetStatusOverride.mockReturnValue(undefined);
  mockSetLastDigest.mockImplementation((digest: DailyDigest) => {
    const state = mockGetState();
    state.lastDigest = digest;
    state.lastDigestAt = digest.generatedAt;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — review follow-ups (#1857)', () => {
  it('lists a reviewed PR the author pushed to and replied on, with the compare range, the question and the menu item', async () => {
    const pr = reviewedPR(1);
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [pr], warnings: [] });
    mockFetchReviewedPRActivity.mockResolvedValue(pushedAndReplied());

    const result = await executeDailyCheck('test-token');

    expect(mockFetchReviewedPRActivity).toHaveBeenCalledWith(pr.url);
    expect(mockFetchCompareStatus).toHaveBeenCalledWith(pr.url, 'rev0000', 'head000');
    expect(result.reviewedPRs).toEqual([
      {
        prUrl: pr.url,
        repo: 'org/repo',
        number: 1,
        title: 'PR 1',
        author: AUTHOR,
        reviewedAt: REVIEWED_AT,
        reviewedSha: 'rev0000',
        headSha: 'head000',
        compareRange: 'rev0000...head000',
        compareUrl: 'https://github.com/org/repo/compare/rev0000...head000',
        rebased: false,
        commits: [
          {
            sha: 'new1',
            author: AUTHOR,
            date: iso(2 * HOUR_MS),
            subject: wrapUntrustedContent('Split helper (new1)', 'org/repo#1', { author: AUTHOR, source: 'pr-commit' }),
          },
        ],
        moreCommits: 0,
        authorComments: 1,
        questions: [
          {
            author: AUTHOR,
            createdAt: iso(HOUR_MS),
            kind: 'review_comment',
            reason: 'reply',
            excerpt: wrapUntrustedContent(
              'Would exponential backoff with a 30s cap be enough, or do you want jitter too?',
              'org/repo#1',
              { author: AUTHOR, source: 'pr-comment' },
            ),
            url: 'https://github.com/org/repo/pull/1#discussion_r501',
          },
        ],
        moreQuestions: 0,
        latestActivityAt: iso(2 * HOUR_MS),
      },
    ]);
    expect(menuItem(result)?.label).toBe('Review follow-ups (1)');
    expect(result.warnings).toEqual([]);
  });

  it('flags a rebased branch (reviewed SHA no longer an ancestor, or gone) without a compare range', async () => {
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [reviewedPR(1), reviewedPR(2)], warnings: [] });
    mockFetchReviewedPRActivity.mockResolvedValue(pushedAndReplied());
    mockFetchCompareStatus.mockImplementation((prUrl) =>
      Promise.resolve(prUrl.endsWith('/1') ? 'diverged' : 'missing'),
    );

    const result = await executeDailyCheck('test-token');

    expect(result.reviewedPRs?.map((e) => [e.number, e.rebased, e.compareRange, e.compareUrl])).toEqual([
      [1, true, undefined, undefined],
      [2, true, undefined, undefined],
    ]);
    expect(result.reviewedPRs?.[0].commits.map((c) => c.sha)).toEqual(['new1']);
    expect(JSON.stringify(result.reviewedPRs)).not.toContain('rev0000...head000');
    expect(phaseWarnings(result)).toEqual([]);
  });

  it('keeps the entry without a range or a rebase flag, with a warning, when the compare call fails', async () => {
    const pr = reviewedPR(1);
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [pr], warnings: [] });
    mockFetchReviewedPRActivity.mockResolvedValue(pushedAndReplied());
    mockFetchCompareStatus.mockRejectedValue(httpError(502, 'Bad Gateway'));

    const result = await executeDailyCheck('test-token');

    expect(result.reviewedPRs?.map((e) => [e.rebased, e.compareRange])).toEqual([[false, undefined]]);
    expect(phaseWarnings(result)).toEqual([
      {
        phase: 'reviewed-prs',
        operation: `compare rev0000...head000 on ${pr.url}`,
        message: 'HTTP 502: Bad Gateway; cannot tell whether the branch was rebased, showing the commit list only',
      },
    ]);
  });

  it('makes no compare call when the head did not move (reply only) and lists the PR without a range', async () => {
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [reviewedPR(1)], warnings: [] });
    mockFetchReviewedPRActivity.mockResolvedValue(
      activity({
        pr: { headSha: 'rev0000', state: 'open', author: AUTHOR },
        reviews: [userReview()],
        comments: [
          { id: 9, user: { login: AUTHOR }, body: 'Done, the helper is split now.', created_at: iso(HOUR_MS) },
        ],
      }),
    );

    const result = await executeDailyCheck('test-token');

    expect(mockFetchCompareStatus).not.toHaveBeenCalled();
    expect(result.reviewedPRs?.map((e) => [e.authorComments, e.commits, e.compareRange, e.rebased])).toEqual([
      [1, [], undefined, false],
    ]);
  });

  it('lists nothing (no key, no menu item) when nothing happened after the review', async () => {
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [reviewedPR(1)], warnings: [] });
    const quiet = activity({ reviews: [userReview()], commits: [authorCommit(iso(-HOUR_MS), 'old1')] });
    mockFetchReviewedPRActivity.mockResolvedValue(quiet);

    const result = await executeDailyCheck('test-token');

    expect(result.reviewedPRs).toBeUndefined();
    expect(menuItem(result)).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('reviewedPRs');
    expect(mockFetchCompareStatus).not.toHaveBeenCalled();
  });

  it('leaves capacity, needsAddressingPRs and actionable issues untouched by reviewed PRs', async () => {
    const own = makeFetchedPR({ repo: 'org/other', number: 50, status: 'waiting_on_maintainer' });
    mockFetchUserOpenPRs.mockResolvedValue({ prs: [own], failures: [] });
    mockGenerateDigest.mockReturnValue({ ...makeDigest(), openPRs: [own], waitingOnMaintainerPRs: [own] });
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [reviewedPR(1), reviewedPR(2), reviewedPR(3)], warnings: [] });
    mockFetchReviewedPRActivity.mockResolvedValue(pushedAndReplied());

    const result = await executeDailyCheck('test-token');

    expect(result.reviewedPRs).toHaveLength(3);
    expect(result.capacity.activePRCount).toBe(1);
    expect(result.capacity.criticalIssueCount).toBe(0);
    expect(result.capacity.hasCapacity).toBe(true);
    expect(result.digest.needsAddressingPRs).toEqual([]);
    expect(result.digest.openPRs.map((pr) => pr.url)).toEqual([own.url]);
    expect(result.actionableIssues).toEqual([]);
    expect(result.attention.needsAttention).toBe(0);
    expect(result.actionMenu.context).toMatchObject({
      hasActionableIssues: false,
      actionableCount: 0,
      hasCapacity: true,
    });
    expect(menuItem(result)?.label).toBe('Review follow-ups (3)');
  });
});

describe('executeDailyCheck() — review follow-ups: dismissal and skips (#1857)', () => {
  it('skips a PR dismissed at or after its search update before any per-PR call', async () => {
    const pr = reviewedPR(1);
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [pr], warnings: [] });
    mockGetIssueDismissedAt.mockImplementation((url) => (url === pr.url ? pr.updatedAt : undefined));

    const result = await executeDailyCheck('test-token');

    expect(mockFetchReviewedPRActivity).not.toHaveBeenCalled();
    expect(result.reviewedPRs).toBeUndefined();
  });

  it('skips a PR dismissed at or after its newest qualifying activity, and lists one dismissed before it', async () => {
    const pr = reviewedPR(1, { updatedAt: iso(3 * HOUR_MS) });
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [pr], warnings: [] });
    mockFetchReviewedPRActivity.mockResolvedValue(pushedAndReplied());

    mockGetIssueDismissedAt.mockImplementation((url) => (url === pr.url ? iso(2 * HOUR_MS) : undefined));
    const dismissedAfter = await executeDailyCheck('test-token');
    expect(dismissedAfter.reviewedPRs).toBeUndefined();
    expect(mockFetchCompareStatus).not.toHaveBeenCalled();

    mockGetIssueDismissedAt.mockImplementation((url) => (url === pr.url ? iso(HOUR_MS + 1000) : undefined));
    const dismissedBefore = await executeDailyCheck('test-token');
    expect(dismissedBefore.reviewedPRs).toHaveLength(1);
  });

  it('enriches at most the per-run cap, most recently updated first, and warns how many were left', async () => {
    const prs = Array.from({ length: REVIEWED_PR_MAX_PER_RUN + 2 }, (_, i) => reviewedPR(i + 1));
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs, warnings: [] });
    mockFetchReviewedPRActivity.mockResolvedValue(pushedAndReplied());

    const result = await executeDailyCheck('test-token');

    expect(mockFetchReviewedPRActivity).toHaveBeenCalledTimes(REVIEWED_PR_MAX_PER_RUN);
    expect(mockFetchReviewedPRActivity).not.toHaveBeenCalledWith(prs[REVIEWED_PR_MAX_PER_RUN].url);
    expect(result.reviewedPRs).toHaveLength(REVIEWED_PR_MAX_PER_RUN);
    expect(phaseWarnings(result)).toEqual([
      {
        phase: 'reviewed-prs',
        operation: 'review follow-ups',
        message: `2 reviewed PR(s) beyond the per-run cap of ${REVIEWED_PR_MAX_PER_RUN} were not checked (the least recently updated); dismiss or re-review stale ones to make room`,
      },
    ]);
  });

  it('skips the phase with one warning when no GitHub username is configured', async () => {
    mockGetState.mockReturnValue(makeDefaultState({ githubUsername: '' }));

    const result = await executeDailyCheck('test-token');

    expect(mockFetchReviewedOpenPRs).not.toHaveBeenCalled();
    expect(phaseWarnings(result)).toEqual([
      { phase: 'reviewed-prs', operation: 'review follow-ups', message: 'skipped: no GitHub username configured' },
    ]);
  });
});

describe('executeDailyCheck() — review follow-ups: failures (#1857)', () => {
  it('drops a PR that is gone (404) with a warning naming it and the status, keeping the others', async () => {
    const gone = reviewedPR(1);
    const fine = reviewedPR(2);
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [gone, fine], warnings: [] });
    mockFetchReviewedPRActivity.mockImplementation((prUrl) =>
      prUrl === gone.url ? Promise.reject(httpError(404, 'Not Found')) : Promise.resolve(pushedAndReplied()),
    );

    const result = await executeDailyCheck('test-token');

    expect(result.reviewedPRs?.map((e) => e.prUrl)).toEqual([fine.url]);
    expect(phaseWarnings(result)).toEqual([
      {
        phase: 'reviewed-prs',
        operation: `fetch activity on ${gone.url}`,
        message: 'PR no longer reachable (HTTP 404); dropped',
      },
    ]);
  });

  it('drops a PR on any other API error with the HTTP status in the warning', async () => {
    const pr = reviewedPR(1);
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [pr], warnings: [] });
    mockFetchReviewedPRActivity.mockRejectedValue(httpError(502, 'Bad Gateway'));

    const result = await executeDailyCheck('test-token');

    expect(result.reviewedPRs).toBeUndefined();
    expect(phaseWarnings(result)).toEqual([
      { phase: 'reviewed-prs', operation: `fetch activity on ${pr.url}`, message: 'HTTP 502: Bad Gateway; dropped' },
    ]);
  });

  it('drops a PR whose activity lists were truncated, naming the lists', async () => {
    const capped = reviewedPR(1);
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [capped], warnings: [] });
    mockFetchReviewedPRActivity.mockResolvedValue({ ...pushedAndReplied(), truncatedLists: ['reviews', 'commits'] });

    const result = await executeDailyCheck('test-token');

    expect(result.reviewedPRs).toBeUndefined();
    expect(phaseWarnings(result)).toEqual([
      {
        phase: 'reviewed-prs',
        operation: `fetch activity on ${capped.url}`,
        message:
          'pagination cap reached on reviews, commits; the newest activity (including any re-review of yours) may be missing; dropped',
      },
    ]);
  });

  it('drops a PR whose thread could not be read, with a warning, and keeps the others', async () => {
    const broken = reviewedPR(1);
    const fine = reviewedPR(2);
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [broken, fine], warnings: [] });
    const poisoned = pushedAndReplied();
    Object.defineProperty(poisoned, 'comments', {
      get() {
        throw new TypeError('comments is not iterable');
      },
    });
    mockFetchReviewedPRActivity.mockImplementation((prUrl) =>
      Promise.resolve(prUrl === broken.url ? poisoned : pushedAndReplied()),
    );

    const result = await executeDailyCheck('test-token');

    expect(result.reviewedPRs?.map((e) => e.prUrl)).toEqual([fine.url]);
    expect(phaseWarnings(result)).toEqual([
      {
        phase: 'reviewed-prs',
        operation: `read activity on ${broken.url}`,
        message: 'comments is not iterable; dropped',
      },
    ]);
  });

  it('surfaces the search cap warning and still lists what was read', async () => {
    const message =
      'GitHub Search API reports 1500 open PRs you reviewed (not authored), but only the 300 most recently updated were read';
    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [reviewedPR(1)], warnings: [message] });
    mockFetchReviewedPRActivity.mockResolvedValue(pushedAndReplied());

    const result = await executeDailyCheck('test-token');

    expect(result.reviewedPRs).toHaveLength(1);
    expect(phaseWarnings(result)).toEqual([
      { phase: 'reviewed-prs', operation: 'search reviewed PRs (truncated)', message },
    ]);
  });

  it('skips the phase with one warning when the search itself fails, and the rest of the run completes', async () => {
    mockFetchReviewedOpenPRs.mockRejectedValue(httpError(503, 'Service Unavailable'));

    const result = await executeDailyCheck('test-token');

    expect(result.reviewedPRs).toBeUndefined();
    expect(result.digest).toBeDefined();
    expect(phaseWarnings(result)).toEqual([
      { phase: 'reviewed-prs', operation: 'prepare review follow-ups', message: 'Service Unavailable' },
    ]);
  });

  it('rejects the whole run on a rate-limit error from the search, the activity fetch, or the compare', async () => {
    mockFetchReviewedOpenPRs.mockRejectedValue(httpError(429, 'API rate limit exceeded'));
    await expect(executeDailyCheck('test-token')).rejects.toMatchObject({ status: 429 });

    mockFetchReviewedOpenPRs.mockResolvedValue({ prs: [reviewedPR(1)], warnings: [] });
    mockFetchReviewedPRActivity.mockRejectedValue(httpError(429, 'API rate limit exceeded'));
    await expect(executeDailyCheck('test-token')).rejects.toMatchObject({ status: 429 });

    mockFetchReviewedPRActivity.mockResolvedValue(pushedAndReplied());
    mockFetchCompareStatus.mockRejectedValue(httpError(429, 'API rate limit exceeded'));
    await expect(executeDailyCheck('test-token')).rejects.toMatchObject({ status: 429 });
  });
});
