/**
 * executeDailyCheck() Phase 3.7: maintainer notes on recently merged PRs
 * (#1861). Same harness shape as daily-orchestration.test.ts (which is past
 * the file-size lint ceiling), trimmed to the mocks this phase touches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DailyDigest, MergedPR } from '../core/types.js';
import type { MergedPRActivity, MergedPRActivityList } from '../core/merged-pr-notes.js';
import { wrapUntrustedContent } from '../core/untrusted-content.js';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any import of the mocked modules
// ---------------------------------------------------------------------------

type ActivityResult = MergedPRActivity & { truncatedLists: MergedPRActivityList[] };

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

function userReply(createdAt: string, body = 'Thank you!') {
  return { body, user: { login: USER }, author_association: 'CONTRIBUTOR', created_at: createdAt };
}

function activity(
  overrides: Partial<MergedPRActivity> = {},
  truncatedLists: MergedPRActivityList[] = [],
): ActivityResult {
  return { comments: [], reviews: [], reviewComments: [], commits: [], truncatedLists, ...overrides };
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
    const reply = userReply(iso(2000));
    mockFetchMergedPRActivity.mockResolvedValue(activity({ comments: [thanks(), reply] }));

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
});

describe('executeDailyCheck() — merged-PR notes: thanks-only grouping per repo (#1861)', () => {
  const older = mergedPR(1, { mergedAt: iso(-DAY_MS) });
  const newer = mergedPR(2);
  const elsewhere = mergedPR(3, { url: 'https://github.com/org/other/pull/3', repo: 'org/other' });
  const olderNoteAt = iso(1000, Date.parse(older.mergedAt));
  /** The user's group acknowledgment, posted on the carrier after its thanks. */
  const ackOnCarrier = activity({ comments: [thanks('Thanks!'), userReply(iso(5000), 'Glad these landed!')] });

  beforeEach(() => {
    mockFetchRecentlyMergedPRs.mockResolvedValue([older, newer, elsewhere]);
    mockFetchMergedPRActivity.mockImplementation((prUrl) => {
      const noteAt = prUrl === older.url ? olderNoteAt : NOTE_AT;
      return Promise.resolve(activity({ comments: [thanks('Thanks!', noteAt)] }));
    });
  });

  it('collapses several thanks-only PRs in one repo onto the most recent one and counts one action for the group', async () => {
    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes?.map((e) => [e.prUrl, e.ackCoveredBy])).toEqual([
      [older.url, newer.url],
      [newer.url, undefined],
      [elsewhere.url, undefined],
    ]);
    // Two things to do: one ack for org/repo (covering both PRs), one for org/other.
    expect(menuItem(result)?.label).toBe('Merged PRs with maintainer notes (2)');
  });

  it("stops listing the covered PR once the user's acknowledgment landed on the carrier (two runs)", async () => {
    const firstRun = await executeDailyCheck('test-token');
    expect(firstRun.mergedPRNotes?.map((e) => e.prUrl)).toEqual([older.url, newer.url, elsewhere.url]);

    // The user posts the group ack on the carrier (the newer PR) only.
    mockFetchMergedPRActivity.mockImplementation((prUrl) => {
      if (prUrl === newer.url) return Promise.resolve(ackOnCarrier);
      const noteAt = prUrl === older.url ? olderNoteAt : NOTE_AT;
      return Promise.resolve(activity({ comments: [thanks('Thanks!', noteAt)] }));
    });
    const secondRun = await executeDailyCheck('test-token');

    expect(secondRun.mergedPRNotes?.map((e) => e.prUrl)).toEqual([elsewhere.url]);
    expect(menuItem(secondRun)?.label).toBe('Merged PR with maintainer notes (1)');
    expect(mockDismissIssue).not.toHaveBeenCalled();
  });

  it('does not let a reply on the carrier cover a substantive note or a thanks posted after that reply', async () => {
    const renamed = thanks('Thanks, I renamed the flag on the way in', olderNoteAt);
    const lateThanks = thanks('Thanks!', iso(10_000));
    mockFetchMergedPRActivity.mockImplementation((prUrl) => {
      if (prUrl === newer.url) return Promise.resolve(ackOnCarrier);
      // The older PR is not thanks-only: the maintainer changed something.
      return Promise.resolve(activity({ comments: [prUrl === older.url ? renamed : lateThanks] }));
    });
    mockFetchRecentlyMergedPRs.mockResolvedValue([older, newer, mergedPR(4, { mergedAt: iso(-2 * DAY_MS) })]);

    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes?.map((e) => [e.prUrl, e.thanksOnly, e.ackCoveredBy])).toEqual([
      [older.url, false, undefined],
      ['https://github.com/org/repo/pull/4', true, undefined],
    ]);
  });
});

