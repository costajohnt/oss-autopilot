/**
 * Tests for config command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runConfig } from './config.js';

const mockGetStateManager = vi.mocked(getStateManager);

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

  it('should return current config when no key specified', async () => {
    const result = await runConfig({});

    expect(result).toEqual({ config: DEFAULT_CONFIG });
  });

  it('should set username config', async () => {
    const result = await runConfig({ key: 'username', value: 'newuser' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'newuser' });
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ success: true, key: 'username', value: 'newuser' });
  });

  it('should add a language', async () => {
    const result = await runConfig({ key: 'add-language', value: 'python' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      languages: ['typescript', 'javascript', 'python'],
    });
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ success: true, key: 'add-language', value: 'python' });
  });

  it('should not add duplicate language', async () => {
    await runConfig({ key: 'add-language', value: 'typescript' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalled();
  });

  it('should add a label', async () => {
    await runConfig({ key: 'add-label', value: 'bug' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      labels: ['good first issue', 'help wanted', 'bug'],
    });
    expect(mockSave).toHaveBeenCalled();
  });

  it('should exclude a repo with valid format', async () => {
    await runConfig({ key: 'exclude-repo', value: 'owner/repo' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      excludeRepos: ['owner/repo'],
    });
    expect(mockCleanupExcludedData).toHaveBeenCalledWith(['owner/repo'], []);
    expect(mockSave).toHaveBeenCalled();
  });

  it('should throw error for invalid repo format in exclude-repo', async () => {
    await expect(runConfig({ key: 'exclude-repo', value: 'invalid' })).rejects.toThrow('Invalid repo format');
  });

  it('should exclude an org', async () => {
    await runConfig({ key: 'exclude-org', value: 'facebook' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      excludeOrgs: ['facebook'],
    });
    expect(mockCleanupExcludedData).toHaveBeenCalledWith([], ['facebook']);
    expect(mockSave).toHaveBeenCalled();
  });

  it('should throw error for invalid org name with slash', async () => {
    await expect(runConfig({ key: 'exclude-org', value: 'owner/repo' })).rejects.toThrow('Invalid org name');
  });

  it('should throw error for unknown config key', async () => {
    await expect(runConfig({ key: 'unknown-key', value: 'val' })).rejects.toThrow('Unknown config key: unknown-key');
  });

  it('should reject an invalid GitHub username', async () => {
    await expect(runConfig({ key: 'username', value: '-invalid' })).rejects.toThrow('cannot start with a hyphen');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('should throw error when value is missing', async () => {
    await expect(runConfig({ key: 'username' })).rejects.toThrow('Value required');
  });

  it('should not add duplicate label', async () => {
    await runConfig({ key: 'add-label', value: 'good first issue' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalled();
  });

  it('should not add duplicate exclude-repo (case-insensitive)', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, excludeRepos: ['Owner/Repo'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      save: mockSave,
    } as any);

    await runConfig({ key: 'exclude-repo', value: 'owner/repo' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should not add duplicate exclude-org (case-insensitive)', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, excludeOrgs: ['Facebook'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      save: mockSave,
    } as any);

    await runConfig({ key: 'exclude-org', value: 'facebook' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});
