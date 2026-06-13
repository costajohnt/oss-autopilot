/**
 * Gist init retry semantics on the state singleton (#1415).
 *
 * `getStateManagerAsync` falls back to the local manager on a transient
 * network error during `createWithGist` (intentional CLI warn-and-proceed).
 * The latch bug: the fallback assigned the local singleton, and the
 * unconditional `if (stateManager) return stateManager` early-return made
 * every later token-bearing call a no-op — so a long-lived gist-configured
 * process (the MCP server) could never recover from one blip. Pinned here:
 *
 *  - the transient fallback reports `degraded` via ensureGistPersistence,
 *  - a LATER call with a token retries createWithGist and upgrades the
 *    singleton when it succeeds,
 *  - non-transient/configuration errors still throw (no silent fallback),
 *  - `no-token` and `local-mode` statuses are distinguished.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let mockTmpDir = '';

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  return {
    ...actual,
    getDataDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      return mockTmpDir;
    },
    getStatePath: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      return path.join(mockTmpDir, 'state.json');
    },
    getBackupDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      const backupDir = path.join(mockTmpDir, 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      return backupDir;
    },
    getLegacyStatePath: () => path.join(mockTmpDir, 'legacy-data', 'state.json'),
    getLegacyBackupDir: () => path.join(mockTmpDir, 'legacy-data', 'backups'),
  };
});

import {
  StateManager,
  getStateManager,
  resetStateManager,
  ensureGistPersistence,
  bootstrapGistBestEffort,
} from './state.js';
import { GistPermissionError } from './errors.js';

function writeGistConfiguredState(): void {
  fs.writeFileSync(
    path.join(mockTmpDir, 'state.json'),
    JSON.stringify({ version: 4, config: { persistence: 'gist' } }),
    'utf8',
  );
}

function transientError(): Error {
  return Object.assign(new Error('connect ECONNRESET api.github.com'), { code: 'ECONNRESET' });
}

/** Armed gist-backed manager: bootstrap verified its Gist (#1443). */
function armedGistManager(): StateManager {
  return { isGistMode: () => true, isGistDegraded: () => false } as unknown as StateManager;
}

/** Degraded gist-backed manager: bootstrap fell back to the local cache —
 * gistStore is assigned (isGistMode() true) but the store is disarmed. */
function degradedGistManager(): StateManager {
  return { isGistMode: () => true, isGistDegraded: () => true } as unknown as StateManager;
}

