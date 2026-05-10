/**
 * Search command
 * Searches for new issues to work on via @oss-scout/core
 */

import { buildCandidateLinkedPR, createAutopilotScout } from './scout-bridge.js';
import { getStateManager } from '../core/index.js';
import { type SearchOutput } from '../formatters/json.js';
import { gradeFromCandidate } from '../core/issue-grading.js';
import { warn } from '../core/logger.js';

export { type SearchOutput } from '../formatters/json.js';

const MODULE = 'search';

/**
 * Hard cap on issue-search result count. Shared between CLI (`cli-registry.ts`),
 * MCP tool (`tools.ts`), and MCP prompt (`prompts.ts`) so a future adjustment
 * lands in one place instead of three (#1002).
 */
export const MAX_SEARCH_RESULTS = 100;

interface SearchOptions {
  maxResults: number;
}

/**
 * Search GitHub for contributable issues using multi-phase discovery.
 *
 * @param options - Search configuration
 * @param options.maxResults - Maximum number of candidates to return
 * @returns Search results with scored candidates and exclusion lists
 * @throws {ConfigurationError} If no GitHub token is available
 *
 * @example
 * ```typescript
 * import { runSearch } from '@oss-autopilot/core/commands';
 *
 * const results = await runSearch({ maxResults: 10 });
 * for (const c of results.candidates) {
 *   console.log(`${c.issue.repo}#${c.issue.number} — ${c.viabilityScore}/100`);
 * }
 * ```
 */
/**
 * Coerce scout's raw `viabilityScore` into a trustworthy 0–100 number.
 * Scout is supposed to emit a finite integer in range, but out-of-contract
 * values (NaN, Infinity, negative, >100, non-number) would otherwise flow
 * straight through to consumers. Defend at the boundary — see #1043.
 */
function sanitizeViabilityScore(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) {
    warn(MODULE, `Ignoring out-of-contract viabilityScore from scout: ${JSON.stringify(raw)}`);
    return 0;
  }
  return raw;
}

export async function runSearch(options: SearchOptions): Promise<SearchOutput> {
  const scout = await createAutopilotScout();
  const result = await scout.search({ maxResults: options.maxResults });

  const stateManager = getStateManager();

  const searchOutput: SearchOutput = {
    candidates: result.candidates.map((c) => {
      const repoScoreRecord = stateManager.getRepoScore(c.issue.repo);
      // Scout's `search` does not emit per-candidate projectHealth (only
      // `vetIssue` does). Pass a sentinel `checkFailed: true` so the grader
      // correctly treats scout-side signals as unknown and grades purely from
      // the autopilot-tracked repoScore. Candidates without a repoScore
      // receive 'F' — that's an honest signal for "we haven't seen this repo
      // before" rather than a fabricated score.
      const grade = gradeFromCandidate({
        repo: c.issue.repo,
        projectHealth: { avgIssueResponseDays: null, daysSinceLastCommit: null, checkFailed: true },
        getRepoScore: (repo) => {
          const score = stateManager.getRepoScore(repo);
          return score
            ? {
                mergedPRCount: score.mergedPRCount,
                closedWithoutMergeCount: score.closedWithoutMergeCount,
                avgResponseDays: score.avgResponseDays ?? null,
              }
            : undefined;
        },
      });
      const linkedPR = buildCandidateLinkedPR(c.vettingResult?.linkedPR);
      return {
        issue: {
          repo: c.issue.repo,
          repoUrl: `https://github.com/${c.issue.repo}`,
          number: c.issue.number,
          title: c.issue.title,
          url: c.issue.url,
          labels: c.issue.labels,
        },
        recommendation: c.recommendation,
        reasonsToApprove: c.reasonsToApprove,
        reasonsToSkip: c.reasonsToSkip,
        searchPriority: c.searchPriority,
        viabilityScore: sanitizeViabilityScore(c.viabilityScore),
        grade,
        repoScore: repoScoreRecord
          ? {
              score: repoScoreRecord.score,
              mergedPRCount: repoScoreRecord.mergedPRCount,
              closedWithoutMergeCount: repoScoreRecord.closedWithoutMergeCount,
              isResponsive: repoScoreRecord.signals?.isResponsive ?? false,
              lastMergedAt: repoScoreRecord.lastMergedAt,
            }
          : undefined,
        ...(linkedPR ? { linkedPR } : {}),
      };
    }),
    excludedRepos: result.excludedRepos,
    aiPolicyBlocklist: result.aiPolicyBlocklist,
  };
  if (result.rateLimitWarning) {
    searchOutput.rateLimitWarning = result.rateLimitWarning;
  }
  return searchOutput;
}
