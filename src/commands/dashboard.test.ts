/**
 * Tests for dashboard command (offline mode)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  getDashboardPath: vi.fn().mockReturnValue('/tmp/dashboard.html'),
  PRMonitor: vi.fn(),
  IssueConversationMonitor: vi.fn(),
  getGitHubToken: vi.fn(),
}));

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
}));

vi.mock('./daily.js', () => ({
  toShelvedPRRef: vi.fn((pr: any) => ({
    number: pr.number,
    url: pr.url,
    title: pr.title,
    repo: pr.repo,
    daysSinceActivity: pr.daysSinceActivity,
    status: pr.status,
  })),
}));

import { getStateManager, getGitHubToken } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import { runDashboard } from './dashboard.js';
import type { DailyDigest } from '../core/types.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockOutputJson = vi.mocked(outputJson);

const makeMockDigest = (generatedAt: string): DailyDigest => ({
  generatedAt,
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
    totalActivePRs: 0,
    totalNeedingAttention: 0,
    totalMergedAllTime: 3,
    mergeRate: 75.0,
  },
});

describe('runDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubToken.mockReturnValue(null);
  });

  describe('offline mode', () => {
    it('should use cached digest in JSON mode when --offline is set', async () => {
      const mockDigest = makeMockDigest('2026-01-15T09:30:00Z');
      mockGetStateManager.mockReturnValue({
        getState: vi.fn().mockReturnValue({
          lastDigest: mockDigest,
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
      expect(outputData.lastUpdated).toBe('2026-01-15T09:30:00Z');
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
          lastDigest: makeMockDigest('2026-01-15T09:30:00Z'),
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
      const mockDigest = makeMockDigest('2026-01-15T09:30:00Z');
      mockGetStateManager.mockReturnValue({
        getState: vi.fn().mockReturnValue({
          lastDigest: mockDigest,
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
      const digest = makeMockDigest('');
      // Clear generatedAt to test fallback
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
