/**
 * --json contract test for the `dismiss`/`undismiss` commands (#965, #997).
 *
 * Goldens pin the DismissOutput/UndismissOutput shapes so the plugin and MCP
 * server cannot silently drift apart from the CLI. Covers both success (newly
 * dismissed/undismissed) and noop (already in the target state) paths.
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/dismiss.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

const mockDismissIssue = vi.fn();
const mockUndismissIssue = vi.fn();

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => ({
      dismissIssue: mockDismissIssue,
      undismissIssue: mockUndismissIssue,
      isGistMode: () => false,
    }),
  };
});

import { runDismiss, runUndismiss } from './dismiss.js';

const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/42';

describe('dismiss --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('dismiss success output matches the golden shape', async () => {
    mockDismissIssue.mockReturnValue(true);
    const result = await runDismiss({ url: TEST_ISSUE_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/dismiss.success.json');
  });

  it('dismiss noop output matches the golden shape (already dismissed)', async () => {
    mockDismissIssue.mockReturnValue(false);
    const result = await runDismiss({ url: TEST_ISSUE_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/dismiss.noop.json');
  });

  it('undismiss success output matches the golden shape', async () => {
    mockUndismissIssue.mockReturnValue(true);
    const result = await runUndismiss({ url: TEST_ISSUE_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/undismiss.success.json');
  });

  it('undismiss noop output matches the golden shape (not currently dismissed)', async () => {
    mockUndismissIssue.mockReturnValue(false);
    const result = await runUndismiss({ url: TEST_ISSUE_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/undismiss.noop.json');
  });
});
