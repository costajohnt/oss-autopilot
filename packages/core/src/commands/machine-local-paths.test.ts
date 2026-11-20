/**
 * Two machines sharing one Gist keep their own filesystem paths (#1950).
 *
 * Each "machine" is a separate home directory under the test's temp HOME, so
 * each has its own `~/.oss-autopilot` (gist-id, state cache, local settings).
 * Both talk to one in-memory Gist. Only command-level entry points are used,
 * so the scenarios describe what a user sees.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const gist = vi.hoisted(() => ({ content: '', pushed: [] as string[] }));

vi.mock('../core/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/github.js')>();
  const response = () => ({
    data: { id: 'shared-gist', description: 'oss-autopilot-state', files: { 'state.json': { content: gist.content } } },
    headers: {},
  });
  const octokit = {
    gists: {
      get: async () => response(),
      list: async () => ({ data: [] }),
      create: async () => response(),
      update: async ({ files }: { files: Record<string, { content: string }> }) => {
        if (files['state.json']) {
          gist.content = files['state.json'].content;
          gist.pushed.push(gist.content);
        }
        return response();
      },
    },
  };
  return { ...actual, getOctokit: () => octokit };
});

import { StateManager, getStateManager, getStateManagerAsync, resetStateManager } from '../core/state.js';
import type { AgentState } from '../core/types.js';
import { runSetup } from './setup.js';
import { runConfig } from './config.js';
import { runLocalRepos } from './local-repos.js';
import { runStateShow } from './state-cmd.js';
import { runSkipAdd } from './skip-add.js';
import { detectIssueList } from './startup.js';

const testHome = os.homedir();
const testCwd = process.cwd();
const machineA = path.join(testHome, 'machine-a');
const machineB = path.join(testHome, 'machine-b');

/** Seed the shared Gist with a fresh gist-mode state, plus any synced fields. */
function seedGist(mutate: (state: AgentState) => void): void {
  const fresh = new StateManager(true);
  const state = structuredClone(fresh.getState()) as AgentState;
  state.config.persistence = 'gist';
  state.config.setupComplete = true;
  mutate(state);
  gist.content = JSON.stringify(state);
  gist.pushed.length = 0;
}

function noSyncedPaths(): void {
  // The Gist starts with none of the machine-specific keys.
}

/** Start a fresh process on the given machine: its own home, state pulled from the Gist. */
async function switchTo(home: string): Promise<void> {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const dataDir = path.join(home, '.oss-autopilot');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'gist-id'), 'shared-gist');
  resetStateManager();
  await getStateManagerAsync('test-token');
}

/** A vault with a list and a skip file on one machine's disk. */
function makeVault(home: string): { list: string; skip: string } {
  const dir = path.join(home, 'vault', 'open-source');
  fs.mkdirSync(dir, { recursive: true });
  const list = path.join(dir, 'potential-issue-list.md');
  const skip = path.join(dir, 'skipped-issues.md');
  fs.writeFileSync(list, '- [#1](https://github.com/o/r/issues/1) - Issue\n');
  fs.writeFileSync(skip, '# Skipped\n');
  return { list, skip };
}

function setPaths(vault: { list: string; skip: string }): string[] {
  return [`issueListPath=${vault.list}`, `skippedIssuesPath=${vault.skip}`];
}

function syncedState(): AgentState {
  return JSON.parse(gist.content) as AgentState;
}

beforeEach(() => {
  fs.rmSync(machineA, { recursive: true, force: true });
  fs.rmSync(machineB, { recursive: true, force: true });
});

afterEach(() => {
  process.chdir(testCwd);
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  resetStateManager();
});

