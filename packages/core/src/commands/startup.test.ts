/**
 * Tests for startup command helper functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseIssueListPathFromConfig, countIssueListItems } from './startup.js';

// --- Mocks for runStartup dashboard tests ---

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(() => ({
    isSetupComplete: vi.fn(() => true),
  })),
  getGitHubToken: vi.fn(() => 'fake-token'),
  getCLIVersion: vi.fn(() => '0.0.0-test'),
  getStatePath: vi.fn(() => '/tmp/state.json'),
  detectGitHubUsername: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('./daily.js', () => ({
  executeDailyCheck: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('./dashboard-lifecycle.js', () => ({
  launchDashboardServer: vi.fn(),
}));

// Mock fs so detectIssueList doesn't hit the real filesystem
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

describe('parseIssueListPathFromConfig', () => {
  it('should extract issueListPath from YAML frontmatter', () => {
    const config = `---
setupComplete: true
issueListPath: open-source/potential-issue-list.md
---

Some content here.
`;
    expect(parseIssueListPathFromConfig(config)).toBe('open-source/potential-issue-list.md');
  });

  it('should handle quoted paths', () => {
    const config = `---
issueListPath: "my issues/list.md"
---
`;
    expect(parseIssueListPathFromConfig(config)).toBe('my issues/list.md');
  });

  it('should handle single-quoted paths', () => {
    const config = `---
issueListPath: 'oss/issues.md'
---
`;
    expect(parseIssueListPathFromConfig(config)).toBe('oss/issues.md');
  });

  it('should return undefined when no frontmatter present', () => {
    const config = `Just some content without frontmatter.`;
    expect(parseIssueListPathFromConfig(config)).toBeUndefined();
  });

  it('should return undefined when issueListPath not in frontmatter', () => {
    const config = `---
setupComplete: true
username: testuser
---
`;
    expect(parseIssueListPathFromConfig(config)).toBeUndefined();
  });

  it('should handle empty frontmatter', () => {
    const config = `---
---
`;
    expect(parseIssueListPathFromConfig(config)).toBeUndefined();
  });

  it('should trim whitespace from path', () => {
    const config = `---
issueListPath:   path/with/spaces.md
---
`;
    expect(parseIssueListPathFromConfig(config)).toBe('path/with/spaces.md');
  });
});

describe('countIssueListItems', () => {
  it('should count available and completed items', () => {
    const content = `## Pursue — Ready to Contribute

### org/repo (500) — Description
- [#123](https://github.com/org/repo/issues/123) — Fix bug
  - **Low complexity**

### ~~org/done (200) — Done repo~~
- ~~[#456](https://github.com/org/done/issues/456) — Old issue~~
  - **Done** — PR #42 submitted

### org/another (300)
- [#789](https://github.com/org/another/issues/789) — New feature
  - **Medium complexity**
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(2);
    expect(result.completedCount).toBe(1);
  });

  it('should return zeros for empty content', () => {
    const result = countIssueListItems('');
    expect(result.availableCount).toBe(0);
    expect(result.completedCount).toBe(0);
  });

  it('should return zeros for content with no list items', () => {
    const content = `## Some heading

Just some text, no issue list items.
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(0);
    expect(result.completedCount).toBe(0);
  });

  it('should detect strikethrough as completed', () => {
    const content = `- ~~[#1](https://github.com/o/r/issues/1) — Done item~~
- [#2](https://github.com/o/r/issues/2) — Active item
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(1);
  });

  it('should detect **Done** marker as completed', () => {
    const content = `- [#1](https://github.com/o/r/issues/1) — Item with **Done** marker
- [#2](https://github.com/o/r/issues/2) — Active item
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(1);
  });

  it('should handle indented list items', () => {
    const content = `  - [#1](https://github.com/o/r/issues/1) — Indented available
  - ~~[#2](https://github.com/o/r/issues/2) — Indented done~~
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(1);
  });

  it('should not count lines without GitHub URLs', () => {
    const content = `- Some regular list item
- Another item
- [#1](https://github.com/o/r/issues/1) — Real issue list item
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(0);
  });

  it('should handle mixed available and completed items', () => {
    const content = `- [#1](https://github.com/o/r/issues/1) — Available 1
- ~~[#2](https://github.com/o/r/issues/2) — Done 1~~
- [#3](https://github.com/o/r/issues/3) — Available 2
- [#4](https://github.com/o/r/issues/4) — Has **Done** in text
- ~~[#5](https://github.com/o/r/issues/5) — Done 2~~
- [#6](https://github.com/o/r/issues/6) — Available 3
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(3);
    expect(result.completedCount).toBe(3);
  });

  it('excludes items with **Skip** sub-bullet from availableCount (#907)', () => {
    const content = `### Repo
- [#1](https://github.com/owner/repo/issues/1) — Actionable
  - **Maybe** — Score 8/10
- [#2](https://github.com/owner/repo/issues/2) — Already vetted out
  - **Skip** — Score 3/10. Existing PR.
- [#3](https://github.com/owner/repo/issues/3) — Merged elsewhere
  - **Merged** — PR merged upstream.
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(2);
  });
});

// --- detectIssueList tests ---

import * as fsImport from 'fs';

describe('detectIssueList', () => {
  let detectIssueList: typeof import('./startup.js').detectIssueList;
  let existsSyncMock: ReturnType<typeof vi.fn>;
  let origReadFileSync: typeof fsImport.readFileSync;

  beforeEach(async () => {
    vi.clearAllMocks();
    const startupMod = await import('./startup.js');
    detectIssueList = startupMod.detectIssueList;
    const fsMod = await import('fs');
    existsSyncMock = fsMod.existsSync as ReturnType<typeof vi.fn>;
    origReadFileSync = (fsImport as any).readFileSync;
  });

  afterEach(() => {
    (fsImport as any).readFileSync = origReadFileSync;
  });

  it('should return undefined when no issue list file exists', () => {
    existsSyncMock.mockReturnValue(false);
    const result = detectIssueList();
    expect(result).toBeUndefined();
  });

  it('should detect issue list from config file', () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p === '.claude/oss-autopilot/config.md') return true;
      if (typeof p === 'string' && p === 'custom/issues.md') return true;
      return false;
    });
    (fsImport as any).readFileSync = vi.fn().mockImplementation((path: string) => {
      if (path === '.claude/oss-autopilot/config.md') {
        return '---\nissueListPath: custom/issues.md\n---\n';
      }
      return '- [#1](https://github.com/o/r/issues/1) — Issue\n';
    });

    const result = detectIssueList();

    expect(result).toBeDefined();
    expect(result?.path).toBe('custom/issues.md');
    expect(result?.source).toBe('configured');
  });

  it('should handle config file read error gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    existsSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p === '.claude/oss-autopilot/config.md') return true;
      return false;
    });
    (fsImport as any).readFileSync = vi.fn().mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const result = detectIssueList();

    // Should return undefined because config read failed and no probes match
    expect(result).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('should auto-detect from known probe paths', () => {
    existsSyncMock.mockImplementation((path: string) => {
      return typeof path === 'string' && path === 'issues.md';
    });
    (fsImport as any).readFileSync = vi
      .fn()
      .mockReturnValue(
        '- [#1](https://github.com/o/r/issues/1) — Issue\n- ~~[#2](https://github.com/o/r/issues/2) — Done~~\n',
      );

    const result = detectIssueList();

    expect(result).toBeDefined();
    expect(result?.path).toBe('issues.md');
    expect(result?.source).toBe('auto-detected');
    expect(result?.availableCount).toBe(1);
    expect(result?.completedCount).toBe(1);
  });

  it('should detect issue list from state.json config (primary)', async () => {
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getState: vi.fn(() => ({ config: { issueListPath: 'state/issues.md' } })),
    } as any);

    existsSyncMock.mockImplementation((p: string) => {
      return typeof p === 'string' && p === 'state/issues.md';
    });
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    const result = detectIssueList();

    expect(result).toBeDefined();
    expect(result?.path).toBe('state/issues.md');
    expect(result?.source).toBe('configured');
  });

  it('should prefer state.json over config.md when both set', async () => {
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getState: vi.fn(() => ({ config: { issueListPath: 'state/issues.md' } })),
    } as any);

    existsSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p === 'state/issues.md') return true;
      if (typeof p === 'string' && p === '.claude/oss-autopilot/config.md') return true;
      if (typeof p === 'string' && p === 'config/issues.md') return true;
      return false;
    });
    (fsImport as any).readFileSync = vi.fn().mockImplementation((path: string) => {
      if (path === '.claude/oss-autopilot/config.md') {
        return '---\nissueListPath: config/issues.md\n---\n';
      }
      return '- [#1](https://github.com/o/r/issues/1) — Issue\n';
    });

    const result = detectIssueList();

    // state.json path should win
    expect(result?.path).toBe('state/issues.md');
    expect(result?.source).toBe('configured');
  });

  it('should detect skippedIssuesPath when skip file exists alongside issue list', async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p === 'open-source/issues.md') return true;
      if (typeof p === 'string' && p === 'open-source/skipped-issues.md') return true;
      return false;
    });
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    // Override getStateManager to return issueListPath pointing to our probe path
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getState: vi.fn(() => ({ config: { issueListPath: 'open-source/issues.md' } })),
    } as any);

    const result = detectIssueList();

    expect(result).toBeDefined();
    expect(result?.path).toBe('open-source/issues.md');
    expect(result?.skippedIssuesPath).toBe('open-source/skipped-issues.md');
  });

  it('should return undefined skippedIssuesPath when skip file does not exist', async () => {
    existsSyncMock.mockImplementation((p: string) => {
      return typeof p === 'string' && p === 'issues.md';
    });
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    const result = detectIssueList();

    expect(result).toBeDefined();
    expect(result?.skippedIssuesPath).toBeUndefined();
  });
});

// --- runStartup behavior tests ---

describe('runStartup behavior', () => {
  // Lazy imports so vi.mock() is in effect
  let runStartup: typeof import('./startup.js').runStartup;
  let executeDailyCheck: ReturnType<typeof vi.fn>;
  let execFile: ReturnType<typeof vi.fn>;
  let launchDashboardServer: ReturnType<typeof vi.fn>;

  function makeDailyOutput(totalActivePRs: number) {
    return {
      digest: {
        generatedAt: new Date().toISOString(),
        openPRs: [],
        needsAddressingPRs: [],
        waitingOnMaintainerPRs: [],
        recentlyClosedPRs: [],
        recentlyMergedPRs: [],
        shelvedPRs: [],
        autoUnshelvedPRs: [],
        summary: {
          totalActivePRs,
          totalMergedAllTime: 0,
          mergeRate: 0,
          totalNeedingAttention: 0,
        },
      },
      capacity: {
        hasCapacity: true,
        activePRCount: totalActivePRs,
        maxActivePRs: 10,
        shelvedPRCount: 0,
        criticalIssueCount: 0,
        reason: `You have capacity: ${totalActivePRs}/10 active PRs, no critical issues`,
      },
      summary: '',
      briefSummary: `${totalActivePRs} Active PRs`,
      actionableIssues: [],
      actionMenu: {
        items: [],
        context: {
          hasActionableIssues: false,
          actionableCount: 0,
          hasCapacity: true,
          hasIssueResponses: false,
          issueResponseCount: 0,
        },
      },
      commentedIssues: [],
      repoGroups: [],
      failures: [],
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    const startupMod = await import('./startup.js');
    runStartup = startupMod.runStartup;

    const dailyMod = await import('./daily.js');
    executeDailyCheck = dailyMod.executeDailyCheck as ReturnType<typeof vi.fn>;

    const cpMod = await import('child_process');
    execFile = cpMod.execFile as unknown as ReturnType<typeof vi.fn>;

    const lifecycleMod = await import('./dashboard-lifecycle.js');
    launchDashboardServer = lifecycleMod.launchDashboardServer as unknown as ReturnType<typeof vi.fn>;
    // Default: SPA not available (assets not built)
    launchDashboardServer.mockResolvedValue(null);
  });

  it('should NOT open browser when totalActivePRs is 0', async () => {
    const daily = makeDailyOutput(0);
    executeDailyCheck.mockResolvedValue(daily);

    const result = await runStartup();

    expect(execFile).not.toHaveBeenCalled();
    expect(result.daily?.briefSummary).not.toContain('Dashboard opened in browser');
  });

  it('should log error when SPA unavailable and totalActivePRs > 0', async () => {
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue(null);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runStartup();

    expect(launchDashboardServer).toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(result.dashboardUrl).toBeUndefined();
    expect(result.daily?.briefSummary).not.toContain('Dashboard opened in browser');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SPA assets not found'));
    consoleSpy.mockRestore();
  });

  it('should return setup incomplete when setup is not done', async () => {
    const { getStateManager } = await import('../core/index.js');
    const mockGetStateManager = getStateManager as ReturnType<typeof vi.fn>;
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn(() => false),
    });

    const result = await runStartup();

    expect(result.setupComplete).toBe(false);
  });

  it('should return auth error when no token', async () => {
    const { getStateManager, getGitHubToken } = await import('../core/index.js');
    const mockGetStateManager = getStateManager as ReturnType<typeof vi.fn>;
    const mockGetGitHubToken = getGitHubToken as ReturnType<typeof vi.fn>;
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn(() => true),
    });
    mockGetGitHubToken.mockReturnValue(null);

    const result = await runStartup();

    expect(result.setupComplete).toBe(true);
    expect(result.authError).toContain('authentication required');
  });

  it('should propagate daily check failure to caller', async () => {
    // Reset mocks to ensure auth passes
    const { getStateManager: gsm, getGitHubToken: ght } = await import('../core/index.js');
    (gsm as ReturnType<typeof vi.fn>).mockReturnValue({ isSetupComplete: vi.fn(() => true) });
    (ght as ReturnType<typeof vi.fn>).mockReturnValue('fake-token');

    executeDailyCheck.mockRejectedValue(new Error('Network error'));

    await expect(runStartup()).rejects.toThrow('Network error');
  });

  it('should return version and daily data on success', async () => {
    const daily = makeDailyOutput(2);
    executeDailyCheck.mockResolvedValue(daily);

    const result = await runStartup();

    expect(result.version).toBeDefined();
    expect(result.setupComplete).toBe(true);
    expect(result.daily).toBeDefined();
  });

  it('should open SPA dashboard URL when SPA launches successfully', async () => {
    const daily = makeDailyOutput(5);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({ url: 'http://oss.localhost:3000', port: 3000, alreadyRunning: false });

    const result = await runStartup();

    // Opens SPA URL
    expect(execFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['http://oss.localhost:3000']),
      expect.any(Function),
    );
    expect(result.dashboardUrl).toBe('http://oss.localhost:3000');
    expect(result.daily?.briefSummary).toContain('Dashboard opened in browser');
  });

  it('should refresh existing dashboard instead of opening new tab (#830)', async () => {
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({ url: 'http://oss.localhost:3001', port: 3001, alreadyRunning: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await runStartup();

    expect(result.dashboardUrl).toBe('http://oss.localhost:3001');
    // Should NOT open a new browser tab
    expect(execFile).not.toHaveBeenCalled();
    // Should trigger a refresh on the running server
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.daily?.briefSummary).toContain('Dashboard refreshed');
    expect(result.daily?.briefSummary).not.toContain('Dashboard opened in browser');
    fetchSpy.mockRestore();
  });

  it('should still succeed when dashboard refresh fails (#830)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({ url: 'http://oss.localhost:3001', port: 3001, alreadyRunning: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

    const result = await runStartup();

    // Startup should succeed despite refresh failure
    expect(result.dashboardUrl).toBe('http://oss.localhost:3001');
    expect(execFile).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Could not trigger dashboard refresh'));
    // Should say "running" not "refreshed" when refresh fails
    expect(result.daily?.briefSummary).toContain('Dashboard running');
    expect(result.daily?.briefSummary).not.toContain('Dashboard refreshed');
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should log when dashboard refresh returns non-200 (#830)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({ url: 'http://oss.localhost:3001', port: 3001, alreadyRunning: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Too many requests', { status: 429 }));

    const result = await runStartup();

    expect(result.dashboardUrl).toBe('http://oss.localhost:3001');
    expect(execFile).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Dashboard refresh returned 429'));
    // Should say "running" not "refreshed" on non-200
    expect(result.daily?.briefSummary).toContain('Dashboard running');
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should not launch SPA when totalActivePRs is 0', async () => {
    const daily = makeDailyOutput(0);
    executeDailyCheck.mockResolvedValue(daily);

    const result = await runStartup();

    expect(launchDashboardServer).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(result.dashboardUrl).toBeUndefined();
  });

  it('should log error when SPA launch throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const daily = makeDailyOutput(5);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockRejectedValue(new Error('spawn ENOENT'));

    const result = await runStartup();

    // Should not crash — dashboard is unavailable but startup continues
    expect(result.dashboardUrl).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
    expect(result.daily?.briefSummary).not.toContain('Dashboard opened in browser');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SPA dashboard launch failed'), 'spawn ENOENT');
    consoleSpy.mockRestore();
  });

  it('should continue gracefully when SPA is unavailable', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue(null);

    const result = await runStartup();

    expect(result.dashboardUrl).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
    expect(result.daily?.briefSummary).not.toContain('Dashboard opened in browser');
    consoleSpy.mockRestore();
  });

  describe('auto-detect flow', () => {
    it('should auto-detect username when setup incomplete and gh available', async () => {
      const { getStateManager: gsm, getGitHubToken: ght, detectGitHubUsername: dgu } = await import('../core/index.js');
      let setupComplete = false;
      (gsm as ReturnType<typeof vi.fn>).mockReturnValue({
        isSetupComplete: vi.fn(() => setupComplete),
        initializeWithDefaults: vi.fn((_username: string) => {
          setupComplete = true;
        }),
        getState: vi.fn(() => ({ config: { setupComplete: true, githubUsername: 'autouser' } })),
      });
      (ght as ReturnType<typeof vi.fn>).mockReturnValue('fake-token');
      (dgu as ReturnType<typeof vi.fn>).mockResolvedValue('autouser');
      executeDailyCheck.mockResolvedValue(makeDailyOutput(0));

      const result = await runStartup();

      expect(result.setupComplete).toBe(true);
      expect(result.autoDetected).toBe(true);
      expect(dgu).toHaveBeenCalled();
      const mockSM = (gsm as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(mockSM.initializeWithDefaults).toHaveBeenCalledWith('autouser');
    });

    it('should return setupComplete:false when initializeWithDefaults throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { getStateManager: gsm, detectGitHubUsername: dgu, getGitHubToken: ght } = await import('../core/index.js');
      (gsm as ReturnType<typeof vi.fn>).mockReturnValue({
        isSetupComplete: vi.fn(() => false),
        initializeWithDefaults: vi.fn(() => {
          throw new Error('EACCES: permission denied');
        }),
      });
      (dgu as ReturnType<typeof vi.fn>).mockResolvedValue('autouser');
      (ght as ReturnType<typeof vi.fn>).mockReturnValue('fake-token');

      const result = await runStartup();

      expect(result.setupComplete).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to save config'),
        expect.stringContaining('EACCES'),
      );
      consoleSpy.mockRestore();
    });

    it('should return setupComplete:false when auto-detect fails', async () => {
      const { getStateManager: gsm, detectGitHubUsername: dgu } = await import('../core/index.js');
      (gsm as ReturnType<typeof vi.fn>).mockReturnValue({
        isSetupComplete: vi.fn(() => false),
      });
      (dgu as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await runStartup();

      expect(result.setupComplete).toBe(false);
      expect(result.autoDetected).toBeUndefined();
    });
  });
});
