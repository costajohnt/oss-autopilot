/**
 * Tests for setup and check-setup commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  DEFAULT_CONFIG: {
    aiPolicyBlocklist: ['matplotlib/matplotlib'],
  },
}));

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
}));

vi.mock('./validation.js', () => ({
  validateGitHubUsername: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import { runSetup, runCheckSetup } from './setup.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockOutputJson = vi.mocked(outputJson);

const DEFAULT_CONFIG = {
  githubUsername: 'testuser',
  maxActivePRs: 10,
  dormantThresholdDays: 30,
  approachingDormantDays: 25,
  languages: ['typescript', 'javascript'],
  labels: ['good first issue', 'help wanted'],
  setupComplete: true,
  aiPolicyBlocklist: ['matplotlib/matplotlib'],
};

describe('runSetup', () => {
  const mockSave = vi.fn();
  const mockUpdateConfig = vi.fn();
  const mockMarkSetupComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG } }),
      updateConfig: mockUpdateConfig,
      markSetupComplete: mockMarkSetupComplete,
      save: mockSave,
    } as any);
  });

  it('should show setup status when already complete in JSON mode', async () => {
    await runSetup({ json: true });

    expect(mockOutputJson).toHaveBeenCalledWith(
      expect.objectContaining({
        setupComplete: true,
        config: expect.objectContaining({
          githubUsername: 'testuser',
          maxActivePRs: 10,
        }),
      }),
    );
  });

  it('should show setup prompts when setup is incomplete in JSON mode', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, setupComplete: false } }),
      updateConfig: mockUpdateConfig,
      save: mockSave,
    } as any);

    await runSetup({ json: true });

    expect(mockOutputJson).toHaveBeenCalledWith(
      expect.objectContaining({
        setupRequired: true,
        prompts: expect.arrayContaining([
          expect.objectContaining({ setting: 'username' }),
          expect.objectContaining({ setting: 'maxActivePRs' }),
        ]),
      }),
    );
  });

  it('should show setup prompts when --reset is used', async () => {
    await runSetup({ reset: true, json: true });

    expect(mockOutputJson).toHaveBeenCalledWith(
      expect.objectContaining({
        setupRequired: true,
      }),
    );
  });

  it('should apply --set settings correctly', async () => {
    await runSetup({ set: ['username=newuser', 'maxActivePRs=5'], json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'newuser' });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ maxActivePRs: 5 });
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        settings: expect.objectContaining({
          username: 'newuser',
          maxActivePRs: '5',
        }),
      }),
    );
  });

  it('should handle languages setting with comma-separated values', async () => {
    await runSetup({ set: ['languages=python,rust,go'], json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ languages: ['python', 'rust', 'go'] });
    expect(mockSave).toHaveBeenCalled();
  });

  it('should handle complete=true setting', async () => {
    await runSetup({ set: ['complete=true'], json: true });

    expect(mockMarkSetupComplete).toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalled();
  });

  it('should handle showHealthCheck=false', async () => {
    await runSetup({ set: ['showHealthCheck=false'], json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ showHealthCheck: false });
  });

  it('should handle squashByDefault with ask value', async () => {
    await runSetup({ set: ['squashByDefault=ask'], json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ squashByDefault: 'ask' });
  });

  it('should handle includeDocIssues setting', async () => {
    await runSetup({ set: ['includeDocIssues=true'], json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ includeDocIssues: true });
  });

  it('should filter invalid aiPolicyBlocklist entries', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSetup({ set: ['aiPolicyBlocklist=valid/repo,invalid-entry'], json: false });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ aiPolicyBlocklist: ['valid/repo'] });
    consoleSpy.mockRestore();
  });

  it('should handle dormantDays setting', async () => {
    await runSetup({ set: ['dormantDays=14'], json: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ dormantThresholdDays: 14 });
  });

  it('should handle approachingDays setting', async () => {
    await runSetup({ set: ['approachingDays=10'], json: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ approachingDormantDays: 10 });
  });

  it('should handle labels setting', async () => {
    await runSetup({ set: ['labels=bug,feature'], json: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ labels: ['bug', 'feature'] });
  });

  it('should handle showHealthCheck=true', async () => {
    await runSetup({ set: ['showHealthCheck=true'], json: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ showHealthCheck: true });
  });

  it('should handle squashByDefault=true', async () => {
    await runSetup({ set: ['squashByDefault=true'], json: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ squashByDefault: true });
  });

  it('should handle squashByDefault=false', async () => {
    await runSetup({ set: ['squashByDefault=false'], json: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ squashByDefault: false });
  });

  it('should handle minStars setting', async () => {
    await runSetup({ set: ['minStars=100'], json: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ minStars: 100 });
  });

  it('should handle minStars with non-numeric value (fallback to 50)', async () => {
    await runSetup({ set: ['minStars=abc'], json: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ minStars: 50 });
  });

  it('should handle includeDocIssues=false', async () => {
    await runSetup({ set: ['includeDocIssues=false'], json: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ includeDocIssues: false });
  });

  it('should warn for all-invalid aiPolicyBlocklist entries', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSetup({ set: ['aiPolicyBlocklist=not-a-repo'], json: false });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('All entries were invalid'));
    expect(mockUpdateConfig).not.toHaveBeenCalledWith(expect.objectContaining({ aiPolicyBlocklist: expect.anything() }));
    consoleSpy.mockRestore();
  });

  it('should handle unknown setting key', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runSetup({ set: ['unknownKey=value'], json: false });
    expect(consoleSpy).toHaveBeenCalledWith('Unknown setting: unknownKey');
    consoleSpy.mockRestore();
  });

  it('should show text output when setup is already complete', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSetup({ json: false });
    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Setup already complete');
    expect(allOutput).toContain('testuser');
    consoleSpy.mockRestore();
  });

  it('should show text setup prompts when setup is incomplete', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, setupComplete: false } }),
      updateConfig: mockUpdateConfig,
      save: mockSave,
    } as any);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSetup({ json: false });
    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('SETUP_REQUIRED');
    expect(allOutput).toContain('SETTING: username');
    expect(allOutput).toContain('END_SETUP_PROMPTS');
    consoleSpy.mockRestore();
  });

  it('should print settings in text mode after --set', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSetup({ set: ['username=alice'], json: false });
    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('username: alice');
    consoleSpy.mockRestore();
  });

  it('should not complete=true when value is not true', async () => {
    await runSetup({ set: ['complete=false'], json: true });
    expect(mockMarkSetupComplete).not.toHaveBeenCalled();
  });

  it('should handle setting with equals in value', async () => {
    await runSetup({ set: ['username=user=name'], json: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'user=name' });
  });

  it('should handle empty set array', async () => {
    await runSetup({ set: [], json: true });
    // No --set values means show status
    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({ setupComplete: true }));
  });
});

describe('runCheckSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should report setup complete in JSON mode', async () => {
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn().mockReturnValue(true),
      getState: vi.fn().mockReturnValue({ config: { githubUsername: 'testuser' } }),
    } as any);

    await runCheckSetup({ json: true });

    expect(mockOutputJson).toHaveBeenCalledWith({
      setupComplete: true,
      username: 'testuser',
    });
  });

  it('should report setup incomplete in JSON mode', async () => {
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn().mockReturnValue(false),
      getState: vi.fn().mockReturnValue({ config: { githubUsername: '' } }),
    } as any);

    await runCheckSetup({ json: true });

    expect(mockOutputJson).toHaveBeenCalledWith({
      setupComplete: false,
      username: '',
    });
  });

  it('should output text when setup is complete', async () => {
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn().mockReturnValue(true),
      getState: vi.fn().mockReturnValue({ config: { githubUsername: 'testuser' } }),
    } as any);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCheckSetup({ json: false });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('SETUP_COMPLETE');
    expect(allOutput).toContain('username=testuser');
    consoleSpy.mockRestore();
  });

  it('should output SETUP_INCOMPLETE when not complete', async () => {
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn().mockReturnValue(false),
      getState: vi.fn().mockReturnValue({ config: { githubUsername: '' } }),
    } as any);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCheckSetup({ json: false });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('SETUP_INCOMPLETE');
    consoleSpy.mockRestore();
  });
});
