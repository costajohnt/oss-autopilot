/**
 * Search command
 * Searches for new issues to work on
 */

import { IssueDiscovery } from '../core/index.js';
import { outputJson, outputJsonError, type SearchOutput } from '../formatters/json.js';

interface SearchOptions {
  maxResults: number;
  json?: boolean;
}

export async function runSearch(options: SearchOptions): Promise<void> {
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

  const discovery = new IssueDiscovery(token);

  if (!options.json) {
    console.log(`\n🔍 Searching for issues (max ${options.maxResults})...\n`);
  }

  const candidates = await discovery.searchIssues({ maxResults: options.maxResults });

  if (options.json) {
    outputJson<SearchOutput>({
      candidates: candidates.map(c => ({
        issue: {
          repo: c.issue.repo,
          number: c.issue.number,
          title: c.issue.title,
          url: c.issue.url,
          labels: c.issue.labels,
        },
        recommendation: c.recommendation,
        reasonsToApprove: c.reasonsToApprove,
        reasonsToSkip: c.reasonsToSkip,
      })),
    });
  } else {
    if (candidates.length === 0) {
      console.log('No matching issues found.');
      return;
    }

    console.log(`Found ${candidates.length} candidates:\n`);

    for (const candidate of candidates) {
      console.log(discovery.formatCandidate(candidate));
      console.log('---');
    }
  }
}
