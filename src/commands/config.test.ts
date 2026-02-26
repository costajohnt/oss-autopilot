/**
 * Tests for config command
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
import { runConfig } from './config.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockOutputJson = vi.mocked(outputJson);
const mockOutputJsonError = vi.mocked(outputJsonError);

const DEFAULT_CONFIG = {
  githubUsername: 'testuser',
  maxActivePRs: 10,
  dormantThresholdDays: 30,
  approachingDormantDays: 25,
  languages: ['typescript', 'javascript'],
  labels: ['good first issue', 'help wanted'],
  excludeRepos: [],
  excludeOrgs: [],
  setupComplete: true,
};

describe('runConfig', () => {
  const mockSave = vi.fn();
  const mockUpdateConfig = vi.fn();
  const mockCleanupExcludedData = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      save: mockSave,
    } as any);
  });

  it('should show current config in JSON mode when no key specified', async () => {
    await runConfig({ json: true });

    expect(mockOutputJson).toHaveBeenCalledWith({ config: DEFAULT_CONFIG });
  });

  it('should set username config', async () => {
    await runConfig({ key: 'username', value: 'newuser', json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'newuser' });
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ success: true, key: 'username', value: 'newuser' });
  });

  it('should exit with error when username has leading hyphen', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runConfig({ key: 'username', value: '-invalid', json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('Invalid GitHub username'));
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('should exit with error when username has consecutive hyphens', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runConfig({ key: 'username', value: 'bad--user', json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('consecutive hyphens'));
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('should add a language', async () => {
    await runConfig({ key: 'add-language', value: 'python', json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      languages: ['typescript', 'javascript', 'python'],
    });
    expect(mockSave).toHaveBeenCalled();
  });

  it('should not add duplicate language', async () => {
    await runConfig({ key: 'add-language', value: 'typescript', json: true });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalled();
  });

  it('should add a label', async () => {
    await runConfig({ key: 'add-label', value: 'bug', json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      labels: ['good first issue', 'help wanted', 'bug'],
    });
    expect(mockSave).toHaveBeenCalled();
  });

  it('should exclude a repo with valid format', async () => {
    await runConfig({ key: 'exclude-repo', value: 'owner/repo', json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      excludeRepos: ['owner/repo'],
    });
    expect(mockCleanupExcludedData).toHaveBeenCalledWith(['owner/repo'], []);
    expect(mockSave).toHaveBeenCalled();
  });

  it('should exit with error for invalid repo format in exclude-repo', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runConfig({ key: 'exclude-repo', value: 'invalid', json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('Invalid repo format'));
    mockExit.mockRestore();
  });

  it('should exclude an org', async () => {
    await runConfig({ key: 'exclude-org', value: 'facebook', json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      excludeOrgs: ['facebook'],
    });
    expect(mockCleanupExcludedData).toHaveBeenCalledWith([], ['facebook']);
    expect(mockSave).toHaveBeenCalled();
  });

  it('should exit with error for invalid org name with slash', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runConfig({ key: 'exclude-org', value: 'owner/repo', json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('Invalid org name'));
    mockExit.mockRestore();
  });

  it('should exit with error for unknown config key', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runConfig({ key: 'unknown-key', value: 'val', json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith('Unknown config key: unknown-key');
    mockExit.mockRestore();
  });

  it('should exit with error when value is missing', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runConfig({ key: 'username', json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith('Value required');
    mockExit.mockRestore();
  });
});
