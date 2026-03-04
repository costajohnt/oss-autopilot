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

vi.mock('./logger.js', () => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { paginateAll } from './pagination.js';
import { cachedRequest } from './http-cache.js';
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
    version: 2,
    repoScores: {},
    config: makeDefaultConfig(),
    events: [],
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

describe('analyzeRequirements', () => {
  let vetter: IssueVetter;

  beforeEach(() => {
    vetter = new IssueVetter(makeOctokit(), makeStateManager());
  });

  it('returns false for empty body', () => {
    expect(vetter.analyzeRequirements('')).toBe(false);
  });

  it('returns false for body shorter than 50 characters', () => {
    expect(vetter.analyzeRequirements('Fix the bug in the login page.')).toBe(false);
  });

  it('returns false with only one clarity indicator', () => {
    const body = '1. First step to reproduce the problem right here.\nSomething happens that is quite broken here.';
    expect(vetter.analyzeRequirements(body)).toBe(false);
  });

  it('returns true with numbered steps + expected behavior', () => {
    const body =
      '1. Go to the settings page and click the button.\n2. Enter a value and submit the form.\nThe app should display a success message after submission.';
    expect(vetter.analyzeRequirements(body)).toBe(true);
  });

  it('returns true with code block + length > 200', () => {
    const body = '```\nconst x = 1;\nconsole.log(x);\n```\n' + 'A'.repeat(200);
    expect(vetter.analyzeRequirements(body)).toBe(true);
  });

  it('returns true with bullet steps + code block', () => {
    const body =
      '- Run the following command:\n```\nnpm install\n```\nThen check output for errors in the console output area.';
    expect(vetter.analyzeRequirements(body)).toBe(true);
  });

  it('returns true with all four indicators', () => {
    const body = '1. Step one\n```\ncode\n```\nExpected: should work. ' + 'A'.repeat(200);
    expect(vetter.analyzeRequirements(body)).toBe(true);
  });

  it('detects asterisk bullet lists', () => {
    const body =
      '* First item in the list here\n* Second item in the list here\nIt should display correctly when rendered.';
    expect(vetter.analyzeRequirements(body)).toBe(true);
  });
});

describe('parseContributionGuidelines', () => {
  let vetter: IssueVetter;

  beforeEach(() => {
    vetter = new IssueVetter(makeOctokit(), makeStateManager());
  });

  it('always returns rawContent', () => {
    const result = vetter.parseContributionGuidelines('Hello world');
    expect(result.rawContent).toBe('Hello world');
  });

  it('detects conventional commits', () => {
    const result = vetter.parseContributionGuidelines('We use conventional commit messages for all PRs.');
    expect(result.commitMessageFormat).toBe('conventional commits');
  });

  it('extracts commit message format from backtick-quoted text', () => {
    const result = vetter.parseContributionGuidelines('Use this commit message format: `fix: description`');
    expect(result.commitMessageFormat).toBe('fix: description');
  });

  it('detects branch naming convention from backtick-quoted text', () => {
    const result = vetter.parseContributionGuidelines('Branch naming convention: `feature/description`');
    expect(result.branchNamingConvention).toBe('feature/description');
  });

  it('detects test frameworks', () => {
    expect(vetter.parseContributionGuidelines('Run jest to test.').testFramework).toBe('Jest');
    expect(vetter.parseContributionGuidelines('We use rspec for testing.').testFramework).toBe('RSpec');
    expect(vetter.parseContributionGuidelines('Run pytest -v to verify.').testFramework).toBe('pytest');
    expect(vetter.parseContributionGuidelines('Run mocha for unit tests.').testFramework).toBe('Mocha');
  });

  it('detects linters', () => {
    expect(vetter.parseContributionGuidelines('Run eslint before submitting.').linter).toBe('ESLint');
    expect(vetter.parseContributionGuidelines('Follow rubocop rules.').linter).toBe('RuboCop');
  });

  it('detects Prettier formatter', () => {
    expect(vetter.parseContributionGuidelines('Format with prettier.').formatter).toBe('Prettier');
  });

  it('detects CLA requirement', () => {
    expect(vetter.parseContributionGuidelines('Please sign the CLA first.').claRequired).toBe(true);
    expect(vetter.parseContributionGuidelines('Contributor License Agreement required.').claRequired).toBe(true);
  });

  it('returns no optional fields for generic content', () => {
    const result = vetter.parseContributionGuidelines('Thank you for contributing!');
    expect(result.testFramework).toBeUndefined();
    expect(result.linter).toBeUndefined();
    expect(result.formatter).toBeUndefined();
    expect(result.claRequired).toBeUndefined();
    expect(result.branchNamingConvention).toBeUndefined();
    expect(result.commitMessageFormat).toBeUndefined();
  });
});

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

describe('checkNoExistingPR', () => {
  let vetter: IssueVetter;
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    octokit = makeOctokit();
    vetter = new IssueVetter(octokit, makeStateManager());
    vi.mocked(paginateAll).mockResolvedValue([]);
  });

  it('returns passed when no PRs found', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 0, items: [] },
    });

    const result = await vetter.checkNoExistingPR('owner', 'repo', 1);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBeUndefined();
  });

  it('returns not passed when search finds PRs', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 1, items: [{}] },
    });

    const result = await vetter.checkNoExistingPR('owner', 'repo', 1);
    expect(result.passed).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  it('returns not passed when timeline has linked PRs', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 0, items: [] },
    });
    vi.mocked(paginateAll).mockResolvedValue([{ event: 'cross-referenced', source: { issue: { pull_request: {} } } }]);

    const result = await vetter.checkNoExistingPR('owner', 'repo', 1);
    expect(result.passed).toBe(false);
  });

  it('ignores non-PR cross-references', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 0, items: [] },
    });
    vi.mocked(paginateAll).mockResolvedValue([
      { event: 'cross-referenced', source: { issue: {} } }, // no pull_request
      { event: 'labeled' }, // different event type
    ]);

    const result = await vetter.checkNoExistingPR('owner', 'repo', 1);
    expect(result.passed).toBe(true);
  });

  it('returns passed + inconclusive on API error and logs warning', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockRejectedValue(new Error('Network error'));

    const result = await vetter.checkNoExistingPR('owner', 'repo', 1);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.reason).toBe('Network error');
    expect(warn).toHaveBeenCalledWith('issue-vetting', expect.stringContaining('owner/repo#1'));
  });
});

