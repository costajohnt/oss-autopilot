/**
 * Tests for read command
 * In v2, the read command is a no-op (PR read state is not tracked locally).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runRead } from './read.js';

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('runRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return v2 info when marking a specific PR as read', async () => {
    const result = await runRead({ prUrl: TEST_PR_URL });

    expect(result).toEqual(expect.objectContaining({ marked: false, url: TEST_PR_URL }));
  });

  it('should return v2 info when marking all PRs as read', async () => {
    const result = await runRead({ all: true });

    expect(result).toEqual(expect.objectContaining({ markedAsRead: 0, all: true }));
  });

  it('should throw when neither prUrl nor --all is provided', async () => {
    await expect(runRead({})).rejects.toThrow('PR URL or --all flag required');
  });
});
