/**
 * Shared utility functions
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

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
 * Known test/placeholder usernames that should trigger auto-detection
 */
const TEST_USERNAMES = ['contributor', 'test', 'demo', 'example', 'user'];

/**
 * Check if a username looks like test/placeholder data
 */
export function isTestUsername(username: string | undefined): boolean {
  if (!username) return true;
  return TEST_USERNAMES.includes(username.toLowerCase());
}

/**
 * Detect GitHub username using the gh CLI.
 * Returns the username or null if detection fails.
 * Uses execFileSync for safety (no shell injection risk).
 */
export function detectGitHubUsername(): string | null {
  try {
    // Use execFileSync with separate args array to avoid shell injection
    const result = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const username = result.trim();
    if (username && username.length > 0) {
      return username;
    }
    return null;
  } catch {
    // gh CLI not available or not authenticated
    return null;
  }
}

/**
 * Check if a repo should be excluded based on the excludeRepos config.
 * Supports:
 *   - Exact match: "owner/repo"
 *   - Owner wildcard: "owner" or "owner/*" matches all repos from that owner
 *
 * @param repoFullName - The full repo name (e.g., "owner/repo")
 * @param excludePatterns - Array of patterns to check against
 */
export function isRepoExcluded(repoFullName: string, excludePatterns: string[]): boolean {
  const [owner] = repoFullName.split('/');

  return excludePatterns.some(pattern => {
    // Exact match: "owner/repo"
    if (pattern === repoFullName) {
      return true;
    }
    // Owner wildcard: "owner" or "owner/*"
    const ownerPattern = pattern.replace(/\/\*$/, ''); // Remove trailing /*
    if (!ownerPattern.includes('/') && ownerPattern === owner) {
      return true;
    }
    return false;
  });
}
