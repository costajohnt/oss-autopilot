/**
 * Tests for init command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runInit } from './init.js';

const mockGetStateManager = vi.mocked(getStateManager);

describe('runInit', () => {
  const mockUpdateConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      updateConfig: mockUpdateConfig,
    } as any);
  });

  it('should set username in config', async () => {
    const result = await runInit({ username: 'testuser' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'testuser' });
    expect(result).toEqual(expect.objectContaining({ username: 'testuser' }));
  });

  it('should return message about daily run', async () => {
    const result = await runInit({ username: 'testuser' });

    expect(result.message).toContain('daily');
  });

  it('should reject empty username', async () => {
    await expect(runInit({ username: '' })).rejects.toThrow('cannot be empty');
  });

  it('should reject username with invalid characters', async () => {
    await expect(runInit({ username: 'user@name!' })).rejects.toThrow('alphanumeric');
  });

  it('should reject username starting with a hyphen', async () => {
    await expect(runInit({ username: '-username' })).rejects.toThrow('cannot start with a hyphen');
  });

  it('should reject username ending with a hyphen', async () => {
    await expect(runInit({ username: 'username-' })).rejects.toThrow('cannot end with a hyphen');
  });

  it('should reject username with consecutive hyphens', async () => {
    await expect(runInit({ username: 'user--name' })).rejects.toThrow('consecutive hyphens');
  });

  it('should reject username exceeding max length', async () => {
    const longUsername = 'a'.repeat(40);
    await expect(runInit({ username: longUsername })).rejects.toThrow('at most 39 characters');
  });

  it('should accept valid username with hyphens', async () => {
    const result = await runInit({ username: 'valid-user-name' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'valid-user-name' });
    expect(result.username).toBe('valid-user-name');
  });
});
