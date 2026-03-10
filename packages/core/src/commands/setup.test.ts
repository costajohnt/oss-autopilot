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

vi.mock('./validation.js', () => ({
  validateGitHubUsername: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runSetup, runCheckSetup } from './setup.js';
import type { SetupSetOutput, SetupRequiredOutput } from './setup.js';

const mockGetStateManager = vi.mocked(getStateManager);

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

  it('should return setup status when already complete', async () => {
    const result = await runSetup({});

    expect(result).toEqual(
      expect.objectContaining({
        setupComplete: true,
        config: expect.objectContaining({
          githubUsername: 'testuser',
          maxActivePRs: 10,
        }),
      }),
    );
  });

  it('should return setup prompts when setup is incomplete', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, setupComplete: false } }),
      updateConfig: mockUpdateConfig,
      save: mockSave,
    } as any);

    const result = (await runSetup({})) as SetupRequiredOutput;

    expect(result.setupRequired).toBe(true);
    expect(result.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ setting: 'username' }),
        expect.objectContaining({ setting: 'maxActivePRs' }),
      ]),
    );
  });

  it('should return setup prompts when --reset is used', async () => {
    const result = (await runSetup({ reset: true })) as SetupRequiredOutput;

    expect(result.setupRequired).toBe(true);
  });

  it('should apply --set settings correctly', async () => {
    const result = (await runSetup({ set: ['username=newuser', 'maxActivePRs=5'] })) as SetupSetOutput;

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'newuser' });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ maxActivePRs: 5 });
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual(
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
    await runSetup({ set: ['languages=python,rust,go'] });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ languages: ['python', 'rust', 'go'] });
    expect(mockSave).toHaveBeenCalled();
  });

  it('should handle complete=true setting', async () => {
    await runSetup({ set: ['complete=true'] });

    expect(mockMarkSetupComplete).toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalled();
  });

  it('should handle showHealthCheck=false', async () => {
    await runSetup({ set: ['showHealthCheck=false'] });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ showHealthCheck: false });
  });

  it('should handle squashByDefault with ask value', async () => {
    await runSetup({ set: ['squashByDefault=ask'] });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ squashByDefault: 'ask' });
  });

  it('should handle includeDocIssues setting', async () => {
    await runSetup({ set: ['includeDocIssues=true'] });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ includeDocIssues: true });
  });

  it('should filter invalid aiPolicyBlocklist entries', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSetup({ set: ['aiPolicyBlocklist=valid/repo,invalid-entry'] });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ aiPolicyBlocklist: ['valid/repo'] });
    consoleSpy.mockRestore();
  });

  it('should handle dormantDays setting', async () => {
    await runSetup({ set: ['dormantDays=14'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ dormantThresholdDays: 14 });
  });

  it('should handle approachingDays setting', async () => {
    await runSetup({ set: ['approachingDays=10'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ approachingDormantDays: 10 });
  });

  it('should handle labels setting', async () => {
    await runSetup({ set: ['labels=bug,feature'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ labels: ['bug', 'feature'] });
  });

  it('should handle showHealthCheck=true', async () => {
    await runSetup({ set: ['showHealthCheck=true'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ showHealthCheck: true });
  });

  it('should handle squashByDefault=true', async () => {
    await runSetup({ set: ['squashByDefault=true'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ squashByDefault: true });
  });

  it('should handle squashByDefault=false', async () => {
    await runSetup({ set: ['squashByDefault=false'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ squashByDefault: false });
  });

  it('should handle minStars setting', async () => {
    await runSetup({ set: ['minStars=100'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ minStars: 100 });
  });

  it('should throw for minStars with non-numeric value', async () => {
    await expect(runSetup({ set: ['minStars=abc'] })).rejects.toThrow('Invalid value for minStars');
  });

  it('should accept minStars=0', async () => {
    await runSetup({ set: ['minStars=0'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ minStars: 0 });
  });

  it('should handle includeDocIssues=false', async () => {
    await runSetup({ set: ['includeDocIssues=false'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ includeDocIssues: false });
  });

  it('should warn for all-invalid aiPolicyBlocklist entries', async () => {
    const result = await runSetup({ set: ['aiPolicyBlocklist=not-a-repo'] });

    expect(result).toHaveProperty('warnings');
    if ('warnings' in result && result.warnings) {
      expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('All entries were invalid')]));
    }
    expect(mockUpdateConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ aiPolicyBlocklist: expect.anything() }),
    );
  });

  it('should handle unknown setting key', async () => {
    const result = await runSetup({ set: ['unknownKey=value'] });

    expect(result).toHaveProperty('warnings');
    if ('warnings' in result && result.warnings) {
      expect(result.warnings).toContain('Unknown setting: unknownKey');
    }
  });

  it('should not complete=true when value is not true', async () => {
    await runSetup({ set: ['complete=false'] });
    expect(mockMarkSetupComplete).not.toHaveBeenCalled();
  });

  it('should handle setting with equals in value', async () => {
    await runSetup({ set: ['username=user=name'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'user=name' });
  });

  it('should handle empty set array', async () => {
    const result = await runSetup({ set: [] });
    // No --set values means show status
    expect(result).toEqual(expect.objectContaining({ setupComplete: true }));
  });

  it('should handle valid projectCategories', async () => {
    const result = (await runSetup({ set: ['projectCategories=devtools,nonprofit'] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ projectCategories: ['devtools', 'nonprofit'] });
    expect(result.settings.projectCategories).toBe('devtools, nonprofit');
  });

  it('should warn for invalid projectCategories', async () => {
    const result = (await runSetup({ set: ['projectCategories=devtools,invalid-cat'] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ projectCategories: ['devtools'] });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Unknown project categories')]));
  });

  it('should handle all-invalid projectCategories', async () => {
    const result = (await runSetup({ set: ['projectCategories=bad1,bad2'] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ projectCategories: [] });
    expect(result.settings.projectCategories).toBe('(empty)');
  });

  it('should handle valid preferredOrgs (lowercased)', async () => {
    const result = (await runSetup({ set: ['preferredOrgs=vercel,remix-run'] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ preferredOrgs: ['vercel', 'remix-run'] });
    expect(result.settings.preferredOrgs).toBe('vercel, remix-run');
  });

  it('should warn when preferredOrgs contains slash (repo path)', async () => {
    const result = (await runSetup({ set: ['preferredOrgs=vercel/next.js,remix-run'] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ preferredOrgs: ['remix-run'] });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('looks like a repo path')]));
  });

  it('should warn for invalid org names in preferredOrgs', async () => {
    const result = (await runSetup({ set: ['preferredOrgs=valid-org,bad org!'] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ preferredOrgs: ['valid-org'] });
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('not a valid GitHub organization name')]),
    );
  });

  it('should normalize preferredOrgs to lowercase and deduplicate', async () => {
    await runSetup({ set: ['preferredOrgs=Vercel,vercel,Remix-Run'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ preferredOrgs: ['vercel', 'remix-run'] });
  });

  it('should handle empty preferredOrgs value', async () => {
    const result = (await runSetup({ set: ['preferredOrgs='] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ preferredOrgs: [] });
    expect(result.settings.preferredOrgs).toBe('(empty)');
  });

  it('should include projectCategories and preferredOrgs in setup prompts', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, setupComplete: false } }),
      updateConfig: mockUpdateConfig,
      save: mockSave,
    } as any);

    const result = (await runSetup({})) as SetupRequiredOutput;
    const settings = result.prompts.map((p) => p.setting);
    expect(settings).toContain('projectCategories');
    expect(settings).toContain('preferredOrgs');
  });

  it('should include new fields in setupComplete config output', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({
        config: {
          ...DEFAULT_CONFIG,
          projectCategories: ['devtools'],
          preferredOrgs: ['vercel'],
        },
      }),
      updateConfig: mockUpdateConfig,
      save: mockSave,
    } as any);

    const result = await runSetup({});
    expect(result).toEqual(
      expect.objectContaining({
        setupComplete: true,
        config: expect.objectContaining({
          projectCategories: ['devtools'],
          preferredOrgs: ['vercel'],
          scope: [],
        }),
      }),
    );
  });

  it('should handle valid scope setting', async () => {
    const result = (await runSetup({ set: ['scope=beginner,intermediate'] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ scope: ['beginner', 'intermediate'] });
    expect(result.settings.scope).toBe('beginner, intermediate');
  });

  it('should warn for invalid scope values', async () => {
    const result = (await runSetup({ set: ['scope=beginner,expert'] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ scope: ['beginner'] });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Unknown issue scopes')]));
  });

  it('should clear scope when empty value provided', async () => {
    const result = (await runSetup({ set: ['scope='] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ scope: undefined });
    expect(result.settings.scope).toBe('(empty — using labels only)');
  });

  it('should deduplicate scope values', async () => {
    await runSetup({ set: ['scope=beginner,beginner,intermediate'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ scope: ['beginner', 'intermediate'] });
  });

  it('should include scope in setup prompts', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, setupComplete: false } }),
      updateConfig: mockUpdateConfig,
      save: mockSave,
    } as any);

    const result = (await runSetup({})) as SetupRequiredOutput;
    const settings = result.prompts.map((p) => p.setting);
    expect(settings).toContain('scope');
  });
});

describe('runCheckSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return setup complete status', async () => {
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn().mockReturnValue(true),
      getState: vi.fn().mockReturnValue({ config: { githubUsername: 'testuser' } }),
    } as any);

    const result = await runCheckSetup();

    expect(result).toEqual({
      setupComplete: true,
      username: 'testuser',
    });
  });

  it('should return setup incomplete status', async () => {
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn().mockReturnValue(false),
      getState: vi.fn().mockReturnValue({ config: { githubUsername: '' } }),
    } as any);

    const result = await runCheckSetup();

    expect(result).toEqual({
      setupComplete: false,
      username: '',
    });
  });
});
