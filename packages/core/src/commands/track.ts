/**
 * Track/Untrack commands
 * In v2, PRs are fetched fresh from GitHub on each `daily` run.
 * These commands are preserved for backward compatibility.
 */

import { getOctokit, requireGitHubToken } from '../core/index.js';
import type { TrackOutput } from '../formatters/json.js';
import { validateUrl, PR_URL_PATTERN, validateGitHubUrl } from './validation.js';
import { parseGitHubUrl } from '../core/utils.js';

export interface UntrackOutput {
  removed: boolean;
  url: string;
  message: string;
}

/**
 * Validate and fetch metadata for a PR URL.
 *
 * @param options - Track options
 * @param options.prUrl - Full GitHub PR URL
 * @returns PR metadata (repo, number, title, url)
 * @throws {ValidationError} If the URL is not a valid GitHub PR URL
 */
export async function runTrack(options: { prUrl: string }): Promise<TrackOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const token = requireGitHubToken();
  const octokit = getOctokit(token);

  const parsed = parseGitHubUrl(options.prUrl);
  if (!parsed || parsed.type !== 'pull') {
    throw new Error(`Invalid PR URL: ${options.prUrl}`);
  }

  const { owner, repo, number } = parsed;

  const { data: ghPR } = await octokit.pulls.get({ owner, repo, pull_number: number });

  return {
    pr: {
      repo: `${owner}/${repo}`,
      number,
      title: ghPR.title,
      url: options.prUrl,
    },
  };
}

/**
 * No-op in v2 — PRs are fetched fresh on each daily run.
 *
 * @param options - Untrack options
 * @param options.prUrl - Full GitHub PR URL
 * @returns Message explaining v2 behavior
 * @throws {ValidationError} If the URL is not a valid GitHub PR URL
 */
export async function runUntrack(options: { prUrl: string }): Promise<UntrackOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  return {
    removed: false,
    url: options.prUrl,
    message: 'In v2, PRs are fetched fresh on each daily run — there is no local tracking list to remove from.',
  };
}
