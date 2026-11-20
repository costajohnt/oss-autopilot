/**
 * Per-machine settings file (#1950). Runs under the temp HOME from
 * test-lib/isolate-home.ts, so `local-config.json` is a real file there.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { getLocalConfigPath } from './paths.js';
import { getMachinePath, getMachineRepoCache, setMachinePath, setMachineRepoCache } from './local-config.js';
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
    expect(readStored()).toEqual({ issueListPath: '/here/list.md' });
    expect(fs.statSync(getLocalConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('prefers the local value over the synced one', () => {
    setMachinePath('skippedIssuesPath', '/here/skip.md');

    expect(getMachinePath('skippedIssuesPath', { skippedIssuesPath: '/other-machine/skip.md' })).toBe('/here/skip.md');
  });

  it('keeps the other key when one is set', () => {
    setMachinePath('issueListPath', '/here/list.md');
    setMachinePath('skippedIssuesPath', '/here/skip.md');

    expect(readStored()).toEqual({ issueListPath: '/here/list.md', skippedIssuesPath: '/here/skip.md' });
  });

  it('a cleared value stays cleared even when the synced document still has one', () => {
    const synced = { issueListPath: existingFile('vault/list.md') };
    setMachinePath('issueListPath', undefined);

    expect(getMachinePath('issueListPath', synced)).toBeUndefined();
  });

  it('adopts a synced absolute path that exists on this machine', () => {
    const list = existingFile('vault/list.md');

    expect(getMachinePath('issueListPath', { issueListPath: list })).toBe(list);
    expect(readStored()).toEqual({ issueListPath: list });
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

  it('ignores an unreadable file instead of throwing', () => {
    fs.writeFileSync(getLocalConfigPath(), '{ not json');

    expect(getMachinePath('issueListPath', { issueListPath: '/synced/list.md' })).toBe('/synced/list.md');
  });

  it('still returns the synced value when the adoption write fails', () => {
    const list = existingFile('vault/list.md');
    fs.mkdirSync(getLocalConfigPath());

    expect(getMachinePath('issueListPath', { issueListPath: list })).toBe(list);
    fs.rmSync(getLocalConfigPath(), { recursive: true });
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
