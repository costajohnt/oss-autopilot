/**
 * Track command (v2 semantics — see #1001)
 *
 * **This command does not mutate state.** In v2, PRs are discovered and
 * enriched automatically on every `daily` run — there is no local tracking
 * list to add to. `runTrack` is an **informational lookup** that fetches PR
 * metadata from GitHub and returns it; useful for inspecting a specific
 * PR's shape without waiting for the next `daily` run. Nothing is persisted.
 *
 * The `runUntrack` v1→v2 stub was removed in v4 (#1133). Use `shelve`/
 * `unshelve` to hide a PR from the daily digest.
 */

import { getOctokit, requireGitHubToken } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import type { TrackOutput } from '../formatters/json.js';
import { validateUrl, PR_URL_PATTERN, validateGitHubUrl } from './validation.js';
import { parseGitHubUrl } from '../core/urls.js';

/**
 * Fetch metadata for a PR URL (informational — does not persist).
 *
 * In v2 this is a read-only lookup. PRs are discovered automatically on each
 * `daily` run; this command exists for one-off inspection of a specific PR's
 * shape (title, repo, number).
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
    throw new ValidationError(`Invalid PR URL: ${options.prUrl}`);
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