describe('ensureGistPersistence retry/upgrade semantics (#1415)', () => {
  let createWithGistSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-init-'));
    resetStateManager();
    createWithGistSpy = vi.spyOn(StateManager, 'createWithGist');
  });

  afterEach(() => {
    createWithGistSpy.mockRestore();
    resetStateManager();
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('returns local-mode when the config does not request gist persistence', async () => {
    expect(await ensureGistPersistence('token')).toBe('local-mode');
    expect(createWithGistSpy).not.toHaveBeenCalled();
  });

  it('returns no-token when gist is configured but no token is available', async () => {
    writeGistConfiguredState();
    expect(await ensureGistPersistence(null)).toBe('no-token');
    expect(createWithGistSpy).not.toHaveBeenCalled();
  });

  it('a transient blip degrades to local — and a LATER call upgrades the singleton', async () => {
    writeGistConfiguredState();

    createWithGistSpy.mockRejectedValueOnce(transientError());
    expect(await ensureGistPersistence('token')).toBe('degraded');
    const localFallback = getStateManager();
    expect(localFallback.isGistMode()).toBe(false);

    // The blip clears: the retry must actually reach createWithGist again
    // (pre-fix, the latched local singleton made this a dead no-op) and the
    // singleton upgrades to the gist-backed manager.
    const gistManager = armedGistManager();
    createWithGistSpy.mockResolvedValueOnce(gistManager);
    expect(await ensureGistPersistence('token')).toBe('gist');
    expect(createWithGistSpy).toHaveBeenCalledTimes(2);
    expect(getStateManager()).toBe(gistManager);
  });

  it('a lazily created local singleton does not block the gist upgrade', async () => {
    writeGistConfiguredState();
    // A tool body touched state before auth resolved — the local manager
    // exists but gist mode is configured and a token is now available.
    const lazyLocal = getStateManager();
    expect(lazyLocal.isGistMode()).toBe(false);

    const gistManager = armedGistManager();
    createWithGistSpy.mockResolvedValueOnce(gistManager);
    expect(await ensureGistPersistence('token')).toBe('gist');
    expect(getStateManager()).toBe(gistManager);
  });

  it('a gist-backed singleton short-circuits: no second createWithGist', async () => {
    writeGistConfiguredState();
    const gistManager = armedGistManager();
    createWithGistSpy.mockResolvedValueOnce(gistManager);

    expect(await ensureGistPersistence('token')).toBe('gist');
    expect(await ensureGistPersistence('token')).toBe('gist');
    expect(createWithGistSpy).toHaveBeenCalledTimes(1);
  });

  it('an unreadable state file reports state-unreadable, not a local-mode choice', async () => {
    fs.writeFileSync(path.join(mockTmpDir, 'state.json'), '{ not json', 'utf8');
    expect(await ensureGistPersistence('token')).toBe('state-unreadable');
    expect(createWithGistSpy).not.toHaveBeenCalled();
  });

  it('concurrent token-bearing calls share one in-flight createWithGist', async () => {
    writeGistConfiguredState();
    const gistManager = armedGistManager();
    let release!: () => void;
    createWithGistSpy.mockImplementationOnce(
      () =>
        new Promise<StateManager>((resolve) => {
          release = () => resolve(gistManager);
        }),
    );

    const a = ensureGistPersistence('token');
    const b = ensureGistPersistence('token');
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();

    expect(await a).toBe('gist');
    expect(await b).toBe('gist');
    expect(createWithGistSpy).toHaveBeenCalledTimes(1);
  });

  it('configuration errors still surface instead of degrading (#1202)', async () => {
    writeGistConfiguredState();
    createWithGistSpy.mockRejectedValueOnce(new GistPermissionError('token lacks gist scope'));
    await expect(ensureGistPersistence('token')).rejects.toThrow(/gist scope/);
  });
});

describe('degraded gist bootstrap honesty + retry (#1443)', () => {
  let createWithGistSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-degraded-'));
    resetStateManager();
    createWithGistSpy = vi.spyOn(StateManager, 'createWithGist');
  });

  afterEach(() => {
    createWithGistSpy.mockRestore();
    resetStateManager();
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it("a degraded bootstrap reports 'degraded', not 'gist'", async () => {
    writeGistConfiguredState();
    // bootstrap() caught all API failures internally and resolved with a
    // disarmed store — isGistMode() is true but nothing can read or push.
    createWithGistSpy.mockResolvedValueOnce(degradedGistManager());
    expect(await ensureGistPersistence('token')).toBe('degraded');
  });

  it('a later token-bearing call replaces a gist-degraded singleton and reports gist', async () => {
    writeGistConfiguredState();

    createWithGistSpy.mockResolvedValueOnce(degradedGistManager());
    expect(await ensureGistPersistence('token')).toBe('degraded');
    const degraded = getStateManager();
    expect(degraded.isGistMode()).toBe(true);
    expect(degraded.isGistDegraded()).toBe(true);

    // The outage clears: the retry must reach createWithGist again (pre-fix,
    // isGistMode() alone short-circuited it forever) and the singleton is
    // replaced by the armed manager.
    const armed = armedGistManager();
    createWithGistSpy.mockResolvedValueOnce(armed);
    expect(await ensureGistPersistence('token')).toBe('gist');
    expect(createWithGistSpy).toHaveBeenCalledTimes(2);
    expect(getStateManager()).toBe(armed);
  });

  it('a retry that resolves via ANOTHER degraded bootstrap stays degraded and keeps retrying', async () => {
    writeGistConfiguredState();

    createWithGistSpy.mockResolvedValueOnce(degradedGistManager());
    expect(await ensureGistPersistence('token')).toBe('degraded');
    createWithGistSpy.mockResolvedValueOnce(degradedGistManager());
    expect(await ensureGistPersistence('token')).toBe('degraded');
    // Still not latched: a third call attempts another bootstrap.
    createWithGistSpy.mockResolvedValueOnce(armedGistManager());
    expect(await ensureGistPersistence('token')).toBe('gist');
    expect(createWithGistSpy).toHaveBeenCalledTimes(3);
  });

  it('token-less calls do not disturb a degraded singleton (no thrash without a retry credential)', async () => {
    writeGistConfiguredState();
    createWithGistSpy.mockResolvedValueOnce(degradedGistManager());
    await ensureGistPersistence('token');
    const degraded = getStateManager();

    // getStateManagerAsync without a token must keep returning the existing
    // singleton rather than tearing it down.
    expect(await ensureGistPersistence(null)).toBe('no-token');
    expect(getStateManager()).toBe(degraded);
    expect(createWithGistSpy).toHaveBeenCalledTimes(1);
  });
});

