/**
 * Tests for setup and check-setup commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: vi.fn(),
    maybeCheckpoint: vi.fn().mockResolvedValue(null),
    DEFAULT_CONFIG: {
      aiPolicyBlocklist: ['matplotlib/matplotlib'],
    },
  };
});

vi.mock('./validation.js', () => ({
  validateGitHubUsername: vi.fn(),
}));

import { getStateManager, maybeCheckpoint, getSetupKeys } from '../core/index.js';
import { runSetup, runCheckSetup } from './setup.js';
import type { SetupSetOutput, SetupRequiredOutput } from './setup.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockMaybeCheckpoint = vi.mocked(maybeCheckpoint);

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
  const mockUpdateConfig = vi.fn();
  const mockMarkSetupComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG } }),
      updateConfig: mockUpdateConfig,
      markSetupComplete: mockMarkSetupComplete,
      batch: (fn: () => void) => fn(),
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
      batch: (fn: () => void) => fn(),
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
  });

  it('should handle complete=true setting', async () => {
    await runSetup({ set: ['complete=true'] });

    expect(mockMarkSetupComplete).toHaveBeenCalled();
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

  it('should set avoidRepos as a whole-list replace, filtering invalid entries (#1464)', async () => {
    const result = (await runSetup({ set: ['avoidRepos=owner/repo,other/repo,not-a-repo'] })) as SetupSetOutput;

    expect(mockUpdateConfig).toHaveBeenCalledWith({ avoidRepos: ['owner/repo', 'other/repo'] });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('not-a-repo')]));
  });

  it('should warn and not update avoidRepos when all entries are invalid (#1464)', async () => {
    const result = (await runSetup({ set: ['avoidRepos=not-a-repo'] })) as SetupSetOutput;

    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('All entries were invalid')]));
    expect(mockUpdateConfig).not.toHaveBeenCalledWith(expect.objectContaining({ avoidRepos: expect.anything() }));
  });

  it('should clear avoidRepos when set to an empty value (#1464)', async () => {
    const result = (await runSetup({ set: ['avoidRepos='] })) as SetupSetOutput;

    expect(mockUpdateConfig).toHaveBeenCalledWith({ avoidRepos: [] });
    expect(result.settings.avoidRepos).toBe('(empty)');
  });

  it('should set boostIssueTypes as a deduped whole-list replace (#1464)', async () => {
    await runSetup({ set: ['boostIssueTypes=bug,good first issue,bug'] });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ boostIssueTypes: ['bug', 'good first issue'] });
  });

  it('should clear boostIssueTypes when set to an empty value (#1464)', async () => {
    const result = (await runSetup({ set: ['boostIssueTypes='] })) as SetupSetOutput;

    expect(mockUpdateConfig).toHaveBeenCalledWith({ boostIssueTypes: [] });
    expect(result.settings.boostIssueTypes).toBe('(empty)');
  });

  it('should handle dormantDays setting', async () => {
    await runSetup({ set: ['dormantDays=14'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ dormantThresholdDays: 14 });
  });

  // Regression: every key the registry advertises as `settableVia: 'setup'` must
  // have a switch handler in runSetup. Three keys (skipBroadWhenSufficientResults,
  // healthCheckFreshnessMinutes, reviewMaxPasses) shipped advertised-but-unhandled,
  // so `setup --set <key>=…` hit the `default` branch and threw the self-referential
  // "Unknown setting … Did you mean <same key>?" error. Probe with '1' (a valid
  // value for the numeric keys, harmless for the rest): a handled key never yields
  // the unknown-key error; an unhandled key always does.
  it('handles every settableVia:setup registry key (no unknown-key error)', async () => {
    const unhandled: string[] = [];
    for (const key of getSetupKeys()) {
      try {
        await runSetup({ set: [`${key}=1`] });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/Unknown setting|Did you mean/.test(message)) {
          unhandled.push(key);
        }
      }
    }
    expect(unhandled).toEqual([]);
  });

  it('should handle skipBroadWhenSufficientResults setting', async () => {
    const result = (await runSetup({ set: ['skipBroadWhenSufficientResults=5'] })) as SetupSetOutput;
    expect(mockUpdateConfig).toHaveBeenCalledWith({ skipBroadWhenSufficientResults: 5 });
    expect(result.settings.skipBroadWhenSufficientResults).toBe('5');
  });

  it('should allow skipBroadWhenSufficientResults=0 (always run broad phase)', async () => {
    await runSetup({ set: ['skipBroadWhenSufficientResults=0'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ skipBroadWhenSufficientResults: 0 });
  });

  it('should reject a negative skipBroadWhenSufficientResults', async () => {
    await expect(runSetup({ set: ['skipBroadWhenSufficientResults=-1'] })).rejects.toThrow(/non-negative integer/);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should handle healthCheckFreshnessMinutes setting', async () => {
    await runSetup({ set: ['healthCheckFreshnessMinutes=45'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ healthCheckFreshnessMinutes: 45 });
  });

  it('should reject a non-positive healthCheckFreshnessMinutes', async () => {
    await expect(runSetup({ set: ['healthCheckFreshnessMinutes=0'] })).rejects.toThrow(/positive integer/);
  });

  it('should handle reviewMaxPasses setting', async () => {
    await runSetup({ set: ['reviewMaxPasses=4'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ reviewMaxPasses: 4 });
  });

  it('should handle approachingDays setting', async () => {
    await runSetup({ set: ['approachingDays=10'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ approachingDormantDays: 10 });
  });

  it('should handle labels setting', async () => {
    await runSetup({ set: ['labels=bug,feature'] });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ labels: ['bug', 'feature'] });
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

  it('should reject unknown setting with a did-you-mean suggestion', async () => {
    await expect(runSetup({ set: ['usrname=value'] })).rejects.toThrow(/Unknown setting "usrname"/);
    await expect(runSetup({ set: ['usrname=value'] })).rejects.toThrow(/did you mean "username"/i);
  });

  it('should reject totally-unrecognized keys but still point at --list-keys', async () => {
    await expect(runSetup({ set: ['totallyBogus=value'] })).rejects.toThrow(/config --list-keys/);
  });

  it('rejects unknown keys before applying any valid ones in the same batch', async () => {
    // If a --set list contains an unknown key, no state mutations from the batch
    // should be applied (avoids partial-update drift in long-running consumers
    // like the MCP server that share the StateManager singleton).
    await expect(runSetup({ set: ['username=valid', 'totallyBogus=x'] })).rejects.toThrow(/Unknown setting/);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('should set maxIssueAgeDays', async () => {
    const result = (await runSetup({ set: ['maxIssueAgeDays=60'] })) as SetupSetOutput;

    expect(mockUpdateConfig).toHaveBeenCalledWith({ maxIssueAgeDays: 60 });
    expect(result.settings).toMatchObject({ maxIssueAgeDays: '60' });
  });

  it('should reject invalid maxIssueAgeDays', async () => {
    await expect(runSetup({ set: ['maxIssueAgeDays=0'] })).rejects.toThrow(/positive integer/);
    await expect(runSetup({ set: ['maxIssueAgeDays=-5'] })).rejects.toThrow(/positive integer/);
  });

  it('should set minRepoScoreThreshold', async () => {
    const result = (await runSetup({ set: ['minRepoScoreThreshold=0'] })) as SetupSetOutput;

    expect(mockUpdateConfig).toHaveBeenCalledWith({ minRepoScoreThreshold: 0 });
    expect(result.settings).toMatchObject({ minRepoScoreThreshold: '0' });
  });

  it('should reject negative minRepoScoreThreshold', async () => {
    await expect(runSetup({ set: ['minRepoScoreThreshold=-1'] })).rejects.toThrow(/non-negative integer/);
  });

  it('should set skippedIssuesPath', async () => {
    const result = (await runSetup({ set: ['skippedIssuesPath=/tmp/skip.txt'] })) as SetupSetOutput;

    expect(mockUpdateConfig).toHaveBeenCalledWith({ skippedIssuesPath: '/tmp/skip.txt' });
    expect(result.settings).toMatchObject({ skippedIssuesPath: '/tmp/skip.txt' });
  });

  it('should clear skippedIssuesPath when value is empty', async () => {
    const result = (await runSetup({ set: ['skippedIssuesPath='] })) as SetupSetOutput;

    expect(mockUpdateConfig).toHaveBeenCalledWith({ skippedIssuesPath: undefined });
    expect(result.settings).toMatchObject({ skippedIssuesPath: '(cleared)' });
  });

  it('should set autoFormatBeforePush to true', async () => {
    const result = (await runSetup({ set: ['autoFormatBeforePush=true'] })) as SetupSetOutput;

    expect(mockUpdateConfig).toHaveBeenCalledWith({ autoFormatBeforePush: true });
    expect(result.settings).toMatchObject({ autoFormatBeforePush: 'true' });
  });

  it('should set autoFormatBeforePush to false', async () => {
    const result = (await runSetup({ set: ['autoFormatBeforePush=false'] })) as SetupSetOutput;

    expect(mockUpdateConfig).toHaveBeenCalledWith({ autoFormatBeforePush: false });
    expect(result.settings).toMatchObject({ autoFormatBeforePush: 'false' });
  });

  it('should reject non-boolean autoFormatBeforePush values', async () => {
    await expect(runSetup({ set: ['autoFormatBeforePush=yes'] })).rejects.toThrow(/must be "true" or "false"/i);
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
      batch: (fn: () => void) => fn(),
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
      batch: (fn: () => void) => fn(),
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
      batch: (fn: () => void) => fn(),
    } as any);

    const result = (await runSetup({})) as SetupRequiredOutput;
    const settings = result.prompts.map((p) => p.setting);
    expect(settings).toContain('scope');
  });

  // scoreThreshold tests removed — field dropped in v3 schema

  describe('gist checkpoint (#1440)', () => {
    it('calls maybeCheckpoint exactly once per successful --set', async () => {
      await runSetup({ set: ['username=newuser', 'maxActivePRs=5'] });

      expect(mockMaybeCheckpoint).toHaveBeenCalledTimes(1);
      expect(mockMaybeCheckpoint).toHaveBeenCalledWith(expect.anything(), 'setup');
    });

    it('threads the checkpoint warning into gistSyncWarning when the Gist push fails', async () => {
      const warning = 'Gist checkpoint push failed after retry; the local mutation is saved';
      mockMaybeCheckpoint.mockResolvedValueOnce(warning);

      const result = (await runSetup({ set: ['username=newuser'] })) as SetupSetOutput;

      expect(result.success).toBe(true);
      expect(result.gistSyncWarning).toBe(warning);
    });

    it('omits gistSyncWarning entirely when the checkpoint succeeds', async () => {
      mockMaybeCheckpoint.mockResolvedValueOnce(null);

      const result = await runSetup({ set: ['username=newuser'] });

      expect(result).not.toHaveProperty('gistSyncWarning');
    });

    it('does not checkpoint when showing setup status (no --set)', async () => {
      await runSetup({});

      expect(mockMaybeCheckpoint).not.toHaveBeenCalled();
    });

    it('does not checkpoint when returning setup prompts', async () => {
      mockGetStateManager.mockReturnValue({
        getState: vi.fn().mockReturnValue({ config: { ...DEFAULT_CONFIG, setupComplete: false } }),
        updateConfig: mockUpdateConfig,
        batch: (fn: () => void) => fn(),
      } as any);

      await runSetup({});

      expect(mockMaybeCheckpoint).not.toHaveBeenCalled();
    });

    it('does not checkpoint when --set validation throws', async () => {
      await expect(runSetup({ set: ['unknownKey=value'] })).rejects.toThrow();

      expect(mockMaybeCheckpoint).not.toHaveBeenCalled();
    });
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
