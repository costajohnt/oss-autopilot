/**
 * Search command
 * Searches for new issues to work on
 */

import { IssueDiscovery, getGitHubToken, getStateManager, DEFAULT_CONFIG } from '../core/index.js';
import { outputJson, type SearchOutput } from '../formatters/json.js';

interface SearchOptions {
  maxResults: number;
  json?: boolean;
}

export async function runSearch(options: SearchOptions): Promise<void> {
  // Token is guaranteed by the preAction hook in cli.ts for non-LOCAL_ONLY_COMMANDS.
  const token = getGitHubToken()!;

  const discovery = new IssueDiscovery(token);

  if (!options.json) {
    console.log(`\n🔍 Searching for issues (max ${options.maxResults})...\n`);
  }

  const candidates = await discovery.searchIssues({ maxResults: options.maxResults });

  if (options.json) {
    const stateManager = getStateManager();
    const { config } = stateManager.getState();
    const excludedRepos = config.excludeRepos || [];
    const aiPolicyBlocklist = config.aiPolicyBlocklist ?? DEFAULT_CONFIG.aiPolicyBlocklist ?? [];
    const searchOutput: SearchOutput = {
      candidates: candidates.map((c) => {
        const repoScoreRecord = stateManager.getRepoScore(c.issue.repo);
        return {
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
          searchPriority: c.searchPriority,
          viabilityScore: c.viabilityScore,
          repoScore: repoScoreRecord
            ? {
                score: repoScoreRecord.score,
                mergedPRCount: repoScoreRecord.mergedPRCount,
                closedWithoutMergeCount: repoScoreRecord.closedWithoutMergeCount,
                isResponsive: repoScoreRecord.signals?.isResponsive ?? false,
                lastMergedAt: repoScoreRecord.lastMergedAt,
              }
            : undefined,
        };
      }),
      excludedRepos,
      aiPolicyBlocklist,
    };
    if (discovery.rateLimitWarning) {
      searchOutput.rateLimitWarning = discovery.rateLimitWarning;
    }
    outputJson<SearchOutput>(searchOutput);
  } else {
    if (candidates.length === 0) {
      if (discovery.rateLimitWarning) {
        console.warn(`\n⚠ ${discovery.rateLimitWarning}\n`);
      } else {
        console.log('No matching issues found.');
      }
      return;
    }

    if (discovery.rateLimitWarning) {
      console.warn(`\n⚠ ${discovery.rateLimitWarning}\n`);
    }

    console.log(`Found ${candidates.length} candidates:\n`);

    for (const candidate of candidates) {
      console.log(discovery.formatCandidate(candidate));
      console.log('---');
    }
  }
}
