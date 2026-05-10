/**
 * Features command (scout 0.9.0 #97/#98/#99)
 *
 * Wraps `scout.features()` to surface feature-scoped contribution
 * opportunities in repos where the user already has 3+ merged PRs
 * (configurable via `featuresAnchorThreshold`). Returns two ranked
 * buckets — "quick wins" and "bigger bets" — split by maintainer-
 * commitment signals (milestones, roadmap membership, label set).
 *
 * Mirrors the shape of `runSearch`: each bucket entry is a
 * {@link SearchCandidate} augmented with a `horizon` literal so callers
 * can render bucket-specific UX while reusing the search candidate
 * formatter.
 */

import type { LinkedPR as ScoutLinkedPR } from '@oss-scout/core';
import { buildCandidateLinkedPR, createAutopilotScout } from './scout-bridge.js';
import { getStateManager } from '../core/index.js';
import { type FeaturesOutput, type FeaturesCandidate, type SearchCandidate } from '../formatters/json.js';
import { gradeFromCandidate } from '../core/issue-grading.js';
import { warn } from '../core/logger.js';

export { type FeaturesOutput, type FeaturesCandidate } from '../formatters/json.js';

const MODULE = 'features';

/**
 * Hard cap on feature-search result count, matching `MAX_SEARCH_RESULTS`
 * for `runSearch`. Shared between CLI (`cli-registry.ts`) and the MCP
 * tool registration so a future adjustment lands in one place.
 */
export const MAX_FEATURES_RESULTS = 100;

interface FeaturesOptions {
  maxResults: number;
  /** Override `featuresAnchorThreshold` for this call (1-50). */
  anchorThreshold?: number;
  /** Override `featuresSplitRatio` for this call (0-1). */
  splitRatio?: number;
}

/**
 * Coerce scout's raw `viabilityScore` into a trustworthy 0-100 number.
 * Same defensive boundary check as `runSearch` — kept inline (not
 * imported) so this command remains self-contained per the existing
 * autopilot convention. See #1043.
 */
function sanitizeViabilityScore(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) {
    warn(MODULE, `Ignoring out-of-contract viabilityScore from scout: ${JSON.stringify(raw)}`);
    return 0;
  }
  return raw;
}

/**
 * Map one scout `FeatureCandidate` into the autopilot output shape.
 * Mirrors the candidate-mapping branch in `runSearch` and stamps the
 * `horizon` field.
 */
function toFeaturesCandidate(
  scoutCandidate: {
    issue: { repo: string; number: number; title: string; url: string; labels: string[] };
    recommendation: SearchCandidate['recommendation'];
    reasonsToApprove: string[];
    reasonsToSkip: string[];
    searchPriority: SearchCandidate['searchPriority'];
    viabilityScore: unknown;
    horizon: FeaturesCandidate['horizon'];
    /** Optional — present on real scout candidates, omitted in some test fixtures. */
    vettingResult?: { linkedPR?: ScoutLinkedPR | null };
  },
  getState: ReturnType<typeof getStateManager>,
): FeaturesCandidate {
  const repoScoreRecord = getState.getRepoScore(scoutCandidate.issue.repo);
  // Same `checkFailed: true` sentinel `runSearch` uses — scout's `features`
  // pipeline reuses the same vetting code that does emit projectHealth on
  // `vetIssue`, but on this surface scout returns the multi-issue list view
  // which today does not propagate per-candidate health into IssueCandidate.
  // Treating health as unknown grades from the autopilot-tracked repoScore
  // alone, falling to 'F' for unfamiliar repos — an honest "we haven't seen
  // this repo" rather than a fabricated score.
  const grade = gradeFromCandidate({
    repo: scoutCandidate.issue.repo,
    projectHealth: { avgIssueResponseDays: null, daysSinceLastCommit: null, checkFailed: true },
    getRepoScore: (repo) => {
      const score = getState.getRepoScore(repo);
      return score
        ? {
            mergedPRCount: score.mergedPRCount,
            closedWithoutMergeCount: score.closedWithoutMergeCount,
            avgResponseDays: score.avgResponseDays ?? null,
          }
        : undefined;
    },
  });
  const linkedPR = buildCandidateLinkedPR(scoutCandidate.vettingResult?.linkedPR);
  return {
    issue: {
      repo: scoutCandidate.issue.repo,
      repoUrl: `https://github.com/${scoutCandidate.issue.repo}`,
      number: scoutCandidate.issue.number,
      title: scoutCandidate.issue.title,
      url: scoutCandidate.issue.url,
      labels: scoutCandidate.issue.labels,
    },
    recommendation: scoutCandidate.recommendation,
    reasonsToApprove: scoutCandidate.reasonsToApprove,
    reasonsToSkip: scoutCandidate.reasonsToSkip,
    searchPriority: scoutCandidate.searchPriority,
    viabilityScore: sanitizeViabilityScore(scoutCandidate.viabilityScore),
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
    horizon: scoutCandidate.horizon,
  };
}

/**
 * Run feature-scoped contribution discovery via `scout.features()`.
 *
 * @param options - Feature search configuration
 * @param options.maxResults - Total candidates returned across both buckets
 * @param options.anchorThreshold - Optional per-call override for the merged-PR threshold (default: scout's `featuresAnchorThreshold`)
 * @param options.splitRatio - Optional per-call override for the quick-win split ratio (default: scout's `featuresSplitRatio`)
 * @returns Two ranked buckets (quick-wins / bigger-bets) plus anchor list and an optional human message
 * @throws {ConfigurationError} If no GitHub token is available
 *
 * @example
 * ```typescript
 * import { runFeatures } from '@oss-autopilot/core/commands';
 *
 * const result = await runFeatures({ maxResults: 10 });
 * for (const c of [...result.quickWins, ...result.biggerBets]) {
 *   console.log(`${c.issue.repo}#${c.issue.number} — ${c.horizon}`);
 * }
 * ```
 */
export async function runFeatures(options: FeaturesOptions): Promise<FeaturesOutput> {
  const scout = await createAutopilotScout();
  const result = await scout.features({
    count: options.maxResults,
    anchorThreshold: options.anchorThreshold,
    splitRatio: options.splitRatio,
  });

  const stateManager = getStateManager();

  const featuresOutput: FeaturesOutput = {
    quickWins: result.quickWins.map((c) => toFeaturesCandidate(c, stateManager)),
    biggerBets: result.biggerBets.map((c) => toFeaturesCandidate(c, stateManager)),
    anchorRepos: result.anchorRepos,
    message: result.message,
  };
  return featuresOutput;
}
