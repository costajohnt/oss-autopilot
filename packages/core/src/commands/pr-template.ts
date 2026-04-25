/**
 * pr-template command — Fetch a repository's PR description template.
 *
 * Usage: oss-autopilot pr-template owner/repo --json
 */

import { getOctokit } from '../core/github.js';
import { requireGitHubToken } from '../core/auth.js';
import { splitRepo } from '../core/urls.js';
import { fetchPRTemplate, type PRTemplateResult } from '../core/pr-template.js';

export async function runPRTemplate(opts: { repo: string }): Promise<PRTemplateResult> {
  const { owner, repo } = splitRepo(opts.repo);
  const token = requireGitHubToken();
  const octokit = getOctokit(token);
  return fetchPRTemplate(octokit, owner, repo);
}
