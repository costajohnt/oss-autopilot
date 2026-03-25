/**
 * Tests for IssueVetter orchestration (vetIssue, vetIssuesParallel).
 *
 * Unit tests for the individual check functions (analyzeRequirements,
 * checkNoExistingPR, checkNotClaimed, checkUserMergedPRsInRepo) are in
 * issue-eligibility.test.ts.
 *
 * Tests for project health and contribution guidelines are in
 * repo-health.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IssueVetter } from './issue-vetting.js';
import { isRateLimitError } from './errors.js';
import type { Octokit } from '@octokit/rest';
import type { IssueCandidate, AgentState, RepoScore } from './types.js';

// ── Mock dependencies ──

vi.mock('./pagination.js', () => ({
  paginateAll: vi.fn().mockResolvedValue([]),
}));

vi.mock('./http-cache.js', () => ({
  getHttpCache: vi.fn().mockReturnValue({
    getIfFresh: vi.fn().mockReturnValue(null),
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    hasInflight: vi.fn().mockReturnValue(false),
    getInflight: vi.fn().mockReturnValue(undefined),
    setInflight: vi.fn().mockReturnValue(() => {}),
  }),
  cachedRequest: vi.fn(),
  cachedTimeBased: vi
    .fn()
    .mockImplementation(async (cache: any, _key: string, _maxAgeMs: number, fetcher: () => Promise<unknown>) => {
      const cached = cache.getIfFresh(_key, _maxAgeMs);
      if (cached) return cached;
      const result = await fetcher();
      cache.set(_key, '', result);
      return result;
    }),
}));

vi.mock('./search-budget.js', () => ({
  getSearchBudgetTracker: vi.fn().mockReturnValue({
    waitForBudget: vi.fn().mockResolvedValue(undefined),
    recordCall: vi.fn(),
    canAfford: vi.fn().mockReturnValue(true),
  }),
}));

vi.mock('./logger.js', () => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { paginateAll } from './pagination.js';
import { cachedRequest, getHttpCache } from './http-cache.js';
import { warn } from './logger.js';

// ── Helpers ──

/** Safely cast a nested octokit method to a vi.fn mock. */
function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

// ── Factories ──

function makeOctokit(): Octokit {
  return {
    issues: {
      get: vi.fn(),
      listEventsForTimeline: vi.fn(),
      listComments: vi.fn(),
    },
    search: {
      issuesAndPullRequests: vi.fn(),
    },
    repos: {
      get: vi.fn(),
      listCommits: vi.fn(),
      getContent: vi.fn(),
    },
    actions: {
      listRepoWorkflows: vi.fn(),
    },
    paginate: vi.fn(),
  } as unknown as Octokit;
}

function makeDefaultConfig(): AgentState['config'] {
  return {
    setupComplete: true,
    maxActivePRs: 3,
    dormantThresholdDays: 30,
    approachingDormantDays: 25,
    maxIssueAgeDays: 90,
    languages: ['typescript'],
    labels: ['good first issue'],
    excludeRepos: [],
    trustedProjects: [] as string[],
    githubUsername: 'testuser',
    minRepoScoreThreshold: 4,
    starredRepos: [] as string[],
  } as AgentState['config'];
}

function makeDefaultState(overrides: Partial<AgentState> = {}): Partial<AgentState> {
  return {
    version: 3,
    repoScores: {},
    config: makeDefaultConfig(),
    lastRunAt: '2025-07-01T00:00:00Z',
    activeIssues: [],
    ...overrides,
  };
}

