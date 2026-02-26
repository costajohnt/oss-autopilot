/**
 * Shared URL validation patterns and helpers for CLI commands.
 */

import { outputJsonError } from '../formatters/json.js';

/** Matches GitHub PR URLs: https://github.com/owner/repo/pull/123 */
export const PR_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

/** Matches GitHub issue URLs: https://github.com/owner/repo/issues/123 */
export const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;

/** Maximum allowed URL length */
const MAX_URL_LENGTH = 2048;
/** Maximum allowed PR/issue number */
const MAX_PR_NUMBER = 999999;
/** Maximum allowed message string length */
const MAX_MESSAGE_LENGTH = 1000;
/** Pattern for valid GitHub repository identifiers */
const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/**
 * Validate a GitHub URL against a pattern. Exits with error if invalid.
 */
export function validateGitHubUrl(url: string, pattern: RegExp, entityType: 'PR' | 'issue', json?: boolean): void {
  if (pattern.test(url)) return;

  const example =
    entityType === 'PR' ? 'https://github.com/owner/repo/pull/123' : 'https://github.com/owner/repo/issues/123';
  const msg = `Invalid ${entityType} URL: ${url}. Expected format: ${example}`;

  if (json) {
    outputJsonError(msg);
  } else {
    console.error(`Error: ${msg}`);
  }
  process.exit(1);
}

/**
 * Validate that a URL does not exceed the maximum allowed length.
 * Returns the URL if valid, throws if too long.
 */
export function validateUrl(url: string): string {
  if (url.length > MAX_URL_LENGTH) {
    throw new Error(`URL exceeds maximum length of ${MAX_URL_LENGTH} characters`);
  }
  return url;
}

/**
 * Validate that a PR/issue number is a positive integer within bounds.
 * Returns the number if valid, throws if invalid.
 */
export function validatePRNumber(num: number): number {
  if (!Number.isInteger(num) || num < 1 || num > MAX_PR_NUMBER) {
    throw new Error(`PR number must be a positive integer up to ${MAX_PR_NUMBER}`);
  }
  return num;
}

/**
 * Validate that a message string does not exceed the maximum allowed length.
 * Returns the message if valid, throws if too long.
 */
export function validateMessage(message: string): string {
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`);
  }
  return message;
}

/**
 * Validate that a repository identifier matches the "owner/repo" format.
 * Returns the identifier if valid, throws if invalid.
 */
export function validateRepoIdentifier(repo: string): string {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid repository format: "${repo}". Expected "owner/repo".`);
  }
  return repo;
}

/** Maximum allowed GitHub username length */
const MAX_GITHUB_USERNAME_LENGTH = 39;

/**
 * GitHub username validation pattern.
 * Rules: alphanumeric and hyphens only, no leading/trailing hyphens, max 39 chars.
 * Consecutive hyphens are checked separately after the regex.
 */
const GITHUB_USERNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/**
 * Validate a GitHub username against GitHub's naming rules.
 * Returns the username if valid, throws with a descriptive message if invalid.
 *
 * Rules enforced:
 *  - May only contain alphanumeric characters and hyphens
 *  - Cannot begin or end with a hyphen
 *  - Cannot contain consecutive hyphens
 *  - Maximum 39 characters
 */
export function validateGitHubUsername(username: string): string {
  if (!username || username.length === 0) {
    throw new Error('GitHub username cannot be empty.');
  }

  if (username.length > MAX_GITHUB_USERNAME_LENGTH) {
    throw new Error(
      `GitHub username "${username}" exceeds the maximum allowed length of ${MAX_GITHUB_USERNAME_LENGTH} characters.`,
    );
  }

  if (!GITHUB_USERNAME_PATTERN.test(username)) {
    throw new Error(
      `Invalid GitHub username "${username}". Usernames may only contain alphanumeric characters and hyphens, and cannot begin or end with a hyphen.`,
    );
  }

  if (username.includes('--')) {
    throw new Error(
      `Invalid GitHub username "${username}". Usernames cannot contain consecutive hyphens.`,
    );
  }

  return username;
}
