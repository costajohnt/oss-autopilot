/**
 * Tests for utility functions originally in utils.ts.
 *
 * The functions now live in the focused modules created by #1116
 * (urls.ts, dates.ts, paths.ts, auth.ts). The shim was removed in #1141;
 * this test file was kept under the historical name to preserve git
 * history and is still the canonical home for cross-module utility tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseGitHubUrl, extractOwnerRepo, splitRepo } from './urls.js';
import { daysBetween, formatRelativeTime, byDateDescending } from './dates.js';
import {
  getGitHubToken,
  getGitHubTokenAsync,
  requireGitHubToken,
  resetGitHubTokenCache,
  detectGitHubUsername,
} from './auth.js';
import { getDataDir, getStatePath, getBackupDir, stateFileExists } from './paths.js';
import { execFileSync, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

describe('path utility functions', () => {
  it('getDataDir should return a path ending with .oss-autopilot', () => {
    const dir = getDataDir();
    expect(dir).toBe(path.join(os.homedir(), '.oss-autopilot'));
  });

  it('getStatePath should return a path ending with state.json', () => {
    const statePath = getStatePath();
    expect(statePath).toMatch(/state\.json$/);
    expect(statePath).toContain('.oss-autopilot');
  });

  it('getBackupDir should return a path ending with backups', () => {
    const backupDir = getBackupDir();
    expect(backupDir).toMatch(/backups$/);
    expect(backupDir).toContain('.oss-autopilot');
  });
});

describe('parseGitHubUrl', () => {
  it('should parse a valid PR URL', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo/pull/123');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 123, type: 'pull' });
  });

  it('should parse a valid issue URL', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo/issues/456');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 456, type: 'issues' });
  });

  it('should handle hyphenated owner and repo names', () => {
    const result = parseGitHubUrl('https://github.com/my-org/my-repo/pull/1');
    expect(result).toEqual({ owner: 'my-org', repo: 'my-repo', number: 1, type: 'pull' });
  });

  it('should handle dotted repo names', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo.js/pull/42');
    expect(result).toEqual({ owner: 'owner', repo: 'repo.js', number: 42, type: 'pull' });
  });

  it('should handle underscored names', () => {
    const result = parseGitHubUrl('https://github.com/my_org/my_repo/issues/7');
    expect(result).toEqual({ owner: 'my_org', repo: 'my_repo', number: 7, type: 'issues' });
  });

  it('should return null for non-GitHub URLs', () => {
    expect(parseGitHubUrl('https://gitlab.com/owner/repo/pull/1')).toBeNull();
  });

  it('should return null for HTTP (non-HTTPS) URLs', () => {
    expect(parseGitHubUrl('http://github.com/owner/repo/pull/1')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseGitHubUrl('')).toBeNull();
  });

  it('should return null for GitHub URL without pull/issues path', () => {
    expect(parseGitHubUrl('https://github.com/owner/repo')).toBeNull();
  });

  it('should return null for GitHub URL with missing number', () => {
    expect(parseGitHubUrl('https://github.com/owner/repo/pull/')).toBeNull();
  });

  it('should return null for malformed owner with special characters in PR URL', () => {
    expect(parseGitHubUrl('https://github.com/owner@bad/repo/pull/1')).toBeNull();
  });

  it('should return null for malformed owner with special characters in issue URL', () => {
    expect(parseGitHubUrl('https://github.com/owner@bad/repo/issues/1')).toBeNull();
  });

  it('should parse large PR numbers', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo/pull/99999');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 99999, type: 'pull' });
  });
});

describe('extractOwnerRepo', () => {
  it('should extract owner and repo from a PR URL', () => {
    expect(extractOwnerRepo('https://github.com/facebook/react/pull/123')).toEqual({
      owner: 'facebook',
      repo: 'react',
    });
  });

  it('should extract owner and repo from an issue URL', () => {
    expect(extractOwnerRepo('https://github.com/vercel/next.js/issues/456')).toEqual({
      owner: 'vercel',
      repo: 'next.js',
    });
  });

  it('should extract from a bare repo URL with trailing slash', () => {
    expect(extractOwnerRepo('https://github.com/vercel/next.js/')).toEqual({ owner: 'vercel', repo: 'next.js' });
  });

  it('should handle hyphenated and underscored names', () => {
    expect(extractOwnerRepo('https://github.com/my-org/my_repo/pull/1')).toEqual({ owner: 'my-org', repo: 'my_repo' });
  });

  it('should return null for non-GitHub URLs', () => {
    expect(extractOwnerRepo('https://gitlab.com/owner/repo')).toBeNull();
  });

  it('should return null for non-HTTPS GitHub URLs', () => {
    expect(extractOwnerRepo('http://github.com/owner/repo')).toBeNull();
  });

  it('should return null for SSH-style URLs', () => {
    expect(extractOwnerRepo('ssh://git@github.com/owner/repo')).toBeNull();
  });

  it('should return null for invalid owner characters', () => {
    expect(extractOwnerRepo('https://github.com/bad@owner/repo')).toBeNull();
  });

  it('should return null for URLs with only owner (no repo)', () => {
    expect(extractOwnerRepo('https://github.com/owner')).toBeNull();
  });
});

describe('daysBetween', () => {
  it('should return 0 for same day', () => {
    const now = new Date();
    expect(daysBetween(now, now)).toBe(0);
  });

  it('should return 1 for exactly 24 hours apart', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-02T00:00:00Z');
    expect(daysBetween(from, to)).toBe(1);
  });

  it('should return 0 for 23 hours apart (floor behavior)', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-01T23:00:00Z');
    expect(daysBetween(from, to)).toBe(0);
  });

  it('should handle large date differences', () => {
    const from = new Date('2025-01-01T00:00:00Z');
    const to = new Date('2026-01-01T00:00:00Z');
    expect(daysBetween(from, to)).toBe(365);
  });

  it('should clamp to zero for reversed dates', () => {
    const from = new Date('2026-01-10T00:00:00Z');
    const to = new Date('2026-01-01T00:00:00Z');
    expect(daysBetween(from, to)).toBe(0);
  });

  it('should handle leap year', () => {
    const from = new Date('2024-02-28T00:00:00Z');
    const to = new Date('2024-03-01T00:00:00Z');
    expect(daysBetween(from, to)).toBe(2); // Feb 28 → Feb 29 → Mar 1
  });
});

describe('splitRepo', () => {
  it('should split standard owner/repo format', () => {
    expect(splitRepo('facebook/react')).toEqual({ owner: 'facebook', repo: 'react' });
  });

  it('should handle hyphenated names', () => {
    expect(splitRepo('my-org/my-repo')).toEqual({ owner: 'my-org', repo: 'my-repo' });
  });

  it('should throw for input with no slash', () => {
    expect(() => splitRepo('noslash')).toThrow('Invalid repo format: expected "owner/repo", got "noslash"');
  });

  it('should throw for empty string', () => {
    expect(() => splitRepo('')).toThrow('Invalid repo format: expected "owner/repo", got ""');
  });

  it('should handle extra slashes (takes first two parts)', () => {
    const result = splitRepo('owner/repo/extra');
    expect(result.owner).toBe('owner');
    expect(result.repo).toBe('repo');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-08T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should format minutes ago', () => {
    expect(formatRelativeTime('2026-02-08T11:45:00Z')).toBe('15m ago');
  });

  it('should format 0 minutes ago for very recent times', () => {
    expect(formatRelativeTime('2026-02-08T12:00:00Z')).toBe('0m ago');
  });

  it('should format hours ago', () => {
    expect(formatRelativeTime('2026-02-08T09:00:00Z')).toBe('3h ago');
  });

  it('should show 59m at the 59-minute boundary (not 1h)', () => {
    expect(formatRelativeTime('2026-02-08T11:01:00Z')).toBe('59m ago');
  });

  it('should show 1h at the 60-minute boundary', () => {
    expect(formatRelativeTime('2026-02-08T11:00:00Z')).toBe('1h ago');
  });

  it('should format days ago', () => {
    expect(formatRelativeTime('2026-02-05T12:00:00Z')).toBe('3d ago');
  });

  it('should show 23h at the 23-hour boundary (not 1d)', () => {
    expect(formatRelativeTime('2026-02-07T13:00:00Z')).toBe('23h ago');
  });

  it('should show 29d at the 29-day boundary', () => {
    expect(formatRelativeTime('2026-01-10T12:00:00Z')).toBe('29d ago');
  });

  it('should switch to date format at 30+ days', () => {
    const result = formatRelativeTime('2026-01-01T12:00:00Z');
    // toLocaleDateString() output varies by locale, just verify it's not "Xd ago"
    expect(result).not.toContain('d ago');
    expect(result).not.toContain('h ago');
    expect(result).not.toContain('m ago');
  });
});

describe('byDateDescending', () => {
  it('should sort items by date descending', () => {
    const items = [{ date: '2026-01-01' }, { date: '2026-03-01' }, { date: '2026-02-01' }];
    items.sort(byDateDescending((item) => item.date));
    expect(items.map((i) => i.date)).toEqual(['2026-03-01', '2026-02-01', '2026-01-01']);
  });

  it('should handle null dates (sort to end)', () => {
    const items = [{ date: null as string | null }, { date: '2026-02-01' }, { date: '2026-01-01' }];
    items.sort(byDateDescending((item) => item.date));
    expect(items[0].date).toBe('2026-02-01');
    expect(items[1].date).toBe('2026-01-01');
    expect(items[2].date).toBeNull();
  });

  it('should handle undefined dates', () => {
    const items = [{ date: undefined as string | undefined }, { date: '2026-01-01' }];
    items.sort(byDateDescending((item) => item.date));
    expect(items[0].date).toBe('2026-01-01');
    expect(items[1].date).toBeUndefined();
  });

  it('should handle equal dates (stable)', () => {
    const items = [
      { date: '2026-01-01', id: 'a' },
      { date: '2026-01-01', id: 'b' },
    ];
    items.sort(byDateDescending((item) => item.date));
    // Both have same date, order is stable (0 diff)
    expect(items.length).toBe(2);
  });
});

describe('getGitHubToken', () => {
  const mockedExecFileSync = vi.mocked(execFileSync);

  beforeEach(() => {
    resetGitHubTokenCache();
    mockedExecFileSync.mockReset();
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  it('should return token from GITHUB_TOKEN env var', () => {
    process.env.GITHUB_TOKEN = 'ghp_env_token_123';
    const token = getGitHubToken();
    expect(token).toBe('ghp_env_token_123');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('should fall back to gh CLI when no env var', () => {
    mockedExecFileSync.mockReturnValue('ghp_faketoken\n');
    const token = getGitHubToken();
    expect(token).toBe('ghp_faketoken');
    expect(mockedExecFileSync).toHaveBeenCalledWith('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2000,
    });
  });

  it('should cache the token on subsequent calls', () => {
    mockedExecFileSync.mockReturnValue('ghp_cached_token\n');
    const token1 = getGitHubToken();
    const token2 = getGitHubToken();
    expect(token1).toBe('ghp_cached_token');
    expect(token2).toBe('ghp_cached_token');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('should return null when no token is available', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('gh not found');
    });
    const token = getGitHubToken();
    expect(token).toBeNull();
  });

  it('should return null on retry after failure without retrying', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('gh not found');
    });
    const token1 = getGitHubToken();
    expect(token1).toBeNull();
    // Second call should not retry execFileSync
    const token2 = getGitHubToken();
    expect(token2).toBeNull();
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('should allow re-fetch after resetGitHubTokenCache', () => {
    process.env.GITHUB_TOKEN = 'ghp_first_token';
    const token1 = getGitHubToken();
    expect(token1).toBe('ghp_first_token');

    resetGitHubTokenCache();
    process.env.GITHUB_TOKEN = 'ghp_second_token';
    const token2 = getGitHubToken();
    expect(token2).toBe('ghp_second_token');
  });

  it('should return token from requireGitHubToken when available', () => {
    process.env.GITHUB_TOKEN = 'ghp_required_token';
    const token = requireGitHubToken();
    expect(token).toBe('ghp_required_token');
  });

  it('should throw with helpful message from requireGitHubToken when no token', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('gh not found');
    });
    expect(() => requireGitHubToken()).toThrow('GitHub authentication required.');
    expect(() => requireGitHubToken()).toThrow('gh auth login');
  });
});

describe('getGitHubTokenAsync', () => {
  const mockedExecFile = vi.mocked(execFile);

  beforeEach(() => {
    resetGitHubTokenCache();
    mockedExecFile.mockReset();
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  it('should return token from GITHUB_TOKEN env var', async () => {
    process.env.GITHUB_TOKEN = 'ghp_env_async_token';
    const token = await getGitHubTokenAsync();
    expect(token).toBe('ghp_env_async_token');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('should fall back to gh CLI asynchronously when no env var', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(null, 'ghp_async_token\n');
      return {} as ReturnType<typeof execFile>;
    });
    const token = await getGitHubTokenAsync();
    expect(token).toBe('ghp_async_token');
    expect(mockedExecFile).toHaveBeenCalledWith(
      'gh',
      ['auth', 'token'],
      { encoding: 'utf-8', timeout: 2000 },
      expect.any(Function),
    );
  });

  it('should cache the token on subsequent calls', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(null, 'ghp_async_cached\n');
      return {} as ReturnType<typeof execFile>;
    });
    const token1 = await getGitHubTokenAsync();
    const token2 = await getGitHubTokenAsync();
    expect(token1).toBe('ghp_async_cached');
    expect(token2).toBe('ghp_async_cached');
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it('should return null when gh CLI fails', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(new Error('gh not found'), '');
      return {} as ReturnType<typeof execFile>;
    });
    const token = await getGitHubTokenAsync();
    expect(token).toBeNull();
  });

  it('should not retry after a failed attempt', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(new Error('gh not found'), '');
      return {} as ReturnType<typeof execFile>;
    });
    const token1 = await getGitHubTokenAsync();
    expect(token1).toBeNull();
    const token2 = await getGitHubTokenAsync();
    expect(token2).toBeNull();
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it('should share cache with synchronous getGitHubToken', async () => {
    process.env.GITHUB_TOKEN = 'ghp_shared_cache';
    const asyncToken = await getGitHubTokenAsync();
    expect(asyncToken).toBe('ghp_shared_cache');

    // The sync version should return the cached value without calling execFileSync
    const syncToken = getGitHubToken();
    expect(syncToken).toBe('ghp_shared_cache');
  });

  it('should allow re-fetch after resetGitHubTokenCache', async () => {
    process.env.GITHUB_TOKEN = 'ghp_first_async';
    const token1 = await getGitHubTokenAsync();
    expect(token1).toBe('ghp_first_async');

    resetGitHubTokenCache();
    process.env.GITHUB_TOKEN = 'ghp_second_async';
    const token2 = await getGitHubTokenAsync();
    expect(token2).toBe('ghp_second_async');
  });
});

describe('stateFileExists', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    // Hermetic fixture: redirect os.homedir() (which reads HOME on Unix,
    // USERPROFILE on Windows) so stateFileExists checks the temp dir, not
    // the developer/CI user's real ~/.oss-autopilot (#1003).
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-statefile-test-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('returns false when the state file does not exist', () => {
    expect(stateFileExists()).toBe(false);
  });

  it('returns true when the state file exists', () => {
    const dir = path.join(tempHome, '.oss-autopilot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), '{}');
    expect(stateFileExists()).toBe(true);
  });

  it('returns false when the directory exists but the file does not', () => {
    fs.mkdirSync(path.join(tempHome, '.oss-autopilot'), { recursive: true });
    expect(stateFileExists()).toBe(false);
  });
});

describe('detectGitHubUsername', () => {
  const mockedExecFile = vi.mocked(execFile);

  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it('should return username when gh api succeeds', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(null, 'octocat\n');
      return {} as ReturnType<typeof execFile>;
    });
    const username = await detectGitHubUsername();
    expect(username).toBe('octocat');
    expect(mockedExecFile).toHaveBeenCalledWith(
      'gh',
      ['api', 'user', '--jq', '.login'],
      { encoding: 'utf-8', timeout: 5000 },
      expect.any(Function),
    );
  });

  it('should return null when gh command fails', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(new Error('gh not found'), '');
      return {} as ReturnType<typeof execFile>;
    });
    const username = await detectGitHubUsername();
    expect(username).toBeNull();
  });

  it('should return null for empty output', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(null, '   \n');
      return {} as ReturnType<typeof execFile>;
    });
    const username = await detectGitHubUsername();
    expect(username).toBeNull();
  });

  it('should return null for invalid username pattern', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(null, '-invalid-start\n');
      return {} as ReturnType<typeof execFile>;
    });
    const username = await detectGitHubUsername();
    expect(username).toBeNull();
  });

  it('should return null for username with consecutive hyphens', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(null, 'bad--name\n');
      return {} as ReturnType<typeof execFile>;
    });
    const username = await detectGitHubUsername();
    expect(username).toBeNull();
  });

  it('should accept valid usernames with hyphens', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(null, 'my-username-42\n');
      return {} as ReturnType<typeof execFile>;
    });
    const username = await detectGitHubUsername();
    expect(username).toBe('my-username-42');
  });

  it('should accept single character usernames', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(null, 'x\n');
      return {} as ReturnType<typeof execFile>;
    });
    const username = await detectGitHubUsername();
    expect(username).toBe('x');
  });

  it('should reject usernames longer than 39 characters', async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      cb(null, 'a'.repeat(40) + '\n');
      return {} as ReturnType<typeof execFile>;
    });
    const username = await detectGitHubUsername();
    expect(username).toBeNull();
  });

  it('should never throw, even on unexpected errors', async () => {
    mockedExecFile.mockImplementation(() => {
      throw new Error('Unexpected synchronous error');
    });
    const username = await detectGitHubUsername();
    expect(username).toBeNull();
  });
});
