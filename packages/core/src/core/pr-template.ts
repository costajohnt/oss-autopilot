/**
 * Fetch a repository's PR description template from GitHub.
 *
 * Checks the standard template locations in GitHub's priority order:
 * 1. .github/PULL_REQUEST_TEMPLATE.md
 * 2. .github/pull_request_template.md
 * 3. docs/pull_request_template.md
 * 4. pull_request_template.md (root)
 *
 * Returns the decoded template content and the path where it was found,
 * or null if no template exists.
 */

import type { Octokit } from '@octokit/rest';
import { debug, warn } from './logger.js';
import { errorMessage, getHttpStatusCode, isRateLimitOrAuthError } from './errors.js';

const MODULE = 'pr-template';

/** Standard paths GitHub checks for PR templates, in priority order. */
const TEMPLATE_PATHS = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  'docs/pull_request_template.md',
  'pull_request_template.md',
];

export interface PRTemplateResult {
  /** The decoded template content, or null if no template was found. */
  template: string | null;
  /** The path where the template was found (e.g., ".github/PULL_REQUEST_TEMPLATE.md"). */
  source: string | null;
  /** If non-null, an error prevented a complete check of all template paths. */
  error?: string;
}

/**
 * Fetch a repository's PR template by trying each standard location.
 * Returns on the first successful match. Rate limit and auth errors
 * propagate to the caller (consistent with project error strategy).
 */
export async function fetchPRTemplate(octokit: Octokit, owner: string, repo: string): Promise<PRTemplateResult> {
  for (const path of TEMPLATE_PATHS) {
    try {
      debug(MODULE, `Checking ${owner}/${repo} for template at ${path}`);
      const { data } = await octokit.repos.getContent({ owner, repo, path });

      // getContent returns an array for directories (e.g., multiple templates); we only want files
      if (Array.isArray(data)) {
        debug(MODULE, `${path} is a directory (multiple templates?), skipping`);
        continue;
      }
      if (data.type !== 'file') {
        debug(MODULE, `${path} is type "${data.type}", skipping`);
        continue;
      }
      if (!data.content) {
        debug(MODULE, `${path} has no content, skipping`);
        continue;
      }

      const template = Buffer.from(data.content, 'base64').toString('utf8');
      debug(MODULE, `Found PR template at ${path} (${template.length} chars)`);
      return { template, source: path };
    } catch (err: unknown) {
      // 404 = template doesn't exist at this path, try next
      if (getHttpStatusCode(err) === 404) continue;
      // Rate limit and auth errors must propagate (project error strategy)
      if (isRateLimitOrAuthError(err)) throw err;
      // Other errors (500, network) — warn and return with error context
      const msg = errorMessage(err);
      warn(MODULE, `Error checking ${owner}/${repo}/${path}: ${msg}`);
      return { template: null, source: null, error: msg };
    }
  }

  debug(MODULE, `No PR template found for ${owner}/${repo}`);
  return { template: null, source: null };
}
