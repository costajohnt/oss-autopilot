/**
 * Init command
 * Initialize with existing open PRs from GitHub
 */

import { getStateManager, PRMonitor, getOctokit, isTestUsername, detectGitHubUsername, isRepoExcluded, parseGitHubUrl } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

interface InitOptions {
  username?: string;
  json?: boolean;
}

export async function runInit(options: InitOptions): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (options.json) {
      outputJsonError('GITHUB_TOKEN environment variable is required');
    } else {
      console.error('Error: GITHUB_TOKEN environment variable is required');
      console.error('Set it with: export GITHUB_TOKEN=$(gh auth token)');
    }
    process.exit(1);
  }

  // Auto-detect username if not provided or is a test value
  let username = options.username;
  if (!username || isTestUsername(username)) {
    const detected = detectGitHubUsername();
    if (detected) {
      username = detected;
      if (!options.json) {
        console.log(`Detected GitHub user: @${username}`);
      }
    } else if (!username) {
      if (options.json) {
        outputJsonError('Could not detect GitHub username. Please provide it: init <username>');
      } else {
        console.error('Error: Could not detect GitHub username.');
        console.error('Please provide it explicitly: init <username>');
        console.error('Or ensure gh CLI is authenticated: gh auth login');
      }
      process.exit(1);
    }
  }

  const stateManager = getStateManager();
  const prMonitor = new PRMonitor(token);
  const octokit = getOctokit(token);

  if (!options.json) {
    console.log(`\n🚀 Initializing with PRs from @${username}...\n`);
  }

  // Set username
  stateManager.updateConfig({ githubUsername: username });

  // Search for open PRs by this user
  const { data } = await octokit.search.issuesAndPullRequests({
    q: `is:pr is:open author:${username}`,
    sort: 'updated',
    order: 'desc',
    per_page: 100,
  });

  if (!options.json) {
    console.log(`Found ${data.total_count} open PRs`);
  }

  const imported: Array<{ repo: string; number: number; title: string }> = [];
  const errors: Array<{ url: string; error: string }> = [];
  const config = stateManager.getState().config;
  let skipped = 0;

  for (const item of data.items) {
    if (item.pull_request) {
      // Check if repo is excluded
      const parsed = parseGitHubUrl(item.html_url);
      if (parsed) {
        const repoFullName = `${parsed.owner}/${parsed.repo}`;
        if (isRepoExcluded(repoFullName, config.excludeRepos)) {
          skipped++;
          continue;
        }
      }

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
      username,
      totalFound: data.total_count,
      imported,
      errors,
    });
  } else {
    console.log(`\nInitialization complete! Tracking ${imported.length} open PRs.`);
    console.log('\nTo import your merged PR history, run: import-history');
    console.log('Run `oss-autopilot status` to see your PRs.');
  }
}
