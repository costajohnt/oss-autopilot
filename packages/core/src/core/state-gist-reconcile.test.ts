/**
 * createWithGist reconciles repoScores against the ledger on load (#1897).
 *
 * The constructor reconciles on a local load, but createWithGist builds an
 * in-memory manager and swaps in the Gist state, so counts an old daily run
 * overwrote from the capped search were never repaired by a fresh process.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import type { AgentState } from './types.js';

const h = vi.hoisted(() => ({ tmpDir: '', state: undefined as unknown as AgentState }));

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  return {
    ...actual,
    getDataDir: () => h.tmpDir,
    getStatePath: () => path.join(h.tmpDir, 'state.json'),
    getStateCachePath: () => path.join(h.tmpDir, 'state-cache.json'),
    getGistIdPath: () => path.join(h.tmpDir, 'gist-id'),
    getBackupDir: () => path.join(h.tmpDir, 'backups'),
  };
});

vi.mock('./github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github.js')>();
  return { ...actual, getOctokit: () => ({}) };
});

vi.mock('./gist-state-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gist-state-store.js')>();
  class MockGistStateStore {
    bootstrap = () => Promise.resolve({ gistId: 'gist-1', state: h.state, created: false });
  }
  return { ...actual, GistStateStore: MockGistStateStore };
});

import { StateManager } from './state.js';
import { createFreshState } from './state-persistence.js';
import { makeRepoScore } from './test-utils.js';

function merged(repo: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://github.com/${repo}/pull/${i + 1}`,
    title: `PR ${i + 1}`,
    mergedAt: '2026-01-01T00:00:00Z',
  }));
}

describe('StateManager.createWithGist reconciles PR counts on load (#1897)', () => {
  beforeEach(() => {
    h.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-reconcile-'));
    const state = createFreshState();
    state.config.minStars = 100;
    // Ledger: 340 + 25 merges in starred repos, 5 below minStars.
    state.mergedPRs = [...merged('big/repo', 340), ...merged('small/repo', 25), ...merged('tiny/repo', 5)];
    // Counts a capped daily run left behind: big/repo undercounted, small/repo zeroed.
    state.repoScores = {
      'big/repo': makeRepoScore({ repo: 'big/repo', mergedPRCount: 274, stargazersCount: 1000 }),
      'small/repo': makeRepoScore({ repo: 'small/repo', stargazersCount: 1000 }),
      'tiny/repo': makeRepoScore({ repo: 'tiny/repo', stargazersCount: 10 }),
    };
    h.state = state;
  });

  afterEach(() => {
    fs.rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it('reports the star-filtered ledger count without marking state un-pushed', async () => {
    const manager = await StateManager.createWithGist('test-token');

    expect(manager.getStats().mergedPRs).toBe(365);
    expect(manager.hasUnpushedChanges()).toBe(false);
  });
});
