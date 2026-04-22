/**
 * --json contract test for the `startup` command (#965, #986).
 *
 * Snapshots the top-level shape variants without pulling in the full
 * daily-check pipeline: `setupComplete: false` (pre-setup) and
 * `authError` (setup done, no token). The happy-path variant (which
 * includes a nested DailyOutput) is deferred until a dedicated
 * `daily` contract test exists — at that point this file should pin
 * that shape too.
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/startup.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

const mocks = vi.hoisted(() => ({
  stateManager: {
    isSetupComplete: vi.fn(),
    initializeWithDefaults: vi.fn(),
    getState: vi.fn(),
  },
  getCLIVersion: vi.fn().mockReturnValue('99.99.99-test'),
  getGitHubToken: vi.fn(),
  getGitHubTokenAsync: vi.fn(),
  detectGitHubUsername: vi.fn(),
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => mocks.stateManager,
    getCLIVersion: mocks.getCLIVersion,
    getGitHubToken: mocks.getGitHubToken,
    getGitHubTokenAsync: mocks.getGitHubTokenAsync,
    detectGitHubUsername: mocks.detectGitHubUsername,
  };
});

// Prevent the daily-check pipeline from running at all: we're only
// testing the short-circuit paths in this file.
vi.mock('./daily.js', () => ({
  executeDailyCheck: vi.fn().mockResolvedValue({
    digest: { summary: { totalActivePRs: 0 } },
    briefSummary: '',
  }),
}));

vi.mock('./dashboard-lifecycle.js', () => ({
  launchDashboardServer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./parse-list.js', () => ({
  parseIssueList: vi.fn().mockReturnValue({ availableCount: 0, completedCount: 0 }),
}));

import { runStartup } from './startup.js';

describe('startup --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCLIVersion.mockReturnValue('99.99.99-test');
  });

  it('setup-incomplete (no auto-detected username) output matches the golden shape', async () => {
    mocks.stateManager.isSetupComplete.mockReturnValue(false);
    mocks.detectGitHubUsername.mockResolvedValue(undefined);

    const result = await runStartup();
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/startup.setup-incomplete.json');
  });

  it('auth-error output matches the golden shape', async () => {
    mocks.stateManager.isSetupComplete.mockReturnValue(true);
    // Both token sources must be empty for the authError branch to fire —
    // runStartup uses the async variant (env → `gh auth token` fallback).
    mocks.getGitHubToken.mockReturnValue(null);
    mocks.getGitHubTokenAsync.mockResolvedValue(null);

    const result = await runStartup();
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/startup.auth-error.json');
  });
});
