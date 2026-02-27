/**
 * Tests for startup command helper functions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
});
