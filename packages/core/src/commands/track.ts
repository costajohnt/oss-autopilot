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

export async function runUntrack(options: { prUrl: string }): Promise<UntrackOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  return {
    removed: false,
    url: options.prUrl,
    message: 'In v2, PRs are fetched fresh on each daily run — there is no local tracking list to remove from.',
  };
}
