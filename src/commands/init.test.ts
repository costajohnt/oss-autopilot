/**
 * Tests for init command
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
import { outputJson } from '../formatters/json.js';
import { runInit } from './init.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockOutputJson = vi.mocked(outputJson);

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
    await runInit({ username: 'testuser', json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'testuser' });
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({ username: 'testuser' }));
  });

  it('should output message about daily run', async () => {
    await runInit({ username: 'testuser', json: true });

    const call = mockOutputJson.mock.calls[0][0] as { message: string };
    expect(call.message).toContain('daily');
  });
});
