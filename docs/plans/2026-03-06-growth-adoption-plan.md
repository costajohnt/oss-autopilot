# Growth & Adoption Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce time-to-value with zero-config first run, add shareable contribution stats, and create a shields.io badge endpoint for viral growth.

**Architecture:** Three additive features that don't break existing behavior. (1) Auto-detect GitHub username in the startup command so first `/oss` run works without `/setup-oss`. (2) New `stats` CLI command that computes contribution metrics from GitHub API data. (3) New `badge-endpoint` package with a Vercel serverless function returning shields.io-compatible JSON.

**Tech Stack:** TypeScript, vitest, Commander.js, Octokit, Vercel serverless functions, shields.io endpoint protocol

---

## Task 1: Add `detectGitHubUsername()` utility

**Files:**
- Modify: `packages/core/src/core/utils.ts`
- Test: `packages/core/src/core/utils.test.ts`

**Step 1: Write the failing test**

Add to `packages/core/src/core/utils.test.ts`:

```typescript
import { detectGitHubUsername } from './utils.js';

describe('detectGitHubUsername', () => {
  it('should detect username from gh CLI', async () => {
    // This test runs against the real `gh` CLI if available
    // In CI, mock via vi.mock of child_process
    const username = await detectGitHubUsername();
    // Should return a string or null, never throw
    expect(typeof username === 'string' || username === null).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/core/utils.test.ts -t "should detect username"`
Expected: FAIL with "detectGitHubUsername is not exported"

**Step 3: Write minimal implementation**

Add to `packages/core/src/core/utils.ts`:

```typescript
/**
 * Detect the GitHub username of the currently authenticated user.
 * Uses `gh api user --jq '.login'` which requires `gh` CLI to be installed
 * and authenticated. Returns null if detection fails.
 */
export async function detectGitHubUsername(): Promise<string | null> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile('gh', ['api', 'user', '--jq', '.login'], (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    if (result && /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(result)) {
      return result;
    }
    return null;
  } catch {
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/core/utils.test.ts -t "should detect username"`
Expected: PASS

**Step 5: Export from core/index.ts**

Add to `packages/core/src/core/index.ts`:

```typescript
export { detectGitHubUsername } from './utils.js';
```

(add alongside the existing utils exports)

**Step 6: Commit**

```bash
git add packages/core/src/core/utils.ts packages/core/src/core/utils.test.ts packages/core/src/core/index.ts
git commit -m "feat: add detectGitHubUsername utility for zero-config first run"
```

---

## Task 2: Add `initializeWithDefaults()` to StateManager

**Files:**
- Modify: `packages/core/src/core/state.ts`
- Test: `packages/core/src/core/state.test.ts` (add new describe block)

**Step 1: Write the failing test**

Add to `packages/core/src/core/state.test.ts`:

```typescript
describe('initializeWithDefaults', () => {
  it('should set username and mark setup complete', () => {
    const sm = getStateManager();
    sm.initializeWithDefaults('testuser');

    const state = sm.getState();
    expect(state.config.githubUsername).toBe('testuser');
    expect(state.config.setupComplete).toBe(true);
    expect(state.config.setupCompletedAt).toBeDefined();
  });

  it('should not overwrite existing config if setup already complete', () => {
    const sm = getStateManager();
    sm.updateConfig({ githubUsername: 'existinguser', setupComplete: true });
    sm.save();

    sm.initializeWithDefaults('newuser');

    const state = sm.getState();
    expect(state.config.githubUsername).toBe('existinguser');
  });

  it('should use sensible defaults', () => {
    const sm = getStateManager();
    sm.initializeWithDefaults('testuser');

    const config = sm.getState().config;
    expect(config.maxActivePRs).toBe(10);
    expect(config.languages).toEqual(['typescript', 'javascript']);
    expect(config.labels).toEqual(['good first issue', 'help wanted']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/core/state.test.ts -t "initializeWithDefaults"`
