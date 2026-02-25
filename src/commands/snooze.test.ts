/**
 * Tests for snooze/unsnooze commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

vi.mock('./validation.js', () => ({
  PR_URL_PATTERN: /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/,
  validateGitHubUrl: vi.fn(),
  validateUrl: vi.fn((url: string) => url),
  validateMessage: vi.fn((msg: string) => msg),
}));

import { getStateManager } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';
import { validateGitHubUrl } from './validation.js';
import { runSnooze, runUnsnooze } from './snooze.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockOutputJson = vi.mocked(outputJson);
const mockOutputJsonError = vi.mocked(outputJsonError);
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

    await runSnooze({ prUrl: TEST_PR_URL, reason: 'flaky CI', json: true });

    expect(mockSnoozePR).toHaveBeenCalledWith(TEST_PR_URL, 'flaky CI', 7);
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({
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

    await runSnooze({ prUrl: TEST_PR_URL, reason: 'upstream issue', days: 3, json: true });

    expect(mockSnoozePR).toHaveBeenCalledWith(TEST_PR_URL, 'upstream issue', 3);
  });

  it('should report already snoozed without saving', async () => {
    mockSnoozePR.mockReturnValue(false);
    mockGetSnoozeInfo.mockReturnValue({ expiresAt: '2026-01-22T00:00:00Z' });

    await runSnooze({ prUrl: TEST_PR_URL, reason: 'flaky CI', json: true });

    expect(mockSave).not.toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({ snoozed: false }));
  });

  it('should reject non-positive snooze duration', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runSnooze({ prUrl: TEST_PR_URL, reason: 'test', days: 0, json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith('Snooze duration must be a positive number of days.');
    mockExit.mockRestore();
  });

  it('should reject negative snooze duration', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runSnooze({ prUrl: TEST_PR_URL, reason: 'test', days: -5, json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith('Snooze duration must be a positive number of days.');
    mockExit.mockRestore();
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

    await runUnsnooze({ prUrl: TEST_PR_URL, json: true });

    expect(mockUnsnoozePR).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ unsnoozed: true, url: TEST_PR_URL });
  });

  it('should not save state when PR was not snoozed', async () => {
    mockUnsnoozePR.mockReturnValue(false);

    await runUnsnooze({ prUrl: TEST_PR_URL, json: true });

    expect(mockSave).not.toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ unsnoozed: false, url: TEST_PR_URL });
  });
});
