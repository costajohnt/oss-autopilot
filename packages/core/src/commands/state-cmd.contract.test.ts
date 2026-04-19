/**
 * --json contract test for the `state` command (#965, #986).
 *
 * Goldens for the three subcommands' outputs: show, sync, unlink.
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/state-cmd.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

vi.mock('../core/state.js', () => ({
  getStateManager: vi.fn(),
  resetStateManager: vi.fn(),
}));

vi.mock('../core/state-persistence.js', () => ({
  atomicWriteFileSync: vi.fn(),
}));

vi.mock('../core/utils.js', () => ({
  getStatePath: vi.fn().mockReturnValue('/fake/state.json'),
  getGistIdPath: vi.fn().mockReturnValue('/fake/gist-id'),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: vi.fn().mockReturnValue(true), unlinkSync: vi.fn() };
});

vi.mock('../core/logger.js', () => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  timed: vi.fn(),
}));

import { getStateManager } from '../core/state.js';
import { runStateShow, runStateSync, runStateUnlink } from './state-cmd.js';

const mockGetStateManager = vi.mocked(getStateManager);

describe('state --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('--show (local mode) output matches the golden shape', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({
        config: { persistence: 'local' },
        lastRunAt: '2026-01-15T10:00:00.000Z',
      }),
      isGistDegraded: vi.fn().mockReturnValue(false),
    } as unknown as ReturnType<typeof getStateManager>);

    const result = await runStateShow();
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/state.show.local.json');
  });

  it('--show (gist mode, degraded) output matches the golden shape', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({
        config: { persistence: 'gist' },
        gistId: 'abc123def456',
        lastRunAt: '2026-01-15T10:00:00.000Z',
      }),
      isGistDegraded: vi.fn().mockReturnValue(true),
    } as unknown as ReturnType<typeof getStateManager>);

    const result = await runStateShow();
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/state.show.gist-degraded.json');
  });

  it('--sync (not in gist mode) output matches the golden shape', async () => {
    mockGetStateManager.mockReturnValue({
      isGistMode: vi.fn().mockReturnValue(false),
    } as unknown as ReturnType<typeof getStateManager>);

    const result = await runStateSync();
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/state.sync.noop.json');
  });

  it('--sync (gist mode, pushed) output matches the golden shape', async () => {
    mockGetStateManager.mockReturnValue({
      isGistMode: vi.fn().mockReturnValue(true),
      checkpoint: vi.fn().mockResolvedValue(true),
      getState: vi.fn().mockReturnValue({ gistId: 'abc123def456' }),
    } as unknown as ReturnType<typeof getStateManager>);

    const result = await runStateSync();
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/state.sync.pushed.json');
  });

  it('--unlink output matches the golden shape', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({
        gistId: 'abc123def456',
        config: { persistence: 'gist' },
      }),
      isGistMode: vi.fn().mockReturnValue(false),
      refreshFromGist: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof getStateManager>);

    const result = await runStateUnlink();
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/state.unlink.json');
  });
});