Expected: FAIL with "initializeWithDefaults is not a function"

**Step 3: Write minimal implementation**

Add method to `StateManager` class in `packages/core/src/core/state.ts`:

```typescript
/**
 * Initialize state with auto-detected defaults for zero-config first run.
 * Sets the username, marks setup complete, and uses DEFAULT_CONFIG values.
 * No-op if setup is already complete (prevents overwriting existing config).
 */
initializeWithDefaults(username: string): void {
  if (this.state.config.setupComplete) {
    debug(MODULE, 'initializeWithDefaults: setup already complete, skipping');
    return;
  }

  this.state.config.githubUsername = username;
  this.state.config.setupComplete = true;
  this.state.config.setupCompletedAt = new Date().toISOString();
  this.save();
  debug(MODULE, `initializeWithDefaults: initialized for user ${username}`);
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/core/state.test.ts -t "initializeWithDefaults"`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/core/state.ts packages/core/src/core/state.test.ts
git commit -m "feat: add StateManager.initializeWithDefaults for zero-config"
```

---

## Task 3: Add auto-detect to startup command

**Files:**
- Modify: `packages/core/src/commands/startup.ts`
- Test: `packages/core/src/commands/startup.test.ts`

**Step 1: Write the failing test**

Add to `packages/core/src/commands/startup.test.ts`:

```typescript
describe('auto-detect flow', () => {
  it('should auto-detect username when setup is incomplete', async () => {
    // Mock: setup incomplete, detectGitHubUsername returns 'autouser'
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn().mockReturnValue(false),
      initializeWithDefaults: vi.fn(),
      getState: vi.fn().mockReturnValue({
        config: { setupComplete: false, githubUsername: '' },
      }),
    } as any);

    // After initializeWithDefaults, isSetupComplete should return true
    // This simulates the state change
    const mockSM = mockGetStateManager();
    let setupComplete = false;
    mockSM.isSetupComplete = vi.fn(() => setupComplete);
    mockSM.initializeWithDefaults = vi.fn(() => { setupComplete = true; });

    // Mock detectGitHubUsername
    vi.mocked(detectGitHubUsername).mockResolvedValue('autouser');
    // Mock getGitHubToken
    vi.mocked(getGitHubToken).mockReturnValue('fake-token');
    // Mock executeDailyCheck
    vi.mocked(executeDailyCheck).mockResolvedValue(mockDailyOutput);

    const result = await runStartup();

    expect(mockSM.initializeWithDefaults).toHaveBeenCalledWith('autouser');
    expect(result.setupComplete).toBe(true);
    expect(result.autoDetected).toBe(true);
  });

  it('should return setupComplete:false when auto-detect fails', async () => {
    mockGetStateManager.mockReturnValue({
      isSetupComplete: vi.fn().mockReturnValue(false),
    } as any);

    vi.mocked(detectGitHubUsername).mockResolvedValue(null);

    const result = await runStartup();

    expect(result.setupComplete).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/commands/startup.test.ts -t "auto-detect flow"`
Expected: FAIL

**Step 3: Modify startup.ts**

Update `runStartup()` in `packages/core/src/commands/startup.ts`:

```typescript
// At top of file, add import:
import { detectGitHubUsername } from '../core/index.js';

// In runStartup(), replace the early return for setup incomplete:
export async function runStartup(): Promise<StartupOutput> {
  const version = getCLIVersion();
  const stateManager = getStateManager();

  // 1. Check setup — try auto-detect if incomplete
  if (!stateManager.isSetupComplete()) {
    const detectedUsername = await detectGitHubUsername();
    if (detectedUsername) {
      stateManager.initializeWithDefaults(detectedUsername);
      // Fall through to continue with daily check
    } else {
      return { version, setupComplete: false };
    }
  }

  // Track whether this was an auto-detected session
  const autoDetected = !stateManager.getState().config.setupCompletedAt ||
    (Date.now() - new Date(stateManager.getState().config.setupCompletedAt!).getTime()) < 5000;

  // 2. Check auth (rest of existing code unchanged...)
  const token = getGitHubToken();
  // ... existing code ...

  return {
    version,
    setupComplete: true,
    autoDetected,  // new field
    daily,
    dashboardUrl,
    dashboardPath,
    issueList,
  };
}
```

**Step 4: Update StartupOutput type**

Add to `packages/core/src/formatters/json.ts` in `StartupOutput`:

```typescript
/** True when username was auto-detected (zero-config first run). */
autoDetected?: boolean;
```

**Step 5: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/commands/startup.test.ts -t "auto-detect flow"`
Expected: PASS

**Step 6: Run full test suite**

Run: `cd packages/core && npx vitest run`
Expected: All tests pass (no regressions)

**Step 7: Commit**

```bash
git add packages/core/src/commands/startup.ts packages/core/src/commands/startup.test.ts packages/core/src/formatters/json.ts
git commit -m "feat: auto-detect GitHub username in startup for zero-config first run"
```

---

## Task 4: Update plugin command to handle auto-detected state

**Files:**
- Modify: `commands/oss.md`
- Modify: `commands/setup-oss.md`

**Step 1: Update oss.md for auto-detect welcome**

In `commands/oss.md`, find the section that handles `data.setupComplete === false` and the first-run welcome. Add handling for `data.autoDetected`:

After the JSON parsing section where `data` is available, add a check:

```markdown
<!-- After successful JSON parse, before Summary output -->
If `data.autoDetected` is `true`, display a welcome message:

**Welcome to OSS Autopilot!** I detected your GitHub username as **@USERNAME** and fetched your open PRs automatically.

Run `/setup-oss` anytime to customize your preferences (languages, labels, PR limits, etc.).

Then continue with the normal summary display.
```

**Step 2: Update setup-oss.md messaging**

In `commands/setup-oss.md`, update the opening description to frame it as optional customization rather than required setup:

Change the introduction from "required setup" language to:
"Customize your OSS Autopilot experience. This is optional — the tool works out of the box with auto-detected settings."

**Step 3: Commit**

```bash
git add commands/oss.md commands/setup-oss.md
git commit -m "feat: update plugin commands for zero-config first run UX"
```

---

## Task 5: Create stats computation module

**Files:**
- Create: `packages/core/src/core/stats.ts`
- Create: `packages/core/src/core/stats.test.ts`

**Step 1: Write the failing tests**

Create `packages/core/src/core/stats.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeContributionStats, type ContributionStats } from './stats.js';

describe('computeContributionStats', () => {
  it('should compute basic stats from repo scores', () => {
    const repoScores = {
      'owner/repo1': { mergedPRCount: 5, closedWithoutMergeCount: 1, repo: 'owner/repo1', score: 7 },
      'owner/repo2': { mergedPRCount: 3, closedWithoutMergeCount: 0, repo: 'owner/repo2', score: 8 },
    };

    const stats = computeContributionStats({ repoScores, activePRCount: 2 });

    expect(stats.totalMerged).toBe(8);
    expect(stats.totalClosed).toBe(1);
    expect(stats.mergeRate).toBeCloseTo(0.889, 2);
    expect(stats.reposContributed).toBe(2);
    expect(stats.activePRs).toBe(2);
    expect(stats.topRepos).toEqual([
      { repo: 'owner/repo1', mergedCount: 5 },
      { repo: 'owner/repo2', mergedCount: 3 },
    ]);
  });

  it('should handle zero merged PRs', () => {
    const stats = computeContributionStats({ repoScores: {}, activePRCount: 0 });

    expect(stats.totalMerged).toBe(0);
    expect(stats.mergeRate).toBe(0);
    expect(stats.reposContributed).toBe(0);
    expect(stats.topRepos).toEqual([]);
  });

  it('should sort topRepos by merged count descending', () => {
    const repoScores = {
      'a/low': { mergedPRCount: 1, closedWithoutMergeCount: 0, repo: 'a/low', score: 5 },
      'b/high': { mergedPRCount: 10, closedWithoutMergeCount: 0, repo: 'b/high', score: 9 },
      'c/mid': { mergedPRCount: 5, closedWithoutMergeCount: 0, repo: 'c/mid', score: 7 },
    };

    const stats = computeContributionStats({ repoScores, activePRCount: 0 });

    expect(stats.topRepos[0].repo).toBe('b/high');
    expect(stats.topRepos[1].repo).toBe('c/mid');
    expect(stats.topRepos[2].repo).toBe('a/low');
  });

  it('should limit topRepos to 10', () => {
    const repoScores: Record<string, any> = {};
    for (let i = 0; i < 15; i++) {
      repoScores[`owner/repo${i}`] = { mergedPRCount: 15 - i, closedWithoutMergeCount: 0, repo: `owner/repo${i}`, score: 5 };
    }

    const stats = computeContributionStats({ repoScores, activePRCount: 0 });

    expect(stats.topRepos.length).toBe(10);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/core/stats.test.ts`
Expected: FAIL with "Cannot find module './stats.js'"

**Step 3: Write minimal implementation**

Create `packages/core/src/core/stats.ts`:

```typescript
/**
 * Contribution statistics computation.
 * Computes metrics from repo scores and PR data for shareable stats and badges.
 */

import type { RepoScore } from './types.js';

export interface ContributionStats {
  totalMerged: number;
  totalClosed: number;
  mergeRate: number;
  activePRs: number;
  reposContributed: number;
  topRepos: Array<{ repo: string; mergedCount: number }>;
}

const MAX_TOP_REPOS = 10;

export interface ComputeStatsInput {
  repoScores: Record<string, Pick<RepoScore, 'mergedPRCount' | 'closedWithoutMergeCount' | 'repo'>>;
  activePRCount: number;
}

/**
 * Compute contribution statistics from repo score data.
 * Pure function — no side effects, no API calls.
 */
export function computeContributionStats(input: ComputeStatsInput): ContributionStats {
  const { repoScores, activePRCount } = input;

  let totalMerged = 0;
  let totalClosed = 0;
  const repoEntries: Array<{ repo: string; mergedCount: number }> = [];

  for (const [, score] of Object.entries(repoScores)) {
    totalMerged += score.mergedPRCount;
    totalClosed += score.closedWithoutMergeCount;
    if (score.mergedPRCount > 0) {
      repoEntries.push({ repo: score.repo, mergedCount: score.mergedPRCount });
    }
  }

  const total = totalMerged + totalClosed;
  const mergeRate = total > 0 ? totalMerged / total : 0;

  repoEntries.sort((a, b) => b.mergedCount - a.mergedCount);

  return {
    totalMerged,
    totalClosed,
    mergeRate,
    activePRs: activePRCount,
    reposContributed: repoEntries.length,
    topRepos: repoEntries.slice(0, MAX_TOP_REPOS),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/core/stats.test.ts`
Expected: PASS

**Step 5: Export from core/index.ts**

Add to `packages/core/src/core/index.ts`:

```typescript
export { computeContributionStats, type ContributionStats, type ComputeStatsInput } from './stats.js';
```

**Step 6: Commit**

```bash
git add packages/core/src/core/stats.ts packages/core/src/core/stats.test.ts packages/core/src/core/index.ts
git commit -m "feat: add contribution stats computation module"
```

---

## Task 6: Create stats CLI command

**Files:**
- Create: `packages/core/src/commands/stats.ts`
- Create: `packages/core/src/commands/stats.test.ts`
- Modify: `packages/core/src/cli-registry.ts`
- Modify: `packages/core/src/formatters/json.ts`

**Step 1: Define StatsOutput type**

Add to `packages/core/src/formatters/json.ts`:

```typescript
/** Output of the stats command */
export interface StatsOutput {
  totalMerged: number;
  totalClosed: number;
  mergeRate: number;
  mergeRateFormatted: string;
  activePRs: number;
  reposContributed: number;
  topRepos: Array<{ repo: string; mergedCount: number }>;
  username: string;
}
```

**Step 2: Write the failing test**

Create `packages/core/src/commands/stats.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runStats } from './stats.js';

const mockGetStateManager = vi.mocked(getStateManager);

describe('runStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({
        config: { githubUsername: 'testuser', setupComplete: true },
        repoScores: {
          'owner/repo1': { repo: 'owner/repo1', mergedPRCount: 5, closedWithoutMergeCount: 1, score: 7 },
          'owner/repo2': { repo: 'owner/repo2', mergedPRCount: 3, closedWithoutMergeCount: 0, score: 8 },
        },
        lastDigest: {
          openPRs: [{ url: 'https://github.com/a/b/pull/1' }, { url: 'https://github.com/c/d/pull/2' }],
          summary: { totalActivePRs: 2 },
        },
      }),
      isSetupComplete: vi.fn().mockReturnValue(true),
    } as any);
  });

  it('should return stats data', async () => {
    const result = await runStats();

    expect(result.totalMerged).toBe(8);
    expect(result.totalClosed).toBe(1);
    expect(result.mergeRate).toBeCloseTo(0.889, 2);
    expect(result.activePRs).toBe(2);
    expect(result.username).toBe('testuser');
    expect(result.reposContributed).toBe(2);
    expect(result.topRepos).toHaveLength(2);
  });

  it('should format merge rate as percentage', async () => {
    const result = await runStats();

    expect(result.mergeRateFormatted).toMatch(/88\.?\d*%/);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/commands/stats.test.ts`
Expected: FAIL with "Cannot find module './stats.js'"

**Step 4: Write minimal implementation**

Create `packages/core/src/commands/stats.ts`:

```typescript
/**
 * Stats command
 * Compute and display contribution statistics.
 */

import { getStateManager } from '../core/index.js';
import { computeContributionStats } from '../core/stats.js';
import type { StatsOutput } from '../formatters/json.js';

/**
 * Compute contribution stats from local state.
 * Uses cached repo scores and last digest for active PR count.
 */
export async function runStats(): Promise<StatsOutput> {
  const stateManager = getStateManager();
  const state = stateManager.getState();

  const activePRCount = state.lastDigest?.summary?.totalActivePRs ?? 0;

  const stats = computeContributionStats({
    repoScores: state.repoScores,
    activePRCount,
  });

  return {
    ...stats,
    mergeRateFormatted: `${(stats.mergeRate * 100).toFixed(1)}%`,
    username: state.config.githubUsername,
  };
}

/**
 * Format stats as a markdown report.
 */
export function formatStatsMarkdown(stats: StatsOutput): string {
  const lines: string[] = [
    `# OSS Contribution Stats for @${stats.username}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Merged PRs | ${stats.totalMerged} |`,
    `| Merge Rate | ${stats.mergeRateFormatted} |`,
    `| Active PRs | ${stats.activePRs} |`,
    `| Repos Contributed | ${stats.reposContributed} |`,
    '',
  ];

  if (stats.topRepos.length > 0) {
    lines.push('## Top Repos');
    lines.push('');
    lines.push('| Repo | Merged PRs |');
    lines.push('|------|-----------|');
    for (const repo of stats.topRepos) {
      lines.push(`| ${repo.repo} | ${repo.mergedCount} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by [OSS Autopilot](https://github.com/costajohnt/oss-autopilot)*');

  return lines.join('\n');
}

/**
 * Format stats as shields.io endpoint JSON.
 * See: https://shields.io/badges/endpoint-badge
 */
export function formatStatsBadge(stats: StatsOutput): object {
  const message = stats.totalMerged > 0
    ? `${stats.mergeRateFormatted} merge rate | ${stats.totalMerged} merged`
    : 'Getting Started';

  const color = stats.mergeRate >= 0.8 ? 'brightgreen'
    : stats.mergeRate >= 0.6 ? 'green'
    : stats.mergeRate >= 0.4 ? 'yellow'
    : stats.totalMerged === 0 ? 'blue'
    : 'orange';

  return {
    schemaVersion: 1,
    label: 'OSS Contributions',
    message,
    color,
  };
}
```

**Step 5: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/commands/stats.test.ts`
Expected: PASS

**Step 6: Register in CLI registry**

Add to the `commands` array in `packages/core/src/cli-registry.ts`:

```typescript
// ── Stats ─────────────────────────────────────────────────────────────
{
  name: 'stats',
  localOnly: true,
  register(program) {
    program
      .command('stats')
      .description('Show contribution statistics')
      .option('--json', 'Output as JSON')
      .option('--markdown', 'Output as shareable markdown report')
      .option('--badge', 'Output as shields.io endpoint JSON')
      .action(async (options) => {
        try {
          const { runStats, formatStatsMarkdown, formatStatsBadge } = await import('./commands/stats.js');
          const data = await runStats();
          if (options.badge) {
            console.log(JSON.stringify(formatStatsBadge(data), null, 2));
          } else if (options.markdown) {
            console.log(formatStatsMarkdown(data));
          } else if (options.json) {
            outputJson(data);
          } else {
            console.log(`\nOSS Contribution Stats (@${data.username})\n`);
            console.log(`  Merged PRs:        ${data.totalMerged}`);
            console.log(`  Closed PRs:        ${data.totalClosed}`);
            console.log(`  Merge Rate:        ${data.mergeRateFormatted}`);
            console.log(`  Active PRs:        ${data.activePRs}`);
            console.log(`  Repos Contributed: ${data.reposContributed}`);
            if (data.topRepos.length > 0) {
              console.log(`\n  Top Repos:`);
              for (const repo of data.topRepos.slice(0, 5)) {
                console.log(`    ${repo.repo}: ${repo.mergedCount} merged`);
              }
            }
            console.log('\n  Use --markdown for a shareable report or --badge for shields.io');
          }
        } catch (err) {
          handleCommandError(err, options.json);
        }
      });
  },
},
```

**Step 7: Run full test suite**

Run: `cd packages/core && npx vitest run`
Expected: All tests pass

**Step 8: Commit**

```bash
git add packages/core/src/commands/stats.ts packages/core/src/commands/stats.test.ts packages/core/src/cli-registry.ts packages/core/src/formatters/json.ts
git commit -m "feat: add stats CLI command with JSON, markdown, and badge output"
```

---

## Task 7: Add stats formatting tests

**Files:**
- Modify: `packages/core/src/commands/stats.test.ts`

**Step 1: Write formatting tests**

Add to `packages/core/src/commands/stats.test.ts`:

```typescript
import { formatStatsMarkdown, formatStatsBadge } from './stats.js';

describe('formatStatsMarkdown', () => {
  const stats: StatsOutput = {
    totalMerged: 8,
    totalClosed: 1,
    mergeRate: 0.889,
    mergeRateFormatted: '88.9%',
    activePRs: 2,
    reposContributed: 2,
    topRepos: [
      { repo: 'owner/repo1', mergedCount: 5 },
      { repo: 'owner/repo2', mergedCount: 3 },
    ],
    username: 'testuser',
  };

  it('should generate valid markdown with heading', () => {
    const md = formatStatsMarkdown(stats);
    expect(md).toContain('# OSS Contribution Stats for @testuser');
    expect(md).toContain('| Merged PRs | 8 |');
    expect(md).toContain('| Merge Rate | 88.9% |');
    expect(md).toContain('owner/repo1');
  });

  it('should include attribution link', () => {
    const md = formatStatsMarkdown(stats);
    expect(md).toContain('OSS Autopilot');
    expect(md).toContain('costajohnt/oss-autopilot');
  });
});

describe('formatStatsBadge', () => {
  it('should return shields.io compatible JSON with green for high merge rate', () => {
    const badge = formatStatsBadge({
      totalMerged: 10, totalClosed: 1, mergeRate: 0.91,
      mergeRateFormatted: '90.9%', activePRs: 2, reposContributed: 3,
      topRepos: [], username: 'testuser',
    });

    expect(badge).toEqual({
      schemaVersion: 1,
      label: 'OSS Contributions',
      message: expect.stringContaining('90.9%'),
      color: 'brightgreen',
    });
  });

  it('should return blue for new contributors', () => {
    const badge = formatStatsBadge({
      totalMerged: 0, totalClosed: 0, mergeRate: 0,
      mergeRateFormatted: '0.0%', activePRs: 0, reposContributed: 0,
      topRepos: [], username: 'newuser',
    });

    expect(badge).toEqual({
      schemaVersion: 1,
      label: 'OSS Contributions',
      message: 'Getting Started',
      color: 'blue',
    });
  });
});
```

**Step 2: Run tests**

Run: `cd packages/core && npx vitest run src/commands/stats.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/core/src/commands/stats.test.ts
git commit -m "test: add formatting tests for stats markdown and badge output"
```

---

## Task 8: Create badge-endpoint package

**Files:**
- Create: `packages/badge-endpoint/package.json`
- Create: `packages/badge-endpoint/tsconfig.json`
- Create: `packages/badge-endpoint/api/badge/[username].ts`
- Create: `packages/badge-endpoint/vercel.json`
- Modify: `pnpm-workspace.yaml` (verify `packages/*` already covers it)

**Step 1: Verify workspace config**

Read `pnpm-workspace.yaml` to confirm `packages/*` glob is present.

Run: `cat pnpm-workspace.yaml`
Expected: Contains `- 'packages/*'` (already includes any new package under packages/)

**Step 2: Create package.json**

Create `packages/badge-endpoint/package.json`:

```json
{
  "name": "@oss-autopilot/badge-endpoint",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vercel dev",
    "deploy": "vercel --prod"
  },
  "dependencies": {
    "@octokit/rest": "^21.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.5.0",
    "vercel": "^39.0.0"
  }
}
```

**Step 3: Create tsconfig.json**

Create `packages/badge-endpoint/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["api/**/*.ts"]
}
```

**Step 4: Create vercel.json**

Create `packages/badge-endpoint/vercel.json`:

```json
{
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=600" },
        { "key": "Access-Control-Allow-Origin", "value": "*" }
      ]
    }
  ]
}
```

**Step 5: Create the serverless function**

Create `packages/badge-endpoint/api/badge/[username].ts`:

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Octokit } from '@octokit/rest';

interface BadgeResponse {
  schemaVersion: number;
  label: string;
  message: string;
  color: string;
}

function errorBadge(message: string): BadgeResponse {
  return { schemaVersion: 1, label: 'OSS Contributions', message, color: 'lightgrey' };
}

/**
 * Compute contribution stats for a GitHub user by querying public PR data.
 * Returns shields.io endpoint-compatible JSON.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { username } = req.query;

  if (typeof username !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username)) {
    return res.status(200).json(errorBadge('invalid username'));
  }

  try {
    const octokit = new Octokit();

    // Fetch merged PR count (public data, no auth needed but rate-limited to 10 req/min)
    const mergedResult = await octokit.search.issuesAndPullRequests({
      q: `is:pr is:merged author:${username}`,
      per_page: 1,
    });
    const mergedCount = mergedResult.data.total_count;

    // Fetch closed-without-merge count
    const closedResult = await octokit.search.issuesAndPullRequests({
      q: `is:pr is:closed is:unmerged author:${username}`,
      per_page: 1,
    });
    const closedCount = closedResult.data.total_count;

    // Fetch open PR count
    const openResult = await octokit.search.issuesAndPullRequests({
      q: `is:pr is:open author:${username}`,
      per_page: 1,
    });
    const openCount = openResult.data.total_count;

    const total = mergedCount + closedCount;
    const mergeRate = total > 0 ? mergedCount / total : 0;
    const mergeRatePct = `${(mergeRate * 100).toFixed(0)}%`;

    let message: string;
    let color: string;

    if (mergedCount === 0 && openCount === 0) {
      message = 'Getting Started';
      color = 'blue';
    } else {
      message = `${mergeRatePct} merge rate · ${mergedCount} merged · ${openCount} open`;
      color = mergeRate >= 0.8 ? 'brightgreen'
        : mergeRate >= 0.6 ? 'green'
        : mergeRate >= 0.4 ? 'yellow'
        : 'orange';
    }

    return res.status(200).json({
      schemaVersion: 1,
      label: 'OSS Contributions',
      message,
      color,
    } satisfies BadgeResponse);
  } catch (error: any) {
    if (error.status === 422) {
      return res.status(200).json(errorBadge('user not found'));
    }
    return res.status(200).json(errorBadge('error'));
  }
}
```

