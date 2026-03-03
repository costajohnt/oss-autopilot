import type { FetchedPR, MergedPR, ClosedPR, ShelvedPRRef, CommentedIssueWithResponse, DashboardData } from './types';

export function makePR(overrides: Partial<FetchedPR> = {}): FetchedPR {
  return {
    id: 1,
    url: 'https://github.com/owner/repo/pull/1',
    repo: 'owner/repo',
    number: 1,
    title: 'Test PR',
    status: 'healthy',
    displayLabel: '[Healthy]',
    displayDescription: 'Everything looks good',
    createdAt: '2025-06-01T00:00:00Z',
    updatedAt: '2025-06-10T00:00:00Z',
    daysSinceActivity: 5,
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

export function makeMergedPR(overrides: Partial<MergedPR> = {}): MergedPR {
  return {
    url: 'https://github.com/owner/repo/pull/10',
    repo: 'owner/repo',
    number: 10,
    title: 'Merged PR',
    mergedAt: '2025-06-09T00:00:00Z',
    ...overrides,
  };
}

export function makeClosedPR(overrides: Partial<ClosedPR> = {}): ClosedPR {
  return {
    url: 'https://github.com/owner/repo/pull/11',
    repo: 'owner/repo',
    number: 11,
    title: 'Closed PR',
    closedAt: '2025-06-08T00:00:00Z',
    ...overrides,
  };
}

export function makeShelvedRef(overrides: Partial<ShelvedPRRef> = {}): ShelvedPRRef {
  return {
    number: 20,
    url: 'https://github.com/owner/repo/pull/20',
    title: 'Shelved PR',
    repo: 'owner/repo',
    daysSinceActivity: 30,
    status: 'dormant',
    ...overrides,
  };
}

export function makeIssueResponse(overrides: Partial<CommentedIssueWithResponse> = {}): CommentedIssueWithResponse {
  return {
    repo: 'owner/repo',
    number: 100,
    title: 'Test Issue',
    url: 'https://github.com/owner/repo/issues/100',
    userLastCommentedAt: '2025-06-01T00:00:00Z',
    labels: ['bug'],
    daysSinceUserComment: 3,
    status: 'new_response',
    lastResponseAuthor: 'maintainer',
    lastResponseBody: 'Thanks for the report!',
    lastResponseAt: '2025-06-04T00:00:00Z',
    isFromMaintainer: true,
    ...overrides,
  };
}

export function makeDashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    stats: { activePRs: 2, shelvedPRs: 0, mergedPRs: 5, closedPRs: 1, mergeRate: '83.3%' },
    prsByRepo: {},
    topRepos: [],
    monthlyMerged: {},
    monthlyOpened: {},
    monthlyClosed: {},
    activePRs: [],
    shelvedPRUrls: [],
    dismissedUrls: [],
    recentlyMergedPRs: [],
    recentlyClosedPRs: [],
    autoUnshelvedPRs: [],
    commentedIssues: [],
    issueResponses: [],
    ...overrides,
  };
}
