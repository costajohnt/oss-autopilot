/**
 * Tests for state-cmd: runStateShow, runStateSync, runStateUnlink
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/state.js', () => ({
  getStateManager: vi.fn(),
  resetStateManager: vi.fn(),
}));

vi.mock('../core/state-persistence.js', () => ({
  atomicWriteFileSync: vi.fn(),
}));

vi.mock('../core/utils.js', () => ({
  getStatePath: vi.fn(),
  getGistIdPath: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

import { getStateManager, resetStateManager } from '../core/state.js';
import { atomicWriteFileSync } from '../core/state-persistence.js';
import { getStatePath, getGistIdPath } from '../core/utils.js';
import * as fs from 'fs';
import { runStateShow, runStateSync, runStateUnlink } from './state-cmd.js';
import { makeStateManagerMock, makeAgentState } from '../core/test-utils.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockResetStateManager = vi.mocked(resetStateManager);
const mockAtomicWriteFileSync = vi.mocked(atomicWriteFileSync);
const mockGetStatePath = vi.mocked(getStatePath);
const mockGetGistIdPath = vi.mocked(getGistIdPath);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockUnlinkSync = vi.mocked(fs.unlinkSync);

const STATE_PATH = '/home/user/.oss-autopilot/state.json';
const GIST_ID_PATH = '/home/user/.oss-autopilot/gist-id';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStatePath.mockReturnValue(STATE_PATH);
  mockGetGistIdPath.mockReturnValue(GIST_ID_PATH);
});

// ---------------------------------------------------------------------------
// runStateShow
// ---------------------------------------------------------------------------

describe('runStateShow', () => {
  it('returns state data in gist mode', async () => {
    const state = makeAgentState({
      gistId: 'abc123',
      config: { persistence: 'gist' },
      lastRunAt: '2026-01-15T10:00:00Z',
    });
    const sm = {
      ...makeStateManagerMock({ state: { gistId: 'abc123', lastRunAt: '2026-01-15T10:00:00Z' }, config: { persistence: 'gist' } }),
      isGistDegraded: vi.fn().mockReturnValue(false),
    };
    mockGetStateManager.mockReturnValue(sm as any);

    const result = await runStateShow();

    expect(result).toEqual({
      persistence: 'gist',
      gistId: 'abc123',
      gistDegraded: false,
      lastRunAt: '2026-01-15T10:00:00Z',
    });
  });

  it('returns state data in local mode with null gistId', async () => {
    const sm = {
      ...makeStateManagerMock({ config: { persistence: 'local' } }),
      isGistDegraded: vi.fn().mockReturnValue(false),
    };
    mockGetStateManager.mockReturnValue(sm as any);

    const result = await runStateShow();

    expect(result.persistence).toBe('local');
    expect(result.gistId).toBeNull();
    expect(result.gistDegraded).toBe(false);
  });

  it('returns gistDegraded true when gist is degraded', async () => {
    const sm = {
      ...makeStateManagerMock({ state: { gistId: 'abc123' }, config: { persistence: 'gist' } }),
      isGistDegraded: vi.fn().mockReturnValue(true),
    };
    mockGetStateManager.mockReturnValue(sm as any);

    const result = await runStateShow();

    expect(result.gistDegraded).toBe(true);
  });

  it('returns undefined lastRunAt when not set', async () => {
    const sm = {
      ...makeStateManagerMock({ state: { lastRunAt: undefined } }),
      isGistDegraded: vi.fn().mockReturnValue(false),
    };
    // Patch getState to return a state with no lastRunAt
    sm.getState = () => ({ ...makeAgentState(), lastRunAt: undefined } as any);
    mockGetStateManager.mockReturnValue(sm as any);

    const result = await runStateShow();

    expect(result.lastRunAt).toBeUndefined();
  });

  it('defaults persistence to "local" when config.persistence is not set', async () => {
    const state = makeAgentState();
    // Remove persistence from config
    (state.config as any).persistence = undefined;
    const sm = {
      getState: () => state as any,
      isGistDegraded: vi.fn().mockReturnValue(false),
    };
    mockGetStateManager.mockReturnValue(sm as any);

    const result = await runStateShow();

    expect(result.persistence).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// runStateSync
// ---------------------------------------------------------------------------

describe('runStateSync', () => {
  it('returns pushed:false when not in gist mode', async () => {
    const sm = {
      ...makeStateManagerMock(),
      isGistMode: vi.fn().mockReturnValue(false),
      checkpoint: vi.fn(),
    };
    mockGetStateManager.mockReturnValue(sm as any);

    const result = await runStateSync();

    expect(result).toEqual({ pushed: false, gistId: null });
    expect(sm.checkpoint).not.toHaveBeenCalled();
  });

  it('pushes state and returns pushed:true with gistId on success', async () => {
    const state = makeAgentState({ gistId: 'abc123' });
    const sm = {
      getState: () => state as any,
      isGistMode: vi.fn().mockReturnValue(true),
      checkpoint: vi.fn().mockResolvedValue(true),
    };
    mockGetStateManager.mockReturnValue(sm as any);

    const result = await runStateSync();

    expect(sm.checkpoint).toHaveBeenCalledOnce();
    expect(result).toEqual({ pushed: true, gistId: 'abc123' });
  });

  it('throws when checkpoint returns false', async () => {
    const sm = {
      ...makeStateManagerMock(),
      isGistMode: vi.fn().mockReturnValue(true),
      checkpoint: vi.fn().mockResolvedValue(false),
    };
    mockGetStateManager.mockReturnValue(sm as any);

    await expect(runStateSync()).rejects.toThrow('Failed to push state to Gist');
  });

  it('propagates errors thrown by checkpoint', async () => {
    const sm = {
      ...makeStateManagerMock(),
      isGistMode: vi.fn().mockReturnValue(true),
      checkpoint: vi.fn().mockRejectedValue(new Error('network error')),
    };
    mockGetStateManager.mockReturnValue(sm as any);

    await expect(runStateSync()).rejects.toThrow('network error');
  });
});

// ---------------------------------------------------------------------------
// runStateUnlink
// ---------------------------------------------------------------------------

describe('runStateUnlink', () => {
  it('refreshes from gist, writes local state, removes gist-id file, resets singleton', async () => {
    const state = makeAgentState({ gistId: 'abc123', config: { persistence: 'gist' } });
    const mockRefreshFromGist = vi.fn().mockResolvedValue(true);
    const sm = {
      getState: vi.fn().mockReturnValue(state),
      isGistMode: vi.fn().mockReturnValue(true),
      refreshFromGist: mockRefreshFromGist,
    };
    mockGetStateManager.mockReturnValue(sm as any);
    mockExistsSync.mockReturnValue(true);

    const result = await runStateUnlink();

    expect(mockRefreshFromGist).toHaveBeenCalledOnce();
    expect(mockAtomicWriteFileSync).toHaveBeenCalledOnce();
    expect(mockAtomicWriteFileSync).toHaveBeenCalledWith(
      STATE_PATH,
      expect.any(String),
      0o600,
    );
    // Written state should not have gistId and should have persistence: 'local'
    const writtenJson = JSON.parse(mockAtomicWriteFileSync.mock.calls[0][1] as string);
    expect(writtenJson.gistId).toBeUndefined();
    expect(writtenJson.config.persistence).toBe('local');

    expect(mockUnlinkSync).toHaveBeenCalledWith(GIST_ID_PATH);
    expect(mockResetStateManager).toHaveBeenCalledOnce();
    expect(result).toEqual({
      unlinked: true,
      localStatePath: STATE_PATH,
      previousGistId: 'abc123',
    });
  });

  it('skips refreshFromGist when not in gist mode', async () => {
    const state = makeAgentState({ gistId: undefined });
    const mockRefreshFromGist = vi.fn();
    const sm = {
      getState: vi.fn().mockReturnValue(state),
      isGistMode: vi.fn().mockReturnValue(false),
      refreshFromGist: mockRefreshFromGist,
    };
    mockGetStateManager.mockReturnValue(sm as any);
    mockExistsSync.mockReturnValue(false);

    const result = await runStateUnlink();

    expect(mockRefreshFromGist).not.toHaveBeenCalled();
    expect(result.previousGistId).toBeNull();
    expect(result.unlinked).toBe(true);
  });

  it('does not call unlinkSync when gist-id file does not exist', async () => {
    const state = makeAgentState({ gistId: 'abc123' });
    const sm = {
      getState: vi.fn().mockReturnValue(state),
      isGistMode: vi.fn().mockReturnValue(false),
      refreshFromGist: vi.fn(),
    };
    mockGetStateManager.mockReturnValue(sm as any);
    mockExistsSync.mockReturnValue(false);

    await runStateUnlink();

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('continues and warns when unlinkSync throws', async () => {
    const state = makeAgentState({ gistId: 'abc123' });
    const sm = {
      getState: vi.fn().mockReturnValue(state),
      isGistMode: vi.fn().mockReturnValue(false),
      refreshFromGist: vi.fn(),
    };
    mockGetStateManager.mockReturnValue(sm as any);
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    // Should not throw — error is caught and warned
    const result = await runStateUnlink();

    expect(result.unlinked).toBe(true);
    expect(mockResetStateManager).toHaveBeenCalledOnce();
  });

  it('resets state manager even when gist-id removal fails', async () => {
    const state = makeAgentState({ gistId: 'abc123' });
    const sm = {
      getState: vi.fn().mockReturnValue(state),
      isGistMode: vi.fn().mockReturnValue(false),
      refreshFromGist: vi.fn(),
    };
    mockGetStateManager.mockReturnValue(sm as any);
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => {
      throw new Error('io error');
    });

    await runStateUnlink();

    expect(mockResetStateManager).toHaveBeenCalledOnce();
  });
});
