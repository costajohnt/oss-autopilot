/**
 * Import History command
 * Import historical merged PRs with rate limiting
 */

import { getStateManager, getOctokit, daysBetween, type TrackedPR } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

// Rate limiting configuration
const REQUESTS_PER_BATCH = 10;
const BATCH_DELAY_MS = 2000; // 2 second pause between batches
const REQUEST_DELAY_MS = 200; // 200ms between individual requests (5 req/sec)

interface ImportHistoryOptions {
  months?: number;
  json?: boolean;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runImportHistory(options: ImportHistoryOptions): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (options.json) {
      outputJsonError('GITHUB_TOKEN environment variable is required');
    } else {
      console.error('Error: GITHUB_TOKEN environment variable is required');
    }
    process.exit(1);
  }

  const stateManager = getStateManager();
  const config = stateManager.getState().config;
  const octokit = getOctokit(token);

  if (!config.githubUsername) {
    if (options.json) {
      outputJsonError('No GitHub username configured. Run: init <username>');
    } else {
      console.error('Error: No GitHub username configured.');
      console.error('Run: init <username> first');
    }
    process.exit(1);
  }

  const months = options.months || 12;
  const username = config.githubUsername;

  if (!options.json) {
    console.log(`\n📚 Importing merged PRs from the last ${months} months for @${username}...\n`);
  }

  // Calculate cutoff date
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);
  const cutoffStr = cutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD

  // First, get the total count
  const { data: searchData } = await octokit.search.issuesAndPullRequests({
    q: `is:pr is:merged author:${username} merged:>${cutoffStr}`,
    sort: 'updated',
    order: 'desc',
    per_page: 1,
  });

  const totalCount = searchData.total_count;

  if (!options.json) {
    console.log(`Found ${totalCount} merged PRs to import`);
    if (totalCount > 100) {
      console.log(`Note: GitHub API limits search to 100 most recent results`);
    }
    console.log('');
  }

  if (totalCount === 0) {
    if (options.json) {
      outputJson({
        username,
        months,
        totalFound: 0,
        imported: [],
        skipped: 0,
        errors: [],
      });
    } else {
      console.log('No merged PRs found in this time period.');
    }
    return;
  }

  // Fetch all merged PRs (up to 100)
  const { data: mergedData } = await octokit.search.issuesAndPullRequests({
    q: `is:pr is:merged author:${username} merged:>${cutoffStr}`,
    sort: 'updated',
    order: 'desc',
    per_page: 100,
  });

  const imported: Array<{ repo: string; number: number; title: string }> = [];
  const errors: Array<{ url: string; error: string }> = [];
  let skipped = 0;
  let processed = 0;

  // Process in batches with rate limiting
  for (let i = 0; i < mergedData.items.length; i++) {
    const item = mergedData.items[i];
    processed++;

    if (!item.pull_request) {
      continue;
    }

    // Progress indicator
    if (!options.json) {
      process.stdout.write(`\rImporting... ${processed}/${mergedData.items.length}`);
    }

    try {
      // Parse the URL to get owner/repo
      const match = item.html_url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!match) {
        skipped++;
        continue;
      }

      const [, owner, repo] = match;
      const prNumber = parseInt(match[3], 10);

      // Check if already tracked
      const existingPR = stateManager.findPR(item.html_url);
      if (existingPR) {
        skipped++;
        continue;
      }

      // Rate limiting: delay between requests
      await sleep(REQUEST_DELAY_MS);

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
        ciStatus: 'passing',
        hasMergeConflict: false,
        reviewDecision: 'approved',
      };

      const added = stateManager.addMergedPR(mergedPR);
      if (added) {
        imported.push({ repo: mergedPR.repo, number: mergedPR.number, title: mergedPR.title });
      } else {
        skipped++;
      }

      // Batch delay: pause after every REQUESTS_PER_BATCH requests
      if (processed % REQUESTS_PER_BATCH === 0 && processed < mergedData.items.length) {
        if (!options.json) {
          process.stdout.write(` (pausing to respect rate limits...)`);
        }
        await sleep(BATCH_DELAY_MS);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({ url: item.html_url, error: errorMsg });
    }
  }

  // Clear the progress line
  if (!options.json) {
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
  }

  stateManager.save();

  if (options.json) {
    outputJson({
      username,
      months,
      totalFound: totalCount,
      imported,
      skipped,
      errors,
    });
  } else {
    console.log(`\n✅ Import complete!`);
    console.log(`   Imported: ${imported.length} merged PRs`);
    if (skipped > 0) {
      console.log(`   Skipped: ${skipped} (already tracked or invalid)`);
    }
    if (errors.length > 0) {
      console.log(`   Errors: ${errors.length}`);
      for (const err of errors.slice(0, 3)) {
        console.log(`     - ${err.url}: ${err.error}`);
      }
      if (errors.length > 3) {
        console.log(`     ... and ${errors.length - 3} more`);
      }
    }
    console.log('\nRun `oss-autopilot status` to see updated stats.');
  }
}
