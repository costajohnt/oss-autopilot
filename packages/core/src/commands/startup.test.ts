/**
 * Tests for startup command helper functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as nodePath from 'node:path';
import { parseIssueListPathFromConfig, countIssueListItems } from './startup.js';

// --- Mocks for runStartup dashboard tests ---

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(() => ({
    isSetupComplete: vi.fn(() => true),
    getLastOvernight: vi.fn(() => undefined),
  })),
  getGitHubToken: vi.fn(() => 'fake-token'),
  getGitHubTokenAsync: vi.fn(() => Promise.resolve('fake-token')),
  getCLIVersion: vi.fn(() => '0.0.0-test'),
  getStatePath: vi.fn(() => '/tmp/state.json'),
  detectGitHubUsername: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('./daily.js', () => ({
  executeDailyCheck: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('./dashboard-lifecycle.js', () => ({
  launchDashboardServer: vi.fn(),
}));

vi.mock('./dashboard-process.js', () => ({
  recordBrowserOpened: vi.fn(),
}));

// Mock fs so detectIssueList doesn't hit the real filesystem
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
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

import * as fsImport from 'node:fs';

describe('detectIssueList', () => {
  let detectIssueList: typeof import('./startup.js').detectIssueList;
  let existsSyncMock: ReturnType<typeof vi.fn>;
  let origReadFileSync: typeof fsImport.readFileSync;

  beforeEach(async () => {
    vi.clearAllMocks();
    const startupMod = await import('./startup.js');
    detectIssueList = startupMod.detectIssueList;
    const fsMod = await import('node:fs');
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
      if (p === '.claude/oss-autopilot/config.md') return true;
      return nodePath.resolve(p) === nodePath.resolve('custom/issues.md');
    });
    (fsImport as any).readFileSync = vi.fn().mockImplementation((path: string) => {
      if (path === '.claude/oss-autopilot/config.md') {
        return '---\nissueListPath: custom/issues.md\n---\n';
      }
      return '- [#1](https://github.com/o/r/issues/1) — Issue\n';
    });

    const result = detectIssueList();

    expect(result).toBeDefined();
    expect(result?.path).toBe(nodePath.resolve('custom/issues.md'));
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

  it('should auto-detect from known probe paths (returns absolute, #1577)', () => {
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
    expect(result?.path).toBe(nodePath.resolve('issues.md'));
    expect(result?.source).toBe('auto-detected');
    expect(result?.availableCount).toBe(1);
    expect(result?.completedCount).toBe(1);
  });

  it('should surface readError when the issue list file cannot be read (#1448)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    existsSyncMock.mockImplementation((path: string) => {
      return typeof path === 'string' && path === 'issues.md';
    });
    (fsImport as any).readFileSync = vi.fn().mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const result = detectIssueList();

    // The 0/0 counts are a read failure, not an empty list — readError says so.
    expect(result).toBeDefined();
    expect(result?.path).toBe(nodePath.resolve('issues.md'));
    expect(result?.availableCount).toBe(0);
    expect(result?.completedCount).toBe(0);
    expect(result?.readError).toContain('EACCES');
    consoleSpy.mockRestore();
  });

  it('should not set readError on a successful read (#1448)', () => {
    existsSyncMock.mockImplementation((path: string) => {
      return typeof path === 'string' && path === 'issues.md';
    });
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    const result = detectIssueList();

    expect(result).toBeDefined();
    expect('readError' in (result ?? {})).toBe(false);
  });

  it('should detect issue list from state.json config (primary)', async () => {
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
      getState: vi.fn(() => ({ config: { issueListPath: 'state/issues.md' } })),
      updateConfig: vi.fn(),
    } as any);

    existsSyncMock.mockImplementation((p: string) => {
      return nodePath.resolve(p) === nodePath.resolve('state/issues.md');
    });
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    const result = detectIssueList();

    expect(result).toBeDefined();
    expect(result?.path).toBe(nodePath.resolve('state/issues.md'));
    expect(result?.source).toBe('configured');
  });

  it('should prefer state.json over config.md when both set', async () => {
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
      getState: vi.fn(() => ({ config: { issueListPath: 'state/issues.md' } })),
      updateConfig: vi.fn(),
    } as any);

    existsSyncMock.mockImplementation((p: string) => {
      if (p === '.claude/oss-autopilot/config.md') return true;
      const r = nodePath.resolve(p);
      return r === nodePath.resolve('state/issues.md') || r === nodePath.resolve('config/issues.md');
    });
    (fsImport as any).readFileSync = vi.fn().mockImplementation((path: string) => {
      if (path === '.claude/oss-autopilot/config.md') {
        return '---\nissueListPath: config/issues.md\n---\n';
      }
      return '- [#1](https://github.com/o/r/issues/1) — Issue\n';
    });

    const result = detectIssueList();

    // state.json path should win
    expect(result?.path).toBe(nodePath.resolve('state/issues.md'));
    expect(result?.source).toBe('configured');
  });

  it('should detect skippedIssuesPath when skip file exists alongside issue list', async () => {
    existsSyncMock.mockImplementation((p: string) => {
      const r = nodePath.resolve(p);
      return r === nodePath.resolve('open-source/issues.md') || r === nodePath.resolve('open-source/skipped-issues.md');
    });
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    // Override getStateManager to return issueListPath pointing to our probe path
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
      getState: vi.fn(() => ({ config: { issueListPath: 'open-source/issues.md' } })),
      updateConfig: vi.fn(),
    } as any);

    const result = detectIssueList();

    expect(result).toBeDefined();
    expect(result?.path).toBe(nodePath.resolve('open-source/issues.md'));
    expect(result?.skippedIssuesPath).toBe(nodePath.resolve('open-source/skipped-issues.md'));
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

  it('persists auto-detected skippedIssuesPath to state.config when not already set (#1330)', async () => {
    // Repro: startup detects the file via the default-path probe but
    // returns it only in the run output. Without persistence, every
    // downstream `skip-add` and scout search reads `config.skippedIssuesPath`
    // (undefined) and silently no-ops the skip filter.
    existsSyncMock.mockImplementation((p: string) => {
      const r = nodePath.resolve(p);
      return r === nodePath.resolve('open-source/issues.md') || r === nodePath.resolve('open-source/skipped-issues.md');
    });
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    const updateConfigSpy = vi.fn();
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
      // No skippedIssuesPath in config yet — the auto-detect must persist it.
      getState: vi.fn(() => ({ config: { issueListPath: 'open-source/issues.md' } })),
      updateConfig: updateConfigSpy,
    } as any);

    const result = detectIssueList();

    // Persisted ABSOLUTE (#1577) — a bare filename next to the (now absolute) list.
    expect(result?.skippedIssuesPath).toBe(nodePath.resolve('open-source/skipped-issues.md'));
    expect(updateConfigSpy).toHaveBeenCalledWith({
      skippedIssuesPath: nodePath.resolve('open-source/skipped-issues.md'),
    });
  });

  it('does NOT re-persist paths already stored as absolute (#1330/#1577)', async () => {
    // Re-running startup on a state that already holds ABSOLUTE paths shouldn't
    // trigger an autoSave every run. Both `config first` branches take the
    // stored value, the default-path probe never runs, updateConfig stays
    // untouched. (A relative value would instead be upgraded once — see above.)
    const absList = nodePath.resolve('open-source/issues.md');
    const absSkip = nodePath.resolve('open-source/skipped-issues.md');
    existsSyncMock.mockImplementation((p: string) => p === absList || p === absSkip);
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    const updateConfigSpy = vi.fn();
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
      getState: vi.fn(() => ({
        config: { issueListPath: absList, skippedIssuesPath: absSkip },
      })),
      updateConfig: updateConfigSpy,
    } as any);

    detectIssueList();

    expect(updateConfigSpy).not.toHaveBeenCalled();
  });

  it('persists an auto-detected list path as absolute so it sticks across CWDs (#1577)', async () => {
    const updateConfigSpy = vi.fn();
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
      getState: vi.fn(() => ({ config: {} })),
      updateConfig: updateConfigSpy,
    } as any);
    existsSyncMock.mockImplementation(
      (p: string) => nodePath.resolve(p) === nodePath.resolve('open-source/potential-issue-list.md'),
    );
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    const result = detectIssueList();

    expect(result?.source).toBe('auto-detected');
    expect(result?.path).toBe(nodePath.resolve('open-source/potential-issue-list.md'));
    expect(updateConfigSpy).toHaveBeenCalledWith({
      issueListPath: nodePath.resolve('open-source/potential-issue-list.md'),
    });
  });

  it('upgrades a relative configured issueListPath to absolute in state (#1577)', async () => {
    const updateConfigSpy = vi.fn();
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
      getState: vi.fn(() => ({ config: { issueListPath: 'state/issues.md' } })),
      updateConfig: updateConfigSpy,
    } as any);
    existsSyncMock.mockImplementation((p: string) => nodePath.resolve(p) === nodePath.resolve('state/issues.md'));
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    detectIssueList();

    expect(updateConfigSpy).toHaveBeenCalledWith({ issueListPath: nodePath.resolve('state/issues.md') });
  });

  it('returns undefined (not a silent probe fallthrough that finds nothing) when a configured list is missing (#1577)', async () => {
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
      getState: vi.fn(() => ({ config: { issueListPath: 'gone/list.md' } })),
      updateConfig: vi.fn(),
    } as any);
    existsSyncMock.mockReturnValue(false); // configured path missing, no probes match
    expect(detectIssueList()).toBeUndefined();
  });

  it('does NOT overwrite a configured-but-missing issueListPath with a probe hit (#1577)', async () => {
    const updateConfigSpy = vi.fn();
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
      getState: vi.fn(() => ({ config: { issueListPath: '/data/oss/issues.md' } })),
      updateConfig: updateConfigSpy,
    } as any);
    // Configured absolute path absent (e.g. /data unmounted), but a probe file
    // happens to exist in CWD. The probe is returned for THIS run, but the
    // user's deliberate config must NOT be clobbered.
    existsSyncMock.mockImplementation((p: string) => nodePath.resolve(p) === nodePath.resolve('issues.md'));
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    const result = detectIssueList();

    expect(result?.path).toBe(nodePath.resolve('issues.md'));
    expect(result?.source).toBe('auto-detected');
    expect(updateConfigSpy).not.toHaveBeenCalled();
  });

  it('anchors a relative configured skippedIssuesPath to the list dir, persisted absolute (#1577)', async () => {
    const absList = nodePath.resolve('vault/open-source/issues.md');
    const expectedSkip = nodePath.resolve('vault/open-source/skipped-issues.md');
    const updateConfigSpy = vi.fn();
    const { getStateManager } = await import('../core/index.js');
    vi.mocked(getStateManager).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
      getState: vi.fn(() => ({ config: { issueListPath: absList, skippedIssuesPath: 'skipped-issues.md' } })),
      updateConfig: updateConfigSpy,
    } as any);
    existsSyncMock.mockImplementation((p: string) => p === absList || p === expectedSkip);
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](https://github.com/o/r/issues/1) — Issue\n');

    const result = detectIssueList();

    expect(result?.skippedIssuesPath).toBe(expectedSkip);
    expect(updateConfigSpy).toHaveBeenCalledWith({ skippedIssuesPath: expectedSkip });
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
      warnings: [],
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    const startupMod = await import('./startup.js');
    runStartup = startupMod.runStartup;

    const dailyMod = await import('./daily.js');
    executeDailyCheck = dailyMod.executeDailyCheck as ReturnType<typeof vi.fn>;

    const cpMod = await import('node:child_process');
    execFile = cpMod.execFile as unknown as ReturnType<typeof vi.fn>;

    const lifecycleMod = await import('./dashboard-lifecycle.js');
    launchDashboardServer = lifecycleMod.launchDashboardServer as unknown as ReturnType<typeof vi.fn>;
    // Default: SPA not available (assets not built)
    launchDashboardServer.mockResolvedValue(null);
  });

  function expectBrowserOpenedWith(url: string): void {
    expect(execFile).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([url]), expect.any(Function));
  }

  it('surfaces the latest overnight run as freshness (#1574)', async () => {
    executeDailyCheck.mockResolvedValue(makeDailyOutput(0));
    const core = await import('../core/index.js');
    const sm = vi.mocked(core.getStateManager);
    sm.mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getState: vi.fn(() => ({ config: {} })),
      getLastOvernight: () => ({
        runAt: new Date(Date.now() - 3 * 36e5).toISOString(),
        reportPath: '/r/overnight-today.md',
        prepareCount: 2,
        judgmentCount: 1,
        prepared: [{ url: 'u', branch: 'b', recordedAt: 'x' }],
      }),
    } as never);
    try {
      const result = await runStartup();
      expect(result.overnight).toEqual({
        runAt: expect.any(String),
        reportPath: '/r/overnight-today.md',
        ageHours: 3,
        prepareCount: 2,
        judgmentCount: 1,
        preparedCount: 1,
      });
    } finally {
      sm.mockReturnValue({ isSetupComplete: vi.fn(() => true), getLastOvernight: vi.fn(() => undefined) } as never);
    }
  });

  it('omits overnight before the first overnight run (#1574)', async () => {
    executeDailyCheck.mockResolvedValue(makeDailyOutput(0));
    const result = await runStartup();
    expect(result.overnight).toBeUndefined();
    expect(result).not.toHaveProperty('overnightError');
  });

  it('should still launch SPA when totalActivePRs is 0 (dashboard empty-state is fine)', async () => {
    // Regression: the old `> 0` gate swallowed the dashboard for misconfigured
    // username, transient API flakes, and users between contributions. The
    // dashboard's own empty-state UI renders zero PRs cleanly, so launch it
    // whenever setup + auth succeed.
    const daily = makeDailyOutput(0);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({
      url: 'http://localhost:3000',
      port: 3000,
      alreadyRunning: false,
    });

    const result = await runStartup();

    expect(launchDashboardServer).toHaveBeenCalled();
    expectBrowserOpenedWith('http://localhost:3000');
    expect(result.dashboardUrl).toBe('http://localhost:3000');
    expect(result.daily?.briefSummary).toContain('Dashboard opened in browser');
  });

  it('should log error and surface dashboardError when SPA assets are unavailable', async () => {
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue(null);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runStartup();

    expect(launchDashboardServer).toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(result.dashboardUrl).toBeUndefined();
    // JSON consumers need a structured signal, not just a stderr line, since
    // the dashboard is now always attempted and missing-URL is ambiguous.
    expect(result.dashboardError).toMatch(/SPA assets not found/);
    expect(result.daily?.briefSummary).not.toContain('Dashboard opened in browser');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SPA assets not found'));
    consoleSpy.mockRestore();
  });

  it('passes through OSS_DASHBOARD_BUILD_STATUS=failed and the error tail (#1293)', async () => {
    const daily = makeDailyOutput(0);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({ url: 'http://localhost:3000', port: 3000, alreadyRunning: false });
    process.env.OSS_DASHBOARD_BUILD_STATUS = 'failed';
    process.env.OSS_DASHBOARD_BUILD_ERROR_TAIL = 'tsc: error TS2322 in src/index.tsx:42';

    try {
      const result = await runStartup();
      expect(result.dashboardBuildStatus).toBe('failed');
      expect(result.dashboardBuildErrorTail).toBe('tsc: error TS2322 in src/index.tsx:42');
    } finally {
      delete process.env.OSS_DASHBOARD_BUILD_STATUS;
      delete process.env.OSS_DASHBOARD_BUILD_ERROR_TAIL;
    }
  });

  it('drops dashboardBuildErrorTail when status is fresh (no failure to surface)', async () => {
    const daily = makeDailyOutput(0);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({ url: 'http://localhost:3000', port: 3000, alreadyRunning: false });
    process.env.OSS_DASHBOARD_BUILD_STATUS = 'fresh';
    process.env.OSS_DASHBOARD_BUILD_ERROR_TAIL = 'leftover from a prior session';

    try {
      const result = await runStartup();
      expect(result.dashboardBuildStatus).toBe('fresh');
      expect(result.dashboardBuildErrorTail).toBeUndefined();
    } finally {
      delete process.env.OSS_DASHBOARD_BUILD_STATUS;
      delete process.env.OSS_DASHBOARD_BUILD_ERROR_TAIL;
    }
  });

  it('rejects malformed OSS_DASHBOARD_BUILD_STATUS values (typed enum guard)', async () => {
    const daily = makeDailyOutput(0);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({ url: 'http://localhost:3000', port: 3000, alreadyRunning: false });
    process.env.OSS_DASHBOARD_BUILD_STATUS = 'arbitrary-injection';

    try {
      const result = await runStartup();
      expect(result.dashboardBuildStatus).toBeUndefined();
    } finally {
      delete process.env.OSS_DASHBOARD_BUILD_STATUS;
    }
  });

  it('should return setup incomplete when setup is not done', async () => {
    const { getStateManager } = await import('../core/index.js');
    const mockGetStateManager = getStateManager as ReturnType<typeof vi.fn>;
    mockGetStateManager.mockReturnValue({
      getLastOvernight: vi.fn(() => undefined),
      isSetupComplete: vi.fn(() => false),
    });

    const result = await runStartup();

    expect(result.setupComplete).toBe(false);
  });

  it('should return auth error when no token is available from either source', async () => {
    const { getStateManager, getGitHubTokenAsync } = await import('../core/index.js');
    const mockGetStateManager = getStateManager as ReturnType<typeof vi.fn>;
    const mockGetGitHubTokenAsync = getGitHubTokenAsync as ReturnType<typeof vi.fn>;
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
    });
    mockGetGitHubTokenAsync.mockResolvedValue(null);

    const result = await runStartup();

    expect(result.setupComplete).toBe(true);
    expect(result.authError).toContain('authentication required');
  });

  it('proceeds when only the `gh auth token` fallback returns a token (#1041)', async () => {
    // Regression: `startup` used the sync `getGitHubToken()` which reads env
    // only. A user authenticated via `gh auth login` but without
    // $GITHUB_TOKEN was wrongly routed to `authError`. The async fallback
    // must now drive the decision.
    const { getStateManager, getGitHubToken, getGitHubTokenAsync } = await import('../core/index.js');
    (getStateManager as ReturnType<typeof vi.fn>).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
    });
    (getGitHubToken as ReturnType<typeof vi.fn>).mockReturnValue(null); // env var unset
    (getGitHubTokenAsync as ReturnType<typeof vi.fn>).mockResolvedValue('token-from-gh-cli');
    executeDailyCheck.mockResolvedValue(makeDailyOutput(0));

    const result = await runStartup();

    expect(result.setupComplete).toBe(true);
    expect(result.authError).toBeUndefined();
    expect(executeDailyCheck).toHaveBeenCalledWith('token-from-gh-cli');
  });

  it('should propagate daily check failure to caller', async () => {
    // Reset mocks to ensure auth passes
    const { getStateManager: gsm, getGitHubTokenAsync: ghtAsync } = await import('../core/index.js');
    (gsm as ReturnType<typeof vi.fn>).mockReturnValue({
      isSetupComplete: vi.fn(() => true),
      getLastOvernight: vi.fn(() => undefined),
    });
    (ghtAsync as ReturnType<typeof vi.fn>).mockResolvedValue('fake-token');

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
    expectBrowserOpenedWith('http://oss.localhost:3000');
    expect(result.dashboardUrl).toBe('http://oss.localhost:3000');
    expect(result.daily?.briefSummary).toContain('Dashboard opened in browser');
  });

  it('should refresh existing dashboard and focus it in the browser (#830)', async () => {
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({ url: 'http://oss.localhost:3001', port: 3001, alreadyRunning: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await runStartup();

    expect(result.dashboardUrl).toBe('http://oss.localhost:3001');
    // Should trigger a refresh on the running server
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
    // No `lastBrowserOpenedAt` recorded yet → falls outside throttle window,
    // so the OS browser-opener still runs to surface the dashboard for users
    // who closed the tab between runs (#1100).
    expectBrowserOpenedWith('http://oss.localhost:3001');
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
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Could not trigger dashboard refresh'));
    // Browser open is independent of refresh health: still focus the dashboard
    // so the user sees cached data rather than nothing.
    expectBrowserOpenedWith('http://oss.localhost:3001');
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
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Dashboard refresh returned 429'));
    // Browser open still happens: user gets stale-but-visible data instead of silent nothing.
    expectBrowserOpenedWith('http://oss.localhost:3001');
    // Should say "running" not "refreshed" on non-200
    expect(result.daily?.briefSummary).toContain('Dashboard running');
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('skips browser-open when running server was opened within the throttle window (#1339)', async () => {
    // Within the default 30-minute throttle: don't pile up duplicate tabs on
    // back-to-back /oss runs. The SPA's existing /api/refresh keeps the
    // already-open tab fresh; opening the URL again would surface a duplicate
    // on browsers/setups where the OS-level "focus existing tab" doesn't fire.
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({
      url: 'http://oss.localhost:3001',
      port: 3001,
      alreadyRunning: true,
      lastBrowserOpenedAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await runStartup();

    expect(result.dashboardUrl).toBe('http://oss.localhost:3001');
    expect(execFile).not.toHaveBeenCalled();
    // The data refresh still fires — the SPA tab gets fresh data.
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
    fetchSpy.mockRestore();
  });

  it('opens browser when last open is older than the throttle window (#1339)', async () => {
    // Beyond the throttle: assume the user has closed the tab or moved on, so
    // re-surface the dashboard.
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({
      url: 'http://oss.localhost:3001',
      port: 3001,
      alreadyRunning: true,
      lastBrowserOpenedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await runStartup();

    expect(execFile).toHaveBeenCalled();
    expectBrowserOpenedWith('http://oss.localhost:3001');
    fetchSpy.mockRestore();
  });

  it('honors OSS_NO_BROWSER=1 by skipping the browser open entirely (#1339)', async () => {
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({ url: 'http://oss.localhost:3000', port: 3000, alreadyRunning: false });
    process.env.OSS_NO_BROWSER = '1';

    try {
      const result = await runStartup();
      expect(result.dashboardUrl).toBe('http://oss.localhost:3000');
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      delete process.env.OSS_NO_BROWSER;
    }
  });

  it('honors OSS_DASHBOARD_REOPEN_THROTTLE_MS=0 by always re-opening (#1339)', async () => {
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({
      url: 'http://oss.localhost:3001',
      port: 3001,
      alreadyRunning: true,
      lastBrowserOpenedAt: new Date(Date.now() - 5_000).toISOString(), // 5s ago — well within default
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    process.env.OSS_DASHBOARD_REOPEN_THROTTLE_MS = '0';

    try {
      await runStartup();
      expect(execFile).toHaveBeenCalled();
      expectBrowserOpenedWith('http://oss.localhost:3001');
    } finally {
      delete process.env.OSS_DASHBOARD_REOPEN_THROTTLE_MS;
      fetchSpy.mockRestore();
    }
  });

  it('records browser-opened timestamp after opening (#1339)', async () => {
    const { recordBrowserOpened } = await import('./dashboard-process.js');
    (recordBrowserOpened as ReturnType<typeof vi.fn>).mockClear();

    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({ url: 'http://oss.localhost:3000', port: 3000, alreadyRunning: false });

    await runStartup();

    expect(recordBrowserOpened).toHaveBeenCalledWith(3000);
  });

  it('does not record browser-opened timestamp when open is throttled (#1339)', async () => {
    const { recordBrowserOpened } = await import('./dashboard-process.js');
    (recordBrowserOpened as ReturnType<typeof vi.fn>).mockClear();

    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({
      url: 'http://oss.localhost:3001',
      port: 3001,
      alreadyRunning: true,
      lastBrowserOpenedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await runStartup();

    expect(recordBrowserOpened).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('launches SPA even when totalActivePRs is 0 (covers misconfig + transient + between-PRs)', async () => {
    const daily = makeDailyOutput(0);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockResolvedValue({
      url: 'http://localhost:3000',
      port: 3000,
      alreadyRunning: false,
    });

    const result = await runStartup();

    expect(launchDashboardServer).toHaveBeenCalled();
    expectBrowserOpenedWith('http://localhost:3000');
    expect(result.dashboardUrl).toBe('http://localhost:3000');
  });

  it('should surface dashboardError and log when SPA launch throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const daily = makeDailyOutput(5);
    executeDailyCheck.mockResolvedValue(daily);
    launchDashboardServer.mockRejectedValue(new Error('spawn ENOENT'));

    const result = await runStartup();

    // Should not crash — dashboard is unavailable but startup continues.
    expect(result.dashboardUrl).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
    expect(result.daily?.briefSummary).not.toContain('Dashboard opened in browser');
    // Structured signal for JSON consumers (plugin layer, MCP), plus the
    // existing stderr line for humans tailing logs.
    expect(result.dashboardError).toMatch(/SPA dashboard launch failed/);
    expect(result.dashboardError).toMatch(/spawn ENOENT/);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SPA dashboard launch failed'));
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
        getLastOvernight: vi.fn(() => undefined),
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