describe('checkNotClaimed', () => {
  let vetter: IssueVetter;
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    octokit = makeOctokit();
    vetter = new IssueVetter(octokit, makeStateManager());
  });

  it('returns passed immediately when commentCount is 0', async () => {
    const result = await vetter.checkNotClaimed('owner', 'repo', 1, 0);
    expect(result.passed).toBe(true);
    expect(octokit.paginate).not.toHaveBeenCalled();
  });

  it('returns passed when no claim phrases found', async () => {
    mockFn(octokit.paginate).mockResolvedValue([
      { body: 'This is a great issue!' },
      { body: 'I agree, we should fix this.' },
    ]);

    const result = await vetter.checkNotClaimed('owner', 'repo', 1, 2);
    expect(result.passed).toBe(true);
  });

  it('returns not passed when claim phrase found', async () => {
    mockFn(octokit.paginate).mockResolvedValue([{ body: "I'm working on this already." }]);

    const result = await vetter.checkNotClaimed('owner', 'repo', 1, 1);
    expect(result.passed).toBe(false);
  });

  it.each([
    "i'll take this",
    'working on it',
    "i'd like to work on this",
    'assigned to me',
    "i'm on it",
    'working on a pr',
    "i'll submit a pr",
    'working on a fix',
  ])('detects claim phrase: "%s"', async (phrase) => {
    mockFn(octokit.paginate).mockResolvedValue([{ body: phrase }]);
    const result = await vetter.checkNotClaimed('owner', 'repo', 1, 1);
    expect(result.passed).toBe(false);
  });

  it('is case-insensitive', async () => {
    mockFn(octokit.paginate).mockResolvedValue([{ body: "I'M WORKING ON THIS" }]);

    const result = await vetter.checkNotClaimed('owner', 'repo', 1, 1);
    expect(result.passed).toBe(false);
  });

  it('handles comments with null body', async () => {
    mockFn(octokit.paginate).mockResolvedValue([{ body: null }, { body: '' }]);

    const result = await vetter.checkNotClaimed('owner', 'repo', 1, 2);
    expect(result.passed).toBe(true);
  });

  it('returns passed + inconclusive on API error and logs warning', async () => {
    mockFn(octokit.paginate).mockRejectedValue(new Error('API down'));

    const result = await vetter.checkNotClaimed('owner', 'repo', 1, 5);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.reason).toBe('API down');
    expect(warn).toHaveBeenCalledWith('issue-vetting', expect.stringContaining('owner/repo#1'));
  });
});

