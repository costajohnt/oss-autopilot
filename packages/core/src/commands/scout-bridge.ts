/**
 * Bridge between oss-autopilot's AgentState and oss-scout's OssScout API.
 * Maps state fields and creates scout instances for search/vet commands.
 */

import { createScout, type LinkedPR as ScoutLinkedPR, type OssScout, type ScoutState } from '@oss-scout/core';
import { getStateManager, isLinkedPRStalled, requireGitHubToken } from '../core/index.js';
import type { LinkedPR } from '../core/linked-pr-classification.js';
import { computeStrategy } from '../core/strategy.js';
import type { CandidateLinkedPR } from '../formatters/json.js';
import { loadSkippedIssuesDetailed } from './skip-file-parser.js';

/**
 * Fraction of search slots reserved for candidates that matched neither
 * strategy-preferred languages nor repos (#1244). Counterweight against
 * echo-chamber bias: without it, strategy-boosted searches return more of
 * what already merged, which merges more of the same, and the profile
 * narrows over time. Scout clamps to [0, 1]; 0.2 is the issue's proposal.
 *
 * Lives here (not `search.ts`, which re-exports it) since #1464: the same
 * ratio is baked into the `ScoutPreferences` built by {@link buildScoutState}
 * so every scout surface shares one policy.
 */
export const SEARCH_DIVERSITY_RATIO = 0.2;

/**
 * Degradation signals collected while building a scout state (#1448).
 * Callers pass an empty object and inspect it after the build — threading an
 * out-param keeps `buildScoutState`/`createAutopilotScout` return types
 * unchanged for the five command call sites.
 */
export interface ScoutBridgeDiagnostics {
  /**
   * Set when a configured skipped-issues file exists but could not be read.
   * The scout state was built with an EMPTY skip list, so explicitly-skipped
   * issues may resurface in results.
   */
  skipListUnavailable?: boolean;
}

/**
 * Convert scout 0.6.0's `LinkedPR` (separate `state` + `merged`) into the
 * shape `classifyLinkedPR` expects (`state` already folded with `merged`).
 *
 * Scout exposes the raw GitHub fields verbatim, but the classifier was
 * written before scout surfaced this data and uses a tri-state
 * `'open' | 'closed' | 'merged'` enum. Folding `merged` into the state
 * preserves the function's existing contract + tests.
 *
 * `updatedAt` (added in scout 0.9.0) flows through unchanged so consumers
 * can hand the result to `isLinkedPRStalled` without re-fetching.
 */
export function adaptScoutLinkedPR(scoutLinkedPR: ScoutLinkedPR | null | undefined): LinkedPR | null {
  if (!scoutLinkedPR) return null;
  const adapted: LinkedPR = {
    author: { login: scoutLinkedPR.author },
    state: scoutLinkedPR.merged ? 'merged' : scoutLinkedPR.state,
  };
  if (scoutLinkedPR.updatedAt !== undefined) {
    adapted.updatedAt = scoutLinkedPR.updatedAt;
  }
  return adapted;
}

/**
 * Build the autopilot-shaped `linkedPR` slice consumed by `SearchOutput`,
 * `VetOutput`, and `FeaturesOutput` from scout's raw `LinkedPR`
 * (#97 / scout 0.9.0). Returns `undefined` when scout reported no linked
 * PR. Computes `isStalled` from the adapted (autopilot-shape) PR so the
 * rule stays consistent with `classifyLinkedPR` and downstream consumers.
 */
export function buildCandidateLinkedPR(scoutLinkedPR: ScoutLinkedPR | null | undefined): CandidateLinkedPR | undefined {
  if (!scoutLinkedPR) return undefined;
  const adapted = adaptScoutLinkedPR(scoutLinkedPR);
  if (!adapted) return undefined;
  const linkedPR: CandidateLinkedPR = {
    number: scoutLinkedPR.number,
    state: adapted.state,
    url: scoutLinkedPR.url,
    isStalled: isLinkedPRStalled(adapted),
  };
  if (scoutLinkedPR.updatedAt !== undefined) {
    linkedPR.updatedAt = scoutLinkedPR.updatedAt;
  }
  return linkedPR;
}

/**
 * Build a ScoutState from the current AgentState.
 * Maps oss-autopilot's config and state fields to oss-scout's state format.
 *
 * @param diagnostics - Optional collector for degradation signals (#1448);
 *   `skipListUnavailable` is set when the skipped-issues file exists but
 *   could not be read.
 */
