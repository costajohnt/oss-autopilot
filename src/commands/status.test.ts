/**
 * Tests for status command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import { runStatus } from './status.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockOutputJson = vi.mocked(outputJson);

describe('runStatus', () => {
  const mockStats = {
    mergedPRs: 5,
    closedPRs: 2,
    activeIssues: 0,
    trustedProjects: 1,
    mergeRate: '71.4%',
    needsResponse: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getStats: vi.fn().mockReturnValue(mockStats),
      getState: vi.fn().mockReturnValue({
        lastRunAt: '2026-01-15T10:00:00Z',
      }),
    } as any);
  });

  it('should output status in JSON mode', async () => {
    await runStatus({ json: true });

    expect(mockOutputJson).toHaveBeenCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({ mergedPRs: 5 }),
        lastRunAt: '2026-01-15T10:00:00Z',
      }),
    );
  });

  it('should output text mode without error', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStatus({ json: false });

    expect(consoleSpy).toHaveBeenCalled();
    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Merged PRs: 5');
    expect(allOutput).toContain('Merge Rate: 71.4%');
    consoleSpy.mockRestore();
  });

  it('should exclude totalTracked from JSON output', async () => {
    mockGetStateManager.mockReturnValue({
      getStats: vi.fn().mockReturnValue({ ...mockStats, totalTracked: 11 }),
      getState: vi.fn().mockReturnValue({
        lastRunAt: '2026-01-15T10:00:00Z',
      }),
    } as any);

    await runStatus({ json: true });

    const outputData = mockOutputJson.mock.calls[0][0] as any;
    expect(outputData.stats.totalTracked).toBeUndefined();
  });

  describe('offline mode', () => {
    it('should include offline and lastUpdated in JSON output when --offline is set', async () => {
      mockGetStateManager.mockReturnValue({
        getStats: vi.fn().mockReturnValue(mockStats),
        getState: vi.fn().mockReturnValue({
          lastRunAt: '2026-01-15T10:00:00Z',
          lastDigestAt: '2026-01-15T09:30:00Z',
        }),
      } as any);

      await runStatus({ json: true, offline: true });

      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.offline).toBe(true);
      expect(outputData.lastUpdated).toBe('2026-01-15T09:30:00Z');
    });

    it('should fall back to lastRunAt when lastDigestAt is not set', async () => {
      await runStatus({ json: true, offline: true });

      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.offline).toBe(true);
      expect(outputData.lastUpdated).toBe('2026-01-15T10:00:00Z');
    });

    it('should not include offline fields when --offline is not set', async () => {
      await runStatus({ json: true });

      const outputData = mockOutputJson.mock.calls[0][0] as any;
      expect(outputData.offline).toBeUndefined();
      expect(outputData.lastUpdated).toBeUndefined();
    });

    it('should show offline message in text mode', async () => {
      mockGetStateManager.mockReturnValue({
        getStats: vi.fn().mockReturnValue(mockStats),
        getState: vi.fn().mockReturnValue({
          lastRunAt: '2026-01-15T10:00:00Z',
          lastDigestAt: '2026-01-15T09:30:00Z',
        }),
      } as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runStatus({ json: false, offline: true });

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(allOutput).toContain('Last Updated: 2026-01-15T09:30:00Z');
      expect(allOutput).toContain('Offline mode: showing cached data');
      expect(allOutput).not.toContain('Last Run:');
      consoleSpy.mockRestore();
    });
  });
});