function makeStateManager(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof import('./state.js').getStateManager> {
  return {
    getState: vi.fn().mockReturnValue(makeDefaultState()),
    getRepoScore: vi.fn().mockReturnValue(undefined),
    getStarredRepos: vi.fn().mockReturnValue([]),
    ...overrides,
  } as ReturnType<typeof import('./state.js').getStateManager>;
}

function makeRepoScore(overrides: Partial<RepoScore> = {}): RepoScore {
  return {
    repo: 'owner/repo',
    score: 5,
    mergedPRCount: 0,
    closedWithoutMergeCount: 0,
    avgResponseDays: null,
    lastEvaluatedAt: '2025-06-30T00:00:00Z',
    signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
    ...overrides,
  };
}

/**
 * Mock dispatch for `octokit.search.issuesAndPullRequests` that distinguishes
 * the merged-PR-check query from the existing-PR-check query.
 */
function mockSearchDispatch(existingPRCount: number, mergedPRCount: number) {
  return ({ q }: { q: string }) => {
    if (q.includes('is:merged') && q.includes('author:@me')) {
      return Promise.resolve({ data: { total_count: mergedPRCount } });
    }
    return Promise.resolve({ data: { total_count: existingPRCount, items: Array(existingPRCount).fill({}) } });
  };
}

// Unique repo names to avoid cross-test cache contamination in guidelinesCache
let uniqueId = 0;
function uniqueOwner(prefix = 'test'): string {
  return `${prefix}-${++uniqueId}`;
}

// ── Global setup ──

beforeEach(() => {
  vi.mocked(warn).mockClear();
});

// ── Tests ──

describe('isRateLimitError (shared from errors.ts)', () => {
  it('returns true for 429 status', () => {
    const error = Object.assign(new Error('Too Many Requests'), { status: 429 });
    expect(isRateLimitError(error)).toBe(true);
  });

  it('returns true for 403 with rate limit message', () => {
    const error = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    expect(isRateLimitError(error)).toBe(true);
  });

  it('returns false for 403 without rate limit message', () => {
    const error = Object.assign(new Error('Resource not accessible'), { status: 403 });
    expect(isRateLimitError(error)).toBe(false);
  });

  it('returns false for other HTTP status codes', () => {
    expect(isRateLimitError(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(false);
    expect(isRateLimitError(Object.assign(new Error('Server Error'), { status: 500 }))).toBe(false);
  });

  it('returns false for non-HTTP errors', () => {
    expect(isRateLimitError(new Error('Network error'))).toBe(false);
    expect(isRateLimitError('string error')).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});

describe('vetIssue', () => {
  let vetter: IssueVetter;
  let octokit: ReturnType<typeof makeOctokit>;
  let stateManager: ReturnType<typeof makeStateManager>;
  let owner: string;

  /** Set up all mocks for a "happy path" where the issue passes all checks. */
  function setupHappyPath(): void {
    mockFn(octokit.issues.get).mockResolvedValue({
      data: {
        id: 12345,
        title: 'Fix the bug',
        body: '1. Go to page\n2. Click button\n```\nerror\n```\nExpected: should work. ' + 'A'.repeat(200),
        comments: 0,
        labels: [{ name: 'bug' }, { name: 'good first issue' }],
        created_at: '2025-06-15T00:00:00Z',
        updated_at: '2025-06-30T00:00:00Z',
      },
    });

    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 0, items: [] },
    });

    vi.mocked(paginateAll).mockResolvedValue([]);

    mockFn(octokit.paginate).mockResolvedValue([]);

    vi.mocked(cachedRequest).mockResolvedValue({
      open_issues_count: 50,
      pushed_at: '2025-06-30T00:00:00Z',
      stargazers_count: 1000,
      forks_count: 200,
    });
    mockFn(octokit.repos.listCommits).mockResolvedValue({
      data: [{ commit: { author: { date: '2025-06-30T00:00:00Z' } } }],
    });
    mockFn(octokit.actions.listRepoWorkflows).mockResolvedValue({
      data: { total_count: 1, workflows: [] },
    });

    mockFn(octokit.repos.getContent).mockRejectedValue(new Error('404 Not Found'));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-07-01T12:00:00Z'));

    octokit = makeOctokit();
    stateManager = makeStateManager();
    vetter = new IssueVetter(octokit, stateManager);
    owner = uniqueOwner('vet');
    setupHappyPath();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws ValidationError for invalid URL', async () => {
    await expect(vetter.vetIssue('not-a-url')).rejects.toThrow('Invalid issue URL');
  });

  it('throws ValidationError for PR URL', async () => {
    await expect(vetter.vetIssue('https://github.com/owner/repo/pull/1')).rejects.toThrow('Invalid issue URL');
  });

  it('propagates error when issue fetch fails', async () => {
    mockFn(octokit.issues.get).mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

    await expect(vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`)).rejects.toThrow('Not Found');
  });

  it('returns cached result on vetting cache hit without API calls', async () => {
    const cachedCandidate = {
      issue: { url: `https://github.com/${owner}/repo/issues/42`, repo: `${owner}/repo` },
      viabilityScore: 80,
      recommendation: 'approve',
      searchPriority: 'normal',
      vettingResult: { passedAllChecks: true, checks: {}, notes: [] },
      projectHealth: { stargazersCount: 100, checkFailed: false },
      reasonsToApprove: [],
      reasonsToSkip: [],
    };

    // Set up cache to return a hit
    const cache = vi.mocked(getHttpCache)();
    vi.mocked(cache.getIfFresh).mockReturnValueOnce(cachedCandidate);

    const result = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);

    expect(result).toEqual(cachedCandidate);
    // Should NOT have called any API methods since cache hit
    expect(octokit.issues.get).not.toHaveBeenCalled();
  });

  it('populates vetting cache after successful vet', async () => {
    const cache = vi.mocked(getHttpCache)();
    vi.mocked(cache.set).mockClear();

    await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);

    // Cache should have been written with the vet: prefix
    expect(cache.set).toHaveBeenCalledWith(
      `vet:https://github.com/${owner}/repo/issues/42`,
      '',
      expect.objectContaining({ viabilityScore: expect.any(Number) }),
    );
  });

  it('returns approved candidate when all checks pass', async () => {
    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);

    expect(candidate.recommendation).toBe('approve');
    expect(candidate.vettingResult.passedAllChecks).toBe(true);
    expect(candidate.issue.repo).toBe(`${owner}/repo`);
    expect(candidate.issue.number).toBe(42);
    expect(candidate.issue.title).toBe('Fix the bug');
    expect(candidate.issue.vetted).toBe(true);
    expect(candidate.viabilityScore).toBeGreaterThan(0);
    expect(candidate.searchPriority).toBe('normal');
  });

  it('detects existing PRs via timeline', async () => {
    // Mock timeline to return a cross-referenced PR event (checkNoExistingPR uses timeline, not Search API)
    vi.mocked(paginateAll).mockResolvedValue([
      { event: 'cross-referenced', source: { issue: { pull_request: { url: 'https://...' } } } },
    ]);

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.vettingResult.checks.noExistingPR).toBe(false);
    expect(candidate.reasonsToSkip).toContain('Has existing PR');
  });

  it('downgrades to needs_review when health check is inconclusive', async () => {
    vi.mocked(cachedRequest).mockRejectedValue(new Error('Timeout'));

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.recommendation).toBe('needs_review');
    expect(candidate.vettingResult.notes).toContainEqual(expect.stringContaining('downgraded'));
  });

  it('downgrades to needs_review when existing-PR check is inconclusive', async () => {
    // Mock timeline to fail (checkNoExistingPR uses timeline, not Search API)
    vi.mocked(paginateAll).mockRejectedValue(new Error('API error'));

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.recommendation).toBe('needs_review');
    expect(candidate.vettingResult.notes).toContainEqual(expect.stringContaining('downgraded'));
  });

  it('recommends skip when more than 2 skip reasons', async () => {
    // Mock timeline to return a cross-referenced PR event (existing PR detected via timeline)
    vi.mocked(paginateAll).mockResolvedValue([
      { event: 'cross-referenced', source: { issue: { pull_request: { url: 'https://...' } } } },
    ]);

    mockFn(octokit.issues.get).mockResolvedValue({
      data: {
        id: 12345,
        title: 'Bug fix',
        body: 'Short', // unclear requirements
        comments: 1,
        labels: [],
        created_at: '2025-06-15T00:00:00Z',
        updated_at: '2025-06-30T00:00:00Z',
      },
    });
    mockFn(octokit.paginate).mockResolvedValue([{ body: "I'm working on this" }]);

    vi.mocked(cachedRequest).mockResolvedValue({
      open_issues_count: 0,
      pushed_at: '2024-01-01T00:00:00Z',
      stargazers_count: 10,
      forks_count: 1,
    });
    mockFn(octokit.repos.listCommits).mockResolvedValue({
      data: [{ commit: { author: { date: '2024-01-01T00:00:00Z' } } }],
    });

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.recommendation).toBe('skip');
    expect(candidate.reasonsToSkip).toEqual(
      expect.arrayContaining(['Has existing PR', 'Already claimed', 'Inactive project', 'Unclear requirements']),
    );
  });

  it('gives trusted project credit for repos with merged PRs in state', async () => {
    stateManager.getRepoScore.mockReturnValue(makeRepoScore({ repo: `${owner}/repo`, score: 8, mergedPRCount: 2 }));

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.reasonsToApprove).toContainEqual(expect.stringContaining('2 PRs merged'));
    expect(candidate.searchPriority).toBe('merged_pr');
  });

  it('falls back to API merged count when state has no merges', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockImplementation(mockSearchDispatch(0, 5));

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.reasonsToApprove).toContainEqual(expect.stringContaining('5 PRs merged'));
  });

  it('uses starred priority for starred repos', async () => {
    stateManager.getStarredRepos.mockReturnValue([`${owner}/repo`]);

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.searchPriority).toBe('starred');
  });

  it('assigns preferred_org priority when org matches preferredOrgs', async () => {
    stateManager.getState.mockReturnValue(
      makeDefaultState({
        config: { ...makeDefaultConfig(), preferredOrgs: [owner.toLowerCase()] },
      }),
    );

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.searchPriority).toBe('preferred_org');
  });

  it('preferred_org does not override merged_pr priority', async () => {
    stateManager.getState.mockReturnValue(
      makeDefaultState({
        config: { ...makeDefaultConfig(), preferredOrgs: [owner.toLowerCase()] },
      }),
    );
    stateManager.getRepoScore.mockReturnValue(makeRepoScore({ repo: `${owner}/repo`, score: 8, mergedPRCount: 2 }));

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.searchPriority).toBe('merged_pr');
  });

  it('adds category match to reasonsToApprove when repo matches projectCategories', async () => {
    // Use an org from the devtools category (eslint)
    stateManager.getState.mockReturnValue(
      makeDefaultState({
        config: { ...makeDefaultConfig(), projectCategories: ['devtools'] },
      }),
    );

    const candidate = await vetter.vetIssue(`https://github.com/eslint/repo/issues/42`);
    expect(candidate.reasonsToApprove).toContainEqual('Matches preferred project category');
  });

  it('detects org affinity from other repos', async () => {
    stateManager.getState.mockReturnValue(
      makeDefaultState({
        repoScores: {
          [`${owner}/other-repo`]: {
            repo: `${owner}/other-repo`,
            mergedPRCount: 3,
            closedWithoutMergeCount: 0,
          },
        },
      }),
    );

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.reasonsToApprove).toContainEqual(expect.stringContaining('Org affinity'));
  });

  it('adds closed-without-merge skip reason when no merges exist', async () => {
    stateManager.getRepoScore.mockReturnValue(
      makeRepoScore({ repo: `${owner}/repo`, score: 3, closedWithoutMergeCount: 2 }),
    );

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.reasonsToSkip).toContainEqual(expect.stringContaining('rejected PR'));
  });

  it('adds mixed-history note when both merges and closures exist', async () => {
    stateManager.getRepoScore.mockReturnValue(
      makeRepoScore({ repo: `${owner}/repo`, score: 6, mergedPRCount: 2, closedWithoutMergeCount: 1 }),
    );

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.vettingResult.notes).toContainEqual(expect.stringContaining('Mixed history'));
  });

  it('gives trustedProjects config credit when no merged PR count', async () => {
    stateManager.getState.mockReturnValue(
      makeDefaultState({
        config: { ...makeDefaultConfig(), trustedProjects: [`${owner}/repo`] },
      }),
    );

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.reasonsToApprove).toContain('Trusted project (previous PR merged)');
  });

  it('builds TrackedIssue with correct fields', async () => {
    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    const issue = candidate.issue;

    expect(issue.id).toBe(12345);
    expect(issue.url).toBe(`https://github.com/${owner}/repo/issues/42`);
    expect(issue.repo).toBe(`${owner}/repo`);
    expect(issue.number).toBe(42);
    expect(issue.status).toBe('candidate');
    expect(issue.labels).toEqual(['bug', 'good first issue']);
    expect(issue.createdAt).toBe('2025-06-15T00:00:00Z');
    expect(issue.updatedAt).toBe('2025-06-30T00:00:00Z');
    expect(issue.vetted).toBe(true);
  });

  it('includes contribution guidelines in vetting result when found', async () => {
    mockFn(octokit.repos.getContent).mockResolvedValue({
      data: { content: Buffer.from('We use conventional commit messages.').toString('base64') },
    });

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.vettingResult.checks.contributionGuidelinesFound).toBe(true);
    expect(candidate.vettingResult.contributionGuidelines).toBeDefined();
    expect(candidate.reasonsToApprove).toContain('Has contribution guidelines');
  });

  it('adds "No CONTRIBUTING.md found" note when missing', async () => {
    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.vettingResult.notes).toContain('No CONTRIBUTING.md found');
  });
});

