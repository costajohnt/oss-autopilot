/**
 * --json contract test for the `shelve`/`unshelve` commands (#965, #997).
 *
 * Goldens pin the ShelveOutput/UnshelveOutput shapes so the plugin and MCP
 * server cannot silently drift apart from the CLI. Covers both success (newly
 * shelved/unshelved) and noop (already in the target state) paths.
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/shelve.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

const mockShelvePR = vi.fn();
const mockUnshelvePR = vi.fn();
const mockClearStatusOverride = vi.fn();
const mockBatch = vi.fn((fn: () => void) => fn());

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => ({
      shelvePR: mockShelvePR,
      unshelvePR: mockUnshelvePR,
      clearStatusOverride: mockClearStatusOverride,
      batch: mockBatch,
      // maybeCheckpoint() checks isGistMode first; stub to false so the
      // real helper short-circuits and contract tests don't need to mock
      // Gist plumbing.
      isGistMode: () => false,
    }),
  };
});

import { runShelve, runUnshelve } from './shelve.js';

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('shelve --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Batch is a pass-through wrapper — default impl re-applies the mutation
    mockBatch.mockImplementation((fn: () => void) => fn());
  });

  it('shelve success output matches the golden shape', async () => {
    mockShelvePR.mockReturnValue(true);
    const result = await runShelve({ prUrl: TEST_PR_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/shelve.success.json');
  });

  it('shelve noop output matches the golden shape (already shelved)', async () => {
    mockShelvePR.mockReturnValue(false);
    const result = await runShelve({ prUrl: TEST_PR_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/shelve.noop.json');
  });

  it('unshelve success output matches the golden shape', async () => {
    mockUnshelvePR.mockReturnValue(true);
    const result = await runUnshelve({ prUrl: TEST_PR_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/unshelve.success.json');
  });

  it('unshelve noop output matches the golden shape (not currently shelved)', async () => {
    mockUnshelvePR.mockReturnValue(false);
    const result = await runUnshelve({ prUrl: TEST_PR_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/unshelve.noop.json');
  });
});
