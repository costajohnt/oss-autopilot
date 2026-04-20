/**
 * Track/Untrack commands (v2 semantics — see #1001)
 *
 * **These commands do not mutate state.** In v2, PRs are discovered and
 * enriched automatically on every `daily` run — there is no local tracking
 * list to add to or remove from. The commands are preserved for backwards
 * compatibility with v1 callers, but:
 *
 * - `runTrack` is an **informational lookup** that fetches PR metadata from
 *   GitHub and returns it. Useful for inspecting a specific PR's shape
 *   without waiting for the next `daily` run. Nothing is persisted.
 * - `runUntrack` is **deprecated** and always a no-op. Use `shelve` to hide
 *   a PR from the daily digest.
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
 * @deprecated No-op in v2. Use `runShelve` to hide a PR from the daily digest.
 *
 * Kept for backwards compatibility with v1 callers. PRs are fetched fresh
 * on each `daily` run, so there is no local tracking list to remove from.
 *
 * @param options - Untrack options
 * @param options.prUrl - Full GitHub PR URL (validated but not used)
 * @returns Output object with `removed: false` and a message explaining v2 behavior
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
