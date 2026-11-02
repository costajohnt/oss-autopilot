/**
 * executeDailyCheck() Phase 3.7: maintainer notes on recently merged PRs
 * (#1861). Same harness shape as daily-orchestration.test.ts (which is past
 * the file-size lint ceiling), trimmed to the mocks this phase touches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DailyDigest, MergedPR } from '../core/types.js';
import type { MergedPRActivity } from '../core/merged-pr-notes.js';
import { wrapUntrustedContent } from '../core/untrusted-content.js';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any import of the mocked modules
// ---------------------------------------------------------------------------

type ActivityResult = MergedPRActivity & { truncated: boolean };

const mockFetchUserOpenPRs = vi.fn();
const mockFetchUserMergedPRCounts = vi.fn();
const mockFetchUserClosedPRCounts = vi.fn();
const mockFetchRepoMetadata = vi.fn();
const mockFetchRecentlyClosedPRs = vi.fn();
const mockFetchRecentlyMergedPRs = vi.fn();
const mockFetchPRClosedBy = vi.fn();
const mockFetchMergedPRActivity = vi.fn<(prUrl: string) => Promise<ActivityResult>>();
const mockGenerateDigest = vi.fn();
const mockFetchCommentedIssues = vi.fn();
const mockHasUserCommentSince = vi.fn();

const mockGetState = vi.fn();
const mockIsGistMode = vi.fn(() => false);
const mockSetLastDigest = vi.fn();
const mockReloadIfChanged = vi.fn(() => false);
const mockGetIssueDismissedAt = vi.fn<(url: string) => string | undefined>();
const mockDismissIssue = vi.fn();
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
      dismissIssue: mockDismissIssue,
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = 'testuser';
const MERGED_AT = '2026-06-02T12:00:00Z';
const MERGED_MS = Date.parse(MERGED_AT);
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(offsetMs: number, fromMs = MERGED_MS): string {
  const date = new Date(fromMs + offsetMs);
  return date.toISOString();
}

/** A second after the merge: the typical "merged, thanks!" timestamp. */
const NOTE_AT = iso(1000);

function mergedPR(number: number, overrides: Partial<MergedPR> = {}): MergedPR {
  return {
    number,
    url: `https://github.com/org/repo/pull/${number}`,
    repo: 'org/repo',
    title: `PR ${number}`,
    mergedAt: MERGED_AT,
    ...overrides,
  };
}

function thanks(body = 'Thanks for the PR!', createdAt = NOTE_AT) {
  return { body, user: { login: 'maintainer' }, author_association: 'MEMBER', created_at: createdAt };
}