export function buildScoutState(diagnostics?: ScoutBridgeDiagnostics): ScoutState {
  const state = getStateManager().getState();
  const { config } = state;

  // Read failure (not absence) of the skip file means scout will see an empty
  // skip list and may resurface explicitly-skipped issues — flag it so the
  // search envelope can carry the signal instead of only stderr (#1448).
  const skippedIssuesLoad = loadSkippedIssuesDetailed(config.skippedIssuesPath);
  if (skippedIssuesLoad.readError !== undefined && diagnostics) {
    diagnostics.skipListUnavailable = true;
  }

  // Strategy-derived personalization (#1464). `computeStrategy` returns null
  // below the merged-PR floor — empty lists then read as "no bias" on scout's
  // side. Baking the bias into the preferences (rather than only per-call
  // search options, #1244) makes every scout surface share it: `search()`
  // falls back to these when no per-call override is passed, and `features()`
  // exposes no per-call bias knobs at all (scout 1.1.0 accepts only
  // count/anchorThreshold/splitRatio/broad), so preferences are the only
  // channel by which bias can reach the features path.
  const strategy = computeStrategy(state);

  return {
    version: 1,
    preferences: {
      githubUsername: config.githubUsername,
      languages: config.languages,
      labels: config.labels,
      scope: config.scope,
      excludeRepos: config.excludeRepos,
      excludeOrgs: config.excludeOrgs ?? [],
      aiPolicyBlocklist: config.aiPolicyBlocklist,
      projectCategories: config.projectCategories ?? [],
      minStars: config.minStars,
      maxIssueAgeDays: config.maxIssueAgeDays,
      includeDocIssues: config.includeDocIssues,
      minRepoScoreThreshold: config.minRepoScoreThreshold,
      interPhaseDelayMs: 30_000,
      broadPhaseDelayMs: 90_000,
      skipBroadWhenSufficientResults: config.skipBroadWhenSufficientResults,
      persistence: config.persistence as 'local' | 'gist',
      slmTriageModel: config.slmTriageModel,
      slmTriageHost: config.slmTriageHost,
      // Scout 0.9.0 made these required on `ScoutPreferences` (their schema
      // ZodDefaults still apply at parse time, but the inferred TS type now
      // demands the fields). We pass scout's documented defaults here so
      // autopilot doesn't have to introduce a new pair of user-visible
      // settings just to satisfy the type. The features CLI command
      // (#runFeatures) accepts per-call `--anchor-threshold` and
      // `--split-ratio` flags for overrides.
      featuresAnchorThreshold: 3,
      featuresSplitRatio: 0.6,
      // Personalization-bias prefs (scout #1244 / #168 / #1464).
      // preferLanguages/preferRepos mirror the strategy derivation the search
      // command uses per-call; avoidRepos/boostIssueTypes are user settings
      // (config-registry keys); diversityRatio matches the search policy.
      preferLanguages: strategy?.recommendations.languages ?? [],
      preferRepos: strategy?.recommendations.repos ?? [],
      diversityRatio: SEARCH_DIVERSITY_RATIO,
      avoidRepos: config.avoidRepos ?? [],
      boostIssueTypes: config.boostIssueTypes ?? [],
    },
    // CONTRACT (#1458): repoScores is passed BY REFERENCE, not copied. Scout's
    // updateRepoScore mutates entries of this shared object in place, so scout
    // calls that touch scores (e.g. search's hasActiveMaintainers feedback,
    // scout #167) write straight into the in-memory AgentState. Those writes
    // reach disk only if a later StateManager mutation triggers a save —
    // scout's own checkpoint() persists nothing under persistence:'provided'.
    // Nothing may RELY on this alias for persistence: daily's former Phase 3.5
    // did, and was deleted in #1458 (its record* calls were also dedup no-ops
    // against the ledger Phase 3 had just written; see
    // scout-bridge.repo-scores.test.ts for the pinning tests). Also note scout
    // recalculates `score` with its own formula (linear merge bonus, no
    // recency term), which differs from autopilot's repo-score-manager
    // formula; daily Phase 2 recomputes every repo it touches with the
    // autopilot formula each run, so the persisted history scores reflect
    // autopilot's model.
    repoScores: state.repoScores,
    // Scout #117 added tombstones (deletion records for gist merge). Autopilot
    // synthesizes a fresh ScoutState per operation and tracks no deletions, so
    // an empty list is correct here.
    tombstones: [],
    starredRepos: config.starredRepos,
    starredReposLastFetched: config.starredReposLastFetched,
    mergedPRs: (state.mergedPRs ?? []).map((pr) => ({
      url: pr.url,
      title: pr.title,
      mergedAt: pr.mergedAt,
    })),
    closedPRs: (state.closedPRs ?? []).map((pr) => ({
      url: pr.url,
      title: pr.title,
      closedAt: pr.closedAt,
    })),
    // Map ephemeral openPRs (regenerated each daily run) from the last digest
    // so oss-scout's Phase 0 also searches repos with active-but-unmerged PRs.
    openPRs: (state.lastDigest?.openPRs ?? []).map((pr: { url: string; title: string; createdAt: string }) => ({
      url: pr.url,
      title: pr.title,
      openedAt: pr.createdAt,
    })),
    savedResults: [],
    skippedIssues: skippedIssuesLoad.issues,
    lastRunAt: state.lastRunAt,
  };
}

/**
 * Create an OssScout instance backed by the current AgentState.
 * Uses 'provided' persistence so scout reads from oss-autopilot's state.
 *
 * @param diagnostics - Optional collector for degradation signals (#1448),
 *   forwarded to {@link buildScoutState}.
 */
export async function createAutopilotScout(diagnostics?: ScoutBridgeDiagnostics): Promise<OssScout> {
  const token = requireGitHubToken();
  return createScout({
    githubToken: token,
    persistence: 'provided',
    initialState: buildScoutState(diagnostics),
  });
}
