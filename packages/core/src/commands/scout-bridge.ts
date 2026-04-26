/**
 * Bridge between oss-autopilot's AgentState and oss-scout's OssScout API.
 * Maps state fields and creates scout instances for search/vet commands.
 */

import { createScout, type LinkedPR as ScoutLinkedPR, type OssScout, type ScoutState } from '@oss-scout/core';
import { getStateManager, requireGitHubToken } from '../core/index.js';
import type { LinkedPR } from '../core/linked-pr-classification.js';
import { loadSkippedIssues } from './skip-file-parser.js';

/**
 * Convert scout 0.6.0's `LinkedPR` (separate `state` + `merged`) into the
 * shape `classifyLinkedPR` expects (`state` already folded with `merged`).
 *
 * Scout exposes the raw GitHub fields verbatim, but the classifier was
 * written before scout surfaced this data and uses a tri-state
 * `'open' | 'closed' | 'merged'` enum. Folding `merged` into the state
 * preserves the function's existing contract + tests.
 */
export function adaptScoutLinkedPR(scoutLinkedPR: ScoutLinkedPR | null | undefined): LinkedPR | null {
  if (!scoutLinkedPR) return null;
  return {
    author: { login: scoutLinkedPR.author },
    state: scoutLinkedPR.merged ? 'merged' : scoutLinkedPR.state,
  };
}

/**
 * Build a ScoutState from the current AgentState.
 * Maps oss-autopilot's config and state fields to oss-scout's state format.
 */
export function buildScoutState(): ScoutState {
  const state = getStateManager().getState();
  const { config } = state;

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
      interPhaseDelayMs: 30000,
      broadPhaseDelayMs: 90000,
      skipBroadWhenSufficientResults: 15,
      persistence: config.persistence as 'local' | 'gist',
    },
    repoScores: state.repoScores,
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
    skippedIssues: loadSkippedIssues(config.skippedIssuesPath),
    lastRunAt: state.lastRunAt,
  };
}

/**
 * Create an OssScout instance backed by the current AgentState.
 * Uses 'provided' persistence so scout reads from oss-autopilot's state.
 */
export async function createAutopilotScout(): Promise<OssScout> {
  const token = requireGitHubToken();
  return createScout({
    githubToken: token,
    persistence: 'provided',
    initialState: buildScoutState(),
  });
}