describe('bootstrapGistBestEffort — localOnly CLI entry points (#1431)', () => {
  let createWithGistSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-besteffort-'));
    resetStateManager();
    createWithGistSpy = vi.spyOn(StateManager, 'createWithGist');
  });

  afterEach(() => {
    createWithGistSpy.mockRestore();
    resetStateManager();
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('local mode: no warning and no token fetch at all', async () => {
    const fetchToken = vi.fn().mockResolvedValue('token');
    expect(await bootstrapGistBestEffort(fetchToken)).toBeNull();
    expect(fetchToken).not.toHaveBeenCalled();
    expect(createWithGistSpy).not.toHaveBeenCalled();
  });

  it('gist mode + token: bootstraps the singleton and returns no warning (mutations will checkpoint)', async () => {
    writeGistConfiguredState();
    const gistManager = armedGistManager();
    createWithGistSpy.mockResolvedValueOnce(gistManager);

    expect(await bootstrapGistBestEffort(vi.fn().mockResolvedValue('token'))).toBeNull();
    // The load-bearing positive: the singleton is gist-backed, so the
    // command's own maybeCheckpoint will actually push instead of no-op.
    expect(getStateManager().isGistMode()).toBe(true);
    expect(createWithGistSpy).toHaveBeenCalledWith('token');
  });

  it('gist mode + no token: LOCAL-ONLY warning, no bootstrap attempt', async () => {
    writeGistConfiguredState();
    const warning = await bootstrapGistBestEffort(vi.fn().mockResolvedValue(null));
    expect(warning).toMatch(/LOCAL-ONLY/);
    expect(warning).toMatch(/no GitHub token/);
    expect(createWithGistSpy).not.toHaveBeenCalled();
  });

  it('transient init failure: degraded warning, command proceeds', async () => {
    writeGistConfiguredState();
    createWithGistSpy.mockRejectedValueOnce(transientError());
    const warning = await bootstrapGistBestEffort(vi.fn().mockResolvedValue('token'));
    expect(warning).toMatch(/LOCAL-ONLY/);
    expect(warning).toMatch(/transient network failure/);
  });

  it('unreadable state file: warning, command proceeds', async () => {
    fs.writeFileSync(path.join(mockTmpDir, 'state.json'), '{ not json', 'utf8');
    const warning = await bootstrapGistBestEffort(vi.fn().mockResolvedValue('token'));
    expect(warning).toMatch(/state file could not be read/);
  });

  it('hard ConfigurationError: warn-and-proceed with repair guidance, NEVER throws (repair commands must stay usable)', async () => {
    writeGistConfiguredState();
    createWithGistSpy.mockRejectedValueOnce(new GistPermissionError('token lacks gist scope'));
    const warning = await bootstrapGistBestEffort(vi.fn().mockResolvedValue('token'));
    expect(warning).toMatch(/LOCAL-ONLY/);
    expect(warning).toMatch(/gist scope/);
    expect(warning).toMatch(/fix the Gist setup/);
  });
});
