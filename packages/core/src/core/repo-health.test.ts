import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkProjectHealth, fetchContributionGuidelines, parseContributionGuidelines } from './repo-health.js';
import type { Octokit } from '@octokit/rest';

// ── Mock dependencies ──

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

import { cachedRequest } from './http-cache.js';
import { warn } from './logger.js';

// ── Helpers ──

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function makeOctokit(): Octokit {
  return {
    repos: {
      get: vi.fn(),
      listCommits: vi.fn(),
      getContent: vi.fn(),
    },
    actions: {
      listRepoWorkflows: vi.fn(),
    },
  } as unknown as Octokit;
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

describe('checkProjectHealth', () => {
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-07-01T12:00:00Z'));

    octokit = makeOctokit();

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
    const health = await checkProjectHealth(octokit, 'owner', 'repo');

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

    const health = await checkProjectHealth(octokit, 'owner', 'repo');
    expect(health.isActive).toBe(false);
    expect(health.daysSinceLastCommit).toBeGreaterThan(30);
  });

  it('sets ciStatus to passing when workflows exist', async () => {
    const health = await checkProjectHealth(octokit, 'owner', 'repo');
    expect(health.ciStatus).toBe('passing');
  });

  it('sets ciStatus to unknown when no workflows', async () => {
    mockFn(octokit.actions.listRepoWorkflows).mockResolvedValue({
      data: { total_count: 0, workflows: [] },
    });

    const health = await checkProjectHealth(octokit, 'owner', 'repo');
    expect(health.ciStatus).toBe('unknown');
  });

  it('sets ciStatus to unknown when CI check API fails and logs warning', async () => {
    mockFn(octokit.actions.listRepoWorkflows).mockRejectedValue(new Error('Forbidden'));

    const health = await checkProjectHealth(octokit, 'owner', 'repo');
    expect(health.ciStatus).toBe('unknown');
    expect(health.isActive).toBe(true);
    // Inner catch isolated the failure — outer catch NOT triggered
    expect(health.checkFailed).toBeUndefined();
    expect(health.stargazersCount).toBe(1000);
    expect(health.forksCount).toBe(200);
    expect(warn).toHaveBeenCalledWith('repo-health', expect.stringContaining('CI status'));
  });

  it('falls back to pushed_at when no commits returned', async () => {
    mockFn(octokit.repos.listCommits).mockResolvedValue({ data: [] });

    const health = await checkProjectHealth(octokit, 'owner', 'repo');
    // pushed_at is '2025-06-30T00:00:00Z' (~1 day ago from fake time)
    expect(health.isActive).toBe(true);
  });

  it('returns failure result on repo-level API error', async () => {
    vi.mocked(cachedRequest).mockRejectedValue(new Error('Repo not found'));

    const health = await checkProjectHealth(octokit, 'owner', 'repo');
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

    const health = await checkProjectHealth(octokit, 'owner', 'repo');
    expect(health).toEqual(cachedHealth);
    // API should NOT have been called (cachedRequest is used for repo.get)
    expect(cachedRequest).not.toHaveBeenCalled();
  });

  it('caches health result after fresh API call (#487)', async () => {
    const { getHttpCache } = await import('./http-cache.js');
    const mockCache = (getHttpCache as any)();
    mockCache.getIfFresh.mockReturnValue(null);
    mockCache.set.mockClear();

    const health = await checkProjectHealth(octokit, 'owner', 'repo');
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
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    octokit = makeOctokit();
  });

  it('returns parsed guidelines when CONTRIBUTING.md found', async () => {
    mockFn(octokit.repos.getContent).mockResolvedValue({
      data: { content: Buffer.from('We use conventional commit messages.').toString('base64') },
    });

    const owner = uniqueOwner('fetch');
    const result = await fetchContributionGuidelines(octokit, owner, 'repo');
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
    const result = await fetchContributionGuidelines(octokit, owner, 'repo');
    expect(result).toBeDefined();
    expect(result!.testFramework).toBe('Jest');
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(4);
  });

  it('returns undefined when no file found at any path', async () => {
    mockFn(octokit.repos.getContent).mockRejectedValue(new Error('404 Not Found'));

    const owner = uniqueOwner('fetch');
    const result = await fetchContributionGuidelines(octokit, owner, 'repo');
    expect(result).toBeUndefined();
    // 4 paths: CONTRIBUTING.md, .github/CONTRIBUTING.md, docs/CONTRIBUTING.md, contributing.md
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(4);
  });

  it('returns cached result on second call', async () => {
    mockFn(octokit.repos.getContent).mockResolvedValue({
      data: { content: Buffer.from('Simple guidelines.').toString('base64') },
    });

    const owner = uniqueOwner('cache');
    await fetchContributionGuidelines(octokit, owner, 'repo');
    const callCountAfterFirst = mockFn(octokit.repos.getContent).mock.calls.length;

    await fetchContributionGuidelines(octokit, owner, 'repo');
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(callCountAfterFirst);
  });

  it('does not log warnings for 404 errors', async () => {
    mockFn(octokit.repos.getContent).mockRejectedValue(new Error('404 Not Found'));

    const owner = uniqueOwner('fetch');
    await fetchContributionGuidelines(octokit, owner, 'repo');
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs warnings for non-404 errors with context', async () => {
    mockFn(octokit.repos.getContent).mockRejectedValue(new Error('Server Error 500'));

    const owner = uniqueOwner('fetch');
    await fetchContributionGuidelines(octokit, owner, 'repo');
    expect(warn).toHaveBeenCalledWith('repo-health', expect.stringContaining('Server Error 500'));
  });
});

