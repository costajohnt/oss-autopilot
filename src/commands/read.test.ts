/**
 * Tests for read command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';
import { runRead } from './read.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockOutputJson = vi.mocked(outputJson);
const mockOutputJsonError = vi.mocked(outputJsonError);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('runRead', () => {
  const mockSave = vi.fn();
  const mockMarkPRAsRead = vi.fn();
  const mockMarkAllPRsAsRead = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      markPRAsRead: mockMarkPRAsRead,
      markAllPRsAsRead: mockMarkAllPRsAsRead,
      save: mockSave,
    } as any);
  });

  it('should mark a specific PR as read', async () => {
    mockMarkPRAsRead.mockReturnValue(true);

    await runRead({ prUrl: TEST_PR_URL, json: true });

    expect(mockMarkPRAsRead).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ marked: true, url: TEST_PR_URL });
  });

  it('should not save when PR is not found or already read', async () => {
    mockMarkPRAsRead.mockReturnValue(false);

    await runRead({ prUrl: TEST_PR_URL, json: true });

    expect(mockSave).not.toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ marked: false, url: TEST_PR_URL });
  });

  it('should mark all PRs as read with --all flag', async () => {
    mockMarkAllPRsAsRead.mockReturnValue(5);

    await runRead({ all: true, json: true });

    expect(mockMarkAllPRsAsRead).toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ markedAsRead: 5, all: true });
  });

  it('should exit with error when neither prUrl nor --all is provided', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runRead({ json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith('PR URL or --all flag required');
    mockExit.mockRestore();
  });

  it('should output text when marking all PRs as read without JSON', async () => {
    mockMarkAllPRsAsRead.mockReturnValue(3);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runRead({ all: true, json: false });

    expect(consoleSpy).toHaveBeenCalled();
    const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).toContain('Marked 3 PRs as read');
    consoleSpy.mockRestore();
  });
});