describe('vetIssuesParallel', () => {
  let vetter: IssueVetter;
  let vetIssueSpy: ReturnType<typeof vi.spyOn>;

  function makeCandidate(url: string): IssueCandidate {
    return {
      issue: {
        id: 1,
        url,
        repo: 'owner/repo',
        number: 1,
        title: 'Test',
        status: 'candidate',
        labels: [],
        createdAt: '',
        updatedAt: '',
        vetted: true,
      },
      vettingResult: {
        passedAllChecks: true,
        checks: {
          noExistingPR: true,
          notClaimed: true,
          projectActive: true,
          clearRequirements: true,
          contributionGuidelinesFound: false,
        },
        notes: [],
      },
      projectHealth: {
        repo: 'owner/repo',
        lastCommitAt: '',
        daysSinceLastCommit: 0,
        openIssuesCount: 0,
        avgIssueResponseDays: 0,
        ciStatus: 'unknown',
        isActive: true,
        stargazersCount: 0,
        forksCount: 0,
      },
      recommendation: 'approve',
      reasonsToSkip: [],
      reasonsToApprove: [],
      viabilityScore: 80,
      searchPriority: 'normal',
    };
  }

  beforeEach(() => {
    vetter = new IssueVetter(makeOctokit(), makeStateManager());
    vetIssueSpy = vi.spyOn(vetter, 'vetIssue');
  });

  it('vets multiple URLs and returns candidates', async () => {
    vetIssueSpy.mockImplementation((url) => Promise.resolve(makeCandidate(url)));

    const result = await vetter.vetIssuesParallel(['url1', 'url2', 'url3'], 10);
    expect(result.candidates).toHaveLength(3);
    expect(result.allFailed).toBe(false);
    expect(result.rateLimitHit).toBe(false);
    expect(result.candidates[0].viabilityScore).toBe(80);
  });

  it('respects maxResults limit', async () => {
    vetIssueSpy.mockImplementation((url) => Promise.resolve(makeCandidate(url)));

    const result = await vetter.vetIssuesParallel(['u1', 'u2', 'u3', 'u4', 'u5'], 2);
    expect(result.candidates).toHaveLength(2);
  });

  it('sets allFailed when all vettings fail and logs systemic warning', async () => {
    vetIssueSpy.mockRejectedValue(new Error('API error'));

    const result = await vetter.vetIssuesParallel(['url1', 'url2'], 10);
    expect(result.allFailed).toBe(true);
    expect(result.candidates).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('issue-vetting', expect.stringContaining('All 2 issue(s) failed vetting'));
  });

  it('detects rate limit failures', async () => {
    vetIssueSpy.mockRejectedValue(Object.assign(new Error('rate limit exceeded'), { status: 429 }));

    const result = await vetter.vetIssuesParallel(['url1'], 10);
    expect(result.rateLimitHit).toBe(true);
  });

  it('overrides searchPriority when provided', async () => {
    vetIssueSpy.mockImplementation((url) => Promise.resolve(makeCandidate(url)));

    const result = await vetter.vetIssuesParallel(['url1'], 10, 'starred');
    expect(result.candidates[0].searchPriority).toBe('starred');
  });

  it('handles empty URL list', async () => {
    const result = await vetter.vetIssuesParallel([], 10);
    expect(result.candidates).toHaveLength(0);
    expect(result.allFailed).toBe(false);
  });

  it('continues processing after individual failures and logs per-issue warning', async () => {
    vetIssueSpy
      .mockRejectedValueOnce(new Error('fail'))
      .mockImplementation((url) => Promise.resolve(makeCandidate(url)));

    const result = await vetter.vetIssuesParallel(['fail-url', 'ok-url'], 10);
    expect(result.candidates).toHaveLength(1);
    expect(result.allFailed).toBe(false);
    expect(warn).toHaveBeenCalledWith('issue-vetting', expect.stringContaining('fail-url'), expect.anything());
  });
});
