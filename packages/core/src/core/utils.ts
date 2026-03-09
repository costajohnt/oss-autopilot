/**
 * Shared utility functions
 */

/** Default concurrency limit for parallel GitHub API requests. */
export const DEFAULT_CONCURRENCY = 5;

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, execFile } from 'child_process';
import { ConfigurationError } from './errors.js';
import { debug } from './logger.js';

const MODULE = 'utils';

// Cached GitHub token (fetched once per session)
let cachedGitHubToken: string | null = null;
let tokenFetchAttempted = false;

/**
 * Returns the oss-autopilot data directory path, creating it if it does not exist.
 *
 * The directory is located at `~/.oss-autopilot/` and serves as the root for
 * all persisted user data (state, backups, cache).
 *
 * @returns Absolute path to the data directory (e.g., `/Users/you/.oss-autopilot`)
 *
 * @example
 * const dir = getDataDir();
 * // "/Users/you/.oss-autopilot"
 */
export function getDataDir(): string {
  const dir = path.join(os.homedir(), '.oss-autopilot');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Returns the path to the state file (`~/.oss-autopilot/state.json`).
 *
 * Implicitly creates the data directory via {@link getDataDir} if it does not exist.
 *
 * @returns Absolute path to `state.json`
 *
 * @example
 * const statePath = getStatePath();
 * // "/Users/you/.oss-autopilot/state.json"
 */
export function getStatePath(): string {
  return path.join(getDataDir(), 'state.json');
}

/**
 * Returns the backup directory path, creating it if it does not exist.
 *
 * Located at `~/.oss-autopilot/backups/`. Used for automatic state backups
 * before each write operation.
 *
 * @returns Absolute path to the backups directory
 *
 * @example
 * const backupDir = getBackupDir();
 * // "/Users/you/.oss-autopilot/backups"
 */
export function getBackupDir(): string {
  const dir = path.join(getDataDir(), 'backups');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Returns the HTTP cache directory path, creating it if it does not exist.
 *
 * Located at `~/.oss-autopilot/cache/`. Used by {@link HttpCache} to store
 * ETag-based response caches for GitHub API endpoints.
 *
 * @returns Absolute path to the cache directory
 *
 * @example
 * const cacheDir = getCacheDir();
 * // "/Users/you/.oss-autopilot/cache"
 */
export function getCacheDir(): string {
  const dir = path.join(getDataDir(), 'cache');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Represents a parsed GitHub pull request or issue URL.
 *
 * @property owner - The repository owner (e.g., `"facebook"`)
 * @property repo - The repository name (e.g., `"react"`)
 * @property number - The PR or issue number
 * @property type - Whether the URL points to a pull request or an issue
 */
interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  number: number;
  type: 'pull' | 'issues';
}

// Validation patterns for GitHub owner and repo names
const OWNER_PATTERN = /^[a-zA-Z0-9_-]+$/;
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/**
 * Validate that owner and repo names contain only safe characters
 */
function isValidOwnerRepo(owner: string, repo: string): boolean {
  return OWNER_PATTERN.test(owner) && REPO_PATTERN.test(repo);
}

/**
 * Parses a GitHub pull request or issue URL into its components.
 *
 * Only accepts HTTPS GitHub URLs (`https://github.com/...`). Returns `null` for
 * invalid URLs, non-GitHub URLs, or URLs with invalid owner/repo characters.
 *
 * @param url - Full GitHub URL (e.g., `"https://github.com/owner/repo/pull/42"`)
 * @returns Parsed URL components, or `null` if the URL is invalid or not a recognized GitHub PR/issue URL
 *
 * @example
 * parseGitHubUrl('https://github.com/facebook/react/pull/123')
 * // { owner: "facebook", repo: "react", number: 123, type: "pull" }
 *
 * @example
 * parseGitHubUrl('https://github.com/vercel/next.js/issues/456')
 * // { owner: "vercel", repo: "next.js", number: 456, type: "issues" }
 *
 * @example
 * parseGitHubUrl('https://example.com/not-github')
 * // null
 */
export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  // URL must start with https://github.com/
  if (!url.startsWith('https://github.com/')) {
    return null;
  }

  const prMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (prMatch) {
    const owner = prMatch[1];
    const repo = prMatch[2];
    if (!isValidOwnerRepo(owner, repo)) {
      return null;
    }
    return {
      owner,
      repo,
      number: parseInt(prMatch[3], 10),
      type: 'pull',
    };
  }

  const issueMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (issueMatch) {
    const owner = issueMatch[1];
    const repo = issueMatch[2];
    if (!isValidOwnerRepo(owner, repo)) {
      return null;
    }
    return {
      owner,
      repo,
      number: parseInt(issueMatch[3], 10),
      type: 'issues',
    };
  }

  return null;
}

/**
 * Extracts the owner and repo from a GitHub web URL
 * (e.g. `https://github.com/owner/repo/pull/42`, `https://github.com/owner/repo/`).
 *
 * Unlike {@link parseGitHubUrl}, this does **not** require a PR or issue number in the URL.
 * Like `parseGitHubUrl`, it enforces an `https://github.com/` prefix.
 *
 * @param url - An HTTPS GitHub URL containing at least `github.com/owner/repo`
 * @returns `{ owner, repo }` or `null` if the URL cannot be parsed or contains invalid owner/repo characters
 *
 * @example
 * extractOwnerRepo('https://github.com/facebook/react/pull/123')
 * // { owner: "facebook", repo: "react" }
 *
 * @example
 * extractOwnerRepo('https://github.com/vercel/next.js/')
 * // { owner: "vercel", repo: "next.js" }
 */
export function extractOwnerRepo(url: string): { owner: string; repo: string } | null {
  if (!url.startsWith('https://github.com/')) return null;
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;

  const owner = match[1];
  const repo = match[2];
  if (!isValidOwnerRepo(owner, repo)) return null;

  return { owner, repo };
}

/**
 * Calculates the number of whole days between two dates, using floor rounding.
 *
 * Can return negative values if `from` is after `to`. Partial days are truncated
 * (e.g., 1.9 days returns 1).
 *
 * @param from - The start date
 * @param to - The end date (defaults to the current date/time)
 * @returns Number of whole days between the two dates (may be negative)
 *
 * @example
 * daysBetween(new Date('2024-01-01'), new Date('2024-01-10'))
 * // 9
 *
 * @example
 * daysBetween(new Date('2024-01-10'), new Date('2024-01-01'))
 * // -9
 */
export function daysBetween(from: Date, to: Date = new Date()): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)));
}

