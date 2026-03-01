/**
 * Tests for status command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runStatus } from './status.js';

const mockGetStateManager = vi.mocked(getStateManager);

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

  it('should return status data', async () => {
    const result = await runStatus({});

    expect(result).toEqual(
      expect.objectContaining({
        stats: expect.objectContaining({ mergedPRs: 5 }),
        lastRunAt: '2026-01-15T10:00:00Z',
      }),
    );
  });

  it('should exclude totalTracked from output', async () => {
    mockGetStateManager.mockReturnValue({
      getStats: vi.fn().mockReturnValue({ ...mockStats, totalTracked: 11 }),
      getState: vi.fn().mockReturnValue({
        lastRunAt: '2026-01-15T10:00:00Z',
      }),
    } as any);

    const result = await runStatus({});

    expect((result.stats as any).totalTracked).toBeUndefined();
  });

  describe('offline mode', () => {
    it('should include offline and lastUpdated when --offline is set', async () => {
      mockGetStateManager.mockReturnValue({
        getStats: vi.fn().mockReturnValue(mockStats),
        getState: vi.fn().mockReturnValue({
          lastRunAt: '2026-01-15T10:00:00Z',
          lastDigestAt: '2026-01-15T09:30:00Z',
        }),
      } as any);

      const result = await runStatus({ offline: true });

      expect(result.offline).toBe(true);
      expect(result.lastUpdated).toBe('2026-01-15T09:30:00Z');
    });

    it('should fall back to lastRunAt when lastDigestAt is not set', async () => {
      const result = await runStatus({ offline: true });

      expect(result.offline).toBe(true);
      expect(result.lastUpdated).toBe('2026-01-15T10:00:00Z');
    });

    it('should not include offline fields when --offline is not set', async () => {
      const result = await runStatus({});

      expect(result.offline).toBeUndefined();
      expect(result.lastUpdated).toBeUndefined();
    });
  });
});
