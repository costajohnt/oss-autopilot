/**
 * --json contract test for the `move` command (#965, #997).
 *
 * Goldens pin the MoveOutput shape for all four valid targets so the plugin
 * and MCP server cannot silently drift apart from the CLI.
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/move.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

const mockSetStatusOverride = vi.fn();
const mockClearStatusOverride = vi.fn();
const mockShelvePR = vi.fn();
const mockUnshelvePR = vi.fn();
const mockBatch = vi.fn((fn: () => void) => fn());

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => ({
      setStatusOverride: mockSetStatusOverride,
      clearStatusOverride: mockClearStatusOverride,
      shelvePR: mockShelvePR,
      unshelvePR: mockUnshelvePR,
      batch: mockBatch,
      isGistMode: () => false,
    }),
  };
});

import { runMove } from './move.js';
import { MoveOutputSchema } from '../formatters/json.js';
import { schemaIssues } from '../core/test-utils.js';

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('move --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockBatch.mockImplementation((fn: () => void) => fn());
  });

  it('target=attention output matches the golden shape', async () => {
    const result = await runMove({ prUrl: TEST_PR_URL, target: 'attention' });
    expect(schemaIssues(MoveOutputSchema, result)).toEqual([]);
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/move.attention.json');
  });

  it('target=waiting output matches the golden shape', async () => {
    const result = await runMove({ prUrl: TEST_PR_URL, target: 'waiting' });
    expect(schemaIssues(MoveOutputSchema, result)).toEqual([]);
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/move.waiting.json');
  });

  it('target=shelved output matches the golden shape', async () => {
    const result = await runMove({ prUrl: TEST_PR_URL, target: 'shelved' });
    expect(schemaIssues(MoveOutputSchema, result)).toEqual([]);
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/move.shelved.json');
  });

  it('target=auto output matches the golden shape', async () => {
    const result = await runMove({ prUrl: TEST_PR_URL, target: 'auto' });
    expect(schemaIssues(MoveOutputSchema, result)).toEqual([]);
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/move.auto.json');
  });

  // The registry now passes MoveOutputSchema to executeAction (#1453), which
  // prints the Zod-parsed data rather than the raw runMove result. Pin that
  // the parse round-trips byte-identically for every target, so wiring the
  // schema cannot change happy-path --json output.
  it.each(['attention', 'waiting', 'shelved', 'auto'] as const)(
    'schema validation preserves the serialized bytes for target=%s (#1453)',
    async (target) => {
      const result = await runMove({ prUrl: TEST_PR_URL, target });
      expect(JSON.stringify(MoveOutputSchema.parse(result), null, 2)).toBe(JSON.stringify(result, null, 2));
    },
  );
});