/**
 * Splits an `"owner/repo"` string into its owner and repo components.
 *
 * @param repoFullName - Full repository name in `"owner/repo"` format
 * @returns Object with `owner` and `repo` string properties
 * @throws {Error} If the input does not contain both an owner and repo separated by `/`
 *
 * @example
 * splitRepo('facebook/react')
 * // { owner: "facebook", repo: "react" }
 */
export function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repo format: expected "owner/repo", got "${repoFullName}"`);
  }
  return { owner, repo };
}

/**
 * Case-insensitive check whether a repo owner matches the given GitHub username.
 * Used to skip a user's own repos (PRs to your own repos aren't OSS contributions).
 */
export function isOwnRepo(owner: string, username: string): boolean {
  return owner.toLowerCase() === username.toLowerCase();
}

/**
 * Read the CLI package version from package.json relative to the running CLI bundle.
 * Resolves `../package.json` from `process.argv[1]` (the bundle entry point).
 * Falls back to '0.0.0' if the file is unreadable.
 */
export function getCLIVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(process.argv[1]), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Formats a timestamp as a human-readable relative time string.
 *
 * Returns minutes for < 1 hour, hours for < 1 day, days for < 30 days,
 * and a locale-formatted date string for anything older.
 *
 * @param dateStr - ISO 8601 date string
 * @returns Relative time like `"5m ago"`, `"3h ago"`, `"12d ago"`, or a formatted date
 *
 * @example
 * formatRelativeTime('2024-01-20T10:00:00Z')
 * // "5d ago" (if called on Jan 25)
 *
 * @example
 * formatRelativeTime(new Date(Date.now() - 120000).toISOString())
 * // "2m ago"
 */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'just now';
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Creates a descending date comparator function for use with `Array.prototype.sort()`.
 *
 * Items with `null` or `undefined` dates are treated as epoch (sorted last).
 *
 * @param getDate - Accessor function that extracts a date value from each item
 * @returns A comparator function that sorts items from newest to oldest
 *
 * @example
 * const prs = [{ createdAt: '2024-01-01' }, { createdAt: '2024-06-15' }];
 * prs.sort(byDateDescending(pr => pr.createdAt));
 * // [{ createdAt: '2024-06-15' }, { createdAt: '2024-01-01' }]
 */
export function byDateDescending<T>(getDate: (item: T) => string | number | null | undefined) {
  return (a: T, b: T): number => {
    const dateA = new Date(getDate(a) || 0).getTime();
    const dateB = new Date(getDate(b) || 0).getTime();
    return dateB - dateA;
  };
}

/**
 * Retrieves a GitHub authentication token, checking sources in priority order.
 *
 * Checks `GITHUB_TOKEN` environment variable first, then falls back to `gh auth token`
 * from the GitHub CLI. The result is cached after the first successful lookup (or first
 * failed attempt), so subsequent calls are instant and do not spawn subprocesses.
 *
 * @returns The GitHub token string, or `null` if no token is available
 *
 * @example
 * const token = getGitHubToken();
 * if (token) {
 *   // use token for API calls
 * }
 */
export function getGitHubToken(): string | null {
  // Return cached token if we already have one
  if (cachedGitHubToken) {
    return cachedGitHubToken;
  }

  // Don't retry if we already tried and failed
  if (tokenFetchAttempted) {
    return null;
  }

  tokenFetchAttempted = true;

  // 1. Check environment variable first
  if (process.env.GITHUB_TOKEN) {
    cachedGitHubToken = process.env.GITHUB_TOKEN;
    return cachedGitHubToken;
  }

  // 2. Try gh CLI (using execFileSync to avoid shell injection - no user input here anyway)
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], // Suppress stderr
      timeout: 2000, // 2 second timeout
    }).trim();

    if (token && token.length > 0) {
      cachedGitHubToken = token;
      debug(MODULE, 'Using GitHub token from gh CLI');
      return cachedGitHubToken;
    }
  } catch (err) {
    // gh CLI not available or not authenticated — fall through to return null
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
 * @returns The GitHub token string (guaranteed non-null)
 * @throws {ConfigurationError} If no token is available, with instructions for `gh auth login` or setting `GITHUB_TOKEN`
 *
 * @example
 * const token = requireGitHubToken(); // throws if not authenticated
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
 *
 * @example
 * afterEach(() => {
 *   resetGitHubTokenCache();
 * });
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
 *
 * @returns The GitHub token string, or `null` if no token is available
 *
 * @example
 * const token = await getGitHubTokenAsync();
 * if (token) {
 *   // use token for API calls
 * }
 */
export async function getGitHubTokenAsync(): Promise<string | null> {
  // Return cached token if we already have one
  if (cachedGitHubToken) {
    return cachedGitHubToken;
  }

  // Don't retry if we already tried and failed
  if (tokenFetchAttempted) {
    return null;
  }

  tokenFetchAttempted = true;

  // 1. Check environment variable first
  if (process.env.GITHUB_TOKEN) {
    cachedGitHubToken = process.env.GITHUB_TOKEN;
    return cachedGitHubToken;
  }

  // 2. Try gh CLI asynchronously (non-blocking)
  try {
    const token = await new Promise<string>((resolve, reject) => {
      execFile('gh', ['auth', 'token'], { encoding: 'utf-8', timeout: 2000 }, (error, stdout) => {
        if (error) {
          reject(error);
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
    // gh CLI not available or not authenticated — fall through to return null
    debug(MODULE, 'gh auth token failed (CLI unavailable or not authenticated)', err);
  }

  return null;
}

/**
 * GitHub username validation pattern.
 * Usernames must start with an alphanumeric character, can contain hyphens
 * (but not consecutive ones and not at the end), and be 1-39 characters.
 */
const GITHUB_USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

/**
 * Check whether the state file exists without creating the data directory.
 * Used for first-run detection in the CLI — we don't want to create
 * `~/.oss-autopilot/` just to check if the user has ever run the tool.
 */
export function stateFileExists(): boolean {
  const stateFile = path.join(os.homedir(), '.oss-autopilot', 'state.json');
  return fs.existsSync(stateFile);
}

/**
 * Detect the authenticated GitHub username via the `gh` CLI.
 *
 * Runs `gh api user --jq '.login'` asynchronously and validates the result
 * against GitHub's username rules. Never throws — returns `null` on any failure
 * (gh not installed, not authenticated, invalid output, etc.).
 *
 * @returns The GitHub username string, or `null` if detection fails
 *
 * @example
 * const username = await detectGitHubUsername();
 * if (username) {
 *   console.log(`Logged in as ${username}`);
 * }
 */
export async function detectGitHubUsername(): Promise<string | null> {
  try {
    const login = await new Promise<string>((resolve, reject) => {
      execFile('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => {
        if (error) {
          reject(error);
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
