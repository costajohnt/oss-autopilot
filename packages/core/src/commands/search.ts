/**
 * Search command
 * Searches for new issues to work on via @oss-scout/core
 */

import {
  adaptScoutLinkedPR,
  buildCandidateLinkedPR,
  createAutopilotScout,
  type ScoutBridgeDiagnostics,
} from './scout-bridge.js';
import { classifyLinkedPR, getStateManager } from '../core/index.js';
import { type SearchOutput } from '../formatters/json.js';
import { gradeFromCandidate } from '../core/issue-grading.js';
import { computeStrategy } from '../core/strategy.js';
import { debug, warn } from '../core/logger.js';

export { type SearchOutput } from '../formatters/json.js';

const MODULE = 'search';

/**
 * Hard cap on issue-search result count. Shared between CLI (`cli-registry.ts`),
 * MCP tool (`tools.ts`), and MCP prompt (`prompts.ts`) so a future adjustment
 * lands in one place instead of three (#1002).
 */
export const MAX_SEARCH_RESULTS = 100;

/**
 * Fraction of search slots reserved for candidates that matched neither
 * strategy-preferred languages nor repos (#1244). Counterweight against
 * echo-chamber bias: without it, strategy-boosted searches return more of
 * what already merged, which merges more of the same, and the profile
 * narrows over time. Scout clamps to [0, 1]; 0.2 is the issue's proposal.
 */
export const SEARCH_DIVERSITY_RATIO = 0.2;

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
  // Collect bridge-level degradation signals (#1448): an unreadable skip file
  // means scout searched with an empty skip list, so explicitly-skipped
  // issues may resurface — the envelope must say so, not just stderr.
  const bridgeDiagnostics: ScoutBridgeDiagnostics = {};
  const scout = await createAutopilotScout(bridgeDiagnostics);
  const stateManager = getStateManager();

  // Derive personalization from local history (#1244). `computeStrategy`
  // returns null below the merged-PR floor — in that case we pass nothing
  // and scout's sort behaves exactly as before. Once strategy data is
  // available, scout boosts language/repo matches into a separate sort
  // tier (still no filtering).
  const strategy = computeStrategy(stateManager.getState());
  const preferLanguages = strategy?.recommendations.languages ?? undefined;
  const preferRepos = strategy?.recommendations.repos ?? undefined;
  if (preferLanguages?.length || preferRepos?.length) {
    debug(
      MODULE,
      `Applying strategy bias to search: preferLanguages=${JSON.stringify(preferLanguages ?? [])}, preferRepos=${JSON.stringify(preferRepos ?? [])}`,
    );
  }

  const result = await scout.search({
    maxResults: options.maxResults,
    preferLanguages,
    preferRepos,
    diversityRatio: SEARCH_DIVERSITY_RATIO,
  });

  // #1354: never surface issues the user already has an open PR for. Uses
  // scout's structured linked-PR metadata when present; candidates without it
  // pass through (the issue-scout agent re-checks via verify-issue anyway).
  // Empty login means "can't prove any PR is the user's own" — nothing hidden.
  const userLogin = stateManager.getState().config?.githubUsername ?? '';
  if (userLogin === '') {
    warn(MODULE, 'githubUsername not configured — the own-PR filter (#1354) cannot run; hiddenOwnPRCount will be 0');
  }
  const visibleCandidates = result.candidates.filter(
    (c) => classifyLinkedPR({ linkedPR: adaptScoutLinkedPR(c.vettingResult?.linkedPR), userLogin }) !== 'user_open',
  );
  const hiddenOwnPRCount = result.candidates.length - visibleCandidates.length;
  if (hiddenOwnPRCount > 0) {
    debug(MODULE, `Hid ${hiddenOwnPRCount} candidate(s) with the user's own open PR (#1354)`);
  }

  const searchOutput: SearchOutput = {
    candidates: visibleCandidates.map((c) => {
      const repoScoreRecord = stateManager.getRepoScore(c.issue.repo);
      // Scout's `search` does not emit per-candidate projectHealth (only
      // `vetIssue` does). Pass a sentinel `checkFailed: true` so the grader
      // correctly treats scout-side signals as unknown and grades purely from
      // the autopilot-tracked repoScore. Candidates without a repoScore
      // receive 'F' — that's an honest signal for "we haven't seen this repo
      // before" rather than a fabricated score.
      //
      // Note (#1465): repoScore here is the cached HISTORY score (the user's
      // own merge outcomes — docs/repo-scores.md §History score), so this
      // grade reflects history only; `vet` later re-grades the same issue
      // with freshly fetched repo health and can legitimately disagree.
      const grade = gradeFromCandidate({
        repo: c.issue.repo,
        projectHealth: {
          repo: c.issue.repo,
          checkFailed: true,
          failureReason: 'health not fetched on the multi-issue search surface',
        },
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
        // Scout 1.0 folded the boostScore/boostReasons/diversitySlot trio into a
        // single `personalization` field (#158). Derive the flat output fields
        // from it so this command's JSON shape is unchanged.
        ...(c.personalization?.kind === 'boosted' ? { boostScore: c.personalization.score } : {}),
        ...(c.personalization?.kind === 'boosted' && c.personalization.reasons.length > 0
          ? { boostReasons: c.personalization.reasons }
          : {}),
        ...(c.personalization?.kind === 'diversity' ? { diversitySlot: true } : {}),
      };
    }),
    excludedRepos: result.excludedRepos,
    aiPolicyBlocklist: result.aiPolicyBlocklist,
    hiddenOwnPRCount,
  };
  if (result.rateLimitWarning) {
    searchOutput.rateLimitWarning = result.rateLimitWarning;
  }
  if (bridgeDiagnostics.skipListUnavailable) {
    searchOutput.skipListUnavailable = true;
  }
  return searchOutput;
}