function activity(overrides: Partial<MergedPRActivity> = {}, isTruncated = false): ActivityResult {
  return { comments: [], reviews: [], reviewComments: [], commits: [], truncated: isTruncated, ...overrides };
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

function notesWarnings(result: { warnings: Array<{ phase: string; operation: string; message: string }> }) {
  return result.warnings.filter((w) => w.phase === 'merged-pr-notes');
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function menuItem(result: Awaited<ReturnType<typeof executeDailyCheck>>) {
  return result.actionMenu.items.find((i) => i.key === 'merged_pr_notes');
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
  mockFetchMergedPRActivity.mockResolvedValue(activity());
  mockGenerateDigest.mockReturnValue(makeDigest());
  mockFetchCommentedIssues.mockResolvedValue({ issues: [], failures: [] });
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

describe('executeDailyCheck() — merged-PR maintainer notes (#1861)', () => {
  it('lists a merged PR whose last word is a maintainer thanks, fences the excerpt, and adds the menu item', async () => {
    const pr = mergedPR(1);
    mockFetchRecentlyMergedPRs.mockResolvedValue([pr]);
    mockFetchMergedPRActivity.mockResolvedValue(activity({ comments: [thanks('Thanks!')] }));

    const result = await executeDailyCheck('test-token');

    expect(mockFetchMergedPRActivity).toHaveBeenCalledWith(pr.url);
    const excerpt = wrapUntrustedContent('Thanks!', 'org/repo#1', { author: 'maintainer', source: 'pr-comment' });
    expect(result.mergedPRNotes).toEqual([
      {
        prUrl: pr.url,
        repo: 'org/repo',
        number: 1,
        title: 'PR 1',
        mergedAt: MERGED_AT,
        notes: [{ excerpt, author: 'maintainer', createdAt: NOTE_AT, kind: 'comment' }],
        maintainerCommits: 0,
        thanksOnly: true,
      },
    ]);
    expect(menuItem(result)?.label).toBe('Merged PR with maintainer notes (1)');
    expect(result.warnings).toEqual([]);
  });

  it('asks only once: nothing is listed after the user commented on the PR after the note', async () => {
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR(1)]);
    const userReply = {
      user: { login: USER },
      author_association: 'CONTRIBUTOR',
      body: 'Thank you!',
      created_at: iso(2000),
    };
    mockFetchMergedPRActivity.mockResolvedValue(activity({ comments: [thanks(), userReply] }));

    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes).toBeUndefined();
    expect(menuItem(result)).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('mergedPRNotes');
  });

  it('flags a maintainer commit pushed on top as a changed-what-shipped note', async () => {
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR(1)]);
    const userCommit = { author: { login: USER }, commit: { message: 'Fix', author: { date: iso(-2 * DAY_MS) } } };
    const maintainerCommit = {
      author: { login: 'maintainer' },
      commit: { message: 'Cover two more cases', author: { date: iso(-60 * 60 * 1000) } },
    };
    mockFetchMergedPRActivity.mockResolvedValue(
      activity({ commits: [userCommit, maintainerCommit], comments: [thanks('thank you')] }),
    );

    const result = await executeDailyCheck('test-token');

    const [entry] = result.mergedPRNotes ?? [];
    expect(entry.maintainerCommits).toBe(1);
    expect(entry.thanksOnly).toBe(false);
    expect(entry.notes.map((n) => n.kind)).toEqual(['commit', 'comment']);
    expect(entry.notes[0].excerpt).toBe(
      wrapUntrustedContent('Cover two more cases', 'org/repo#1', { author: 'maintainer', source: 'pr-commit' }),
    );
  });

  it('collapses several thanks-only PRs in one repo onto the most recent one', async () => {
    const older = mergedPR(1, { mergedAt: iso(-DAY_MS) });
    const newer = mergedPR(2);
    const elsewhere = mergedPR(3, { url: 'https://github.com/org/other/pull/3', repo: 'org/other' });
    mockFetchRecentlyMergedPRs.mockResolvedValue([older, newer, elsewhere]);
    const olderNoteAt = iso(1000, Date.parse(older.mergedAt));
    mockFetchMergedPRActivity.mockImplementation((prUrl) => {
      const noteAt = prUrl === older.url ? olderNoteAt : NOTE_AT;
      return Promise.resolve(activity({ comments: [thanks('Thanks!', noteAt)] }));
    });

    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes?.map((e) => [e.prUrl, e.ackCoveredBy])).toEqual([
      [older.url, newer.url],
      [newer.url, undefined],
      [elsewhere.url, undefined],
    ]);
    expect(menuItem(result)?.label).toBe('Merged PRs with maintainer notes (3)');
  });

  it('skips a PR whose URL was dismissed at or after the newest note, and keeps one dismissed before it', async () => {
    const pr = mergedPR(1);
    mockFetchRecentlyMergedPRs.mockResolvedValue([pr]);
    mockFetchMergedPRActivity.mockResolvedValue(activity({ comments: [thanks('Thanks!', NOTE_AT)] }));

    mockGetIssueDismissedAt.mockImplementation((url) => (url === pr.url ? NOTE_AT : undefined));
    const dismissedAfter = await executeDailyCheck('test-token');
    expect(dismissedAfter.mergedPRNotes).toBeUndefined();

    const beforeNote = iso(0);
    mockGetIssueDismissedAt.mockImplementation((url) => (url === pr.url ? beforeNote : undefined));
    const dismissedBefore = await executeDailyCheck('test-token');
    expect(dismissedBefore.mergedPRNotes).toHaveLength(1);
    expect(mockDismissIssue).not.toHaveBeenCalled();
  });

  it('drops a PR that is gone (404) with a warning naming it and the status, keeping the others', async () => {
    const gone = mergedPR(1);
    const fine = mergedPR(2);
    mockFetchRecentlyMergedPRs.mockResolvedValue([gone, fine]);
    const notFound = httpError(404, 'Not Found');
    mockFetchMergedPRActivity.mockImplementation((prUrl) =>
      prUrl === gone.url ? Promise.reject(notFound) : Promise.resolve(activity({ comments: [thanks()] })),
    );

    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes?.map((e) => e.prUrl)).toEqual([fine.url]);
    expect(notesWarnings(result)).toEqual([
      {
        phase: 'merged-pr-notes',
        operation: `fetch activity on ${gone.url}`,
        message: 'PR no longer reachable (HTTP 404); dropped',
      },
    ]);
  });

  it('drops a PR on any other API error with the HTTP status in the warning', async () => {
    const pr = mergedPR(1);
    mockFetchRecentlyMergedPRs.mockResolvedValue([pr]);
    mockFetchMergedPRActivity.mockRejectedValue(httpError(502, 'Bad Gateway'));

    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes).toBeUndefined();
    expect(notesWarnings(result)).toEqual([
      { phase: 'merged-pr-notes', operation: `fetch activity on ${pr.url}`, message: 'HTTP 502: Bad Gateway; dropped' },
    ]);
  });

  it('rejects the whole run on a rate-limit error', async () => {
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR(1)]);
    mockFetchMergedPRActivity.mockRejectedValue(httpError(429, 'API rate limit exceeded'));

    await expect(executeDailyCheck('test-token')).rejects.toMatchObject({ status: 429 });
  });

  it('warns when the activity lists were truncated but still reports the notes it saw', async () => {
    const pr = mergedPR(1);
    mockFetchRecentlyMergedPRs.mockResolvedValue([pr]);
    mockFetchMergedPRActivity.mockResolvedValue(activity({ comments: [thanks()] }, true));

    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes).toHaveLength(1);
    expect(notesWarnings(result)).toEqual([
      {
        phase: 'merged-pr-notes',
        operation: `fetch activity on ${pr.url}`,
        message: 'pagination cap reached; the newest notes may be missing',
      },
    ]);
  });

  it('makes no activity calls when the recently-merged fetch fell back to an empty list', async () => {
    mockFetchRecentlyMergedPRs.mockRejectedValue(new Error('search down'));

    const result = await executeDailyCheck('test-token');

    expect(mockFetchMergedPRActivity).not.toHaveBeenCalled();
    expect(result.mergedPRNotes).toBeUndefined();
    expect(notesWarnings(result)).toEqual([]);
  });

  it('skips the phase with one warning when no GitHub username is configured', async () => {
    mockGetState.mockReturnValue(makeDefaultState({ githubUsername: '' }));
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR(1)]);

    const result = await executeDailyCheck('test-token');

    expect(mockFetchMergedPRActivity).not.toHaveBeenCalled();
    expect(notesWarnings(result)).toEqual([
      {
        phase: 'merged-pr-notes',
        operation: 'merged-PR maintainer notes',
        message: 'skipped: no GitHub username configured',
      },
    ]);
  });
});
