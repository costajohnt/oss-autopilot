/**
 * Shared test factories for oss-autopilot.
 *
 * Centralises mock object construction so that when types gain new required
 * fields we only update one place. Every factory accepts an override bag —
 * callers only specify the fields relevant to their test.
 */

import type { z } from 'zod';
import type {
  FetchedPR,
  DailyDigest,
  AgentState,
  AgentConfig,
  IssueCandidate,
  TrackedIssue,
  IssueVettingResult,
  ProjectHealth,
  RepoScore,
  CapacityAssessment,
} from './types.js';
import { DEFAULT_CONFIG, INITIAL_STATE } from './types.js';
import type { StateManager, Stats } from './state.js';
// ---------------------------------------------------------------------------
// FetchedPR
// ---------------------------------------------------------------------------

export function makeFetchedPR(overrides: Partial<FetchedPR> = {}): FetchedPR {
  const repo = overrides.repo ?? 'owner/repo';
  const number = overrides.number ?? 1;
  return {
    id: 1,
    url: `https://github.com/${repo}/pull/${number}`,
    repo,
    number,
    title: 'Test PR',
    status: 'waiting_on_maintainer',
    waitReason: 'pending_review',
    stalenessTier: 'active',
    displayLabel: '[Waiting on Maintainer]',
    displayDescription: 'Awaiting review',
    createdAt: '2025-06-01T00:00:00Z',
    updatedAt: '2025-06-15T00:00:00Z',
    daysSinceActivity: 2,
    ciStatus: 'passing',
    failingCheckNames: [],
    classifiedChecks: [],
    ciCategorization: { category: 'all_passing', summary: 'All checks passing', action: 'none' },
    hasMergeConflict: false,
    reviewDecision: 'approved',
    hasUnrespondedComment: false,
    hasIncompleteChecklist: false,
    maintainerActionHints: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DailyDigest
// ---------------------------------------------------------------------------

export function makeDailyDigest(overrides: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: '2025-06-20T00:00:00Z',
    openPRs: [],
    needsAddressingPRs: [],
    waitingOnMaintainerPRs: [],
    recentlyClosedPRs: [],
    recentlyMergedPRs: [],
    shelvedPRs: [],
    autoUnshelvedPRs: [],
    summary: {
      totalActivePRs: 0,
      totalNeedingAttention: 0,
      totalMergedAllTime: 0,
      mergeRate: 0,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CapacityAssessment
// ---------------------------------------------------------------------------

export function makeCapacityAssessment(overrides: Partial<CapacityAssessment> = {}): CapacityAssessment {
  return {
    hasCapacity: true,
    activePRCount: 3,
    maxActivePRs: 10,
    shelvedPRCount: 0,
    criticalIssueCount: 0,
    reason: 'You have capacity',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RepoScore
// ---------------------------------------------------------------------------

export function makeRepoScore(
  overrides: Partial<Omit<RepoScore, 'signals'>> & { signals?: Partial<RepoScore['signals']> } = {},
): RepoScore {
  const { signals: signalOverrides, ...rest } = overrides;
  return {
    repo: 'owner/repo',
    score: 5,
    mergedPRCount: 0,
    closedWithoutMergeCount: 0,
    avgResponseDays: null,
    lastEvaluatedAt: new Date().toISOString(),
    signals: {
      hasActiveMaintainers: true,
      isResponsive: false,
      hasHostileComments: false,
      ...signalOverrides,
    },
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// AgentState
// ---------------------------------------------------------------------------

export function makeAgentState(
  overrides: Omit<Partial<AgentState>, 'config'> & { config?: Partial<AgentConfig> } = {},
): AgentState {
  const { config: configOverrides, ...rest } = overrides;
  const config: AgentConfig = { ...DEFAULT_CONFIG, githubUsername: 'testuser', ...configOverrides };
  return {
    ...INITIAL_STATE,
    lastRunAt: '2025-01-01T00:00:00Z',
    ...rest,
    config,
  };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    mergedPRs: 0,
    closedPRs: 0,
    activeIssues: 0,
    trustedProjects: 0,
    mergeRate: '0.0',
    totalTracked: 0,
    needsResponse: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// StateManager mock
// ---------------------------------------------------------------------------

/**
 * Build a type-safe StateManager mock for use with vi.mocked(getStateManager).
 * Only override the methods your test needs; defaults provide sensible no-op behaviour.
 *
 * `config` is a shorthand for `state.config` -- most callers only need to
 * override a few config fields without touching other AgentState fields.
 *
 * Note: the `as unknown` cast means new StateManager methods won't cause a
 * compile error here. If tests fail with "X is not a function", add the
 * missing method stub to this mock.
 */
export function makeStateManagerMock(
  overrides: {
    state?: Omit<Partial<AgentState>, 'config'>;
    stats?: Partial<Stats>;
    config?: Partial<AgentConfig>;
  } = {},
) {
  const state = makeAgentState({ ...overrides.state, config: overrides.config });
  const stats = makeStats(overrides.stats);

  // Return an object matching the StateManager public interface.
  // No-op stubs for write methods; real values for read methods.
  return {
    getState: () => state as Readonly<AgentState>,
    getStats: () => stats,
    isSetupComplete: () => state.config.setupComplete,
    save: () => {},
    batch: (fn: () => void) => fn(),
    markSetupComplete: () => {},
    initializeWithDefaults: () => {},
    reloadIfChanged: () => false,
    setLastDigest: () => {},
    setMonthlyMergedCounts: () => {},
    setMonthlyClosedCounts: () => {},
    setMonthlyOpenedCounts: () => {},
    setLocalRepoCache: () => {},
    getMergedPRs: () => [],
    addMergedPRs: () => {},
    getMergedPRWatermark: () => undefined,
    getClosedPRs: () => [],
    addClosedPRs: () => {},
    getClosedPRWatermark: () => undefined,
    updateConfig: () => {},
    addIssue: () => {},
    addTrustedProject: () => {},
    cleanupExcludedData: () => {},
    getStarredRepos: () => [],
    setStarredRepos: () => {},
    isStarredReposStale: () => false,
    shelvePR: () => false,
    unshelvePR: () => false,
    isPRShelved: () => false,
    dismissIssue: () => false,
    undismissIssue: () => false,
    getIssueDismissedAt: () => undefined,
    setStatusOverride: () => {},
    clearStatusOverride: () => false,
    getStatusOverride: () => undefined,
    getSearchSeen: () => state.searchSeen ?? [],
    setSearchSeen: (seen: AgentState['searchSeen']) => {
      state.searchSeen = seen;
    },
    getLastOvernight: () => state.lastOvernight,
    setLastOvernight: (record: NonNullable<AgentState['lastOvernight']>) => {
      state.lastOvernight = record;
    },
    getSearchRotation: () => state.searchRotation,
    setSearchRotation: (rotation: NonNullable<AgentState['searchRotation']>) => {
      state.searchRotation = rotation;
    },
    getRepoScore: () => undefined,
    updateRepoScore: () => {},
    incrementMergedCount: () => {},
    incrementClosedCount: () => {},
    markRepoHostile: () => {},
    getReposWithMergedPRs: () => [],
    getReposWithOpenPRs: () => [],
    getHighScoringRepos: () => [],
    getLowScoringRepos: () => [],
  } as unknown as StateManager;
}

// ---------------------------------------------------------------------------
// IssueCandidate
// ---------------------------------------------------------------------------

export function makeIssueCandidate(overrides: Partial<IssueCandidate> = {}): IssueCandidate {
  const issue: TrackedIssue = {
    id: 1,
    url: 'https://github.com/owner/repo/issues/1',
    repo: 'owner/repo',
    number: 1,
    title: 'Test Issue',
    status: 'candidate',
    labels: ['good first issue'],
    createdAt: '2025-06-01T00:00:00Z',
    updatedAt: '2025-06-15T00:00:00Z',
    vetted: true,
    ...overrides.issue,
  };

  const vettingResult: IssueVettingResult = {
    passedAllChecks: true,
    checks: {
      noExistingPR: true,
      notClaimed: true,
      projectActive: true,
      clearRequirements: true,
      contributionGuidelinesFound: true,
    },
    notes: [],
    ...overrides.vettingResult,
  };

  const projectHealth: ProjectHealth = {
    repo: 'owner/repo',
    lastCommitAt: '2025-06-14T00:00:00Z',
    daysSinceLastCommit: 1,
    openIssuesCount: 50,
    avgIssueResponseDays: 2,
    ciStatus: 'passing',
    isActive: true,
    ...overrides.projectHealth,
  };

  return {
    issue,
    vettingResult,
    projectHealth,
    recommendation: 'approve',
    reasonsToSkip: [],
    reasonsToApprove: ['Active project', 'Good first issue'],
    viabilityScore: 80,
    searchPriority: 'normal',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema validation (contract tests)
// ---------------------------------------------------------------------------

/**
 * Returns the Zod issues from validating `value` against `schema` — empty
 * when it parses. Contract tests assert this equals `[]` so a golden that
 * drifts from its exported output schema fails loudly with the exact paths,
 * instead of passing on golden equality alone (#1418).
 */
export function schemaIssues(schema: z.ZodTypeAny, value: unknown): z.ZodIssue[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues;
}
