/**
 * Shared URL validation patterns and helpers for CLI commands.
 */

import { outputJsonError } from '../formatters/json.js';

/** Matches GitHub PR URLs: https://github.com/owner/repo/pull/123 */
export const PR_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

/** Matches GitHub issue URLs: https://github.com/owner/repo/issues/123 */
export const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;

/**
 * Validate a GitHub URL against a pattern. Exits with error if invalid.
 */
export function validateGitHubUrl(url: string, pattern: RegExp, entityType: 'PR' | 'issue', json?: boolean): void {
  if (pattern.test(url)) return;

  const example = entityType === 'PR'
    ? 'https://github.com/owner/repo/pull/123'
    : 'https://github.com/owner/repo/issues/123';
  const msg = `Invalid ${entityType} URL: ${url}. Expected format: ${example}`;

  if (json) {
    outputJsonError(msg);
  } else {
    console.error(`Error: ${msg}`);
  }
  process.exit(1);
}
