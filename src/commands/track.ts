/**
 * Track/Untrack commands
 * In v2, PRs are fetched fresh from GitHub on each `daily` run.
 * These commands are preserved for backward compatibility.
 */

import { getOctokit, getGitHubToken } from '../core/index.js';
import { outputJson, outputJsonError, type TrackOutput } from '../formatters/json.js';
import { validateUrl, PR_URL_PATTERN, validateGitHubUrl } from './validation.js';
import { parseGitHubUrl } from '../core/utils.js';

interface TrackOptions {
  prUrl: string;
  json?: boolean;
}

interface UntrackOptions {
  prUrl: string;
  json?: boolean;
}

export async function runTrack(options: TrackOptions): Promise<void> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR', options.json);

  // Token is guaranteed by the preAction hook in cli.ts for non-LOCAL_ONLY_COMMANDS.
  const token = getGitHubToken()!;
  const octokit = getOctokit(token);

  const parsed = parseGitHubUrl(options.prUrl);
  if (!parsed || parsed.type !== 'pull') {
    if (options.json) {
      outputJsonError(`Invalid PR URL: ${options.prUrl}`);
    } else {
      console.error(`Error: Invalid PR URL: ${options.prUrl}`);
    }
    process.exit(1);
  }

  const { owner, repo, number } = parsed;

  if (!options.json) {
    console.log(`\n📌 Fetching PR: ${options.prUrl}\n`);
  }

  const { data: ghPR } = await octokit.pulls.get({ owner, repo, pull_number: number });

  const pr = {
    repo: `${owner}/${repo}`,
    number,
    title: ghPR.title,
    url: options.prUrl,
  };

  if (options.json) {
    outputJson<TrackOutput>({ pr });
  } else {
    console.log(`PR: ${pr.repo}#${pr.number} - ${pr.title}`);
    console.log('Note: In v2, PRs are tracked automatically via the daily run.');
  }
}

export async function runUntrack(options: UntrackOptions): Promise<void> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR', options.json);

  if (options.json) {
    outputJson({
      removed: false,
      url: options.prUrl,
      message: 'In v2, PRs are fetched fresh on each daily run — there is no local tracking list to remove from.',
    });
  } else {
    console.log(
      'Note: In v2, PRs are fetched fresh on each daily run — there is no local tracking list to remove from.',
    );
    console.log('Use `shelve` to temporarily hide a PR from the daily summary.');
  }
}
