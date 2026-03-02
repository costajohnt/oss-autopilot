/**
 * Search command
 * Searches for new issues to work on
 */

import { IssueDiscovery, requireGitHubToken, getStateManager, DEFAULT_CONFIG } from '../core/index.js';
import { type SearchOutput } from '../formatters/json.js';

export { type SearchOutput } from '../formatters/json.js';

interface SearchOptions {
  maxResults: number;
}

export async function runSearch(options: SearchOptions): Promise<SearchOutput> {
  const token = requireGitHubToken();

  const discovery = new IssueDiscovery(token);

  const candidates = await discovery.searchIssues({ maxResults: options.maxResults });

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
  return searchOutput;
}