describe('checkProjectHealth', () => {
  let vetter: IssueVetter;
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-07-01T12:00:00Z'));

    octokit = makeOctokit();
    vetter = new IssueVetter(octokit, makeStateManager());

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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns active health for recently committed repo', async () => {
    const health = await vetter.checkProjectHealth('owner', 'repo');

    expect(health.isActive).toBe(true);
    expect(health.daysSinceLastCommit).toBeLessThan(30);
    expect(health.stargazersCount).toBe(1000);
    expect(health.forksCount).toBe(200);
    expect(health.openIssuesCount).toBe(50);
    expect(health.checkFailed).toBeUndefined();
  });

  it('returns inactive for stale repo', async () => {
    mockFn(octokit.repos.listCommits).mockResolvedValue({
      data: [{ commit: { author: { date: '2025-01-01T00:00:00Z' } } }],
    });

    const health = await vetter.checkProjectHealth('owner', 'repo');
    expect(health.isActive).toBe(false);
    expect(health.daysSinceLastCommit).toBeGreaterThan(30);
  });

  it('sets ciStatus to passing when workflows exist', async () => {
    const health = await vetter.checkProjectHealth('owner', 'repo');
    expect(health.ciStatus).toBe('passing');
  });

  it('sets ciStatus to unknown when no workflows', async () => {
    mockFn(octokit.actions.listRepoWorkflows).mockResolvedValue({
      data: { total_count: 0, workflows: [] },
    });

    const health = await vetter.checkProjectHealth('owner', 'repo');
    expect(health.ciStatus).toBe('unknown');
  });

  it('sets ciStatus to unknown when CI check API fails and logs warning', async () => {
    mockFn(octokit.actions.listRepoWorkflows).mockRejectedValue(new Error('Forbidden'));

    const health = await vetter.checkProjectHealth('owner', 'repo');
    expect(health.ciStatus).toBe('unknown');
    expect(health.isActive).toBe(true);
    // Inner catch isolated the failure — outer catch NOT triggered
    expect(health.checkFailed).toBeUndefined();
    expect(health.stargazersCount).toBe(1000);
    expect(health.forksCount).toBe(200);
    expect(warn).toHaveBeenCalledWith('issue-vetting', expect.stringContaining('CI status'));
  });

  it('falls back to pushed_at when no commits returned', async () => {
    mockFn(octokit.repos.listCommits).mockResolvedValue({ data: [] });

    const health = await vetter.checkProjectHealth('owner', 'repo');
    // pushed_at is '2025-06-30T00:00:00Z' (~1 day ago from fake time)
    expect(health.isActive).toBe(true);
  });

  it('returns failure result on repo-level API error', async () => {
    vi.mocked(cachedRequest).mockRejectedValue(new Error('Repo not found'));

    const health = await vetter.checkProjectHealth('owner', 'repo');
    expect(health.checkFailed).toBe(true);
    expect(health.failureReason).toBe('Repo not found');
    expect(health.isActive).toBe(false);
    expect(health.daysSinceLastCommit).toBe(999);
    expect(health.stargazersCount).toBeUndefined();
    expect(health.forksCount).toBeUndefined();
  });

  it('returns cached health when getIfFresh returns data (#487)', async () => {
    const { getHttpCache } = await import('./http-cache.js');
    const mockCache = (getHttpCache as any)();
    const cachedHealth = {
      repo: 'owner/repo',
      lastCommitAt: '2025-06-30T00:00:00Z',
      daysSinceLastCommit: 1,
      openIssuesCount: 10,
      avgIssueResponseDays: 0,
      ciStatus: 'passing',
      isActive: true,
      stargazersCount: 500,
      forksCount: 50,
    };
    mockCache.getIfFresh.mockReturnValueOnce(cachedHealth);
    vi.mocked(cachedRequest).mockClear();

    const health = await vetter.checkProjectHealth('owner', 'repo');
    expect(health).toEqual(cachedHealth);
    // API should NOT have been called (cachedRequest is used for repo.get)
    expect(cachedRequest).not.toHaveBeenCalled();
  });

  it('caches health result after fresh API call (#487)', async () => {
    const { getHttpCache } = await import('./http-cache.js');
    const mockCache = (getHttpCache as any)();
    mockCache.getIfFresh.mockReturnValue(null);
    mockCache.set.mockClear();

    const health = await vetter.checkProjectHealth('owner', 'repo');
    expect(health.isActive).toBe(true);
    // cache.set should have been called with the health result
    expect(mockCache.set).toHaveBeenCalledWith(
      'health:owner/repo',
      '',
      expect.objectContaining({ repo: 'owner/repo', isActive: true }),
    );
  });
});

