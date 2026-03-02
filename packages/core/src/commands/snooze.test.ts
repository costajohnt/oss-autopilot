/**
 * Tests for snooze/unsnooze commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

vi.mock('./validation.js', () => ({
  PR_URL_PATTERN: /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/,
  validateGitHubUrl: vi.fn(),
  validateUrl: vi.fn((url: string) => url),
  validateMessage: vi.fn((msg: string) => msg),
}));

import { getStateManager } from '../core/index.js';
import { validateGitHubUrl } from './validation.js';
import { runSnooze, runUnsnooze } from './snooze.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockValidateGitHubUrl = vi.mocked(validateGitHubUrl);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('runSnooze', () => {
  const mockSave = vi.fn();
  const mockSnoozePR = vi.fn();
  const mockGetSnoozeInfo = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateGitHubUrl.mockImplementation(() => {});
    mockGetStateManager.mockReturnValue({
      snoozePR: mockSnoozePR,
      getSnoozeInfo: mockGetSnoozeInfo,
      save: mockSave,
    } as any);
  });

  it('should snooze a PR with default duration', async () => {
    mockSnoozePR.mockReturnValue(true);
    mockGetSnoozeInfo.mockReturnValue({ expiresAt: '2026-01-22T00:00:00Z' });

    const result = await runSnooze({ prUrl: TEST_PR_URL, reason: 'flaky CI' });

    expect(mockSnoozePR).toHaveBeenCalledWith(TEST_PR_URL, 'flaky CI', 7);
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({
      snoozed: true,
      url: TEST_PR_URL,
      days: 7,
      reason: 'flaky CI',
      expiresAt: '2026-01-22T00:00:00Z',
    });
  });

  it('should snooze a PR with custom duration', async () => {
    mockSnoozePR.mockReturnValue(true);
    mockGetSnoozeInfo.mockReturnValue({ expiresAt: '2026-01-17T00:00:00Z' });

    const result = await runSnooze({ prUrl: TEST_PR_URL, reason: 'upstream issue', days: 3 });

    expect(mockSnoozePR).toHaveBeenCalledWith(TEST_PR_URL, 'upstream issue', 3);
    expect(result.days).toBe(3);
  });

  it('should report already snoozed without saving', async () => {
    mockSnoozePR.mockReturnValue(false);
    mockGetSnoozeInfo.mockReturnValue({ expiresAt: '2026-01-22T00:00:00Z' });

    const result = await runSnooze({ prUrl: TEST_PR_URL, reason: 'flaky CI' });

    expect(mockSave).not.toHaveBeenCalled();
    expect(result.snoozed).toBe(false);
  });

  it('should throw for non-positive snooze duration', async () => {
    await expect(runSnooze({ prUrl: TEST_PR_URL, reason: 'test', days: 0 })).rejects.toThrow(
      'Snooze duration must be a positive number of days.',
    );
  });

  it('should throw for negative snooze duration', async () => {
    await expect(runSnooze({ prUrl: TEST_PR_URL, reason: 'test', days: -5 })).rejects.toThrow(
      'Snooze duration must be a positive number of days.',
    );
  });

  it('should throw for NaN snooze duration', async () => {
    await expect(runSnooze({ prUrl: TEST_PR_URL, reason: 'test', days: NaN })).rejects.toThrow(
      'Snooze duration must be a positive number of days.',
    );
  });

  it('should throw for Infinity snooze duration', async () => {
    await expect(runSnooze({ prUrl: TEST_PR_URL, reason: 'test', days: Infinity })).rejects.toThrow(
      'Snooze duration must be a positive number of days.',
    );
  });

  it('should propagate errors from snooze operation', async () => {
    mockSnoozePR.mockImplementation(() => {
      throw new Error('State corrupted');
    });

    await expect(runSnooze({ prUrl: TEST_PR_URL, reason: 'test' })).rejects.toThrow('State corrupted');
  });
});

describe('runUnsnooze', () => {
  const mockSave = vi.fn();
  const mockUnsnoozePR = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateGitHubUrl.mockImplementation(() => {});
    mockGetStateManager.mockReturnValue({
      unsnoozePR: mockUnsnoozePR,
      save: mockSave,
    } as any);
  });

  it('should unsnooze a PR and save state', async () => {
    mockUnsnoozePR.mockReturnValue(true);

    const result = await runUnsnooze({ prUrl: TEST_PR_URL });

    expect(mockUnsnoozePR).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ unsnoozed: true, url: TEST_PR_URL });
  });

  it('should not save state when PR was not snoozed', async () => {
    mockUnsnoozePR.mockReturnValue(false);

    const result = await runUnsnooze({ prUrl: TEST_PR_URL });

    expect(mockSave).not.toHaveBeenCalled();
    expect(result).toEqual({ unsnoozed: false, url: TEST_PR_URL });
  });
});