describe('executeDailyCheck() — merged-PR notes: dismissal (#1861)', () => {
  const pr = mergedPR(1);

  beforeEach(() => {
    mockFetchRecentlyMergedPRs.mockResolvedValue([pr]);
    mockFetchMergedPRActivity.mockResolvedValue(activity({ comments: [thanks('Thanks!', NOTE_AT)] }));
  });

  it('skips a PR whose URL was dismissed at or after the newest note, and keeps one dismissed before it', async () => {
    mockGetIssueDismissedAt.mockImplementation((url) => (url === pr.url ? NOTE_AT : undefined));
    const dismissedAfter = await executeDailyCheck('test-token');
    expect(dismissedAfter.mergedPRNotes).toBeUndefined();

    const beforeNote = iso(0);
    mockGetIssueDismissedAt.mockImplementation((url) => (url === pr.url ? beforeNote : undefined));
    const dismissedBefore = await executeDailyCheck('test-token');
    expect(dismissedBefore.mergedPRNotes).toHaveLength(1);
    expect(mockDismissIssue).not.toHaveBeenCalled();
  });

  it('lists a PR dismissed between two notes (a newer note resurfaces it, with both notes)', async () => {
    const first = thanks('Thanks!', iso(1000));
    const second = thanks('And the follow-up is in as well', iso(10_000));
    mockFetchMergedPRActivity.mockResolvedValue(activity({ comments: [first, second] }));
    mockGetIssueDismissedAt.mockImplementation((url) => (url === pr.url ? iso(5000) : undefined));

    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes?.[0].notes.map((n) => n.createdAt)).toEqual([iso(1000), iso(10_000)]);
  });

  it('fails open on an unreadable dismiss timestamp: the PR is listed and the stamp is left alone', async () => {
    mockGetIssueDismissedAt.mockImplementation((url) => (url === pr.url ? 'not-a-date' : undefined));

    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes?.map((e) => e.prUrl)).toEqual([pr.url]);
    expect(notesWarnings(result)).toEqual([]);
  });
});

describe('executeDailyCheck() — merged-PR notes: failures and skips (#1861)', () => {
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

  it('drops a PR whose thread could not be read, with a warning, and keeps the others', async () => {
    const broken = mergedPR(1);
    const fine = mergedPR(2);
    mockFetchRecentlyMergedPRs.mockResolvedValue([broken, fine]);
    const poisoned = activity();
    Object.defineProperty(poisoned, 'comments', {
      get() {
        throw new TypeError('comments is not iterable');
      },
    });
    mockFetchMergedPRActivity.mockImplementation((prUrl) =>
      Promise.resolve(prUrl === broken.url ? poisoned : activity({ comments: [thanks()] })),
    );

    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes?.map((e) => e.prUrl)).toEqual([fine.url]);
    expect(notesWarnings(result)).toEqual([
      {
        phase: 'merged-pr-notes',
        operation: `read activity on ${broken.url}`,
        message: 'comments is not iterable; dropped',
      },
    ]);
  });

  it('rejects the whole run on a rate-limit error', async () => {
    mockFetchRecentlyMergedPRs.mockResolvedValue([mergedPR(1)]);
    mockFetchMergedPRActivity.mockRejectedValue(httpError(429, 'API rate limit exceeded'));

    await expect(executeDailyCheck('test-token')).rejects.toMatchObject({ status: 429 });
  });

  it('drops a PR whose activity lists were truncated, naming the lists in the warning', async () => {
    const capped = mergedPR(1);
    const fine = mergedPR(2);
    mockFetchRecentlyMergedPRs.mockResolvedValue([capped, fine]);
    mockFetchMergedPRActivity.mockImplementation((prUrl) =>
      Promise.resolve(activity({ comments: [thanks()] }, prUrl === capped.url ? ['comments', 'review comments'] : [])),
    );

    const result = await executeDailyCheck('test-token');

    expect(result.mergedPRNotes?.map((e) => e.prUrl)).toEqual([fine.url]);
    expect(notesWarnings(result)).toEqual([
      {
        phase: 'merged-pr-notes',
        operation: `fetch activity on ${capped.url}`,
        message:
          'pagination cap reached on comments, review comments; the newest activity (including any reply of yours) may be missing; dropped',
      },
    ]);
  });

  it('skips the phase with one warning and no activity calls when the recently-merged fetch fell back', async () => {
    mockFetchRecentlyMergedPRs.mockRejectedValue(new Error('search down'));

    const result = await executeDailyCheck('test-token');

    expect(mockFetchMergedPRActivity).not.toHaveBeenCalled();
    expect(result.mergedPRNotes).toBeUndefined();
    expect(notesWarnings(result)).toEqual([
      {
        phase: 'merged-pr-notes',
        operation: 'merged-PR maintainer notes',
        message: 'skipped: recently-merged fetch failed',
      },
    ]);
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
