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
}));

vi.mock('./daily.js', () => ({
  executeDailyCheck: vi.fn(),
}));

vi.mock('./dashboard.js', () => ({
  writeDashboardFromState: vi.fn(() => '/tmp/dashboard.html'),
}));

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
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

### org/repo (500★) — Description
- [#123](https://github.com/org/repo/issues/123) — Fix bug
  - **Low complexity**

### ~~org/done (200★) — Done repo~~
- ~~[#456](https://github.com/org/done/issues/456) — Old issue~~
  - **Done** — PR #42 submitted

### org/another (300★)
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
    const content = `- ~~[#1](url) — Done item~~
- [#2](url) — Active item
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(1);
  });

  it('should detect **Done** marker as completed', () => {
    const content = `- [#1](url) — Item with **Done** marker
- [#2](url) — Active item
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(1);
  });

  it('should handle indented list items', () => {
    const content = `  - [#1](url) — Indented available
  - ~~[#2](url) — Indented done~~
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(1);
  });

  it('should not count lines that do not start with - [', () => {
    const content = `- Some regular list item
- Another item
- [#1](url) — Real issue list item
  - Sub-item that starts with - [but is indented sub-bullet
`;
    const result = countIssueListItems(content);
    // Only "- [#1]" matches — "  - Sub-item..." has "S" not "[" after "- "
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(0);
  });

  it('should handle mixed available and completed items', () => {
    const content = `- [#1](url) — Available 1
- ~~[#2](url) — Done 1~~
- [#3](url) — Available 2
- [#4](url) — Has **Done** in text
- ~~[#5](url) — Done 2~~
- [#6](url) — Available 3
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(3);
    expect(result.completedCount).toBe(3);
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
      return '- [#1](url) — Issue\n';
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
    (fsImport as any).readFileSync = vi.fn().mockReturnValue('- [#1](url) — Issue\n- ~~[#2](url) — Done~~\n');

    const result = detectIssueList();

    expect(result).toBeDefined();
    expect(result?.path).toBe('issues.md');
    expect(result?.source).toBe('auto-detected');
    expect(result?.availableCount).toBe(1);
    expect(result?.completedCount).toBe(1);
  });
});

// --- runStartup dashboard behavior tests ---

describe('runStartup dashboard behavior', () => {
  // Lazy imports so vi.mock() is in effect
  let runStartup: typeof import('./startup.js').runStartup;
  let executeDailyCheck: ReturnType<typeof vi.fn>;
  let writeDashboardFromState: ReturnType<typeof vi.fn>;
  let execFile: ReturnType<typeof vi.fn>;

  function makeDailyOutput(totalActivePRs: number) {
    return {
      digest: {
        generatedAt: new Date().toISOString(),
        openPRs: [],
        prsNeedingResponse: [],
        ciFailingPRs: [],
        ciBlockedPRs: [],
        ciNotRunningPRs: [],
        mergeConflictPRs: [],
        needsRebasePRs: [],
        missingRequiredFilesPRs: [],
        incompleteChecklistPRs: [],
        needsChangesPRs: [],
        changesAddressedPRs: [],
        waitingOnMaintainerPRs: [],
        approachingDormant: [],
        dormantPRs: [],
        healthyPRs: [],
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
      updates: [],
      capacity: {
        hasCapacity: true,
        activePRCount: totalActivePRs,
        maxActivePRs: 10,
        shelvedPRCount: 0,
        criticalIssueCount: 0,
        reason: `You have capacity: ${totalActivePRs}/10 active PRs, no critical issues`,
      },
      summary: '',
      briefSummary: `📊 ${totalActivePRs} Active PRs`,
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

    const dashMod = await import('./dashboard.js');
    writeDashboardFromState = dashMod.writeDashboardFromState as ReturnType<typeof vi.fn>;

    const cpMod = await import('child_process');
    execFile = cpMod.execFile as unknown as ReturnType<typeof vi.fn>;
  });

  it('should NOT open browser when totalActivePRs is 0', async () => {
    const daily = makeDailyOutput(0);
    executeDailyCheck.mockResolvedValue(daily);
    writeDashboardFromState.mockReturnValue('/tmp/dashboard.html');

    await runStartup({ json: true });

    expect(writeDashboardFromState).toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(daily.briefSummary).not.toContain('Dashboard opened in browser');
  });

  it('should open browser when totalActivePRs > 0', async () => {
    const daily = makeDailyOutput(3);
    executeDailyCheck.mockResolvedValue(daily);
    writeDashboardFromState.mockReturnValue('/tmp/dashboard.html');

    await runStartup({ json: true });

    expect(writeDashboardFromState).toHaveBeenCalled();
    expect(execFile).toHaveBeenCalled();
    expect(daily.briefSummary).toContain('Dashboard opened in browser');
  });

  it('should not open browser when dashboard generation fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const daily = makeDailyOutput(5);
    executeDailyCheck.mockResolvedValue(daily);
    writeDashboardFromState.mockImplementation(() => {
      throw new Error('Dashboard write failed');
    });

    await runStartup({ json: true });

    expect(execFile).not.toHaveBeenCalled();
    expect(daily.briefSummary).not.toContain('Dashboard opened in browser');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Dashboard'), 'Dashboard write failed');
    consoleErrorSpy.mockRestore();
  });

  it('should output text summary when not in JSON mode', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const daily = makeDailyOutput(2);
    executeDailyCheck.mockResolvedValue(daily);
    writeDashboardFromState.mockReturnValue('/tmp/dashboard.html');

    await runStartup({ json: false });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('OSS Autopilot');
    expect(allOutput).toContain('Dashboard');
    consoleSpy.mockRestore();
  });

  it('should return setup incomplete when setup is not done', async () => {
    const { getStateManager } = await import('../core/index.js');
    const mockGetStateManager = getStateManager as ReturnType<typeof vi.fn>;
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn(() => false),
    });

    await runStartup({ json: true });

    const { outputJson } = await import('../formatters/json.js');
    const mockOutputJson = outputJson as unknown as ReturnType<typeof vi.fn>;
    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({ setupComplete: false }));
  });

  it('should output text when setup is incomplete', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { getStateManager } = await import('../core/index.js');
    const mockGetStateManager = getStateManager as ReturnType<typeof vi.fn>;
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn(() => false),
    });

    await runStartup({ json: false });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Setup incomplete');
    consoleSpy.mockRestore();
  });

  it('should handle auth error in JSON mode', async () => {
    const { getStateManager, getGitHubToken } = await import('../core/index.js');
    const mockGetStateManager = getStateManager as ReturnType<typeof vi.fn>;
    const mockGetGitHubToken = getGitHubToken as ReturnType<typeof vi.fn>;
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn(() => true),
    });
    mockGetGitHubToken.mockReturnValue(null);

    await runStartup({ json: true });

    const { outputJson } = await import('../formatters/json.js');
    const mockOutputJson = outputJson as unknown as ReturnType<typeof vi.fn>;
    expect(mockOutputJson).toHaveBeenCalledWith(
      expect.objectContaining({ setupComplete: true, authError: expect.any(String) }),
    );
  });

  it('should handle auth error in text mode', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getStateManager, getGitHubToken } = await import('../core/index.js');
    const mockGetStateManager = getStateManager as ReturnType<typeof vi.fn>;
    const mockGetGitHubToken = getGitHubToken as ReturnType<typeof vi.fn>;
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn(() => true),
    });
    mockGetGitHubToken.mockReturnValue(null);

    await runStartup({ json: false });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('authentication required');
    consoleSpy.mockRestore();
  });

  it('should handle daily check failure in JSON mode', async () => {
    // Reset mocks to ensure auth passes (auth error tests above may have set token to null)
    const { getStateManager: gsm, getGitHubToken: ght } = await import('../core/index.js');
    (gsm as ReturnType<typeof vi.fn>).mockReturnValue({ isSetupComplete: vi.fn(() => true) });
    (ght as ReturnType<typeof vi.fn>).mockReturnValue('fake-token');

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    executeDailyCheck.mockRejectedValue(new Error('Network error'));

    await expect(runStartup({ json: true })).rejects.toThrow('exit');

    const { outputJsonError } = await import('../formatters/json.js');
    const mockOutputJsonError = outputJsonError as unknown as ReturnType<typeof vi.fn>;
    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('Network error'));
    mockExit.mockRestore();
  });

  it('should handle daily check failure in text mode', async () => {
    // Reset mocks to ensure auth passes
    const { getStateManager: gsm, getGitHubToken: ght } = await import('../core/index.js');
    (gsm as ReturnType<typeof vi.fn>).mockReturnValue({ isSetupComplete: vi.fn(() => true) });
    (ght as ReturnType<typeof vi.fn>).mockReturnValue('fake-token');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    executeDailyCheck.mockRejectedValue(new Error('Network error'));

    await expect(runStartup({ json: false })).rejects.toThrow('exit');

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Daily check failed');
    consoleSpy.mockRestore();
    mockExit.mockRestore();
  });
});