describe('fetchContributionGuidelines', () => {
  let vetter: IssueVetter;
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    octokit = makeOctokit();
    vetter = new IssueVetter(octokit, makeStateManager());
  });

  it('returns parsed guidelines when CONTRIBUTING.md found', async () => {
    mockFn(octokit.repos.getContent).mockResolvedValue({
      data: { content: Buffer.from('We use conventional commit messages.').toString('base64') },
    });

    const owner = uniqueOwner('fetch');
    const result = await vetter.fetchContributionGuidelines(owner, 'repo');
    expect(result).toBeDefined();
    expect(result!.commitMessageFormat).toBe('conventional commits');
  });

  it('tries multiple file paths until found', async () => {
    // All 4 paths are probed in parallel; only .github/CONTRIBUTING.md succeeds
    mockFn(octokit.repos.getContent).mockImplementation(({ path }: { path: string }) => {
      if (path === '.github/CONTRIBUTING.md') {
        return Promise.resolve({ data: { content: Buffer.from('Run jest.').toString('base64') } });
      }
      return Promise.reject(new Error('404 Not Found'));
    });

    const owner = uniqueOwner('fetch');
    const result = await vetter.fetchContributionGuidelines(owner, 'repo');
    expect(result).toBeDefined();
    expect(result!.testFramework).toBe('Jest');
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(4);
  });

  it('returns undefined when no file found at any path', async () => {
    mockFn(octokit.repos.getContent).mockRejectedValue(new Error('404 Not Found'));

    const owner = uniqueOwner('fetch');
    const result = await vetter.fetchContributionGuidelines(owner, 'repo');
    expect(result).toBeUndefined();
    // 4 paths: CONTRIBUTING.md, .github/CONTRIBUTING.md, docs/CONTRIBUTING.md, contributing.md
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(4);
  });

  it('returns cached result on second call', async () => {
    mockFn(octokit.repos.getContent).mockResolvedValue({
      data: { content: Buffer.from('Simple guidelines.').toString('base64') },
    });

    const owner = uniqueOwner('cache');
    await vetter.fetchContributionGuidelines(owner, 'repo');
    const callCountAfterFirst = mockFn(octokit.repos.getContent).mock.calls.length;

    await vetter.fetchContributionGuidelines(owner, 'repo');
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(callCountAfterFirst);
  });

  it('does not log warnings for 404 errors', async () => {
    mockFn(octokit.repos.getContent).mockRejectedValue(new Error('404 Not Found'));

    const owner = uniqueOwner('fetch');
    await vetter.fetchContributionGuidelines(owner, 'repo');
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs warnings for non-404 errors with context', async () => {
    mockFn(octokit.repos.getContent).mockRejectedValue(new Error('Server Error 500'));

    const owner = uniqueOwner('fetch');
    await vetter.fetchContributionGuidelines(owner, 'repo');
    expect(warn).toHaveBeenCalledWith('issue-vetting', expect.stringContaining('Server Error 500'));
  });
});

describe('checkUserMergedPRsInRepo', () => {
  let vetter: IssueVetter;
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    octokit = makeOctokit();
    vetter = new IssueVetter(octokit, makeStateManager());
  });

  it('returns count of merged PRs', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 3 },
    });

    const count = await vetter.checkUserMergedPRsInRepo('owner', 'repo');
    expect(count).toBe(3);
  });

  it('returns 0 when no merged PRs', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 0 },
    });

    const count = await vetter.checkUserMergedPRsInRepo('owner', 'repo');
    expect(count).toBe(0);
  });

  it('returns 0 on API error and logs warning', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockRejectedValue(new Error('API error'));

    const count = await vetter.checkUserMergedPRsInRepo('owner', 'repo');
    expect(count).toBe(0);
    expect(warn).toHaveBeenCalledWith('issue-vetting', expect.stringContaining('owner/repo'));
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

  it('detects existing PRs via search', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockImplementation(mockSearchDispatch(1, 0));

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
    mockFn(octokit.search.issuesAndPullRequests).mockImplementation(({ q }: { q: string }) => {
      if (q.includes('is:merged') && q.includes('author:@me')) {
        return Promise.resolve({ data: { total_count: 0 } });
      }
      return Promise.reject(new Error('API error'));
    });

    const candidate = await vetter.vetIssue(`https://github.com/${owner}/repo/issues/42`);
    expect(candidate.recommendation).toBe('needs_review');
    expect(candidate.vettingResult.notes).toContainEqual(expect.stringContaining('downgraded'));
  });

  it('recommends skip when more than 2 skip reasons', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockImplementation(mockSearchDispatch(1, 0));

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
