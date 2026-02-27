/**
 * Tests for read command
 * In v2, the read command is a no-op (PR read state is not tracked locally).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

import { outputJson, outputJsonError } from '../formatters/json.js';
import { runRead } from './read.js';

const mockOutputJson = vi.mocked(outputJson);
const mockOutputJsonError = vi.mocked(outputJsonError);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('runRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should output v2 info when marking a specific PR as read', async () => {
    await runRead({ prUrl: TEST_PR_URL, json: true });

    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({ marked: false, url: TEST_PR_URL }));
  });

  it('should output v2 info when marking all PRs as read', async () => {
    await runRead({ all: true, json: true });

    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({ markedAsRead: 0, all: true }));
  });

  it('should exit with error when neither prUrl nor --all is provided', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runRead({ json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith('PR URL or --all flag required');
    mockExit.mockRestore();
  });

  it('should output text when marking all PRs as read without JSON', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runRead({ all: true, json: false });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
