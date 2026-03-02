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
  const mockSave = vi.fn();
  const mockUpdateConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      updateConfig: mockUpdateConfig,
      save: mockSave,
    } as any);
  });

  it('should set username and save state', async () => {
    const result = await runInit({ username: 'testuser' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'testuser' });
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ username: 'testuser' }));
  });

  it('should return message about daily run', async () => {
    const result = await runInit({ username: 'testuser' });

    expect(result.message).toContain('daily');
  });
});
