/**
 * Token-cache latch semantics (#1415).
 *
 * The front-door auth module previously latched `tokenFetchAttempted` BEFORE
 * the `gh auth token` attempt, so a single transient failure (a 2s spawn
 * timeout on a busy machine) returned null forever for the process — which
 * permanently silenced Gist mode in the long-lived MCP server. The contract
 * pinned here: timeouts do NOT latch (the next call retries), definitive
 * outcomes (token, empty token, gh missing/not authenticated) DO latch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
  execFileSync: mocks.execFileSync,
}));

import { getGitHubToken, getGitHubTokenAsync, resetGitHubTokenCache } from './auth.js';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

/** Queue one async `gh auth token` outcome. */
function execFileOnce(outcome: { error?: Error; stdout?: string }): void {
  mocks.execFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
    if (outcome.error) cb(outcome.error, '', '');
    else cb(null, outcome.stdout ?? '', '');
    return {} as never;
  });
}

/** An async execFile timeout kill, as Node reports it (killed, no code). */
function asyncTimeoutError(): Error {
  return Object.assign(new Error('spawn gh ETIMEDOUT'), { killed: true, signal: 'SIGTERM' });
}

/** A SYNC execFileSync timeout, as Node reports it: `code: 'ETIMEDOUT'`,
 * NO `killed` property — the production shape the sync no-latch arm
 * depends on (verified empirically; the two paths differ). */
function syncTimeoutError(): Error {
  return Object.assign(new Error('spawn gh ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
}

/** gh not installed. */
function enoentError(): Error {
  return Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
}

let savedEnvToken: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  resetGitHubTokenCache();
  savedEnvToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  if (savedEnvToken !== undefined) process.env.GITHUB_TOKEN = savedEnvToken;
  resetGitHubTokenCache();
});

describe('getGitHubTokenAsync latch semantics (#1415)', () => {
  it('a timeout does NOT latch: the next call retries and can succeed', async () => {
    execFileOnce({ error: asyncTimeoutError() });
    expect(await getGitHubTokenAsync()).toBeNull();

    execFileOnce({ stdout: 'ghp_recovered\n' });
    expect(await getGitHubTokenAsync()).toBe('ghp_recovered');
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it('gh missing (ENOENT) latches: the next call returns null without spawning', async () => {
    execFileOnce({ error: enoentError() });
    expect(await getGitHubTokenAsync()).toBeNull();

    expect(await getGitHubTokenAsync()).toBeNull();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('an authoritative empty token latches', async () => {
    execFileOnce({ stdout: '\n' });
    expect(await getGitHubTokenAsync()).toBeNull();

    expect(await getGitHubTokenAsync()).toBeNull();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('a successful fetch is cached: no second spawn', async () => {
    execFileOnce({ stdout: 'ghp_cached\n' });
    expect(await getGitHubTokenAsync()).toBe('ghp_cached');
    expect(await getGitHubTokenAsync()).toBe('ghp_cached');
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('a non-zero gh exit (not authenticated) latches', async () => {
    // Async shape for `gh auth token` exiting 1: numeric code, killed false.
    execFileOnce({ error: Object.assign(new Error('gh exited 1'), { code: 1, killed: false }) });
    expect(await getGitHubTokenAsync()).toBeNull();

    expect(await getGitHubTokenAsync()).toBeNull();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('GITHUB_TOKEN env wins without spawning', async () => {
    process.env.GITHUB_TOKEN = 'ghp_env';
    expect(await getGitHubTokenAsync()).toBe('ghp_env');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

describe('getGitHubToken (sync) latch semantics (#1415)', () => {
  it('a timeout does NOT latch the sync path either', () => {
    mocks.execFileSync.mockImplementationOnce(() => {
      throw syncTimeoutError();
    });
    expect(getGitHubToken()).toBeNull();

    mocks.execFileSync.mockReturnValueOnce('ghp_sync\n');
    expect(getGitHubToken()).toBe('ghp_sync');
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
  });

  it('a definitive failure latches the sync path', () => {
    mocks.execFileSync.mockImplementationOnce(() => {
      throw enoentError();
    });
    expect(getGitHubToken()).toBeNull();

    expect(getGitHubToken()).toBeNull();
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });

  it('the caches are shared: an async success makes sync instant', async () => {
    execFileOnce({ stdout: 'ghp_shared\n' });
    expect(await getGitHubTokenAsync()).toBe('ghp_shared');
    expect(getGitHubToken()).toBe('ghp_shared');
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });
});
