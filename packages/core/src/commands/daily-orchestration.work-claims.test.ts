/**
 * executeDailyCheck(): live work claims in the output and the
 * collect_implementations menu item (#1856, #1852). Same harness shape as
 * daily-orchestration.merged-pr-notes.test.ts, trimmed to what this reads:
 * `state.workClaims` straight from the state manager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DailyDigest, WorkClaim } from '../core/types.js';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any import of the mocked modules
// ---------------------------------------------------------------------------

const mockFetchUserOpenPRs = vi.fn();
const mockFetchUserMergedPRCounts = vi.fn();
const mockFetchUserClosedPRCounts = vi.fn();
const mockFetchRepoMetadata = vi.fn();
const mockFetchRecentlyClosedPRs = vi.fn();
const mockFetchRecentlyMergedPRs = vi.fn();
const mockGenerateDigest = vi.fn();
const mockFetchCommentedIssues = vi.fn();

const mockGetState = vi.fn();
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
    fetchPRClosedBy = vi.fn();
    fetchMergedPRActivity = vi.fn();
    fetchReviewedOpenPRs = vi.fn().mockResolvedValue({ prs: [], warnings: [] });
    fetchReviewedPRActivity = vi.fn();
    fetchCompareStatus = vi.fn();
    generateDigest = mockGenerateDigest;
  }

  class MockIssueConversationMonitor {
    fetchCommentedIssues = mockFetchCommentedIssues;
    hasUserCommentSince = vi.fn().mockResolvedValue(false);
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
      setLastDigest: vi.fn(),
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
      getIssueDismissedAt: vi.fn(),
      getDismissedPRHead: vi.fn(),
      dismissIssue: vi.fn(),
      undismissIssue: vi.fn(),
      getStatusOverride: mockGetStatusOverride,
      getStateStaleness: vi.fn(() => null),
      getLoadRecovery: vi.fn(() => null),
      isGistMode: vi.fn(() => false),
      isGistDegraded: vi.fn(() => false),
      getGistHealth: vi.fn(() => ({ mode: 'local', degraded: null })),
      batch: (fn: () => void) => fn(),
      reloadIfChanged: vi.fn(() => false),
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
    reloadIfChanged: vi.fn(() => false),
  })),
}));

// Import AFTER all mocks are declared
import { executeDailyCheck } from './daily.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function iso(offsetMs: number): string {
  const date = new Date(NOW + offsetMs);
  return date.toISOString();
}

function claim(number: number, overrides: Partial<WorkClaim> = {}): WorkClaim {
  return {
    kind: 'implementation',
    url: `https://github.com/org/repo/issues/${number}`,
    session: 'air/20261102T110000-ab12',
    startedAt: iso(-HOUR_MS),
    expiresAt: iso(23 * HOUR_MS),
    status: 'running',
    worktree: `/work/wt/${number}`,
    ...overrides,
  };
}

function makeDigest(): DailyDigest {
  return {
    generatedAt: iso(0),
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

function makeState(workClaims: WorkClaim[]) {
  return {
    version: 4,
    activeIssues: [],
    mergedPRs: [],
    closedPRs: [],
    repoScores: {},
    config: {
      setupComplete: true,
      githubUsername: 'testuser',
      maxActivePRs: 10,
      languages: ['TypeScript'],
      labels: [],
      excludeRepos: [],
      trustedProjects: [],
      shelvedPRUrls: [],
      dismissedIssues: {},
    },
    lastRunAt: iso(-2 * HOUR_MS),
    workClaims,
  };
}

function emptyCounts() {
  return { repos: new Map(), monthlyCounts: {}, monthlyOpenedCounts: {}, dailyActivityCounts: {}, searchedPRs: [] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockFetchUserOpenPRs.mockResolvedValue({ prs: [], failures: [] });
  mockFetchUserMergedPRCounts.mockResolvedValue(emptyCounts());
  mockFetchUserClosedPRCounts.mockResolvedValue(emptyCounts());
  mockFetchRepoMetadata.mockResolvedValue(new Map());
  mockFetchRecentlyClosedPRs.mockResolvedValue([]);
  mockFetchRecentlyMergedPRs.mockResolvedValue([]);
  mockGenerateDigest.mockReturnValue(makeDigest());
  mockFetchCommentedIssues.mockResolvedValue({ issues: [], failures: [], warnings: [] });
  mockGetStatusOverride.mockReturnValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeDailyCheck() — work claims (#1856, #1852)', () => {
  it('lists the live claims, counts only finished implementations in the menu item, and leaves expired ones out', async () => {
    const running = claim(1);
    const finished = claim(2, { status: 'finished', finishedAt: iso(-10 * 60 * 1000) });
    const expired = claim(3, { status: 'finished', expiresAt: iso(-1) });
    mockGetState.mockReturnValue(makeState([running, finished, expired]));

    const result = await executeDailyCheck('test-token');

    expect(result.workClaims).toEqual([running, finished]);
    const item = result.actionMenu.items.find((i) => i.key === 'collect_implementations');
    expect(item?.label).toBe('Collect finished implementations (1)');
  });

  it('a pr claim is listed but never counted as collectable', async () => {
    const pr = claim(4, { kind: 'pr', url: 'https://github.com/org/repo/pull/4', worktree: undefined });
    mockGetState.mockReturnValue(makeState([pr]));

    const result = await executeDailyCheck('test-token');

    expect(result.workClaims).toEqual([pr]);
    expect(result.actionMenu.items.map((i) => i.key)).not.toContain('collect_implementations');
  });

  it('carries no workClaims key and no menu item when nothing live is claimed', async () => {
    const expired = claim(5, { expiresAt: iso(-HOUR_MS) });
    mockGetState.mockReturnValue(makeState([expired]));

    const result = await executeDailyCheck('test-token');

    expect('workClaims' in result).toBe(false);
    expect(result.actionMenu.items.map((i) => i.key)).not.toContain('collect_implementations');
  });
});
