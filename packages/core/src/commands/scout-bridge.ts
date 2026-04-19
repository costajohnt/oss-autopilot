/**
 * Bridge between oss-autopilot's AgentState and oss-scout's OssScout API.
 * Maps state fields and creates scout instances for search/vet commands.
 */

import { createScout, type OssScout, type ScoutState } from '@oss-scout/core';
import { getStateManager, requireGitHubToken } from '../core/index.js';
import { loadSkippedIssues } from './skip-file-parser.js';

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
