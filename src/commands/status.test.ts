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
    activePRs: 3,
    dormantPRs: 1,
    mergedPRs: 5,
    closedPRs: 2,
    activeIssues: 0,
    trustedProjects: 1,
    mergeRate: '71%',
    needsResponse: 1,
  };

  const mockActivePRs = [
    { repo: 'owner/repo', number: 1, title: 'Fix bug', hasUnreadComments: true },
    { repo: 'owner/repo', number: 2, title: 'Add feature', hasUnreadComments: false },
  ];

  const mockDormantPRs = [{ repo: 'other/repo', number: 10, title: 'Old PR', hasUnreadComments: false }];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getStats: vi.fn().mockReturnValue(mockStats),
      getState: vi.fn().mockReturnValue({
        activePRs: mockActivePRs,
        dormantPRs: mockDormantPRs,
        lastRunAt: '2026-01-15T10:00:00Z',
      }),
    } as any);
  });

  it('should output status in JSON mode', async () => {
    await runStatus({ json: true });

    expect(mockOutputJson).toHaveBeenCalledWith({
      stats: mockStats,
      activePRs: mockActivePRs,
      dormantPRs: mockDormantPRs,
      lastRunAt: '2026-01-15T10:00:00Z',
    });
  });

  it('should output text mode without error', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStatus({ json: false });

    expect(consoleSpy).toHaveBeenCalled();
    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Active PRs: 3');
    expect(allOutput).toContain('Dormant PRs: 1');
    expect(allOutput).toContain('Merge Rate: 71%');
    consoleSpy.mockRestore();
  });

  it('should exclude totalTracked from JSON output', async () => {
    mockGetStateManager.mockReturnValue({
      getStats: vi.fn().mockReturnValue({ ...mockStats, totalTracked: 11 }),
      getState: vi.fn().mockReturnValue({
        activePRs: [],
        dormantPRs: [],
        lastRunAt: '2026-01-15T10:00:00Z',
      }),
    } as any);

    await runStatus({ json: true });

    const outputData = mockOutputJson.mock.calls[0][0] as any;
    expect(outputData.stats.totalTracked).toBeUndefined();
  });

  it('should handle empty PR lists', async () => {
    mockGetStateManager.mockReturnValue({
      getStats: vi.fn().mockReturnValue({ ...mockStats, activePRs: 0, dormantPRs: 0 }),
      getState: vi.fn().mockReturnValue({
        activePRs: [],
        dormantPRs: [],
        lastRunAt: '',
      }),
    } as any);

    await runStatus({ json: true });

    const outputData = mockOutputJson.mock.calls[0][0] as any;
    expect(outputData.activePRs).toEqual([]);
    expect(outputData.dormantPRs).toEqual([]);
  });
});
