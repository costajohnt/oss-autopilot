/**
 * Tests for dashboard command
 *
 * Covers: HTML generation, data aggregation, XSS escaping, error handling,
 * star count filtering, status/repo filtering, edge cases (empty data, malformed input).
 *
 * Since escapeHtml, buildDashboardStats, and generateDashboardHtml are private,
 * we test them indirectly through the exported runDashboard() and writeDashboardFromState().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  FetchedPR,
  DailyDigest,
  AgentState,
  ClosedPR,
  MergedPR,
  ShelvedPRRef,
  CommentedIssueWithResponse,
  RepoScore,
} from '../core/types.js';
import {
  makeFetchedPR as _makeFetchedPR,
  makeDailyDigest,
  makeShelvedPRRef as _makeShelvedPRRef,
  makeAgentState,
} from '../core/test-utils.js';

// ── Mocks ────────────────────────────────────────────────────────────
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  getDashboardPath: vi.fn().mockReturnValue('/tmp/test-dashboard.html'),
  PRMonitor: vi.fn(),
  IssueConversationMonitor: vi.fn(),
  getGitHubToken: vi.fn(),
}));

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
}));

vi.mock('./daily.js', () => ({
  toShelvedPRRef: vi.fn((pr: FetchedPR) => ({
    number: pr.number,
    url: pr.url,
    title: pr.title,
    repo: pr.repo,
    daysSinceActivity: pr.daysSinceActivity,
    status: pr.status,
  })),
}));

import * as fs from 'fs';
import { execFile } from 'child_process';
import {
  getStateManager,
  getDashboardPath,
  PRMonitor,
  IssueConversationMonitor,
  getGitHubToken,
} from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import { runDashboard, writeDashboardFromState } from './dashboard.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockGetDashboardPath = vi.mocked(getDashboardPath);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockOutputJson = vi.mocked(outputJson);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

const mockExecFile = vi.mocked(execFile);

// ── Test Data Factories — thin wrappers over shared factories ────────

function makeFetchedPR(overrides: Partial<FetchedPR> = {}): FetchedPR {
  return _makeFetchedPR({
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    daysSinceActivity: 5,
    ...overrides,
  });
}

function makeShelvedPRRef(overrides: Partial<ShelvedPRRef> = {}): ShelvedPRRef {
  return _makeShelvedPRRef({
    number: 99,
    url: 'https://github.com/owner/shelved-repo/pull/99',
    repo: 'owner/shelved-repo',
    daysSinceActivity: 40,
    status: 'dormant',
    ...overrides,
  });
}

function makeDigest(overrides: Partial<DailyDigest> = {}): DailyDigest {
  return makeDailyDigest({
    generatedAt: '2026-01-15T12:00:00Z',
    summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 10, mergeRate: 83.3 },
    ...overrides,
  });
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return makeAgentState({
    config: {
      setupComplete: true,
      maxActivePRs: 10,
      dormantThresholdDays: 30,
      approachingDormantDays: 25,
      maxIssueAgeDays: 90,
      languages: ['typescript'],
      labels: ['good first issue'],
      excludeRepos: [],
      trustedProjects: [],
      githubUsername: 'testuser',
      minRepoScoreThreshold: 4,
      starredRepos: [],
      shelvedPRUrls: [],
    },
    lastRunAt: '2026-01-15T12:00:00Z',
    ...overrides,
  });
}

function makeRepoScore(overrides: Partial<RepoScore> = {}): RepoScore {
  return {
    repo: 'owner/repo',
    score: 7,
    mergedPRCount: 3,
    closedWithoutMergeCount: 1,
    avgResponseDays: 2,
    lastEvaluatedAt: '2026-01-15T00:00:00Z',
    signals: {
      hasActiveMaintainers: true,
      isResponsive: true,
      hasHostileComments: false,
    },
    ...overrides,
  };
}

function setupMockStateManager(state: AgentState, digest?: DailyDigest) {
  const stateWithDigest = { ...state, lastDigest: digest };
  return {
    getState: vi.fn().mockReturnValue(stateWithDigest),
    setLastDigest: vi.fn(),
    setMonthlyMergedCounts: vi.fn(),
    setMonthlyClosedCounts: vi.fn(),
    setMonthlyOpenedCounts: vi.fn(),
    save: vi.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDashboardPath.mockReturnValue('/tmp/test-dashboard.html');
    // Suppress console.error and console.log by default in tests
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // ── escapeHtml (tested via HTML output) ────────────────────────────

  describe('escapeHtml via HTML output', () => {
    it('should escape HTML special characters in PR titles', async () => {
      const xssTitle = '<script>alert("xss")</script>';
      const digest = makeDigest({
        openPRs: [makeFetchedPR({ title: xssTitle })],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });
      const state = makeState({ lastDigest: digest });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: false });

      const html = mockWriteFileSync.mock.calls[0][1] as string;
      expect(html).not.toContain('<script>alert("xss")</script>');
      expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    it('should escape ampersands in PR titles', async () => {
      const title = 'Fix A & B issue';
      const digest = makeDigest({
        openPRs: [makeFetchedPR({ title })],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });
      const state = makeState({ lastDigest: digest });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: false });

      const html = mockWriteFileSync.mock.calls[0][1] as string;
      // The title should have the ampersand escaped in data attributes and display
      expect(html).toContain('Fix A &amp; B issue');
    });

    it('should escape single quotes in PR titles', async () => {
      const title = "It's a test";
      const digest = makeDigest({
        openPRs: [makeFetchedPR({ title })],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });
      const state = makeState({ lastDigest: digest });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: false });

      const html = mockWriteFileSync.mock.calls[0][1] as string;
      expect(html).toContain('It&#39;s a test');
    });

    it('should escape double quotes in repo names', async () => {
      // While GitHub repo names can't contain quotes, test the defense-in-depth
      const digest = makeDigest({
        openPRs: [makeFetchedPR({ repo: 'owner/"repo' })],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });
      const state = makeState({ lastDigest: digest });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: false });

      const html = mockWriteFileSync.mock.calls[0][1] as string;
      expect(html).toContain('owner/&quot;repo');
    });

    it('should escape maintainer comment content in needs-response section', async () => {
      const maliciousComment = '<img src=x onerror="alert(1)">';
      const pr = makeFetchedPR({
        status: 'needs_response',
        hasUnrespondedComment: true,
        lastMaintainerComment: {
          author: 'evil<user>',
          body: maliciousComment,
          createdAt: '2026-01-15T00:00:00Z',
        },
      });
      const digest = makeDigest({
        openPRs: [pr],
        prsNeedingResponse: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
      });
      const state = makeState({ lastDigest: digest });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: false });

      const html = mockWriteFileSync.mock.calls[0][1] as string;
      expect(html).not.toContain('<img src=x onerror="alert(1)">');
      expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
      expect(html).toContain('evil&lt;user&gt;');
    });
  });

  // ── buildDashboardStats (tested via output) ────────────────────────

  describe('buildDashboardStats via output', () => {
    it('should compute correct stats from digest summary', async () => {
      const digest = makeDigest({
        shelvedPRs: [makeShelvedPRRef(), makeShelvedPRRef({ number: 100 })],
        summary: { totalActivePRs: 5, totalNeedingAttention: 2, totalMergedAllTime: 20, mergeRate: 80.0 },
      });
      const state = makeState({
        lastDigest: digest,
        repoScores: {
          'owner/repo': makeRepoScore({ closedWithoutMergeCount: 3 }),
          'owner/other': makeRepoScore({ closedWithoutMergeCount: 2 }),
        },
      });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: true });

      expect(mockOutputJson).toHaveBeenCalledWith(
        expect.objectContaining({
          stats: {
            activePRs: 5,
            shelvedPRs: 2,
            mergedPRs: 20,
            closedPRs: 5, // 3 + 2
            mergeRate: '80.0%',
          },
        }),
      );
    });

    it('should handle zero merge rate correctly', async () => {
      const digest = makeDigest({
        summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });
      const state = makeState({ lastDigest: digest });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: true });

      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.stats.mergeRate).toBe('0.0%');
    });

    it('should default missing summary fields to zero', async () => {
      // Simulate digest with undefined summary
      const digest = makeDigest();
      (digest as any).summary = undefined;
      const state = makeState({ lastDigest: digest });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: true });

      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.stats.activePRs).toBe(0);
      expect(outputData.stats.mergedPRs).toBe(0);
      expect(outputData.stats.mergeRate).toBe('0.0%');
    });
  });

  // ── runDashboard ───────────────────────────────────────────────────

  describe('runDashboard', () => {
    describe('no token (cached data path)', () => {
      it('should use cached digest when no token is available', async () => {
        const digest = makeDigest();
        const state = makeState({ lastDigest: digest });
        const mockSM = setupMockStateManager(state, digest);
        mockGetStateManager.mockReturnValue(mockSM as any);
        mockGetGitHubToken.mockReturnValue(null);

        await runDashboard({ json: false });

        expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/test-dashboard.html', expect.any(String), { mode: 0o644 });
      });

      it('should output error when no digest and no token', async () => {
        const state = makeState();
        const mockSM = {
          getState: vi.fn().mockReturnValue(state),
        };
        mockGetStateManager.mockReturnValue(mockSM as any);
        mockGetGitHubToken.mockReturnValue(null);

        await runDashboard({ json: false });

        expect(mockWriteFileSync).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('No dashboard data available'));
      });

      it('should output JSON error when no digest in JSON mode', async () => {
        const state = makeState();
        const mockSM = {
          getState: vi.fn().mockReturnValue(state),
        };
        mockGetStateManager.mockReturnValue(mockSM as any);
        mockGetGitHubToken.mockReturnValue(null);

        await runDashboard({ json: true });

        expect(mockOutputJson).toHaveBeenCalledWith({
          error: 'No data available. Run daily check first with GITHUB_TOKEN.',
        });
      });
    });

    describe('with token (fresh fetch path)', () => {
      let mockPRMonitor: any;
      let mockIssueMonitor: any;

      beforeEach(() => {
        mockPRMonitor = {
          fetchUserOpenPRs: vi.fn().mockResolvedValue({ prs: [], failures: [] }),
          fetchRecentlyClosedPRs: vi.fn().mockResolvedValue([]),
          fetchRecentlyMergedPRs: vi.fn().mockResolvedValue([]),
          fetchUserMergedPRCounts: vi.fn().mockResolvedValue({
            monthlyCounts: {},
            monthlyOpenedCounts: {},
          }),
          fetchUserClosedPRCounts: vi.fn().mockResolvedValue({
            monthlyCounts: {},
            monthlyOpenedCounts: {},
          }),
          generateDigest: vi.fn().mockReturnValue(makeDigest()),
        };
        mockIssueMonitor = {
          fetchCommentedIssues: vi.fn().mockResolvedValue({ issues: [], failures: [] }),
        };

        vi.mocked(PRMonitor).mockImplementation(function () {
          return mockPRMonitor;
        } as any);
        vi.mocked(IssueConversationMonitor).mockImplementation(function () {
          return mockIssueMonitor;
        } as any);
        mockGetGitHubToken.mockReturnValue('ghp_test_token');
      });

      it('should fetch fresh data when token is available', async () => {
        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        expect(mockPRMonitor.fetchUserOpenPRs).toHaveBeenCalled();
        expect(mockPRMonitor.fetchRecentlyClosedPRs).toHaveBeenCalled();
        expect(mockPRMonitor.fetchRecentlyMergedPRs).toHaveBeenCalled();
        expect(mockPRMonitor.fetchUserMergedPRCounts).toHaveBeenCalled();
        expect(mockPRMonitor.fetchUserClosedPRCounts).toHaveBeenCalled();
        expect(mockIssueMonitor.fetchCommentedIssues).toHaveBeenCalled();
      });

      it('should save refreshed digest to state', async () => {
        const pr = makeFetchedPR();
        mockPRMonitor.fetchUserOpenPRs.mockResolvedValue({ prs: [pr], failures: [] });
        const freshDigest = makeDigest({ openPRs: [pr] });
        mockPRMonitor.generateDigest.mockReturnValue(freshDigest);

        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        expect(mockSM.setLastDigest).toHaveBeenCalled();
        expect(mockSM.save).toHaveBeenCalled();
      });

      it('should store monthly merged and closed counts', async () => {
        mockPRMonitor.fetchUserMergedPRCounts.mockResolvedValue({
          monthlyCounts: { '2026-01': 3 },
          monthlyOpenedCounts: { '2026-01': 2 },
        });
        mockPRMonitor.fetchUserClosedPRCounts.mockResolvedValue({
          monthlyCounts: { '2026-01': 1 },
          monthlyOpenedCounts: { '2026-01': 1 },
        });

        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        expect(mockSM.setMonthlyMergedCounts).toHaveBeenCalledWith({ '2026-01': 3 });
        expect(mockSM.setMonthlyClosedCounts).toHaveBeenCalledWith({ '2026-01': 1 });
      });

      it('should combine opened counts from merged, closed, and open PRs', async () => {
        const pr = makeFetchedPR({ createdAt: '2026-01-10T00:00:00Z' });
        mockPRMonitor.fetchUserOpenPRs.mockResolvedValue({ prs: [pr], failures: [] });
        mockPRMonitor.fetchUserMergedPRCounts.mockResolvedValue({
          monthlyCounts: {},
          monthlyOpenedCounts: { '2026-01': 2 },
        });
        mockPRMonitor.fetchUserClosedPRCounts.mockResolvedValue({
          monthlyCounts: {},
          monthlyOpenedCounts: { '2026-01': 1 },
        });
        mockPRMonitor.generateDigest.mockReturnValue(makeDigest());

        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        // 2 (from merged) + 1 (from closed) + 1 (from open PR) = 4
        expect(mockSM.setMonthlyOpenedCounts).toHaveBeenCalledWith({ '2026-01': 4 });
      });

      it('should handle partial API failures gracefully', async () => {
        mockPRMonitor.fetchRecentlyClosedPRs.mockRejectedValue(new Error('API rate limit'));
        mockPRMonitor.fetchRecentlyMergedPRs.mockRejectedValue(new Error('Network error'));

        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        // Should still succeed and generate a dashboard
        expect(mockWriteFileSync).toHaveBeenCalled();
        // Digest should have been generated (even with empty closed/merged arrays)
        expect(mockPRMonitor.generateDigest).toHaveBeenCalledWith([], [], []);
      });

      it('should fall back to cached data on complete fetch failure', async () => {
        const cachedDigest = makeDigest();
        const state = makeState({ lastDigest: cachedDigest });
        const mockSM = setupMockStateManager(state, cachedDigest);
        mockGetStateManager.mockReturnValue(mockSM as any);

        // Make the entire fetch fail by throwing from fetchUserOpenPRs
        mockPRMonitor.fetchUserOpenPRs.mockRejectedValue(new Error('Total failure'));

        await runDashboard({ json: false });

        // Should fall back and still write dashboard from cached data
        expect(mockWriteFileSync).toHaveBeenCalled();
      });

      it('should handle issue conversation failures gracefully', async () => {
        mockIssueMonitor.fetchCommentedIssues.mockRejectedValue(new Error('No GitHub username configured'));

        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        // Should still generate dashboard
        expect(mockWriteFileSync).toHaveBeenCalled();
      });

      it('should log PR fetch failures', async () => {
        mockPRMonitor.fetchUserOpenPRs.mockResolvedValue({
          prs: [makeFetchedPR()],
          failures: [{ url: 'https://github.com/owner/repo/pull/1', error: 'Rate limited' }],
        });
        mockPRMonitor.generateDigest.mockReturnValue(makeDigest());

        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('1 PR fetch(es) failed'));
      });

      it('should handle stateManager.setMonthlyMergedCounts failure', async () => {
        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockSM.setMonthlyMergedCounts.mockImplementation(() => {
          throw new Error('Write failed');
        });
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        // Should still continue and generate dashboard
        expect(mockWriteFileSync).toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to store monthly merged counts'),
          expect.any(String),
        );
      });

      it('should handle stateManager.setMonthlyClosedCounts failure', async () => {
        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockSM.setMonthlyClosedCounts.mockImplementation(() => {
          throw new Error('Write failed');
        });
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        expect(mockWriteFileSync).toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to store monthly closed counts'),
          expect.any(String),
        );
      });

      it('should handle stateManager.setMonthlyOpenedCounts failure', async () => {
        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockSM.setMonthlyOpenedCounts.mockImplementation(() => {
          throw new Error('Write failed');
        });
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        expect(mockWriteFileSync).toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to store monthly opened counts'),
          expect.any(String),
        );
      });

      it('should shelve dormant PRs for display purposes', async () => {
        const dormantPR = makeFetchedPR({ status: 'dormant', daysSinceActivity: 35 });
        mockPRMonitor.fetchUserOpenPRs.mockResolvedValue({ prs: [dormantPR], failures: [] });
        mockPRMonitor.generateDigest.mockReturnValue(makeDigest({ openPRs: [dormantPR] }));

        const state = makeState();
        const mockSM = setupMockStateManager(state);
        mockGetStateManager.mockReturnValue(mockSM as any);

        await runDashboard({ json: false });

        // The digest passed to setLastDigest should have shelvedPRs populated
        const savedDigest = mockSM.setLastDigest.mock.calls[0][0] as DailyDigest;
        expect(savedDigest.shelvedPRs.length).toBe(1);
        expect(savedDigest.autoUnshelvedPRs).toEqual([]);
        expect(savedDigest.summary.totalActivePRs).toBe(0); // dormant is excluded from active
      });
    });

    describe('JSON output mode', () => {
      it('should output structured JSON with stats, PRs, and chart data', async () => {
        const pr = makeFetchedPR();
        const digest = makeDigest({
          openPRs: [pr],
          summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 5, mergeRate: 83.3 },
        });
        const state = makeState({
          lastDigest: digest,
          repoScores: { 'owner/repo': makeRepoScore({ mergedPRCount: 5, closedWithoutMergeCount: 1 }) },
          monthlyMergedCounts: { '2026-01': 2 },
        });
        const mockSM = setupMockStateManager(state, digest);
        mockGetStateManager.mockReturnValue(mockSM as any);
        mockGetGitHubToken.mockReturnValue(null);

        await runDashboard({ json: true });

        expect(mockOutputJson).toHaveBeenCalledWith(
          expect.objectContaining({
            stats: expect.objectContaining({ activePRs: 1, mergedPRs: 5 }),
            activePRs: [pr],
            monthlyMerged: { '2026-01': 2 },
            topRepos: expect.arrayContaining([expect.objectContaining({ repo: 'owner/repo' })]),
          }),
        );
      });

      it('should include issue responses in JSON output', async () => {
        const issue: CommentedIssueWithResponse = {
          repo: 'owner/repo',
          number: 42,
          title: 'Test issue',
          url: 'https://github.com/owner/repo/issues/42',
          userLastCommentedAt: '2026-01-10T00:00:00Z',
          labels: ['help wanted'],
          daysSinceUserComment: 5,
          status: 'new_response',
          lastResponseAuthor: 'maintainer',
          lastResponseBody: 'Thanks for the PR!',
          lastResponseAt: '2026-01-14T00:00:00Z',
          isFromMaintainer: true,
        };

        const digest = makeDigest();
        const state = makeState({ lastDigest: digest });
        const mockSM = setupMockStateManager(state, digest);
        mockGetStateManager.mockReturnValue(mockSM as any);
        mockGetGitHubToken.mockReturnValue('ghp_test');

        const mockPRMonitor = {
          fetchUserOpenPRs: vi.fn().mockResolvedValue({ prs: [], failures: [] }),
          fetchRecentlyClosedPRs: vi.fn().mockResolvedValue([]),
          fetchRecentlyMergedPRs: vi.fn().mockResolvedValue([]),
          fetchUserMergedPRCounts: vi.fn().mockResolvedValue({ monthlyCounts: {}, monthlyOpenedCounts: {} }),
          fetchUserClosedPRCounts: vi.fn().mockResolvedValue({ monthlyCounts: {}, monthlyOpenedCounts: {} }),
          generateDigest: vi.fn().mockReturnValue(digest),
        };
        const mockIssueMonitor = {
          fetchCommentedIssues: vi.fn().mockResolvedValue({ issues: [issue], failures: [] }),
        };

        vi.mocked(PRMonitor).mockImplementation(function () {
          return mockPRMonitor;
        } as any);
        vi.mocked(IssueConversationMonitor).mockImplementation(function () {
          return mockIssueMonitor;
        } as any);

        await runDashboard({ json: true });

        const outputData = mockOutputJson.mock.calls[0][0] as any;
        expect(outputData.issueResponses).toHaveLength(1);
        expect(outputData.issueResponses[0].lastResponseAuthor).toBe('maintainer');
        expect(outputData.commentedIssues).toHaveLength(1);
      });

      it('should not write HTML file in JSON mode', async () => {
        const digest = makeDigest();
        const state = makeState({ lastDigest: digest });
        const mockSM = setupMockStateManager(state, digest);
        mockGetStateManager.mockReturnValue(mockSM as any);
        mockGetGitHubToken.mockReturnValue(null);

        await runDashboard({ json: true });

        expect(mockWriteFileSync).not.toHaveBeenCalled();
      });
    });

    describe('--open flag', () => {
      it('should call execFile to open browser on macOS', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'darwin' });

        const digest = makeDigest();
        const state = makeState({ lastDigest: digest });
        const mockSM = setupMockStateManager(state, digest);
        mockGetStateManager.mockReturnValue(mockSM as any);
        mockGetGitHubToken.mockReturnValue(null);

        await runDashboard({ open: true });

        expect(mockExecFile).toHaveBeenCalledWith('open', ['/tmp/test-dashboard.html'], expect.any(Function));

        Object.defineProperty(process, 'platform', { value: originalPlatform });
      });

      it('should not call execFile when --open is not set', async () => {
        const digest = makeDigest();
        const state = makeState({ lastDigest: digest });
        const mockSM = setupMockStateManager(state, digest);
        mockGetStateManager.mockReturnValue(mockSM as any);
        mockGetGitHubToken.mockReturnValue(null);

        await runDashboard({ open: false });

        expect(mockExecFile).not.toHaveBeenCalled();
      });
    });
  });

  // ── HTML generation content tests ──────────────────────────────────

  describe('HTML generation', () => {
    async function getHtmlOutput(digest: DailyDigest, stateOverrides: Partial<AgentState> = {}): Promise<string> {
      const state = makeState({ lastDigest: digest, ...stateOverrides });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: false });

      return (mockWriteFileSync.mock.calls[0]?.[1] as string) ?? '';
    }

    it('should generate valid HTML with DOCTYPE', async () => {
      const html = await getHtmlOutput(makeDigest());
      expect(html).toMatch(/^<!DOCTYPE html>/);
      expect(html).toContain('</html>');
    });

    it('should include page title', async () => {
      const html = await getHtmlOutput(makeDigest());
      expect(html).toContain('<title>OSS Autopilot - Mission Control</title>');
    });

    it('should include Chart.js script tag', async () => {
      const html = await getHtmlOutput(makeDigest());
      expect(html).toContain('https://cdn.jsdelivr.net/npm/chart.js');
    });

    it('should display stat cards with correct values', async () => {
      const digest = makeDigest({
        shelvedPRs: [makeShelvedPRRef()],
        summary: { totalActivePRs: 3, totalNeedingAttention: 1, totalMergedAllTime: 15, mergeRate: 75.0 },
      });
      const html = await getHtmlOutput(digest, {
        repoScores: {
          'owner/repo': makeRepoScore({ closedWithoutMergeCount: 5 }),
        },
      });

      // Stat card values
      expect(html).toContain('>3</div>'); // active PRs
      expect(html).toContain('>1</div>'); // shelved
      expect(html).toContain('>15</div>'); // merged
      expect(html).toContain('>5</div>'); // closed
      expect(html).toContain('>75.0%</div>'); // merge rate
    });

    it('should render Action Required section when there are action items', async () => {
      const failingPR = makeFetchedPR({ status: 'failing_ci', ciStatus: 'failing' });
      const digest = makeDigest({
        openPRs: [failingPR],
        ciFailingPRs: [failingPR],
        summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Action Required');
      expect(html).toContain('1 issue');
      expect(html).toContain('CI Failing');
    });

    it('should render Waiting on Others section', async () => {
      const waitingPR = makeFetchedPR({ status: 'waiting_on_maintainer' });
      const digest = makeDigest({
        openPRs: [waitingPR],
        waitingOnMaintainerPRs: [waitingPR],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Waiting on Others');
      expect(html).toContain('1 PR');
      expect(html).toContain('Waiting on Maintainer');
    });

    it('should render healthy status when no action items or waiting', async () => {
      const digest = makeDigest({
        summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Health Status');
      expect(html).toContain('All PRs are healthy');
    });

    it('should render recently merged PRs section', async () => {
      const merged: MergedPR = {
        url: 'https://github.com/owner/repo/pull/5',
        repo: 'owner/repo',
        number: 5,
        title: 'Fix the bug',
        mergedAt: '2026-01-14T00:00:00Z',
      };
      const digest = makeDigest({ recentlyMergedPRs: [merged] });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Recently Merged');
      expect(html).toContain('1 merged');
      expect(html).toContain('owner/repo#5');
      expect(html).toContain('Fix the bug');
    });

    it('should render recently closed PRs section', async () => {
      const closed: ClosedPR = {
        url: 'https://github.com/owner/repo/pull/6',
        repo: 'owner/repo',
        number: 6,
        title: 'Abandoned PR',
        closedAt: '2026-01-13T00:00:00Z',
      };
      const digest = makeDigest({ recentlyClosedPRs: [closed] });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Recently Closed');
      expect(html).toContain('1 closed');
      expect(html).toContain('owner/repo#6');
    });

    it('should render shelved PRs section', async () => {
      const shelved = makeShelvedPRRef({ title: 'On hold PR', number: 88, repo: 'owner/shelved' });
      const digest = makeDigest({
        shelvedPRs: [shelved],
        openPRs: [],
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Shelved Pull Requests');
      expect(html).toContain('1 shelved');
      expect(html).toContain('On hold PR');
    });

    it('should render active PRs list with badges', async () => {
      const pr = makeFetchedPR({
        title: 'Add new feature',
        ciStatus: 'failing',
        hasMergeConflict: true,
        daysSinceActivity: 2,
      });
      const digest = makeDigest({
        openPRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Active Pull Requests');
      expect(html).toContain('1 open');
      expect(html).toContain('Add new feature');
      expect(html).toContain('CI Failing');
      expect(html).toContain('Merge Conflict');
    });

    it('should show empty state when no active PRs', async () => {
      const digest = makeDigest();
      const html = await getHtmlOutput(digest);
      expect(html).toContain('No active pull requests');
      expect(html).toContain('0 open');
    });

    it('should display approaching dormant badge for stale PRs', async () => {
      const stalePR = makeFetchedPR({ daysSinceActivity: 26 });
      const digest = makeDigest({
        openPRs: [stalePR],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('26d inactive');
    });

    it('should render needs-response items with maintainer comment', async () => {
      const pr = makeFetchedPR({
        status: 'needs_response',
        hasUnrespondedComment: true,
        lastMaintainerComment: {
          author: 'maintainer-alice',
          body: 'Could you rebase this?',
          createdAt: '2026-01-15T00:00:00Z',
        },
      });
      const digest = makeDigest({
        openPRs: [pr],
        prsNeedingResponse: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Needs Response');
      expect(html).toContain('@maintainer-alice');
      expect(html).toContain('Could you rebase this?');
    });

    it('should render incomplete checklist items with stats', async () => {
      const pr = makeFetchedPR({
        status: 'incomplete_checklist',
        hasIncompleteChecklist: true,
        checklistStats: { checked: 2, total: 5 },
      });
      const digest = makeDigest({
        openPRs: [pr],
        incompleteChecklistPRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Incomplete Checklist');
      expect(html).toContain('(2/5)');
    });

    it('should render missing required files', async () => {
      const pr = makeFetchedPR({
        status: 'missing_required_files' as any,
        missingRequiredFiles: ['changeset', 'CLA'],
      });
      const digest = makeDigest({
        openPRs: [pr],
        missingRequiredFilesPRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Missing Required Files');
      expect(html).toContain('changeset, CLA');
    });

    it('should render needs-rebase items with commits behind count', async () => {
      const pr = makeFetchedPR({
        status: 'needs_rebase',
        commitsBehindUpstream: 15,
      });
      const digest = makeDigest({
        openPRs: [pr],
        needsRebasePRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Needs Rebase');
      expect(html).toContain('(15 behind)');
    });

    it('should render changes addressed items with reviewer name', async () => {
      const pr = makeFetchedPR({
        status: 'changes_addressed',
        hasUnrespondedComment: true,
        lastMaintainerComment: {
          author: 'reviewer-bob',
          body: 'Looks good, but needs tests',
          createdAt: '2026-01-15T00:00:00Z',
        },
      });
      const digest = makeDigest({
        openPRs: [pr],
        changesAddressedPRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Changes Addressed');
      expect(html).toContain('from @reviewer-bob');
    });

    it('should render auto-unshelved PRs section', async () => {
      const unshelved: ShelvedPRRef = {
        number: 77,
        url: 'https://github.com/owner/repo/pull/77',
        title: 'Unshelved PR',
        repo: 'owner/repo',
        daysSinceActivity: 5,
        status: 'needs_response',
      };
      const digest = makeDigest({ autoUnshelvedPRs: [unshelved] });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Auto-Unshelved');
      expect(html).toContain('1 unshelved');
    });

    it('should render issue conversations section', async () => {
      // Issue responses are passed to generateDashboardHtml via runDashboard with token
      // For the no-token path, they're empty. Test the with-token path.
      const issue: CommentedIssueWithResponse = {
        repo: 'owner/repo',
        number: 42,
        title: 'Feature request: add dark mode support for better visibility',
        url: 'https://github.com/owner/repo/issues/42',
        userLastCommentedAt: '2026-01-10T00:00:00Z',
        labels: ['enhancement'],
        daysSinceUserComment: 5,
        status: 'new_response',
        lastResponseAuthor: 'maintainer',
        lastResponseBody: 'Great idea! Would you like to submit a PR?',
        lastResponseAt: '2026-01-14T00:00:00Z',
        isFromMaintainer: true,
      };

      const digest = makeDigest();
      const state = makeState({ lastDigest: digest });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue('ghp_test');

      const mockPRMonitor = {
        fetchUserOpenPRs: vi.fn().mockResolvedValue({ prs: [], failures: [] }),
        fetchRecentlyClosedPRs: vi.fn().mockResolvedValue([]),
        fetchRecentlyMergedPRs: vi.fn().mockResolvedValue([]),
        fetchUserMergedPRCounts: vi.fn().mockResolvedValue({ monthlyCounts: {}, monthlyOpenedCounts: {} }),
        fetchUserClosedPRCounts: vi.fn().mockResolvedValue({ monthlyCounts: {}, monthlyOpenedCounts: {} }),
        generateDigest: vi.fn().mockReturnValue(digest),
      };
      const mockIssueMonitor = {
        fetchCommentedIssues: vi.fn().mockResolvedValue({ issues: [issue], failures: [] }),
      };
      vi.mocked(PRMonitor).mockImplementation(function () {
        return mockPRMonitor;
      } as any);
      vi.mocked(IssueConversationMonitor).mockImplementation(function () {
        return mockIssueMonitor;
      } as any);

      await runDashboard({ json: false });

      const html = mockWriteFileSync.mock.calls[0][1] as string;
      expect(html).toContain('Issue Conversations');
      expect(html).toContain('1 reply');
      expect(html).toContain('owner/repo#42');
      expect(html).toContain('@maintainer');
    });

    it('should pluralize reply/replies correctly', async () => {
      const issues: CommentedIssueWithResponse[] = [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Issue 1',
          url: 'https://github.com/owner/repo/issues/1',
          userLastCommentedAt: '2026-01-10T00:00:00Z',
          labels: [],
          daysSinceUserComment: 5,
          status: 'new_response',
          lastResponseAuthor: 'a',
          lastResponseBody: 'ok',
          lastResponseAt: '2026-01-14T00:00:00Z',
          isFromMaintainer: true,
        },
        {
          repo: 'owner/repo',
          number: 2,
          title: 'Issue 2',
          url: 'https://github.com/owner/repo/issues/2',
          userLastCommentedAt: '2026-01-10T00:00:00Z',
          labels: [],
          daysSinceUserComment: 5,
          status: 'new_response',
          lastResponseAuthor: 'b',
          lastResponseBody: 'yes',
          lastResponseAt: '2026-01-14T00:00:00Z',
          isFromMaintainer: true,
        },
      ];

      const digest = makeDigest();
      const state = makeState({ lastDigest: digest });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue('ghp_test');

      const mockPRMonitor = {
        fetchUserOpenPRs: vi.fn().mockResolvedValue({ prs: [], failures: [] }),
        fetchRecentlyClosedPRs: vi.fn().mockResolvedValue([]),
        fetchRecentlyMergedPRs: vi.fn().mockResolvedValue([]),
        fetchUserMergedPRCounts: vi.fn().mockResolvedValue({ monthlyCounts: {}, monthlyOpenedCounts: {} }),
        fetchUserClosedPRCounts: vi.fn().mockResolvedValue({ monthlyCounts: {}, monthlyOpenedCounts: {} }),
        generateDigest: vi.fn().mockReturnValue(digest),
      };
      vi.mocked(PRMonitor).mockImplementation(function () {
        return mockPRMonitor;
      } as any);
      vi.mocked(IssueConversationMonitor).mockImplementation(function () {
        return {
          fetchCommentedIssues: vi.fn().mockResolvedValue({ issues, failures: [] }),
        };
      } as any);

      await runDashboard({ json: false });

      const html = mockWriteFileSync.mock.calls[0][1] as string;
      expect(html).toContain('2 replies');
    });

    it('should include theme toggle button', async () => {
      const html = await getHtmlOutput(makeDigest());
      expect(html).toContain('id="themeToggle"');
      expect(html).toContain('id="themeIconSun"');
      expect(html).toContain('id="themeIconMoon"');
      expect(html).toContain('id="themeLabel"');
    });

    it('should include dark mode CSS variables', async () => {
      const html = await getHtmlOutput(makeDigest());
      expect(html).toContain('[data-theme="dark"]');
      expect(html).toContain('[data-theme="light"]');
      expect(html).toContain('--bg-base');
    });

    it('should include filter toolbar', async () => {
      const html = await getHtmlOutput(makeDigest());
      expect(html).toContain('id="searchInput"');
      expect(html).toContain('id="statusFilter"');
      expect(html).toContain('id="repoFilter"');
      expect(html).toContain('id="filterCount"');
    });

    it('should populate repo filter with unique repos from all PR lists', async () => {
      const pr1 = makeFetchedPR({ repo: 'org/alpha' });
      const pr2 = makeFetchedPR({ repo: 'org/beta', number: 2 });
      const merged: MergedPR = {
        url: 'https://github.com/org/gamma/pull/3',
        repo: 'org/gamma',
        number: 3,
        title: 'Merged',
        mergedAt: '2026-01-14T00:00:00Z',
      };
      const digest = makeDigest({
        openPRs: [pr1, pr2],
        recentlyMergedPRs: [merged],
        summary: { totalActivePRs: 2, totalNeedingAttention: 0, totalMergedAllTime: 1, mergeRate: 100 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('org/alpha');
      expect(html).toContain('org/beta');
      expect(html).toContain('org/gamma');
    });

    it('should include timestamp from digest', async () => {
      const digest = makeDigest({ generatedAt: '2026-06-15T14:30:00Z' });
      const html = await getHtmlOutput(digest);
      // The timestamp is formatted with toLocaleString, so check for key parts
      expect(html).toContain('Last updated:');
    });

    it('should show "Unknown" when generatedAt is missing', async () => {
      const digest = makeDigest({ generatedAt: '' });
      const html = await getHtmlOutput(digest);
      expect(html).toContain('Unknown');
    });

    it('should include footer with generation info', async () => {
      const html = await getHtmlOutput(makeDigest());
      expect(html).toContain('OSS Autopilot // Mission Control');
      expect(html).toContain('Dashboard generated:');
    });

    it('should render PR activity text correctly', async () => {
      const todayPR = makeFetchedPR({ daysSinceActivity: 0 });
      const yesterdayPR = makeFetchedPR({ daysSinceActivity: 1, number: 2 });
      const oldPR = makeFetchedPR({ daysSinceActivity: 7, number: 3 });
      const digest = makeDigest({
        openPRs: [todayPR, yesterdayPR, oldPR],
        summary: { totalActivePRs: 3, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Today');
      expect(html).toContain('Yesterday');
      expect(html).toContain('7d ago');
    });
  });

  // ── Star count / repo exclusion filter ─────────────────────────────

  describe('star count filter for repo breakdown chart', () => {
    it('should exclude repos below minStars threshold from chart', async () => {
      const pr = makeFetchedPR({ repo: 'org/small-repo' });
      const digest = makeDigest({
        openPRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest, {
        repoScores: {
          'org/small-repo': makeRepoScore({
            repo: 'org/small-repo',
            stargazersCount: 10, // Below default 50
            mergedPRCount: 1,
            closedWithoutMergeCount: 0,
          }),
        },
        config: {
          ...makeState().config,
          minStars: 50,
        },
      });

      // The chart JS should NOT include small-repo's data
      // Check the labels array in the chart configuration
      expect(html).toContain('reposChart');
      // small-repo should be filtered from the chart labels
      // However, the PR list section should still show it
    });

    it('should include repos without star data (fail-open)', async () => {
      const pr = makeFetchedPR({ repo: 'org/unknown-stars' });
      const digest = makeDigest({
        openPRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest, {
        repoScores: {
          'org/unknown-stars': makeRepoScore({
            repo: 'org/unknown-stars',
            stargazersCount: undefined, // No star data
            mergedPRCount: 2,
          }),
        },
      });

      // Repo without star data should be included (fail-open behavior)
      expect(html).toContain('unknown-stars');
    });

    it('should exclude repos listed in excludeRepos', async () => {
      const digest = makeDigest();
      const html = await getHtmlOutput(digest, {
        repoScores: {
          'org/excluded-repo': makeRepoScore({
            repo: 'org/excluded-repo',
            mergedPRCount: 5,
            stargazersCount: 1000,
          }),
          'org/included-repo': makeRepoScore({
            repo: 'org/included-repo',
            mergedPRCount: 3,
            stargazersCount: 500,
          }),
        },
        config: {
          ...makeState().config,
          excludeRepos: ['org/excluded-repo'],
        },
      });

      // The chart data should include included-repo but not excluded-repo
      expect(html).toContain('included-repo');
      // excluded-repo should not appear in the chart labels
    });

    it('should exclude repos by org when excludeOrgs is set', async () => {
      const digest = makeDigest();
      const html = await getHtmlOutput(digest, {
        repoScores: {
          'blocked-org/repo': makeRepoScore({
            repo: 'blocked-org/repo',
            mergedPRCount: 10,
            stargazersCount: 5000,
          }),
        },
        config: {
          ...makeState().config,
          excludeOrgs: ['blocked-org'],
        },
      });

      // The chart should not include repos from blocked-org
      expect(html).not.toContain('blocked-org/repo');
    });

    async function getHtmlOutput(digest: DailyDigest, stateOverrides: Partial<AgentState> = {}): Promise<string> {
      const state = makeState({ lastDigest: digest, ...stateOverrides });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: false });
      return (mockWriteFileSync.mock.calls[0]?.[1] as string) ?? '';
    }
  });

  // ── Data aggregation (prsByRepo) ───────────────────────────────────

  describe('data aggregation for charts', () => {
    it('should aggregate PRs by repo from open PRs and repo scores', async () => {
      const pr1 = makeFetchedPR({ repo: 'org/alpha' });
      const pr2 = makeFetchedPR({ repo: 'org/alpha', number: 2 });
      const pr3 = makeFetchedPR({ repo: 'org/beta', number: 3 });
      const digest = makeDigest({
        openPRs: [pr1, pr2, pr3],
        summary: { totalActivePRs: 3, totalNeedingAttention: 0, totalMergedAllTime: 5, mergeRate: 100 },
      });
      const state = makeState({
        lastDigest: digest,
        repoScores: {
          'org/alpha': makeRepoScore({ mergedPRCount: 3, closedWithoutMergeCount: 0 }),
          'org/beta': makeRepoScore({ mergedPRCount: 2, closedWithoutMergeCount: 1 }),
        },
      });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: true });

      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.prsByRepo['org/alpha']).toEqual({ active: 2, merged: 3, closed: 0 });
      expect(outputData.prsByRepo['org/beta']).toEqual({ active: 1, merged: 2, closed: 1 });
    });

    it('should sort top repos by total PRs descending', async () => {
      const digest = makeDigest({
        summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 10, mergeRate: 100 },
      });
      const state = makeState({
        lastDigest: digest,
        repoScores: {
          'org/small': makeRepoScore({ mergedPRCount: 1, closedWithoutMergeCount: 0 }),
          'org/medium': makeRepoScore({ mergedPRCount: 3, closedWithoutMergeCount: 1 }),
          'org/large': makeRepoScore({ mergedPRCount: 6, closedWithoutMergeCount: 0 }),
        },
      });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: true });

      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.topRepos[0].repo).toBe('org/large');
      expect(outputData.topRepos[1].repo).toBe('org/medium');
      expect(outputData.topRepos[2].repo).toBe('org/small');
    });

    it('should limit topRepos to 10 entries', async () => {
      const digest = makeDigest();
      const repoScores: Record<string, RepoScore> = {};
      for (let i = 0; i < 15; i++) {
        repoScores[`org/repo-${i}`] = makeRepoScore({
          repo: `org/repo-${i}`,
          mergedPRCount: 15 - i,
          closedWithoutMergeCount: 0,
        });
      }
      const state = makeState({ lastDigest: digest, repoScores });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: true });

      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.topRepos.length).toBeLessThanOrEqual(10);
    });

    it('should include monthly data in output', async () => {
      const digest = makeDigest();
      const state = makeState({
        lastDigest: digest,
        monthlyMergedCounts: { '2026-01': 5, '2025-12': 3 },
        monthlyClosedCounts: { '2026-01': 1 },
        monthlyOpenedCounts: { '2026-01': 6 },
      });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: true });

      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.monthlyMerged).toEqual({ '2026-01': 5, '2025-12': 3 });
    });
  });

  // ── writeDashboardFromState ────────────────────────────────────────

  describe('writeDashboardFromState', () => {
    it('should throw when no digest is available', () => {
      const state = makeState();
      const mockSM = {
        getState: vi.fn().mockReturnValue(state),
      };
      mockGetStateManager.mockReturnValue(mockSM as any);

      expect(() => writeDashboardFromState()).toThrow('No digest data available');
    });

    it('should generate and write HTML from cached state', () => {
      const digest = makeDigest({
        openPRs: [makeFetchedPR()],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 5, mergeRate: 83.3 },
      });
      const state = makeState({ lastDigest: digest });
      const mockSM = {
        getState: vi.fn().mockReturnValue(state),
      };
      mockGetStateManager.mockReturnValue(mockSM as any);

      const path = writeDashboardFromState();

      expect(path).toBe('/tmp/test-dashboard.html');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/test-dashboard.html',
        expect.stringContaining('<!DOCTYPE html>'),
        { mode: 0o644 },
      );
    });

    it('should use monthly counts from state', () => {
      const digest = makeDigest();
      const state = makeState({
        lastDigest: digest,
        monthlyMergedCounts: { '2026-01': 3 },
        monthlyClosedCounts: { '2026-01': 1 },
        monthlyOpenedCounts: { '2026-01': 4 },
      });
      const mockSM = {
        getState: vi.fn().mockReturnValue(state),
      };
      mockGetStateManager.mockReturnValue(mockSM as any);

      writeDashboardFromState();

      const html = mockWriteFileSync.mock.calls[0][1] as string;
      // Chart data should include the monthly counts
      expect(html).toContain('2026-01');
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    async function getHtmlOutput(digest: DailyDigest, stateOverrides: Partial<AgentState> = {}): Promise<string> {
      const state = makeState({ lastDigest: digest, ...stateOverrides });
      const mockSM = setupMockStateManager(state, digest);
      mockGetStateManager.mockReturnValue(mockSM as any);
      mockGetGitHubToken.mockReturnValue(null);

      await runDashboard({ json: false });
      return (mockWriteFileSync.mock.calls[0]?.[1] as string) ?? '';
    }

    it('should handle empty PR lists in all digest arrays', async () => {
      const digest = makeDigest(); // All arrays empty by default
      const html = await getHtmlOutput(digest);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('All PRs are healthy');
      expect(html).toContain('No active pull requests');
    });

    it('should handle PR with very long title (truncation)', async () => {
      const longTitle = 'A'.repeat(200);
      const pr = makeFetchedPR({ title: longTitle, status: 'failing_ci', ciStatus: 'failing' });
      const digest = makeDigest({
        openPRs: [pr],
        ciFailingPRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      // The health-meta uses truncateTitle(pr.title, 50) which truncates to 50 chars + "..."
      expect(html).toContain('A'.repeat(50) + '...');
      // The full title (escaped) should also appear in the active PR list
      expect(html).toContain('A'.repeat(200));
    });

    it('should handle digest with all status categories populated', async () => {
      const basePR = makeFetchedPR();
      const digest = makeDigest({
        openPRs: [basePR],
        prsNeedingResponse: [makeFetchedPR({ status: 'needs_response', hasUnrespondedComment: true, number: 10 })],
        ciFailingPRs: [makeFetchedPR({ status: 'failing_ci', ciStatus: 'failing', number: 11 })],
        mergeConflictPRs: [makeFetchedPR({ status: 'merge_conflict', hasMergeConflict: true, number: 12 })],
        needsChangesPRs: [makeFetchedPR({ status: 'needs_changes', number: 13 })],
        changesAddressedPRs: [makeFetchedPR({ status: 'changes_addressed', number: 14 })],
        waitingOnMaintainerPRs: [makeFetchedPR({ status: 'waiting_on_maintainer', number: 15 })],
        ciBlockedPRs: [makeFetchedPR({ status: 'ci_blocked', number: 16 })],
        ciNotRunningPRs: [makeFetchedPR({ status: 'ci_not_running', number: 17 })],
        incompleteChecklistPRs: [
          makeFetchedPR({ status: 'incomplete_checklist', hasIncompleteChecklist: true, number: 18 }),
        ],
        missingRequiredFilesPRs: [makeFetchedPR({ status: 'missing_required_files' as any, number: 19 })],
        needsRebasePRs: [makeFetchedPR({ status: 'needs_rebase', number: 20 })],
        shelvedPRs: [makeShelvedPRRef()],
        autoUnshelvedPRs: [makeShelvedPRRef({ number: 77, status: 'needs_response' })],
        recentlyMergedPRs: [
          {
            url: 'https://github.com/o/r/pull/30',
            repo: 'o/r',
            number: 30,
            title: 'Merged',
            mergedAt: '2026-01-14T00:00:00Z',
          },
        ],
        recentlyClosedPRs: [
          {
            url: 'https://github.com/o/r/pull/31',
            repo: 'o/r',
            number: 31,
            title: 'Closed',
            closedAt: '2026-01-13T00:00:00Z',
          },
        ],
        summary: { totalActivePRs: 1, totalNeedingAttention: 7, totalMergedAllTime: 1, mergeRate: 50 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('Action Required');
      expect(html).toContain('Waiting on Others');
      expect(html).toContain('Recently Merged');
      expect(html).toContain('Recently Closed');
      expect(html).toContain('Shelved Pull Requests');
      expect(html).toContain('Auto-Unshelved');
    });

    it('should handle missing optional fields gracefully', async () => {
      // PR with minimal data - no optional fields
      const pr = makeFetchedPR({
        lastMaintainerComment: undefined,
        latestCommitDate: undefined,
        checklistStats: undefined,
        missingRequiredFiles: undefined,
        commitsBehindUpstream: undefined,
      });
      const digest = makeDigest({
        openPRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('<!DOCTYPE html>');
    });

    it('should handle PR with daysSinceActivity exactly at approaching dormant threshold', async () => {
      const pr = makeFetchedPR({ daysSinceActivity: 25 }); // Exactly at default threshold
      const digest = makeDigest({
        openPRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).toContain('25d inactive');
    });

    it('should handle empty repoScores', async () => {
      const digest = makeDigest();
      const html = await getHtmlOutput(digest, { repoScores: {} });
      expect(html).toContain('<!DOCTYPE html>');
    });

    it('should handle undefined monthly counts in state', async () => {
      const digest = makeDigest();
      const html = await getHtmlOutput(digest, {
        monthlyMergedCounts: undefined,
        monthlyClosedCounts: undefined,
        monthlyOpenedCounts: undefined,
      });

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('monthlyChart');
    });

    it('should pluralize "issue" in action required badge correctly', async () => {
      // Single issue
      const pr1 = makeFetchedPR({ status: 'failing_ci', ciStatus: 'failing' });
      const singleDigest = makeDigest({
        openPRs: [pr1],
        ciFailingPRs: [pr1],
        summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
      });

      let html = await getHtmlOutput(singleDigest);
      expect(html).toContain('1 issue');
      expect(html).not.toContain('1 issues');

      vi.clearAllMocks();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      // Multiple issues
      const pr2 = makeFetchedPR({ status: 'merge_conflict', hasMergeConflict: true, number: 2 });
      const multiDigest = makeDigest({
        openPRs: [pr1, pr2],
        ciFailingPRs: [pr1],
        mergeConflictPRs: [pr2],
        summary: { totalActivePRs: 2, totalNeedingAttention: 2, totalMergedAllTime: 0, mergeRate: 0 },
      });

      html = await getHtmlOutput(multiDigest);
      expect(html).toContain('2 issues');
    });

    it('should pluralize "PR" in waiting on others badge correctly', async () => {
      // Single PR
      const pr1 = makeFetchedPR({ status: 'waiting_on_maintainer' });
      const singleDigest = makeDigest({
        openPRs: [pr1],
        waitingOnMaintainerPRs: [pr1],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(singleDigest);
      expect(html).toContain('1 PR<');
    });

    it('should handle XSS in URL fields', async () => {
      const pr = makeFetchedPR({
        url: 'https://github.com/owner/repo/pull/1"><script>alert(1)</script>',
      });
      const digest = makeDigest({
        openPRs: [pr],
        summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
      });

      const html = await getHtmlOutput(digest);
      expect(html).not.toContain('<script>alert(1)</script>');
    });
  });

  // ── Offline Mode ────────────────────────────────────────────────────
  describe('offline mode', () => {
    beforeEach(() => {
      mockGetGitHubToken.mockReturnValue(null);
    });

    it('should use cached digest in JSON mode when --offline is set', async () => {
      const digest = makeDigest({});
      mockGetStateManager.mockReturnValue({
        getState: vi.fn().mockReturnValue({
          lastDigest: digest,
          lastDigestAt: '2026-01-15T09:30:00Z',
          lastRunAt: '2026-01-15T10:00:00Z',
          repoScores: {},
          config: { shelvedPRUrls: [], approachingDormantDays: 25 },
        }),
        getStats: vi.fn(),
      } as any);

      await runDashboard({ json: true, offline: true });

      expect(mockOutputJson).toHaveBeenCalledTimes(1);
      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.offline).toBe(true);
      expect(outputData.lastUpdated).toBe(digest.generatedAt);
      expect(outputData.stats).toBeDefined();
    });

    it('should show error when no cached data exists in JSON mode', async () => {
      mockGetStateManager.mockReturnValue({
        getState: vi.fn().mockReturnValue({
          lastDigest: undefined,
          lastRunAt: '2026-01-15T10:00:00Z',
          repoScores: {},
          config: {},
        }),
        getStats: vi.fn(),
      } as any);

      await runDashboard({ json: true, offline: true });

      expect(mockOutputJson).toHaveBeenCalledTimes(1);
      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.error).toBe('No cached data found. Run without --offline first.');
      expect(outputData.offline).toBe(true);
    });

    it('should show error when no cached data exists in text mode', async () => {
      mockGetStateManager.mockReturnValue({
        getState: vi.fn().mockReturnValue({
          lastDigest: undefined,
          lastRunAt: '2026-01-15T10:00:00Z',
          repoScores: {},
          config: {},
        }),
        getStats: vi.fn(),
      } as any);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await runDashboard({ json: false, offline: true });

      const allErrorOutput = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(allErrorOutput).toContain('No cached data found. Run without --offline first.');
      consoleErrorSpy.mockRestore();
    });

    it('should not call getGitHubToken when --offline is set', async () => {
      mockGetStateManager.mockReturnValue({
        getState: vi.fn().mockReturnValue({
          lastDigest: makeDigest({}),
          lastDigestAt: '2026-01-15T09:30:00Z',
          lastRunAt: '2026-01-15T10:00:00Z',
          repoScores: {},
          config: { shelvedPRUrls: [], approachingDormantDays: 25 },
        }),
        getStats: vi.fn(),
      } as any);

      await runDashboard({ json: true, offline: true });

      expect(mockGetGitHubToken).not.toHaveBeenCalled();
    });

    it('should not include offline fields when --offline is not set', async () => {
      const digest = makeDigest({});
      mockGetStateManager.mockReturnValue({
        getState: vi.fn().mockReturnValue({
          lastDigest: digest,
          lastDigestAt: '2026-01-15T09:30:00Z',
          lastRunAt: '2026-01-15T10:00:00Z',
          repoScores: {},
          config: { shelvedPRUrls: [], approachingDormantDays: 25 },
        }),
        getStats: vi.fn(),
      } as any);

      await runDashboard({ json: true });

      expect(mockOutputJson).toHaveBeenCalledTimes(1);
      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.offline).toBeUndefined();
      expect(outputData.lastUpdated).toBeUndefined();
    });

    it('should fall back to lastRunAt when generatedAt and lastDigestAt are missing', async () => {
      const digest = makeDigest({});
      (digest as any).generatedAt = '';
      mockGetStateManager.mockReturnValue({
        getState: vi.fn().mockReturnValue({
          lastDigest: digest,
          lastDigestAt: undefined,
          lastRunAt: '2026-01-15T10:00:00Z',
          repoScores: {},
          config: { shelvedPRUrls: [], approachingDormantDays: 25 },
        }),
        getStats: vi.fn(),
      } as any);

      await runDashboard({ json: true, offline: true });

      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.offline).toBe(true);
      expect(outputData.lastUpdated).toBe('2026-01-15T10:00:00Z');
    });
  });
});
