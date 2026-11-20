/**
 * Tests for the unified move command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock getStateManager for command-level tests
vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  maybeCheckpoint: vi.fn().mockResolvedValue(null),
}));

import { getStateManager } from '../core/index.js';
import { runMove } from './move.js';

const mockGetStateManager = vi.mocked(getStateManager);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/1';

describe('runMove', () => {
  const mockShelvePR = vi.fn();
  const mockUnshelvePR = vi.fn();
  const mockSetStatusOverride = vi.fn();
  const mockClearStatusOverride = vi.fn();
  const mockGetState = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({});
    mockGetStateManager.mockReturnValue({
      shelvePR: mockShelvePR,
      unshelvePR: mockUnshelvePR,
      setStatusOverride: mockSetStatusOverride,
      clearStatusOverride: mockClearStatusOverride,
      getState: mockGetState,
      batch: (fn: () => void) => fn(),
    } as any);
  });

  describe('move to attention', () => {
    it('should set status override to needs_addressing and unshelve', async () => {
      mockUnshelvePR.mockReturnValue(false);
      const result = await runMove({ prUrl: TEST_PR_URL, target: 'attention' });

      expect(mockSetStatusOverride).toHaveBeenCalledWith(TEST_PR_URL, 'needs_addressing', expect.any(String));
      expect(mockUnshelvePR).toHaveBeenCalledWith(TEST_PR_URL);

      expect(result).toEqual({
        url: TEST_PR_URL,
        target: 'attention',
        description: 'Moved to Need Attention',
      });
    });
  });

  describe('move to waiting', () => {
    it('should set status override to waiting_on_maintainer and unshelve', async () => {
      mockUnshelvePR.mockReturnValue(false);
      const result = await runMove({ prUrl: TEST_PR_URL, target: 'waiting' });

      expect(mockSetStatusOverride).toHaveBeenCalledWith(TEST_PR_URL, 'waiting_on_maintainer', expect.any(String));
      expect(mockUnshelvePR).toHaveBeenCalledWith(TEST_PR_URL);

      expect(result).toEqual({
        url: TEST_PR_URL,
        target: 'waiting',
        description: 'Moved to Waiting on Maintainer',
      });
    });
  });

  describe('move to shelved', () => {
    it('records the action reasons the last digest holds for the PR (#1922)', async () => {
      const openPRs = [
        {
          url: TEST_PR_URL,
          status: 'needs_addressing',
          actionReason: 'failing_ci',
          actionReasons: ['failing_ci', 'merge_conflict'],
        },
        { url: 'https://github.com/owner/repo/pull/2', status: 'waiting_on_maintainer' },
        { url: 'https://github.com/owner/repo/pull/3', status: 'needs_addressing', actionReason: 'failing_ci' },
      ];
      mockGetState.mockReturnValue({ lastDigest: { openPRs } });

      await runMove({ prUrl: 'https://github.com/Owner/Repo/pull/1', target: 'shelved' });
      expect(mockShelvePR).toHaveBeenLastCalledWith('https://github.com/Owner/Repo/pull/1', [
        'failing_ci',
        'merge_conflict',
      ]);

      await runMove({ prUrl: openPRs[1].url, target: 'shelved' });
      expect(mockShelvePR).toHaveBeenLastCalledWith(openPRs[1].url, []);

      // Only a primary reason on the PR: a one-element set.
      await runMove({ prUrl: openPRs[2].url, target: 'shelved' });
      expect(mockShelvePR).toHaveBeenLastCalledWith(openPRs[2].url, ['failing_ci']);
    });

    it('should shelve PR and clear status override', async () => {
      mockShelvePR.mockReturnValue(true);
      mockClearStatusOverride.mockReturnValue(false);
      const result = await runMove({ prUrl: TEST_PR_URL, target: 'shelved' });

      // No digest yet: the reasons are unknown and left for the daily run to record.
      expect(mockShelvePR).toHaveBeenCalledWith(TEST_PR_URL, undefined);
      expect(mockClearStatusOverride).toHaveBeenCalledWith(TEST_PR_URL);

      expect(result).toEqual({
        url: TEST_PR_URL,
        target: 'shelved',
        description: 'Shelved — excluded from capacity and actionable items',
      });
    });
  });

  describe('move to auto', () => {
    it('should clear override and unshelve', async () => {
      mockClearStatusOverride.mockReturnValue(true);
      mockUnshelvePR.mockReturnValue(false);
      const result = await runMove({ prUrl: TEST_PR_URL, target: 'auto' });

      expect(mockClearStatusOverride).toHaveBeenCalledWith(TEST_PR_URL);
      expect(mockUnshelvePR).toHaveBeenCalledWith(TEST_PR_URL);

      expect(result).toEqual({
        url: TEST_PR_URL,
        target: 'auto',
        description: 'Reset to computed status',
      });
    });

    it('should handle auto when only unshelve changes state', async () => {
      mockClearStatusOverride.mockReturnValue(false);
      mockUnshelvePR.mockReturnValue(true);
      const result = await runMove({ prUrl: TEST_PR_URL, target: 'auto' });

      expect(result.target).toBe('auto');
    });

    it('should succeed even when nothing changed', async () => {
      mockClearStatusOverride.mockReturnValue(false);
      mockUnshelvePR.mockReturnValue(false);
      const result = await runMove({ prUrl: TEST_PR_URL, target: 'auto' });

      expect(result).toEqual({
        url: TEST_PR_URL,
        target: 'auto',
        description: 'Reset to computed status',
      });
    });
  });

  describe('validation', () => {
    it('should throw on invalid target', async () => {
      await expect(runMove({ prUrl: TEST_PR_URL, target: 'invalid' })).rejects.toThrow(
        'Invalid target "invalid". Must be one of: attention, waiting, shelved, auto',
      );
    });

    it('should throw ValidationError on invalid URL', async () => {
      await expect(runMove({ prUrl: 'not-a-url', target: 'attention' })).rejects.toThrow(/Invalid PR URL/);
    });

    it('should throw ValidationError on issue URL (not a PR URL)', async () => {
      await expect(runMove({ prUrl: 'https://github.com/owner/repo/issues/1', target: 'attention' })).rejects.toThrow(
        /Invalid PR URL/,
      );
    });
  });
});
