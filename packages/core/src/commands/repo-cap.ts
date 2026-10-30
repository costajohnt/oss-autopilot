/**
 * repo-cap command: per-repo open-PR cap and excludeRepos check for one repo.
 * Used by the draft-first workflow before pushing. The open-PR count is live
 * from GitHub so PRs opened earlier in the same session count; merges (for
 * the cold cap) come from local state.
 */

import { getOctokit, getStateManager, requireGitHubToken } from '../core/index.js';
import { ConfigurationError } from '../core/errors.js';
import { getRepoCapStatus, type RepoCapStatus } from '../core/repo-cap.js';
import { validateRepoIdentifier } from './validation.js';

export async function runRepoCap(options: { repo: string }): Promise<RepoCapStatus> {
  const repo = validateRepoIdentifier(options.repo);
  const state = getStateManager().getState();
  const username = state.config.githubUsername;
  if (!username) {
    throw new ConfigurationError('githubUsername is not configured; run setup first.');
  }
  const { data } = await getOctokit(requireGitHubToken()).search.issuesAndPullRequests({
    q: `is:pr is:open author:${username} repo:${repo}`,
    per_page: 1,
  });
  return getRepoCapStatus(state, repo, { openPRCount: data.total_count });
}