describe('parseContributionGuidelines', () => {
  it('always returns rawContent', () => {
    const result = parseContributionGuidelines('Hello world');
    expect(result.rawContent).toBe('Hello world');
  });

  it('detects conventional commits', () => {
    const result = parseContributionGuidelines('We use conventional commit messages for all PRs.');
    expect(result.commitMessageFormat).toBe('conventional commits');
  });

  it('extracts commit message format from backtick-quoted text', () => {
    const result = parseContributionGuidelines('Use this commit message format: `fix: description`');
    expect(result.commitMessageFormat).toBe('fix: description');
  });

  it('detects branch naming convention from backtick-quoted text', () => {
    const result = parseContributionGuidelines('Branch naming convention: `feature/description`');
    expect(result.branchNamingConvention).toBe('feature/description');
  });

  it('detects test frameworks', () => {
    expect(parseContributionGuidelines('Run jest to test.').testFramework).toBe('Jest');
    expect(parseContributionGuidelines('We use rspec for testing.').testFramework).toBe('RSpec');
    expect(parseContributionGuidelines('Run pytest -v to verify.').testFramework).toBe('pytest');
    expect(parseContributionGuidelines('Run mocha for unit tests.').testFramework).toBe('Mocha');
  });

  it('detects linters', () => {
    expect(parseContributionGuidelines('Run eslint before submitting.').linter).toBe('ESLint');
    expect(parseContributionGuidelines('Follow rubocop rules.').linter).toBe('RuboCop');
  });

  it('detects Prettier formatter', () => {
    expect(parseContributionGuidelines('Format with prettier.').formatter).toBe('Prettier');
  });

  it('detects CLA requirement', () => {
    expect(parseContributionGuidelines('Please sign the CLA first.').claRequired).toBe(true);
    expect(parseContributionGuidelines('Contributor License Agreement required.').claRequired).toBe(true);
  });

  it('returns no optional fields for generic content', () => {
    const result = parseContributionGuidelines('Thank you for contributing!');
    expect(result.testFramework).toBeUndefined();
    expect(result.linter).toBeUndefined();
    expect(result.formatter).toBeUndefined();
    expect(result.claRequired).toBeUndefined();
    expect(result.branchNamingConvention).toBeUndefined();
    expect(result.commitMessageFormat).toBeUndefined();
  });
});
