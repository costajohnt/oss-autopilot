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

    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({
      setupComplete: true,
      config: expect.objectContaining({
        githubUsername: 'testuser',
        maxActivePRs: 10,
      }),
    }));
  });

  it('should show setup prompts when setup is incomplete in JSON mode', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, setupComplete: false } }),
      updateConfig: mockUpdateConfig,
      save: mockSave,
    } as any);

    await runSetup({ json: true });

    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({
      setupRequired: true,
      prompts: expect.arrayContaining([
        expect.objectContaining({ setting: 'username' }),
        expect.objectContaining({ setting: 'maxActivePRs' }),
      ]),
    }));
  });

  it('should show setup prompts when --reset is used', async () => {
    await runSetup({ reset: true, json: true });

    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({
      setupRequired: true,
    }));
  });

  it('should apply --set settings correctly', async () => {
    await runSetup({ set: ['username=newuser', 'maxActivePRs=5'], json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'newuser' });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ maxActivePRs: 5 });
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      settings: expect.objectContaining({
        username: 'newuser',
        maxActivePRs: '5',
      }),
    }));
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

    const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
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

    const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).toContain('SETUP_INCOMPLETE');
    consoleSpy.mockRestore();
  });
});
