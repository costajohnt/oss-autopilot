/**
 * Shared test factories for oss-autopilot.
 *
 * Centralises mock object construction so that when types gain new required
 * fields we only update one place. Every factory accepts a `Partial<T>`
 * override bag — callers only specify the fields relevant to their test.
 */

import type { FetchedPR, DailyDigest } from './types.js';
import type { CapacityAssessment } from '../formatters/json.js';

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
    status: 'healthy',
    displayLabel: '[Healthy]',
    displayDescription: 'Everything looks good',
    createdAt: '2025-06-01T00:00:00Z',
    updatedAt: '2025-06-15T00:00:00Z',
    daysSinceActivity: 2,
    ciStatus: 'passing',
    failingCheckNames: [],
    classifiedChecks: [],
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
    prsNeedingResponse: [],
    ciFailingPRs: [],
    ciBlockedPRs: [],
    ciNotRunningPRs: [],
    mergeConflictPRs: [],
    needsRebasePRs: [],
    missingRequiredFilesPRs: [],
    incompleteChecklistPRs: [],
    needsChangesPRs: [],
    changesAddressedPRs: [],
    waitingOnMaintainerPRs: [],
    approachingDormant: [],
    dormantPRs: [],
    healthyPRs: [],
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
