/**
 * Init command
 * Initialize with existing PRs from GitHub
 */

import { getStateManager, PRMonitor, getOctokit, isTestUsername, detectGitHubUsername, daysBetween, type TrackedPR } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

// How far back to import merged PRs (in months)
const MERGE_HISTORY_MONTHS = 12;

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

  // Now import merged PRs from the last N months for historical data
  if (!options.json) {
    console.log(`\nImporting merged PRs from the last ${MERGE_HISTORY_MONTHS} months...`);
  }

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - MERGE_HISTORY_MONTHS);
  const cutoffStr = cutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD

  const { data: mergedData } = await octokit.search.issuesAndPullRequests({
    q: `is:pr is:merged author:${username} merged:>${cutoffStr}`,
    sort: 'updated',
    order: 'desc',
    per_page: 100,
  });

  if (!options.json) {
    console.log(`Found ${mergedData.total_count} merged PRs`);
  }

  const importedMerged: Array<{ repo: string; number: number; title: string }> = [];

  for (const item of mergedData.items) {
    if (item.pull_request) {
      try {
        // Parse the URL to get owner/repo
        const match = item.html_url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
        if (!match) continue;

        const [, owner, repo] = match;
        const prNumber = parseInt(match[3], 10);

        // Fetch full PR data to get merge date
        const { data: prData } = await octokit.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        });

        const now = new Date();
        const mergedPR: TrackedPR = {
          id: prData.id,
          url: item.html_url,
          repo: `${owner}/${repo}`,
          number: prNumber,
          title: prData.title,
          status: 'merged',
          activityStatus: 'active',
          createdAt: prData.created_at,
          updatedAt: prData.updated_at,
          lastChecked: now.toISOString(),
          lastActivityAt: prData.merged_at || prData.updated_at,
          mergedAt: prData.merged_at || undefined,
          daysSinceActivity: daysBetween(new Date(prData.merged_at || prData.updated_at), now),
          hasUnreadComments: false,
          reviewCommentCount: prData.review_comments,
          commitCount: prData.commits,
          ciStatus: 'passing', // Merged PRs passed CI
          hasMergeConflict: false,
          reviewDecision: 'approved', // Merged PRs were approved
        };

        const added = stateManager.addMergedPR(mergedPR);
        if (added) {
          importedMerged.push({ repo: mergedPR.repo, number: mergedPR.number, title: mergedPR.title });
          if (!options.json) {
            console.log(`  Added: ${mergedPR.repo}#${mergedPR.number} - ${mergedPR.title}`);
          }
        }
      } catch (error) {
        // Silently skip errors for merged PRs (less critical than open PRs)
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!options.json) {
          console.error(`  Skipped ${item.html_url}: ${errorMsg}`);
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
      importedMerged,
      errors,
    });
  } else {
    console.log(`\nInitialization complete!`);
    console.log(`  Open PRs: ${imported.length}`);
    console.log(`  Merged PRs: ${importedMerged.length}`);
    console.log('\nRun `oss-autopilot status` to see your PRs.');
  }
}
