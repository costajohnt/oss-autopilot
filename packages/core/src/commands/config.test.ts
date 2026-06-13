/**
 * Tests for config command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: vi.fn(),
    maybeCheckpoint: vi.fn().mockResolvedValue(null),
  };
});

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { runConfig } from './config.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockMaybeCheckpoint = vi.mocked(maybeCheckpoint);

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
  const mockUpdateConfig = vi.fn();
  const mockCleanupExcludedData = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);
  });

  it('should return current config when no key specified', async () => {
    const result = await runConfig({});

    expect(result).toEqual({ config: DEFAULT_CONFIG });
  });

  it('should set username config', async () => {
    const result = await runConfig({ key: 'username', value: 'newuser' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'newuser' });
    expect(result).toEqual({ success: true, key: 'username', value: 'newuser' });
  });

  it('should add a language', async () => {
    const result = await runConfig({ key: 'add-language', value: 'python' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      languages: ['typescript', 'javascript', 'python'],
    });
    expect(result).toEqual({ success: true, key: 'add-language', value: 'python' });
  });

  it('should not add duplicate language', async () => {
    await runConfig({ key: 'add-language', value: 'typescript' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should add a label', async () => {
    await runConfig({ key: 'add-label', value: 'bug' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      labels: ['good first issue', 'help wanted', 'bug'],
    });
  });

  it('should exclude a repo with valid format', async () => {
    await runConfig({ key: 'exclude-repo', value: 'owner/repo' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      excludeRepos: ['owner/repo'],
    });
    expect(mockCleanupExcludedData).toHaveBeenCalledWith(['owner/repo'], []);
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
  });

  it('should throw error for invalid org name with slash', async () => {
    await expect(runConfig({ key: 'exclude-org', value: 'owner/repo' })).rejects.toThrow('Invalid org name');
  });

  it('should throw a did-you-mean error for unknown config key', async () => {
    await expect(runConfig({ key: 'add-lable', value: 'val' })).rejects.toThrow(/Unknown config key "add-lable"/);
    await expect(runConfig({ key: 'add-lable', value: 'val' })).rejects.toThrow(/did you mean "add-label"/i);
  });

  it('should point at --list-keys when no close match exists', async () => {
    await expect(runConfig({ key: 'xyzabc', value: 'val' })).rejects.toThrow(/config --list-keys/);
  });

  it('should return the full key registry when listKeys is true', async () => {
    const result = await runConfig({ listKeys: true });
    expect('keys' in result).toBe(true);
    if ('keys' in result) {
      expect(result.keys.length).toBeGreaterThan(10);
      expect(result.keys.some((k) => k.key === 'username')).toBe(true);
      expect(result.keys.some((k) => k.key === 'skippedIssuesPath')).toBe(true);
    }
  });

  it('should reject listKeys combined with a positional key or value', async () => {
    await expect(runConfig({ listKeys: true, key: 'username' })).rejects.toThrow(/cannot be combined/);
    await expect(runConfig({ listKeys: true, value: 'foo' })).rejects.toThrow(/cannot be combined/);
  });

  it('should reject an invalid GitHub username', async () => {
    await expect(runConfig({ key: 'username', value: '-invalid' })).rejects.toThrow('cannot start with a hyphen');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should throw error when value is missing', async () => {
    await expect(runConfig({ key: 'username' })).rejects.toThrow('Value required');
  });

  it('should not add duplicate label', async () => {
    await runConfig({ key: 'add-label', value: 'good first issue' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should not add duplicate exclude-repo (case-insensitive)', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, excludeRepos: ['Owner/Repo'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);

    await runConfig({ key: 'exclude-repo', value: 'owner/repo' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should not add duplicate exclude-org (case-insensitive)', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, excludeOrgs: ['Facebook'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);

    await runConfig({ key: 'exclude-org', value: 'facebook' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should add an avoid-repo with valid format (#1464)', async () => {
    await runConfig({ key: 'add-avoid-repo', value: 'owner/repo' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ avoidRepos: ['owner/repo'] });
    // Soft penalty, not a hard exclusion — tracked data must stay intact.
    expect(mockCleanupExcludedData).not.toHaveBeenCalled();
  });

  it('should throw error for invalid repo format in add-avoid-repo (#1464)', async () => {
    await expect(runConfig({ key: 'add-avoid-repo', value: 'invalid' })).rejects.toThrow('Invalid repo format');
  });

  it('should not add duplicate avoid-repo (case-insensitive) (#1464)', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, avoidRepos: ['Owner/Repo'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);

    await runConfig({ key: 'add-avoid-repo', value: 'owner/repo' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should remove an avoid-repo case-insensitively (#1464)', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, avoidRepos: ['Owner/Repo', 'other/repo'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);

    await runConfig({ key: 'remove-avoid-repo', value: 'owner/repo' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ avoidRepos: ['other/repo'] });
  });

  it('should throw when removing an avoid-repo that is not on the list (#1464)', async () => {
    await expect(runConfig({ key: 'remove-avoid-repo', value: 'owner/repo' })).rejects.toThrow('not on the avoid list');
  });

  it('should add a boost issue type (#1464)', async () => {
    await runConfig({ key: 'add-boost-issue-type', value: 'good first issue' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ boostIssueTypes: ['good first issue'] });
  });

  it('should not add duplicate boost issue type (case-insensitive) (#1464)', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, boostIssueTypes: ['Bug'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);

    await runConfig({ key: 'add-boost-issue-type', value: 'bug' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should remove a boost issue type case-insensitively (#1464)', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, boostIssueTypes: ['Bug', 'enhancement'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);

    await runConfig({ key: 'remove-boost-issue-type', value: 'bug' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ boostIssueTypes: ['enhancement'] });
  });

  it('should throw when removing a boost issue type that is not on the list (#1464)', async () => {
    await expect(runConfig({ key: 'remove-boost-issue-type', value: 'bug' })).rejects.toThrow('not on the boost list');
  });

  it('should remove a label', async () => {
    await runConfig({ key: 'remove-label', value: 'good first issue' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      labels: ['help wanted'],
    });
  });

  it('should throw when removing a label that does not exist', async () => {
    await expect(runConfig({ key: 'remove-label', value: 'nonexistent' })).rejects.toThrow('not currently configured');
  });

  it('should add a scope', async () => {
    await runConfig({ key: 'add-scope', value: 'beginner' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ scope: ['beginner'] });
  });

  it('should append a scope to existing scopes', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, scope: ['beginner'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);

    await runConfig({ key: 'add-scope', value: 'intermediate' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ scope: ['beginner', 'intermediate'] });
  });

  it('should not add duplicate scope', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, scope: ['beginner'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);

    await runConfig({ key: 'add-scope', value: 'beginner' });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should throw for invalid scope value', async () => {
    await expect(runConfig({ key: 'add-scope', value: 'expert' })).rejects.toThrow('Invalid scope');
  });

  it('should remove a scope', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, scope: ['beginner', 'intermediate'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);

    await runConfig({ key: 'remove-scope', value: 'beginner' });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ scope: ['intermediate'] });
  });

  it('should throw when removing the last scope', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, scope: ['beginner'] } }),
      updateConfig: mockUpdateConfig,
      cleanupExcludedData: mockCleanupExcludedData,
      batch: (fn: () => void) => fn(),
    } as any);

    await expect(runConfig({ key: 'remove-scope', value: 'beginner' })).rejects.toThrow('Cannot remove the last scope');
  });

  it('should throw when removing a scope that is not set', async () => {
    await expect(runConfig({ key: 'remove-scope', value: 'advanced' })).rejects.toThrow('not currently set');
  });

  it('should throw for invalid scope value in remove-scope', async () => {
    await expect(runConfig({ key: 'remove-scope', value: 'expert' })).rejects.toThrow('Invalid scope');
  });

  // scoreThreshold tests removed — field dropped in v3 schema

  describe('gist checkpoint (#1440)', () => {
    it('calls maybeCheckpoint exactly once per successful set', async () => {
      await runConfig({ key: 'username', value: 'newuser' });

      expect(mockMaybeCheckpoint).toHaveBeenCalledTimes(1);
      expect(mockMaybeCheckpoint).toHaveBeenCalledWith(expect.anything(), 'config');
    });

    it('threads the checkpoint warning into gistSyncWarning when the Gist push fails', async () => {
      const warning = 'Gist checkpoint push failed after retry; the local mutation is saved';
      mockMaybeCheckpoint.mockResolvedValueOnce(warning);

      const result = await runConfig({ key: 'username', value: 'newuser' });

      expect(result).toEqual({ success: true, key: 'username', value: 'newuser', gistSyncWarning: warning });
    });

    it('omits gistSyncWarning entirely when the checkpoint succeeds', async () => {
      mockMaybeCheckpoint.mockResolvedValueOnce(null);

      const result = await runConfig({ key: 'username', value: 'newuser' });

      expect(result).not.toHaveProperty('gistSyncWarning');
      expect(result).toEqual({ success: true, key: 'username', value: 'newuser' });
    });

    it('does not checkpoint when showing the current config', async () => {
      await runConfig({});

      expect(mockMaybeCheckpoint).not.toHaveBeenCalled();
    });

    it('does not checkpoint when listing keys', async () => {
      await runConfig({ listKeys: true });

      expect(mockMaybeCheckpoint).not.toHaveBeenCalled();
    });

    it('does not checkpoint when the mutation throws', async () => {
      await expect(runConfig({ key: 'remove-label', value: 'nonexistent' })).rejects.toThrow();

      expect(mockMaybeCheckpoint).not.toHaveBeenCalled();
    });
  });
});