**Step 6: Commit**

```bash
git add packages/badge-endpoint/
git commit -m "feat: add shields.io badge endpoint serverless function"
```

---

## Task 9: Add README documentation for stats and badges

**Files:**
- Modify: `README.md` (add Stats & Badges section)

**Step 1: Add documentation section**

Add a new section to `README.md` after the existing features sections:

```markdown
## Contribution Stats & Badges

### View Your Stats

```bash
oss-autopilot stats              # Terminal output
oss-autopilot stats --json       # Structured JSON
oss-autopilot stats --markdown   # Shareable markdown report
oss-autopilot stats --badge      # Shields.io endpoint JSON
```

### Add a Badge to Your GitHub Profile

Show off your open source contributions with a live badge on your GitHub profile README:

```markdown
![OSS Contributions](https://img.shields.io/endpoint?url=https://oss-autopilot-stats.vercel.app/api/badge/YOUR_USERNAME)
```

The badge updates hourly and shows your merge rate, total merged PRs, and active PR count.
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add stats command and badge documentation"
```

---

## Task 10: Run full test suite and bundle

**Files:** None (validation only)

**Step 1: Run all tests**

Run: `cd packages/core && npx vitest run`
Expected: All tests pass

**Step 2: Build and bundle**

Run: `pnpm run bundle`
Expected: `packages/core/dist/cli.bundle.cjs` regenerated without errors

**Step 3: Smoke test the stats command**

Run: `GITHUB_TOKEN=$(gh auth token) node packages/core/dist/cli.bundle.cjs stats --json`
Expected: JSON output with stats data

**Step 4: Smoke test auto-detect (optional, only if fresh state)**

Run: `GITHUB_TOKEN=$(gh auth token) node packages/core/dist/cli.bundle.cjs startup --json`
Expected: Output includes `setupComplete: true`

**Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: test and bundle validation"
```

---

## Summary of All Tasks

| Task | Feature | Files | Effort |
|------|---------|-------|--------|
| 1 | Zero-config | `utils.ts`, `utils.test.ts` | Small |
| 2 | Zero-config | `state.ts`, `state.test.ts` | Small |
| 3 | Zero-config | `startup.ts`, `startup.test.ts`, `json.ts` | Medium |
| 4 | Zero-config | `oss.md`, `setup-oss.md` | Small |
| 5 | Stats | `stats.ts`, `stats.test.ts` | Small |
| 6 | Stats CLI | `stats.ts` (cmd), `stats.test.ts`, `cli-registry.ts`, `json.ts` | Medium |
| 7 | Stats | `stats.test.ts` (formatting tests) | Small |
| 8 | Badge | `packages/badge-endpoint/` (new package) | Medium |
| 9 | Docs | `README.md` | Small |
| 10 | Validation | Bundle + smoke test | Small |