describe('machine-specific paths with a shared Gist (#1950)', () => {
  it('two machines no longer overwrite each other: each keeps the paths it set', async () => {
    seedGist(noSyncedPaths);
    const vaultA = makeVault(machineA);
    const vaultB = makeVault(machineB);

    await switchTo(machineA);
    await runSetup({ set: setPaths(vaultA) });
    await switchTo(machineB);
    await runSetup({ set: setPaths(vaultB) });

    await switchTo(machineA);
    expect(detectIssueList()).toMatchObject({
      path: vaultA.list,
      source: 'configured',
      skippedIssuesPath: vaultA.skip,
    });
    await switchTo(machineB);
    expect(detectIssueList()).toMatchObject({
      path: vaultB.list,
      source: 'configured',
      skippedIssuesPath: vaultB.skip,
    });
  });

  it('path settings are written to the local file only, never to the synced document', async () => {
    seedGist(noSyncedPaths);
    const vault = makeVault(machineA);

    await switchTo(machineA);
    await runSetup({ set: setPaths(vault) });
    await runConfig({ key: 'issueListPath', value: vault.list });
    await runSetup({ set: ['maxActivePRs=7'] });

    expect(getStateManager().getState().config.issueListPath).toBeUndefined();
    expect(getStateManager().getState().config.skippedIssuesPath).toBeUndefined();
    expect(gist.pushed.length).toBeGreaterThan(0);
    expect(gist.pushed.join('\n')).not.toContain(machineA);
    const local = fs.readFileSync(path.join(machineA, '.oss-autopilot', 'local-config.json'), 'utf8');
    expect(JSON.parse(local)).toEqual({
      issueListPath: { path: vault.list, source: 'set' },
      skippedIssuesPath: { path: vault.skip, source: 'set' },
    });
  });

  it('a list auto-detected in the current directory is kept locally, not pushed', async () => {
    seedGist(noSyncedPaths);
    const vault = makeVault(machineA);

    await switchTo(machineA);
    process.chdir(path.join(machineA, 'vault'));
    const found = detectIssueList();
    await getStateManager().checkpoint();

    expect(found).toMatchObject({ path: fs.realpathSync(vault.list), source: 'auto-detected' });
    expect(gist.content).not.toContain('potential-issue-list.md');
    const local = fs.readFileSync(path.join(machineA, '.oss-autopilot', 'local-config.json'), 'utf8');
    expect(JSON.parse(local)).toEqual({
      issueListPath: { path: fs.realpathSync(vault.list), source: 'probe' },
      skippedIssuesPath: { path: fs.realpathSync(vault.skip), source: 'probe' },
    });
  });

  it('an old-shaped synced state still loads, keeps its keys, and a machine without those paths does not adopt them', async () => {
    const foreignList = path.join(machineA, 'vault', 'open-source', 'potential-issue-list.md');
    seedGist((state) => {
      state.config.issueListPath = foreignList;
      state.config.skippedIssuesPath = path.join(machineA, 'vault', 'open-source', 'skipped-issues.md');
      state.localRepoCache = {
        repos: { 'o/r': { path: path.join(machineA, 'dev', 'r'), exists: true, currentBranch: 'main' } },
        scanPaths: [path.join(machineA, 'dev')],
        cachedAt: '2026-11-19T00:00:00.000Z',
      };
    });

    await switchTo(machineB);
    const state = getStateManager().getState();
    const located = detectIssueList();
    await getStateManager().checkpoint();

    // The keys survive load and push untouched, for clients that still read them.
    expect(state.config.issueListPath).toBe(foreignList);
    expect(syncedState().config.issueListPath).toBe(foreignList);
    expect(syncedState().localRepoCache?.repos['o/r']).toBeDefined();
    // Same result as a configured-but-missing path before this change: no list.
    expect(located).toBeUndefined();
    expect(fs.existsSync(path.join(machineB, '.oss-autopilot', 'local-config.json'))).toBe(false);
  });

  it('a synced path that exists on this machine is adopted, then survives an older client overwriting the synced key', async () => {
    const vaultA = makeVault(machineA);
    seedGist((state) => {
      state.config.issueListPath = vaultA.list;
    });

    await switchTo(machineA);
    expect(detectIssueList()?.path).toBe(vaultA.list);
    // An older client on machine B writes its own path to the shared document.
    seedGist((state) => {
      state.config.issueListPath = path.join(machineB, 'elsewhere', 'list.md');
    });
    await switchTo(machineA);

    expect(detectIssueList()).toMatchObject({ path: vaultA.list, source: 'configured' });
  });

  it('local-repos never returns the other machine clone paths', async () => {
    const repoA = path.join(machineA, 'dev', 'r');
    seedGist((state) => {
      state.localRepoCache = {
        repos: { 'o/r': { path: repoA, exists: true, currentBranch: 'main' } },
        scanPaths: [path.join(machineA, 'dev')],
        cachedAt: '2026-11-19T00:00:00.000Z',
      };
    });

    await switchTo(machineB);
    const repos = await runLocalRepos({ paths: [path.join(machineB, 'dev')] });

    expect(repos).toMatchObject({ fromCache: false, repos: {} });
    expect(JSON.stringify(repos)).not.toContain(machineA);
  });

  it('state-show prints no path at all, so never the other machine synced paths', async () => {
    seedGist((state) => {
      state.config.issueListPath = path.join(machineA, 'vault', 'list.md');
      state.config.skippedIssuesPath = path.join(machineA, 'vault', 'skip.md');
    });

    await switchTo(machineB);
    const shown = await runStateShow({ validate: true });

    expect(shown).toMatchObject({ persistence: 'gist', gistId: 'shared-gist' });
    expect(JSON.stringify(shown)).not.toContain(machineA);
  });

  it('config shows the paths in effect on this machine and where they come from', async () => {
    const vaultB = makeVault(machineB);
    const foreignList = path.join(machineA, 'vault', 'list.md');
    seedGist((state) => {
      state.config.issueListPath = foreignList;
      state.config.skippedIssuesPath = path.join(machineA, 'vault', 'skip.md');
    });

    await switchTo(machineB);
    const before = await runConfig({});
    await runSetup({ set: [`issueListPath=${vaultB.list}`, 'skippedIssuesPath='] });
    const after = await runConfig({});

    // No local value yet: the synced fallback is what is in effect, and says so.
    expect(before).toMatchObject({
      config: { issueListPath: foreignList },
      machinePathSources: { issueListPath: 'synced', skippedIssuesPath: 'synced' },
    });
    expect(after).toMatchObject({
      config: { issueListPath: vaultB.list },
      machinePathSources: { issueListPath: 'set', skippedIssuesPath: 'set' },
    });
    expect(after).not.toHaveProperty('config.skippedIssuesPath');
    expect(JSON.stringify(after)).not.toContain(machineA);
    // The shown overlay is a copy: the synced document keeps its keys.
    expect(getStateManager().getState().config.issueListPath).toBe(foreignList);
  });

  it('skip-add refuses to create a skip file under a directory that only exists on the other machine', async () => {
    const foreignSkip = path.join(machineA, 'vault', 'open-source', 'skipped-issues.md');
    seedGist((state) => {
      state.config.skippedIssuesPath = foreignSkip;
    });

    await switchTo(machineB);

    expect(() => runSkipAdd({ issueUrl: 'https://github.com/o/r/issues/1' })).toThrow(
      /directory does not exist on this machine.*setup --set skippedIssuesPath=<path>/,
    );
    expect(fs.existsSync(path.dirname(foreignSkip))).toBe(false);
  });

  it('a fresh scan is cached locally and removes the synced copy from the Gist', async () => {
    seedGist((state) => {
      state.localRepoCache = {
        repos: { 'o/r': { path: path.join(machineA, 'dev', 'r'), exists: true, currentBranch: 'main' } },
        scanPaths: [path.join(machineA, 'dev')],
        cachedAt: '2026-11-19T00:00:00.000Z',
      };
    });

    await switchTo(machineB);
    await runLocalRepos({ scan: true, paths: [path.join(machineB, 'dev')] });
    await getStateManager().checkpoint();
    const cached = await runLocalRepos({});

    expect(syncedState().localRepoCache).toBeUndefined();
    expect(gist.content).not.toContain(machineA);
    expect(gist.content).not.toContain(machineB);
    expect(cached).toMatchObject({ fromCache: true, repos: {}, scanPaths: [path.join(machineB, 'dev')] });
  });
});
