/**
 * Shared validation patterns and helpers for CLI commands.
 */

import { ValidationError } from '../core/errors.js';
import { isPlaceholderUsername } from '../core/placeholder-usernames.js';

/** Matches GitHub PR URLs: https://github.com/owner/repo/pull/123 */
export const PR_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

/** Matches GitHub issue URLs: https://github.com/owner/repo/issues/123 */
export const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;

/** Matches GitHub issue or PR URLs: /issues/123 or /pull/123 */
export const ISSUE_OR_PR_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/;

/** Maximum allowed URL length */
const MAX_URL_LENGTH = 2048;
/** Maximum allowed PR/issue number */
const MAX_PR_NUMBER = 999_999;
/** Maximum allowed message string length */
const MAX_MESSAGE_LENGTH = 1000;
/** Pattern for valid GitHub repository identifiers */
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/**
 * Validate a GitHub URL against a pattern. Throws if invalid.
 */
export function validateGitHubUrl(url: string, pattern: RegExp, entityType: 'PR' | 'issue' | 'issue or PR'): void {
  if (pattern.test(url)) return;

  const examples: Record<string, string> = {
    PR: 'https://github.com/owner/repo/pull/123',
    issue: 'https://github.com/owner/repo/issues/123',
    'issue or PR': 'https://github.com/owner/repo/issues/123 or https://github.com/owner/repo/pull/123',
  };
  throw new ValidationError(`Invalid ${entityType} URL: ${url}. Expected format: ${examples[entityType]}`);
}

/**
 * Validate that a URL does not exceed the maximum allowed length.
 * Returns the URL if valid, throws if too long.
 */
export function validateUrl(url: string): string {
  if (url.length > MAX_URL_LENGTH) {
    throw new ValidationError(`URL exceeds maximum length of ${MAX_URL_LENGTH} characters`);
  }
  return url;
}

/**
 * Validate that a PR/issue number is a positive integer within bounds.
 * Returns the number if valid, throws if invalid.
 */
export function validatePRNumber(num: number): number {
  if (!Number.isInteger(num) || num < 1 || num > MAX_PR_NUMBER) {
    throw new ValidationError(`PR number must be a positive integer up to ${MAX_PR_NUMBER}`);
  }
  return num;
}

/**
 * Validate that a message string does not exceed the maximum allowed length.
 * Returns the message if valid, throws if too long.
 */
export function validateMessage(message: string): string {
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`);
  }
  return message;
}

/**
 * Validate that a repository identifier matches the "owner/repo" format.
 * Returns the identifier if valid, throws if invalid.
 */
export function validateRepoIdentifier(repo: string): string {
  if (!REPO_PATTERN.test(repo)) {
    throw new ValidationError(`Invalid repository format: "${repo}". Expected "owner/repo".`);
  }
  return repo;
}

/** Maximum allowed GitHub username length */
const MAX_USERNAME_LENGTH = 39;
/** Pattern for valid GitHub username characters (alphanumeric and hyphens) */
const USERNAME_CHARS_PATTERN = /^[\da-z-]+$/i;
/** Pattern for consecutive hyphens */
const CONSECUTIVE_HYPHENS_PATTERN = /--/;

/**
 * Validate a GitHub username against GitHub's username rules.
 * Throws a ValidationError if the username is invalid.
 *
 * Rules:
 * - Must not be empty
 * - Maximum 39 characters
 * - Only alphanumeric characters and hyphens
 * - Cannot start or end with a hyphen
 * - Cannot contain consecutive hyphens
 */
export function validateGitHubUsername(username: string): string {
  if (!username || username.trim().length === 0) {
    throw new ValidationError('GitHub username cannot be empty.');
  }

  const trimmed = username.trim();

  if (trimmed.length > MAX_USERNAME_LENGTH) {
    throw new ValidationError(
      `GitHub username must be at most ${MAX_USERNAME_LENGTH} characters (got ${trimmed.length}).`,
    );
  }

  if (!USERNAME_CHARS_PATTERN.test(trimmed)) {
    throw new ValidationError('GitHub username can only contain alphanumeric characters and hyphens.');
  }

  if (trimmed.startsWith('-')) {
    throw new ValidationError('GitHub username cannot start with a hyphen.');
  }

  if (trimmed.endsWith('-')) {
    throw new ValidationError('GitHub username cannot end with a hyphen.');
  }

  if (CONSECUTIVE_HYPHENS_PATTERN.test(trimmed)) {
    throw new ValidationError('GitHub username cannot contain consecutive hyphens.');
  }

  // Reject the same placeholder strings that pr-monitor's runtime auto-repair
  // catches. Without this guard `init`, `setup --set username=`, and the MCP
  // `config` tool happily persist values like "example-user" copied from
  // documentation, leaving auto-repair to clean up after the next fetch and
  // surfacing a "showing partial data" banner on the dashboard in the meantime.
  if (isPlaceholderUsername(trimmed)) {
    throw new ValidationError(
      `"${trimmed}" looks like a placeholder from documentation, not a real GitHub username. Use your actual GitHub login.`,
    );
  }

  return trimmed;
}
