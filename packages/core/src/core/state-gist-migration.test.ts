/**
 * Post-migration persistence detection (#1438).
 *
 * The first-time Gist migration renames state.json to
 * state.json.pre-gist-migration, and gist-mode saves only ever write
 * state-cache.json. Before the fix, ensureGistPersistence treated a missing
 * state.json as "fresh local-mode user", so the machine that CREATED the
 * Gist permanently dropped out of gist mode on its very next process: fresh
 * local state, orphaned Gist, and no warning anywhere (even the LOCAL-ONLY
 * warning was suppressed because the status read local-mode). Pinned here:
 *
 *  - the real createWithGist migration path renames state.json and leaves
 *    the cache + gist-id artifacts behind,
 *  - a fresh process's ensureGistPersistence peek classifies that machine
 *    as gist-configured (via the cache, or the gist-id file when the cache
 *    is missing — e.g. installs migrated before the cache write existed),
 *  - a genuinely fresh install (no artifacts at all) still reads local-mode,
 *  - an explicit non-gist config in the cache wins over a stray gist-id file,
 *  - an unreadable cache reports state-unreadable, not a local-mode choice.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let mockTmpDir = '';

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  const dir = () => {
    if (!mockTmpDir) throw new Error('mockTmpDir not set');
    if (!fs.existsSync(mockTmpDir)) fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
    return mockTmpDir;
  };
  return {
    ...actual,
    getDataDir: dir,
    getStatePath: () => path.join(dir(), 'state.json'),
    getStateCachePath: () => path.join(dir(), 'state-cache.json'),
    getGistIdPath: () => path.join(dir(), 'gist-id'),
    getBackupDir: () => {
      const backupDir = path.join(dir(), 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      return backupDir;
    },
    getLegacyStatePath: () => path.join(mockTmpDir, 'legacy-data', 'state.json'),
    getLegacyBackupDir: () => path.join(mockTmpDir, 'legacy-data', 'backups'),
  };
});

const gistsCreate = vi.fn();
const gistsList = vi.fn();
const gistsGet = vi.fn();

vi.mock('./github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github.js')>();
  return {
    ...actual,
    getOctokit: () => ({
      gists: {
        create: gistsCreate,
        list: gistsList,
        get: gistsGet,
      },
    }),
  };
});

import { resetStateManager, ensureGistPersistence } from './state.js';

describe('post-migration persistence detection (#1438)', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-migration-'));
    resetStateManager();
    vi.clearAllMocks();
    // checkGistScope + searchForGist both call gists.list; an empty list
    // passes the scope probe and forces the create-new-Gist migration path.
    gistsList.mockResolvedValue({ data: [] });
    gistsCreate.mockImplementation(({ files }: { files: Record<string, { content: string }> }) =>
      Promise.resolve({ data: { id: 'gist-1438', files } }),
    );
  });

  afterEach(() => {
    resetStateManager();
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('keeps the migrating machine in gist mode across processes', async () => {
    fs.writeFileSync(
      path.join(mockTmpDir, 'state.json'),
      JSON.stringify({ version: 4, config: { persistence: 'gist' } }),
      'utf8',
    );

    // Process 1: first gist-mode run migrates local state into a new Gist.
    await expect(ensureGistPersistence('token-1')).resolves.toBe('gist');
    expect(gistsCreate).toHaveBeenCalledTimes(1);
    // The migration renames state.json away and leaves the gist artifacts.
    expect(fs.existsSync(path.join(mockTmpDir, 'state.json'))).toBe(false);
    expect(fs.existsSync(path.join(mockTmpDir, 'state.json.pre-gist-migration'))).toBe(true);
    expect(fs.existsSync(path.join(mockTmpDir, 'state-cache.json'))).toBe(true);
    expect(fs.readFileSync(path.join(mockTmpDir, 'gist-id'), 'utf8')).toBe('gist-1438');

    // Process 2: a fresh peek must NOT classify this machine as local-mode —
    // that was the #1438 regression (fresh local state, orphaned Gist).
    resetStateManager();
    await expect(ensureGistPersistence(null)).resolves.toBe('no-token');
  });

  it('falls back to the gist-id file when the cache is also missing', async () => {
    fs.writeFileSync(path.join(mockTmpDir, 'gist-id'), 'gist-1438', 'utf8');
    await expect(ensureGistPersistence(null)).resolves.toBe('no-token');
  });

  it('still reads local-mode on a genuinely fresh install', async () => {
    await expect(ensureGistPersistence(null)).resolves.toBe('local-mode');
  });

  it('respects an explicit non-gist cache config over a stray gist-id file', async () => {
    fs.writeFileSync(
      path.join(mockTmpDir, 'state-cache.json'),
      JSON.stringify({ version: 4, config: { persistence: 'local' } }),
      'utf8',
    );
    fs.writeFileSync(path.join(mockTmpDir, 'gist-id'), 'gist-1438', 'utf8');
    await expect(ensureGistPersistence(null)).resolves.toBe('local-mode');
  });

  it('reports state-unreadable, not local-mode, when the cache cannot be parsed', async () => {
    fs.writeFileSync(path.join(mockTmpDir, 'state-cache.json'), '{not json', 'utf8');
    await expect(ensureGistPersistence(null)).resolves.toBe('state-unreadable');
  });
});
