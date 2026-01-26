/**
 * Init command
 * Initialize with existing PRs from GitHub
 */

import { getStateManager, PRMonitor, getOctokit, getGitHubToken } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

interface InitOptions {
  username: string;
  json?: boolean;
}

export async function runInit(options: InitOptions): Promise<void> {
  const token = getGitHubToken();
  if (!token) {
    if (options.json) {
      outputJsonError('GitHub authentication required. Run "gh auth login" or set GITHUB_TOKEN.');
    } else {
      console.error('Error: GitHub authentication required.');
      console.error('');
      console.error('Options:');
      console.error('  1. Use gh CLI: gh auth login');
      console.error('  2. Set GITHUB_TOKEN environment variable');
    }
    process.exit(1);
  }

  const stateManager = getStateManager();
  const prMonitor = new PRMonitor(token);
  const octokit = getOctokit(token);

  if (!options.json) {
    console.log(`\n🚀 Initializing with PRs from @${options.username}...\n`);
  }

  // Set username
  stateManager.updateConfig({ githubUsername: options.username });

  // Search for open PRs by this user
  const { data } = await octokit.search.issuesAndPullRequests({
    q: `is:pr is:open author:${options.username}`,
    sort: 'updated',
    order: 'desc',
    per_page: 50,
  });

  if (!options.json) {
    console.log(`Found ${data.total_count} open PRs`);
  }

  const imported: Array<{ repo: string; number: number; title: string }> = [];
  const errors: Array<{ url: string; error: string }> = [];

  for (const item of data.items) {
    if (item.pull_request) {
      try {
        const pr = await prMonitor.trackPR(item.html_url);
        imported.push({ repo: pr.repo, number: pr.number, title: pr.title });
        if (!options.json) {
          console.log(`  Added: ${pr.repo}#${pr.number} - ${pr.title}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ url: item.html_url, error: errorMsg });
        if (!options.json) {
          console.error(`  Error adding ${item.html_url}:`, errorMsg);
        }
      }
    }
  }

  stateManager.save();

  if (options.json) {
    outputJson({
      username: options.username,
      totalFound: data.total_count,
      imported,
      errors,
    });
  } else {
    console.log('\nInitialization complete! Run `oss-autopilot status` to see your PRs.');
  }
}
