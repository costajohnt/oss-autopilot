/**
 * GitHub authentication: token resolution + username detection.
 *
 * Both sync and async token getters share a process-level cache so a
 * successful async fetch makes subsequent sync calls instant.
 *
 * Extracted from utils.ts under #1116.
 */

import { execFileSync, execFile } from 'node:child_process';
import { ConfigurationError } from './errors.js';
import { debug } from './logger.js';

const MODULE = 'auth';

// Cached GitHub token (fetched once per session)
let cachedGitHubToken: string | null = null;
let tokenFetchAttempted = false;

/**
 * Retrieves a GitHub authentication token, checking sources in priority order.
 *
 * Checks `GITHUB_TOKEN` environment variable first, then falls back to `gh auth token`
 * from the GitHub CLI. The result is cached after the first successful lookup (or first
 * failed attempt), so subsequent calls are instant and do not spawn subprocesses.
 *
 * @returns The GitHub token string, or `null` if no token is available
 */
export function getGitHubToken(): string | null {
  if (cachedGitHubToken) {
    return cachedGitHubToken;
  }

  if (tokenFetchAttempted) {
    return null;
  }

  tokenFetchAttempted = true;

  if (process.env.GITHUB_TOKEN) {
    cachedGitHubToken = process.env.GITHUB_TOKEN;
    return cachedGitHubToken;
  }

  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();

    if (token && token.length > 0) {
      cachedGitHubToken = token;
      debug(MODULE, 'Using GitHub token from gh CLI');
      return cachedGitHubToken;
    }
  } catch (err) {
    debug(MODULE, 'gh auth token failed (CLI unavailable or not authenticated)', err);
  }

  return null;
}

/**
 * Returns a GitHub token or throws an error with setup instructions.
 *
 * Delegates to {@link getGitHubToken} and throws if no token is found. Use this
 * in commands that cannot proceed without authentication.
 *
 * @throws {ConfigurationError} If no token is available, with instructions for `gh auth login` or setting `GITHUB_TOKEN`
 */
export function requireGitHubToken(): string {
  const token = getGitHubToken();

  if (!token) {
    throw new ConfigurationError(
      'GitHub authentication required.\n\n' +
        'Options:\n' +
        '  1. Use gh CLI: gh auth login\n' +
        '  2. Set GITHUB_TOKEN environment variable\n\n' +
        'The gh CLI is recommended - install from https://cli.github.com',
    );
  }

  return token;
}

/**
 * Resets the cached GitHub token and fetch-attempted flag.
 *
 * Intended for use in tests to ensure a clean state between test cases.
 * After calling this, the next call to {@link getGitHubToken} will re-fetch the token.
 */
export function resetGitHubTokenCache(): void {
  cachedGitHubToken = null;
  tokenFetchAttempted = false;
}

/**
 * Asynchronous version of {@link getGitHubToken}.
 *
 * Uses `execFile` (non-blocking) instead of `execFileSync` to avoid blocking
 * the event loop during CLI cold start. Shares the same cache as the synchronous
 * version, so a successful async fetch makes subsequent sync calls instant.
 */
export async function getGitHubTokenAsync(): Promise<string | null> {
  if (cachedGitHubToken) {
    return cachedGitHubToken;
  }

  if (tokenFetchAttempted) {
    return null;
  }

  tokenFetchAttempted = true;

  if (process.env.GITHUB_TOKEN) {
    cachedGitHubToken = process.env.GITHUB_TOKEN;
    return cachedGitHubToken;
  }

  try {
    const token = await new Promise<string>((resolve, reject) => {
      execFile('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 2000 }, (error, stdout) => {
        if (error) {
          reject(error as Error);
        } else {
          resolve(stdout.trim());
        }
      });
    });

    if (token && token.length > 0) {
      cachedGitHubToken = token;
      debug(MODULE, 'Using GitHub token from gh CLI (async)');
      return cachedGitHubToken;
    }
  } catch (err) {
    debug(MODULE, 'gh auth token failed (CLI unavailable or not authenticated)', err);
  }

  return null;
}

/**
 * GitHub username validation pattern.
 * Usernames must start with an alphanumeric character, can contain hyphens
 * (but not consecutive ones and not at the end), and be 1-39 characters.
 */
const GITHUB_USERNAME_RE = /^[\da-z](?:[\da-z]|-(?=[\da-z])){0,38}$/i;

/**
 * Detect the authenticated GitHub username via the `gh` CLI.
 *
 * Runs `gh api user --jq '.login'` asynchronously and validates the result
 * against GitHub's username rules. Never throws — returns `null` on any failure
 * (gh not installed, not authenticated, invalid output, etc.).
 */
export async function detectGitHubUsername(): Promise<string | null> {
  try {
    const login = await new Promise<string>((resolve, reject) => {
      execFile('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
        if (error) {
          reject(error as Error);
        } else {
          resolve(stdout.trim());
        }
      });
    });

    if (login && GITHUB_USERNAME_RE.test(login)) {
      debug(MODULE, `Detected GitHub username: ${login}`);
      return login;
    }

    debug(MODULE, `gh api user returned invalid username: "${login}"`);
    return null;
  } catch (err) {
    debug(MODULE, 'detectGitHubUsername failed', err);
    return null;
  }
}
