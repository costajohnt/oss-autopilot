/**
 * Shared utility functions
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

// Cached GitHub token (fetched once per session)
let cachedGitHubToken: string | null = null;
let tokenFetchAttempted = false;

/**
 * Get the data directory for oss-autopilot.
 * Creates the directory if it doesn't exist.
 * Returns ~/.oss-autopilot/
 */
export function getDataDir(): string {
  const dir = path.join(os.homedir(), '.oss-autopilot');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the path to the state file.
 * Returns ~/.oss-autopilot/state.json
 */
export function getStatePath(): string {
  return path.join(getDataDir(), 'state.json');
}

/**
 * Get the backup directory for state files.
 * Creates the directory if it doesn't exist.
 * Returns ~/.oss-autopilot/backups/
 */
export function getBackupDir(): string {
  const dir = path.join(getDataDir(), 'backups');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the dashboard file path.
 * Returns ~/.oss-autopilot/dashboard.html
 */
export function getDashboardPath(): string {
  return path.join(getDataDir(), 'dashboard.html');
}

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
 * Parse a GitHub PR or issue URL
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
 * Calculate days between two dates
 */
export function daysBetween(from: Date, to: Date = new Date()): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Split repo string "owner/repo" into components
 */
export function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split('/');
  return { owner, repo };
}

/**
 * Format a date as a human-readable relative time string
 */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Create a descending date comparator for array.sort()
 */
export function byDateDescending<T>(getDate: (item: T) => string | number | null | undefined) {
  return (a: T, b: T): number => {
    const dateA = new Date(getDate(a) || 0).getTime();
    const dateB = new Date(getDate(b) || 0).getTime();
    return dateB - dateA;
  };
}

/**
 * Get GitHub token from environment or gh CLI.
 *
 * Priority:
 * 1. GITHUB_TOKEN environment variable
 * 2. gh auth token (from gh CLI)
 *
 * Result is cached for the session.
 * Returns null if no token is available.
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
      timeout: 5000, // 5 second timeout
    }).trim();

    if (token && token.length > 0) {
      cachedGitHubToken = token;
      console.error('Using GitHub token from gh CLI');
      return cachedGitHubToken;
    }
  } catch {
    // gh CLI not available or not authenticated - fall through
  }

  return null;
}

/**
 * Get GitHub token or throw an error with helpful message.
 * Use this when a token is required for the operation.
 */
export function requireGitHubToken(): string {
  const token = getGitHubToken();

  if (!token) {
    throw new Error(
      'GitHub authentication required.\n\n' +
      'Options:\n' +
      '  1. Use gh CLI: gh auth login\n' +
      '  2. Set GITHUB_TOKEN environment variable\n\n' +
      'The gh CLI is recommended - install from https://cli.github.com'
    );
  }

  return token;
}

/**
 * Reset the cached token (for testing)
 */
export function resetGitHubTokenCache(): void {
  cachedGitHubToken = null;
  tokenFetchAttempted = false;
}
