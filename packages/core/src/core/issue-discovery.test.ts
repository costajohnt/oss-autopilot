/**
 * Tests for issue discovery, scoring, filtering, and eligibility functions.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Create a temp directory for tests that write files (saveSearchResults)
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-autopilot-test-'));

let mockOctokitInstance: any;

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => mockOctokitInstance),
  checkRateLimit: vi.fn().mockResolvedValue({ remaining: 30, limit: 30, resetAt: new Date().toISOString() }),
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
  // Pass through to the fetcher so octokit mocks are still exercised
  cachedRequest: vi
    .fn()
    .mockImplementation(
      async (_cache: unknown, _url: string, fetcher: (h: Record<string, string>) => Promise<{ data: unknown }>) => {
        const response = await fetcher({});
        return response.data;
      },
    ),
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

vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: () => ({
      config: { githubUsername: 'testuser', trustedProjects: [], starredRepos: [] },
      repoScores: {},
    }),
    getStarredRepos: () => [],
    getReposWithMergedPRs: () => [],
    getReposWithOpenPRs: () => [],
    getLowScoringRepos: () => [],
    getRepoScore: () => undefined,
  })),
}));

vi.mock('./utils.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getDataDir: () => testDataDir,
    // Make sleep a no-op so inter-phase delays don't cause test timeouts
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

const { IssueDiscovery } = await import('./issue-discovery.js');
const { isLabelFarming, hasTemplatedTitle, detectLabelFarmingRepos, isDocOnlyIssue, applyPerRepoCap, DOC_ONLY_LABELS } =
  await import('./issue-filtering.js');
const { calculateRepoQualityBonus, calculateViabilityScore } = await import('./issue-scoring.js');
const { analyzeRequirements } = await import('./issue-eligibility.js');

const { getStateManager } = await import('./state.js');

/** Create a search item with enough body content to pass analyzeRequirements */
function makeSearchItem(repo: string, num: number) {
  return {
    html_url: `https://github.com/${repo}/issues/${num}`,
    repository_url: `https://api.github.com/repos/${repo}`,
    updated_at: new Date().toISOString(),
    title: `Test issue ${num}`,
    labels: [{ name: 'good first issue' }],
    id: num,
    comments: 0,
    body: `1. Step one\n2. Step two\nThis should work correctly.\n${'x'.repeat(200)}`,
    created_at: new Date().toISOString(),
    number: num,
  };
}

/**
 * Build state mock for search-related tests.
 * Sets up getStateManager to return a mock with the supplied config overrides,
 * repo lists, and activeIssues.
 */
function mockStateForSearch(
  overrides: {
    mergedPRRepos?: string[];
    openPRRepos?: string[];
    starredRepos?: string[];
    lowScoringRepos?: string[];
    config?: Record<string, unknown>;
    activeIssues?: any[];
    isStarredReposStale?: boolean;
  } = {},
): void {
  const config: Record<string, unknown> = {
    githubUsername: 'testuser',
    trustedProjects: [],
    starredRepos: [],
    excludeRepos: [],
    languages: ['typescript'],
    labels: ['good first issue'],
    maxIssueAgeDays: 90,
    includeDocIssues: true,
    minStars: 0,
    ...overrides.config,
  };
  (getStateManager as any).mockReturnValue({
    getState: () => ({ config, repoScores: {}, activeIssues: overrides.activeIssues ?? [] }),
    getStarredRepos: () => overrides.starredRepos ?? [],
    setStarredRepos: vi.fn(),
    isStarredReposStale: () => overrides.isStarredReposStale ?? false,
    getReposWithMergedPRs: () => overrides.mergedPRRepos ?? [],
    getReposWithOpenPRs: () => overrides.openPRRepos ?? [],
    getLowScoringRepos: () => overrides.lowScoringRepos ?? [],
    getRepoScore: () => undefined,
    getHighScoringRepos: () => [],
  });
}

/**
 * Build a full octokit mock satisfying both search and vetting pipelines.
 * Accepts a custom searchImpl to route queries by content.
 */
function fullOctokitMock(
  searchImpl?: (params: { q?: string }) => Promise<{ data: { total_count: number; items: any[] } }>,
): any {
  const recentDate = new Date().toISOString();
  const defaultSearch = () => Promise.resolve({ data: { total_count: 0, items: [] } });

  return {
    search: {
      issuesAndPullRequests: vi.fn().mockImplementation(searchImpl ?? defaultSearch),
    },
    issues: {
      get: vi.fn().mockImplementation(({ owner, repo, issue_number }: any) =>
        Promise.resolve({
          data: {
            id: issue_number,
            html_url: `https://github.com/${owner}/${repo}/issues/${issue_number}`,
            title: `Test issue ${issue_number}`,
            labels: [{ name: 'good first issue' }],
            created_at: recentDate,
            updated_at: recentDate,
            comments: 0,
            body: `1. Step one\n2. Step two\nThis should work correctly.\n${'x'.repeat(200)}`,
          },
        }),
      ),
      listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
    },
    repos: {
      get: vi.fn().mockResolvedValue({
        data: { open_issues_count: 5, pushed_at: recentDate, stargazers_count: 200, forks_count: 30 },
      }),
      listCommits: vi.fn().mockResolvedValue({
        data: [{ commit: { author: { date: recentDate } } }],
      }),
      getContent: vi.fn().mockRejectedValue(new Error('404 Not Found')),
    },
    actions: {
      listRepoWorkflows: vi.fn().mockResolvedValue({ data: { total_count: 1 } }),
    },
    paginate: {
      iterator: vi.fn(),
    },
    activity: {
      listReposStarredByAuthenticatedUser: vi.fn(),
    },
  };
}

describe('calculateViabilityScore', () => {
  const baseParams = {
    repoScore: null as number | null,
    hasExistingPR: false,
    isClaimed: false,
    clearRequirements: false,
    hasContributionGuidelines: false,
    issueUpdatedAt: '2020-01-01T00:00:00Z', // Very old, no freshness bonus
    closedWithoutMergeCount: 0,
    mergedPRCount: 0,
    orgHasMergedPRs: false,
  };

  it('should return base score of 50 with no bonuses or penalties', () => {
    const score = calculateViabilityScore(baseParams);
    expect(score).toBe(50);
  });

  it('should add repo score contribution (score * 2)', () => {
    const score = calculateViabilityScore({ ...baseParams, repoScore: 8 });
    expect(score).toBe(50 + 16); // 8 * 2 = 16
  });

  it('should add +20 for max repo score of 10', () => {
    const score = calculateViabilityScore({ ...baseParams, repoScore: 10 });
    expect(score).toBe(50 + 20);
  });

  it('should add +15 for clear requirements', () => {
    const score = calculateViabilityScore({ ...baseParams, clearRequirements: true });
    expect(score).toBe(50 + 15);
  });

  it('should add +15 for freshness (updated within 14 days)', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    const score = calculateViabilityScore({
      ...baseParams,
      issueUpdatedAt: recent.toISOString(),
    });
    expect(score).toBe(50 + 15);
  });

  it('should add partial freshness bonus for 15-30 day old issues', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 22); // 22 days old
    const score = calculateViabilityScore({
      ...baseParams,
      issueUpdatedAt: recent.toISOString(),
    });
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThan(50 + 15);
  });

  it('should add no freshness bonus for 31+ day old issues', () => {
    const old = new Date();
    old.setDate(old.getDate() - 45);
    const score = calculateViabilityScore({
      ...baseParams,
      issueUpdatedAt: old.toISOString(),
    });
    expect(score).toBe(50);
  });

  it('should add +10 for contribution guidelines', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      hasContributionGuidelines: true,
    });
    expect(score).toBe(50 + 10);
  });

  it('should subtract -30 for existing PR', () => {
    const score = calculateViabilityScore({ ...baseParams, hasExistingPR: true });
    expect(score).toBe(50 - 30);
  });

  it('should subtract -20 for claimed issue', () => {
    const score = calculateViabilityScore({ ...baseParams, isClaimed: true });
    expect(score).toBe(50 - 20);
  });

  it('should clamp to 0 when penalties exceed score', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      hasExistingPR: true,
      isClaimed: true,
    });
    expect(score).toBe(0); // 50 - 30 - 20 = 0
  });

  it('should clamp to 100 when bonuses are maxed', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 1);
    const score = calculateViabilityScore({
      repoScore: 10,
      hasExistingPR: false,
      isClaimed: false,
      clearRequirements: true,
      hasContributionGuidelines: true,
      issueUpdatedAt: recent.toISOString(),
      closedWithoutMergeCount: 0,
      mergedPRCount: 0,
      orgHasMergedPRs: false,
    });
    // 50 + 20 + 15 + 15 + 10 = 110, clamped to 100
    expect(score).toBe(100);
  });

  it('should combine multiple bonuses and penalties correctly', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 3);
    const score = calculateViabilityScore({
      repoScore: 5,
      hasExistingPR: false,
      isClaimed: true, // -20
      clearRequirements: true, // +15
      hasContributionGuidelines: true, // +10
      issueUpdatedAt: recent.toISOString(), // +15
      closedWithoutMergeCount: 0,
      mergedPRCount: 0,
      orgHasMergedPRs: false,
    });
    // 50 + 10 + 15 + 15 + 10 - 20 = 80
    expect(score).toBe(80);
  });

  it('should add +15 for merged PR in this repo (#99)', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      mergedPRCount: 1,
    });
    expect(score).toBe(50 + 15);
  });

  it('should add +15 for merged PR even with multiple merges (#99)', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      mergedPRCount: 5,
    });
    expect(score).toBe(50 + 15);
  });

  it('should NOT add merged PR bonus when mergedPRCount is 0', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      mergedPRCount: 0,
    });
    expect(score).toBe(50);
  });

  it('should stack merged PR bonus (+15) with org affinity (+5) for +20 total relationship bonus', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      mergedPRCount: 2,
      orgHasMergedPRs: true,
    });
    // 50 + 15 (merged PR) + 5 (org affinity) = 70
    expect(score).toBe(70);
  });

  it('should subtract -15 for closed-without-merge history with no merges', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      closedWithoutMergeCount: 2,
      mergedPRCount: 0,
    });
    expect(score).toBe(50 - 15);
  });

  it('should NOT subtract penalty when closed PRs exist but merges also exist', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      closedWithoutMergeCount: 1,
      mergedPRCount: 2,
    });
    // No -15 penalty because mergedPRCount > 0, but +15 merged PR bonus applies
    expect(score).toBe(50 + 15);
  });

  it('should NOT subtract penalty when closedWithoutMergeCount is 0', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      closedWithoutMergeCount: 0,
      mergedPRCount: 0,
    });
    expect(score).toBe(50);
  });

  it('should apply closed-PR penalty alongside other penalties', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      hasExistingPR: true, // -30
      closedWithoutMergeCount: 1, // -15
      mergedPRCount: 0,
    });
    // 50 - 30 - 15 = 5
    expect(score).toBe(5);
  });

  it('should add +5 for org affinity', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      orgHasMergedPRs: true,
    });
    expect(score).toBe(55);
  });

  it('should NOT add org affinity bonus when false', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      orgHasMergedPRs: false,
    });
    expect(score).toBe(50);
  });

  it('should combine org affinity with other bonuses', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 3);
    const score = calculateViabilityScore({
      ...baseParams,
      repoScore: 8, // +16
      clearRequirements: true, // +15
      issueUpdatedAt: recent.toISOString(), // +15
      orgHasMergedPRs: true, // +5
    });
    // 50 + 16 + 15 + 15 + 5 = 101, clamped to 100
    expect(score).toBe(100);
  });
});

describe('analyzeRequirements', () => {
  it('should return false for empty body', () => {
    expect(analyzeRequirements('')).toBe(false);
  });

  it('should return false for very short body (< 50 chars)', () => {
    expect(analyzeRequirements('Fix the bug')).toBe(false);
  });

  it('should return true for body with numbered steps and expected behavior', () => {
    const body = `
      This feature should add pagination to the API.
      1. Add page parameter to GET /items
      2. Return 20 items per page
      3. Include next/prev links in response
      The API should return a 400 error for invalid page numbers.
    `;
    expect(analyzeRequirements(body)).toBe(true);
  });

  it('should return true for body with code block and expected behavior', () => {
    const body = `
      The function currently throws an error when passed null:
      \`\`\`
      TypeError: Cannot read property 'name' of null
      \`\`\`
      It should handle null gracefully and return an empty string instead.
    `;
    expect(analyzeRequirements(body)).toBe(true);
  });

  it('should return true for long body with bullet points', () => {
    const body = `
      We need to update the dashboard to show contribution metrics.
      - Add a new section for monthly stats
      - Include a chart showing PRs over time
      - The chart should update automatically when new data arrives
      This will help users track their contribution velocity.
    `;
    expect(analyzeRequirements(body)).toBe(true);
  });

  it('should return false for body with only length but no structure', () => {
    const body = 'a'.repeat(201); // Long but no steps, code blocks, or expected behavior
    expect(analyzeRequirements(body)).toBe(false);
  });

  it('should return true for body > 200 chars with expected behavior keywords', () => {
    const body = `
      The current implementation does not handle edge cases well. When a user
      submits a form with special characters, the system should validate the input
      and display an appropriate error message. Currently it silently drops the data.
      We want to improve user experience by providing clear feedback.
    `;
    expect(analyzeRequirements(body)).toBe(true);
  });
});

describe('IssueDiscovery.vetIssue inconclusive downgrade', () => {
  let discovery: InstanceType<typeof IssueDiscovery>;

  // Use relative dates so tests don't become flaky as wall-clock time passes thresholds
  const recentDate = () => new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
  const olderDate = () => new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(); // 20 days ago

  const makeGhIssue = () => ({
    id: 1,
    html_url: 'https://github.com/owner/repo/issues/42',
    title: 'Test issue with clear requirements',
    labels: [{ name: 'good first issue' }],
    created_at: olderDate(),
    updated_at: recentDate(),
    comments: 0,
    body: `
      This feature should add pagination to the API.
      1. Add page parameter to GET /items
      2. Return 20 items per page
      The API should return a 400 error for invalid page numbers.
    `,
  });

  beforeEach(() => {
    const recent = recentDate();
    mockOctokitInstance = {
      issues: {
        get: vi.fn().mockResolvedValue({ data: makeGhIssue() }),
        listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
      },
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({ data: { total_count: 0, items: [] } }),
      },
      repos: {
        get: vi.fn().mockResolvedValue({
          data: { open_issues_count: 5, pushed_at: recent, stargazers_count: 100, forks_count: 20 },
        }),
        listCommits: vi.fn().mockResolvedValue({
          data: [{ commit: { author: { date: recent } } }],
        }),
        getContent: vi.fn().mockRejectedValue(new Error('404 Not Found')),
      },
      actions: {
        listRepoWorkflows: vi.fn().mockResolvedValue({ data: { total_count: 1 } }),
      },
    };
    discovery = new IssueDiscovery('fake-token');
  });

  it('should approve when all checks pass definitively', async () => {
    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.recommendation).toBe('approve');
  });

  it('should downgrade to needs_review when checkNoExistingPR is inconclusive', async () => {
    // Make the search call throw (simulating rate limit / API error)
    mockOctokitInstance.search.issuesAndPullRequests.mockRejectedValue(new Error('API rate limit exceeded'));

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.recommendation).toBe('needs_review');
    expect(candidate.vettingResult.notes).toContainEqual(
      expect.stringContaining('Could not verify absence of existing PRs'),
    );
    expect(candidate.vettingResult.notes).toContainEqual(expect.stringContaining('Recommendation downgraded'));
  });

  it('should downgrade to needs_review when checkNotClaimed is inconclusive', async () => {
    // Issue has comments, so checkNotClaimed will try to fetch them
    mockOctokitInstance.issues.get.mockResolvedValue({
      data: { ...makeGhIssue(), comments: 3 },
    });
    // Make paginate throw (simulating API error)
    mockOctokitInstance.paginate = vi.fn().mockRejectedValue(new Error('Server error'));

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.recommendation).toBe('needs_review');
    expect(candidate.vettingResult.notes).toContainEqual(expect.stringContaining('Could not verify claim status'));
  });

  it('should downgrade to needs_review when project health check fails', async () => {
    // Make repos.get throw (simulating API error)
    mockOctokitInstance.repos.get.mockRejectedValue(new Error('Not Found'));

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.recommendation).toBe('needs_review');
    expect(candidate.vettingResult.notes).toContainEqual(expect.stringContaining('Could not verify project activity'));
  });

  it('should note unavailable quality bonus when health check fails', async () => {
    mockOctokitInstance.repos.get.mockRejectedValue(new Error('Not Found'));

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.vettingResult.notes).toContainEqual(expect.stringContaining('Repo quality bonus unavailable'));
  });

  it('should populate stargazersCount and forksCount from checkProjectHealth', async () => {
    mockOctokitInstance.repos.get.mockResolvedValue({
      data: { open_issues_count: 5, pushed_at: '2026-02-01T00:00:00Z', stargazers_count: 5000, forks_count: 800 },
    });

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.projectHealth.stargazersCount).toBe(5000);
    expect(candidate.projectHealth.forksCount).toBe(800);
  });
});

describe('IssueDiscovery.vetIssue prior contribution detection (#373)', () => {
  let discovery: InstanceType<typeof IssueDiscovery>;

  const makeGhIssue = () => ({
    id: 1,
    html_url: 'https://github.com/owner/repo/issues/42',
    title: 'Test issue with clear requirements',
    labels: [{ name: 'good first issue' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    comments: 0,
    body: `
      This feature should add pagination to the API.
      1. Add page parameter to GET /items
      2. Return 20 items per page
      The API should return a 400 error for invalid page numbers.
    `,
  });

  beforeEach(() => {
    mockOctokitInstance = {
      issues: {
        get: vi.fn().mockResolvedValue({ data: makeGhIssue() }),
        listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
      },
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({ data: { total_count: 0, items: [] } }),
      },
      repos: {
        get: vi.fn().mockResolvedValue({
          data: { open_issues_count: 5, pushed_at: '2026-02-01T00:00:00Z', stargazers_count: 100, forks_count: 20 },
        }),
        listCommits: vi.fn().mockResolvedValue({
          data: [{ commit: { author: { date: '2026-02-01T00:00:00Z' } } }],
        }),
        getContent: vi.fn().mockRejectedValue(new Error('404 Not Found')),
      },
      actions: {
        listRepoWorkflows: vi.fn().mockResolvedValue({ data: { total_count: 1 } }),
      },
    };
    discovery = new IssueDiscovery('fake-token');
  });

  it('should flag prior contributions from GitHub API when not in local state', async () => {
    // Mock the merged PR search to return 5 merged PRs
    mockOctokitInstance.search.issuesAndPullRequests.mockImplementation((params: { q?: string }) => {
      if (params?.q?.includes('is:merged author:@me')) {
        return Promise.resolve({ data: { total_count: 5, items: [] } });
      }
      return Promise.resolve({ data: { total_count: 0, items: [] } });
    });

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.reasonsToApprove).toContainEqual('Trusted project (5 PRs merged)');
    expect(candidate.searchPriority).toBe('merged_pr');
  });

  it('should prefer local repoScore mergedPRCount over GitHub API count', async () => {
    // Set up local state with 3 merged PRs
    const stateManager = (discovery as unknown as { stateManager: { getRepoScore: ReturnType<typeof vi.fn> } })
      .stateManager;
    stateManager.getRepoScore = vi.fn().mockReturnValue({ mergedPRCount: 3, closedWithoutMergeCount: 0, score: 8 });

    // GitHub API returns 5, but local state (3) should take precedence
    mockOctokitInstance.search.issuesAndPullRequests.mockImplementation((params: { q?: string }) => {
      if (params?.q?.includes('is:merged author:@me')) {
        return Promise.resolve({ data: { total_count: 5, items: [] } });
      }
      return Promise.resolve({ data: { total_count: 0, items: [] } });
    });

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.reasonsToApprove).toContainEqual('Trusted project (3 PRs merged)');
  });

  it('should handle GitHub API errors gracefully and return 0 merged count', async () => {
    // Make all search calls fail
    mockOctokitInstance.search.issuesAndPullRequests.mockRejectedValue(new Error('API rate limit'));

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    // Should not include "Trusted project" since both API and local state have 0
    expect(candidate.reasonsToApprove).not.toContainEqual(expect.stringContaining('Trusted project'));
    // Recommendation downgraded because checkNoExistingPR is also inconclusive
    expect(candidate.recommendation).toBe('needs_review');
  });

  it('should give viability score bonus for prior contributions from API', async () => {
    // Mock with 2 merged PRs from API
    mockOctokitInstance.search.issuesAndPullRequests.mockImplementation((params: { q?: string }) => {
      if (params?.q?.includes('is:merged author:@me')) {
        return Promise.resolve({ data: { total_count: 2, items: [] } });
      }
      return Promise.resolve({ data: { total_count: 0, items: [] } });
    });

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    // Viability score should include the +15 merged PR bonus
    expect(candidate.viabilityScore).toBeGreaterThanOrEqual(65); // 50 base + 15 merged
  });
});

describe('isLabelFarming', () => {
  const makeItem = (labels: string[]) => ({
    html_url: 'https://github.com/spam/repo/issues/1',
    repository_url: 'https://api.github.com/repos/spam/repo',
    updated_at: '2026-01-01T00:00:00Z',
    labels: labels.map((name) => ({ name })),
  });

  it('should return false with 4 beginner labels', () => {
    expect(isLabelFarming(makeItem(['good first issue', 'hacktoberfest', 'easy', 'beginner']))).toBe(false);
  });

  it('should return true with 5 beginner labels', () => {
    expect(isLabelFarming(makeItem(['good first issue', 'hacktoberfest', 'easy', 'beginner', 'starter']))).toBe(true);
  });

  it('should count only beginner labels, ignoring non-beginner labels', () => {
    expect(
      isLabelFarming(makeItem(['good first issue', 'hacktoberfest', 'bug', 'enhancement', 'easy', 'documentation'])),
    ).toBe(false); // Only 3 beginner labels
  });

  it('should handle string labels', () => {
    const item = {
      html_url: 'https://github.com/spam/repo/issues/1',
      repository_url: 'https://api.github.com/repos/spam/repo',
      updated_at: '2026-01-01T00:00:00Z',
      labels: ['good first issue', 'hacktoberfest', 'easy', 'beginner', 'newbie'] as any,
    };
    expect(isLabelFarming(item)).toBe(true);
  });

  it('should return false when no labels present', () => {
    const item = {
      html_url: 'https://github.com/spam/repo/issues/1',
      repository_url: 'https://api.github.com/repos/spam/repo',
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(isLabelFarming(item)).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isLabelFarming(makeItem(['Good First Issue', 'HACKTOBERFEST', 'Easy', 'Beginner', 'Starter']))).toBe(true);
  });
});

describe('hasTemplatedTitle', () => {
  it('should detect "Add Trivia Question 61"', () => {
    expect(hasTemplatedTitle('Add Trivia Question 61')).toBe(true);
  });

  it('should detect "Create Entry #5"', () => {
    expect(hasTemplatedTitle('Create Entry #5')).toBe(true);
  });

  it('should detect "Update Documentation Item 12"', () => {
    expect(hasTemplatedTitle('Update Documentation Item 12')).toBe(true);
  });

  it('should detect "Write Blog Post #42"', () => {
    expect(hasTemplatedTitle('Write Blog Post #42')).toBe(true);
  });

  it('should detect "Implement Feature Task 7"', () => {
    expect(hasTemplatedTitle('Implement Feature Task 7')).toBe(true);
  });

  it('should NOT detect "Fix authentication bug"', () => {
    expect(hasTemplatedTitle('Fix authentication bug')).toBe(false);
  });

  it('should NOT detect "Add dark mode support"', () => {
    expect(hasTemplatedTitle('Add dark mode support')).toBe(false);
  });

  it('should NOT detect empty string', () => {
    expect(hasTemplatedTitle('')).toBe(false);
  });

  it('should NOT detect "Update the README with installation instructions"', () => {
    expect(hasTemplatedTitle('Update the README with installation instructions')).toBe(false);
  });

  // False-positive resistance: legitimate titles ending in numbers
  it('should NOT detect "Add support for Python 3.12"', () => {
    expect(hasTemplatedTitle('Add support for Python 3.12')).toBe(false);
  });

  it('should NOT detect "Implement RFC 7231"', () => {
    expect(hasTemplatedTitle('Implement RFC 7231')).toBe(false);
  });

  it('should NOT detect "Update CI pipeline to use Node 22"', () => {
    expect(hasTemplatedTitle('Update CI pipeline to use Node 22')).toBe(false);
  });
});

describe('detectLabelFarmingRepos', () => {
  const makeItem = (repo: string, opts: { labels?: string[]; title?: string } = {}) => ({
    html_url: `https://github.com/${repo}/issues/1`,
    repository_url: `https://api.github.com/repos/${repo}`,
    updated_at: '2026-01-01T00:00:00Z',
    title: opts.title || 'Some issue',
    labels: (opts.labels || []).map((name) => ({ name })),
  });

  it('should flag repo with single issue having 5+ beginner labels', () => {
    const items = [
      makeItem('spam/repo', {
        labels: ['good first issue', 'hacktoberfest', 'easy', 'beginner', 'starter'],
      }),
      makeItem('legit/project', { labels: ['bug'] }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.has('spam/repo')).toBe(true);
    expect(spamRepos.has('legit/project')).toBe(false);
  });

  it('should flag repo with 3+ templated title issues', () => {
    const items = [
      makeItem('spam/trivia', { title: 'Add Trivia Question 1' }),
      makeItem('spam/trivia', { title: 'Add Trivia Question 2' }),
      makeItem('spam/trivia', { title: 'Add Trivia Question 3' }),
      makeItem('legit/project', { title: 'Fix login redirect' }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.has('spam/trivia')).toBe(true);
    expect(spamRepos.has('legit/project')).toBe(false);
  });

  it('should NOT flag repo with only 2 templated title issues', () => {
    const items = [
      makeItem('borderline/repo', { title: 'Add Question 1' }),
      makeItem('borderline/repo', { title: 'Add Question 2' }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.has('borderline/repo')).toBe(false);
  });

  it('should return empty set for clean items', () => {
    const items = [
      makeItem('legit/a', { title: 'Fix memory leak', labels: ['bug'] }),
      makeItem('legit/b', { title: 'Add feature X', labels: ['good first issue'] }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.size).toBe(0);
  });

  it('should handle mixed spam signals across repos', () => {
    const items = [
      // Spam repo via labels
      makeItem('spam/labels', {
        labels: ['good first issue', 'hacktoberfest', 'easy', 'beginner', 'community'],
      }),
      // Spam repo via templated titles (need 3)
      makeItem('spam/titles', { title: 'Create Entry 1' }),
      makeItem('spam/titles', { title: 'Create Entry 2' }),
      makeItem('spam/titles', { title: 'Create Entry 3' }),
      // Legit
      makeItem('legit/project', { title: 'Improve error handling' }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.has('spam/labels')).toBe(true);
    expect(spamRepos.has('spam/titles')).toBe(true);
    expect(spamRepos.has('legit/project')).toBe(false);
  });
});

describe('calculateRepoQualityBonus', () => {
  it('should return 0 for tiny repo (< 50 stars, < 50 forks)', () => {
    expect(calculateRepoQualityBonus(10, 5)).toBe(0);
  });

  it('should return 3 for small repo (50-499 stars)', () => {
    expect(calculateRepoQualityBonus(100, 20)).toBe(3);
  });

  it('should return 7 for medium repo (500-4999 stars, 50+ forks)', () => {
    expect(calculateRepoQualityBonus(1000, 100)).toBe(7); // 5 stars + 2 forks
  });

  it('should return 12 for large repo (5000+ stars, 500+ forks)', () => {
    expect(calculateRepoQualityBonus(30000, 5000)).toBe(12); // 8 stars + 4 forks
  });

  it('should return 12 for very large repo (natural max)', () => {
    expect(calculateRepoQualityBonus(50000, 10000)).toBe(12); // 8 + 4
  });

  it('should return 8 for high-star low-fork repo', () => {
    expect(calculateRepoQualityBonus(10000, 30)).toBe(8); // 8 stars + 0 forks
  });

  it('should return 4 for low-star high-fork repo', () => {
    expect(calculateRepoQualityBonus(10, 1000)).toBe(4); // 0 stars + 4 forks
  });

  it('should handle exact boundary values', () => {
    expect(calculateRepoQualityBonus(50, 0)).toBe(3); // exactly 50 stars
    expect(calculateRepoQualityBonus(500, 0)).toBe(5); // exactly 500 stars
    expect(calculateRepoQualityBonus(5000, 0)).toBe(8); // exactly 5000 stars
    expect(calculateRepoQualityBonus(0, 50)).toBe(2); // exactly 50 forks
    expect(calculateRepoQualityBonus(0, 500)).toBe(4); // exactly 500 forks
  });

  it('should return 0 for zero stars and forks', () => {
    expect(calculateRepoQualityBonus(0, 0)).toBe(0);
  });
});

describe('calculateViabilityScore with repoQualityBonus', () => {
  const baseParams = {
    repoScore: null as number | null,
    hasExistingPR: false,
    isClaimed: false,
    clearRequirements: false,
    hasContributionGuidelines: false,
    issueUpdatedAt: '2020-01-01T00:00:00Z',
    closedWithoutMergeCount: 0,
    mergedPRCount: 0,
    orgHasMergedPRs: false,
  };

  it('should add repoQualityBonus to base score', () => {
    const score = calculateViabilityScore({ ...baseParams, repoQualityBonus: 8 });
    expect(score).toBe(58); // 50 + 8
  });

  it('should default to 0 when repoQualityBonus is undefined', () => {
    const score = calculateViabilityScore(baseParams);
    expect(score).toBe(50);
  });

  it('should still clamp to 100 with quality bonus', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 1);
    const score = calculateViabilityScore({
      repoScore: 10, // +20
      hasExistingPR: false,
      isClaimed: false,
      clearRequirements: true, // +15
      hasContributionGuidelines: true, // +10
      issueUpdatedAt: recent.toISOString(), // +15
      closedWithoutMergeCount: 0,
      mergedPRCount: 0,
      orgHasMergedPRs: true, // +5
      repoQualityBonus: 12, // +12
    });
    // 50 + 20 + 12 + 15 + 15 + 10 + 5 = 127, clamped to 100
    expect(score).toBe(100);
  });

  it('should combine quality bonus with other bonuses and penalties', () => {
    const score = calculateViabilityScore({
      ...baseParams,
      repoQualityBonus: 7, // +7
      clearRequirements: true, // +15
      isClaimed: true, // -20
    });
    // 50 + 7 + 15 - 20 = 52
    expect(score).toBe(52);
  });
});

// isRateLimitError tests are in errors.test.ts (shared function moved to errors.ts)

describe('isDocOnlyIssue (#105)', () => {
  const makeItem = (labels: string[]) => ({
    html_url: 'https://github.com/owner/repo/issues/1',
    repository_url: 'https://api.github.com/repos/owner/repo',
    updated_at: '2026-01-01T00:00:00Z',
    labels: labels.map((name) => ({ name })),
  });

  it('should return true when ALL labels are doc-related', () => {
    expect(isDocOnlyIssue(makeItem(['documentation', 'typo']))).toBe(true);
  });

  it('should return true for single doc label', () => {
    expect(isDocOnlyIssue(makeItem(['docs']))).toBe(true);
  });

  it('should return true for spelling label', () => {
    expect(isDocOnlyIssue(makeItem(['spelling']))).toBe(true);
  });

  it('should return false when mixed labels (doc + non-doc)', () => {
    expect(isDocOnlyIssue(makeItem(['documentation', 'good first issue']))).toBe(false);
  });

  it('should return false when no labels', () => {
    expect(isDocOnlyIssue(makeItem([]))).toBe(false);
  });

  it('should return false for non-doc labels', () => {
    expect(isDocOnlyIssue(makeItem(['bug', 'enhancement']))).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isDocOnlyIssue(makeItem(['Documentation', 'TYPO']))).toBe(true);
  });

  it('should return false when item has no labels property', () => {
    const item = {
      html_url: 'https://github.com/owner/repo/issues/1',
      repository_url: 'https://api.github.com/repos/owner/repo',
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(isDocOnlyIssue(item)).toBe(false);
  });

  it('should handle string labels', () => {
    const item = {
      html_url: 'https://github.com/owner/repo/issues/1',
      repository_url: 'https://api.github.com/repos/owner/repo',
      updated_at: '2026-01-01T00:00:00Z',
      labels: ['documentation', 'docs'] as any,
    };
    expect(isDocOnlyIssue(item)).toBe(true);
  });

  it('should return false for mixed string labels', () => {
    const item = {
      html_url: 'https://github.com/owner/repo/issues/1',
      repository_url: 'https://api.github.com/repos/owner/repo',
      updated_at: '2026-01-01T00:00:00Z',
      labels: ['documentation', 'bug'] as any,
    };
    expect(isDocOnlyIssue(item)).toBe(false);
  });
});

describe('applyPerRepoCap (#105)', () => {
  const makeCandidate = (repo: string, score: number): any => ({
    issue: { repo, number: Math.random(), title: `Issue in ${repo}` },
    viabilityScore: score,
    searchPriority: 'normal',
    recommendation: 'approve',
  });

  it('should keep at most 2 issues per repo', () => {
    const candidates = [
      makeCandidate('owner/repo-a', 90),
      makeCandidate('owner/repo-a', 85),
      makeCandidate('owner/repo-a', 80), // Should be dropped
      makeCandidate('owner/repo-b', 75),
    ];
    const result = applyPerRepoCap(candidates, 2);
    expect(result).toHaveLength(3);
    expect(result.filter((c: any) => c.issue.repo === 'owner/repo-a')).toHaveLength(2);
    expect(result.filter((c: any) => c.issue.repo === 'owner/repo-b')).toHaveLength(1);
  });

  it('should keep first N per repo based on input order (preserves sort)', () => {
    const candidates = [
      makeCandidate('owner/repo-a', 90),
      makeCandidate('owner/repo-a', 85),
      makeCandidate('owner/repo-a', 80),
    ];
    const result = applyPerRepoCap(candidates, 2);
    expect(result).toHaveLength(2);
    expect(result[0].viabilityScore).toBe(90);
    expect(result[1].viabilityScore).toBe(85);
  });

  it('should return all candidates when no repo exceeds cap', () => {
    const candidates = [
      makeCandidate('owner/repo-a', 90),
      makeCandidate('owner/repo-b', 85),
      makeCandidate('owner/repo-c', 80),
    ];
    const result = applyPerRepoCap(candidates, 2);
    expect(result).toHaveLength(3);
  });

  it('should handle empty input', () => {
    expect(applyPerRepoCap([], 2)).toHaveLength(0);
  });

  it('should handle cap of 1', () => {
    const candidates = [
      makeCandidate('owner/repo-a', 90),
      makeCandidate('owner/repo-a', 85),
      makeCandidate('owner/repo-b', 80),
      makeCandidate('owner/repo-b', 75),
    ];
    const result = applyPerRepoCap(candidates, 1);
    expect(result).toHaveLength(2);
    expect(result[0].issue.repo).toBe('owner/repo-a');
    expect(result[1].issue.repo).toBe('owner/repo-b');
  });

  it('should handle multiple repos each at exactly the cap', () => {
    const candidates = [
      makeCandidate('owner/repo-a', 90),
      makeCandidate('owner/repo-a', 85),
      makeCandidate('owner/repo-b', 80),
      makeCandidate('owner/repo-b', 75),
      makeCandidate('owner/repo-c', 70),
    ];
    const result = applyPerRepoCap(candidates, 2);
    expect(result).toHaveLength(5); // All kept
  });

  it('should cap multiple repos simultaneously', () => {
    const candidates = [
      makeCandidate('owner/repo-a', 90),
      makeCandidate('owner/repo-a', 85),
      makeCandidate('owner/repo-a', 80), // Dropped
      makeCandidate('owner/repo-b', 75),
      makeCandidate('owner/repo-b', 70),
      makeCandidate('owner/repo-b', 65), // Dropped
      makeCandidate('owner/repo-c', 60),
    ];
    const result = applyPerRepoCap(candidates, 2);
    expect(result).toHaveLength(5);
    expect(result.filter((c: any) => c.issue.repo === 'owner/repo-a')).toHaveLength(2);
    expect(result.filter((c: any) => c.issue.repo === 'owner/repo-b')).toHaveLength(2);
    expect(result.filter((c: any) => c.issue.repo === 'owner/repo-c')).toHaveLength(1);
  });
});

describe('aiPolicyBlocklist filtering in searchIssues (#108)', () => {
  let discovery: InstanceType<typeof IssueDiscovery>;

  beforeEach(() => {
    mockStateForSearch({ config: { aiPolicyBlocklist: ['blocked/repo'] } });

    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: {
            total_count: 2,
            items: [makeSearchItem('blocked/repo', 1), makeSearchItem('allowed/repo', 2)],
          },
        }),
      },
      issues: {
        get: vi.fn().mockImplementation(({ owner, repo, issue_number }: any) =>
          Promise.resolve({
            data: {
              id: issue_number,
              html_url: `https://github.com/${owner}/${repo}/issues/${issue_number}`,
              title: `Test issue ${issue_number}`,
              labels: [{ name: 'good first issue' }],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              comments: 0,
              body: `1. Step one\n2. Step two\nThis should work correctly.\n${'x'.repeat(200)}`,
            },
          }),
        ),
        listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
      },
      repos: {
        get: vi.fn().mockResolvedValue({
          data: { open_issues_count: 5, pushed_at: new Date().toISOString(), stargazers_count: 100, forks_count: 20 },
        }),
        listCommits: vi.fn().mockResolvedValue({
          data: [{ commit: { author: { date: new Date().toISOString() } } }],
        }),
        getContent: vi.fn().mockRejectedValue(new Error('404 Not Found')),
      },
      actions: {
        listRepoWorkflows: vi.fn().mockResolvedValue({ data: { total_count: 1 } }),
      },
    };

    discovery = new IssueDiscovery('fake-token');
  });

  it('should filter out issues from blocklisted repos', async () => {
    const candidates = await discovery.searchIssues({ maxResults: 10 });
    const repos = candidates.map((c) => c.issue.repo);
    expect(repos).not.toContain('blocked/repo');
    expect(repos).toContain('allowed/repo');
  });

  it('should pass through all issues when blocklist is empty', async () => {
    mockStateForSearch({ config: { aiPolicyBlocklist: [] } });
    discovery = new IssueDiscovery('fake-token');

    const candidates = await discovery.searchIssues({ maxResults: 10 });
    const repos = candidates.map((c) => c.issue.repo);
    expect(repos).toContain('blocked/repo');
    expect(repos).toContain('allowed/repo');
  });

  it('should handle undefined blocklist gracefully', async () => {
    mockStateForSearch();
    discovery = new IssueDiscovery('fake-token');

    const candidates = await discovery.searchIssues({ maxResults: 10 });
    const repos = candidates.map((c) => c.issue.repo);
    // Neither test repo is in DEFAULT_CONFIG.aiPolicyBlocklist (['matplotlib/matplotlib']), so both pass through
    expect(repos).toContain('blocked/repo');
    expect(repos).toContain('allowed/repo');
  });

  it('should fall back to DEFAULT_CONFIG blocklist when config value is undefined', async () => {
    mockStateForSearch();
    // Include matplotlib/matplotlib (which IS in DEFAULT_CONFIG.aiPolicyBlocklist) in search results
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        total_count: 2,
        items: [makeSearchItem('matplotlib/matplotlib', 1), makeSearchItem('allowed/repo', 2)],
      },
    });
    discovery = new IssueDiscovery('fake-token');

    const candidates = await discovery.searchIssues({ maxResults: 10 });
    const repos = candidates.map((c) => c.issue.repo);
    expect(repos).not.toContain('matplotlib/matplotlib');
    expect(repos).toContain('allowed/repo');
  });
});

describe('IssueDiscovery.formatCandidate', () => {
  let discovery: InstanceType<typeof IssueDiscovery>;

  beforeEach(() => {
    mockOctokitInstance = {};
    discovery = new IssueDiscovery('fake-token');
  });

  it('should format an approved candidate with status icon', () => {
    const candidate = {
      issue: {
        repo: 'owner/repo',
        number: 42,
        title: 'Fix a bug',
        labels: ['bug', 'help wanted'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-15T00:00:00Z',
        url: 'https://github.com/owner/repo/issues/42',
      },
      vettingResult: {
        checks: { noExistingPR: true, notClaimed: true, clearRequirements: false },
        notes: ['Looks promising'],
      },
      projectHealth: {
        daysSinceLastCommit: 5,
        openIssuesCount: 100,
        ciStatus: 'passing',
        checkFailed: false,
      },
      recommendation: 'approve' as const,
      reasonsToApprove: ['Active maintainers', 'Good repo score'],
      reasonsToSkip: [],
      viabilityScore: 85,
      searchPriority: 'normal' as const,
    };

    const output = discovery.formatCandidate(candidate as any);
    expect(output).toContain('owner/repo#42');
    expect(output).toContain('Fix a bug');
    expect(output).toContain('bug, help wanted');
    expect(output).toContain('APPROVE');
    expect(output).toContain('Active maintainers');
    expect(output).toContain('Looks promising');
    expect(output).toContain('5 days ago');
  });

  it('should format a skip candidate with reasons to skip', () => {
    const candidate = {
      issue: {
        repo: 'stale/repo',
        number: 10,
        title: 'Old issue',
        labels: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-15T00:00:00Z',
        url: 'https://github.com/stale/repo/issues/10',
      },
      vettingResult: {
        checks: { noExistingPR: false },
        notes: [],
      },
      projectHealth: {
        daysSinceLastCommit: 365,
        openIssuesCount: 500,
        ciStatus: 'failing',
        checkFailed: false,
      },
      recommendation: 'skip' as const,
      reasonsToApprove: [],
      reasonsToSkip: ['PR already exists', 'Stale repo'],
      viabilityScore: 20,
      searchPriority: 'normal' as const,
    };

    const output = discovery.formatCandidate(candidate as any);
    expect(output).toContain('SKIP');
    expect(output).toContain('PR already exists');
    expect(output).toContain('Stale repo');
  });

  it('should handle checkFailed in project health', () => {
    const candidate = {
      issue: {
        repo: 'owner/repo',
        number: 1,
        title: 'Issue',
        labels: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-15T00:00:00Z',
        url: 'https://github.com/owner/repo/issues/1',
      },
      vettingResult: { checks: {}, notes: [] },
      projectHealth: {
        daysSinceLastCommit: 0,
        openIssuesCount: 10,
        ciStatus: 'unknown',
        checkFailed: true,
      },
      recommendation: 'needs_review' as const,
      reasonsToApprove: [],
      reasonsToSkip: [],
      viabilityScore: 50,
      searchPriority: 'normal' as const,
    };

    const output = discovery.formatCandidate(candidate as any);
    expect(output).toContain('unknown (API error)');
  });
});

describe('Phase 3: actively maintained repos (#349)', () => {
  let discovery: InstanceType<typeof IssueDiscovery>;

  beforeEach(() => {
    mockStateForSearch({ config: { minStars: 50 } });
    mockOctokitInstance = fullOctokitMock();
    // Phase 3 tests use .mockResolvedValueOnce chains, so reset the default impl
    mockOctokitInstance.search.issuesAndPullRequests.mockReset();
    discovery = new IssueDiscovery('fake-token');
  });

  it('should search Phase 3 when earlier phases return no results', async () => {
    // Phase 2 returns empty, Phase 3 finds a candidate
    mockOctokitInstance.search.issuesAndPullRequests
      .mockResolvedValueOnce({ data: { total_count: 0, items: [] } }) // Phase 2
      .mockResolvedValueOnce({
        data: {
          total_count: 1,
          items: [makeSearchItem('maintained/repo', 42)],
        },
      }); // Phase 3

    const candidates = await discovery.searchIssues({ maxResults: 5 });
    expect(candidates.length).toBe(1);
    expect(candidates[0].issue.repo).toBe('maintained/repo');
  });

  it('should skip Phase 3 when earlier phases fill maxResults', async () => {
    // Phase 2 returns enough results; vetIssue also calls search (checkNoExistingPR)
    // so use mockResolvedValue as a default for all vetting calls
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: { total_count: 0, items: [] },
    });
    // Phase 2 search call returns 3 items (first call)
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: {
        total_count: 3,
        items: [makeSearchItem('found/repo1', 1), makeSearchItem('found/repo2', 2), makeSearchItem('found/repo3', 3)],
      },
    });

    const candidates = await discovery.searchIssues({ maxResults: 3 });
    expect(candidates.length).toBe(3);
    // Verify no Phase 3 query was made (check that no call includes 'archived:false')
    const calls = mockOctokitInstance.search.issuesAndPullRequests.mock.calls;
    const phase3Calls = calls.filter((c: any[]) => c[0]?.q?.includes('archived:false'));
    expect(phase3Calls).toHaveLength(0);
  });

  it('should exclude repos already found in earlier phases', async () => {
    // vetIssue calls search for checkNoExistingPR — default to empty results
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: { total_count: 0, items: [] },
    });
    // Phase 2 finds already/found
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: {
        total_count: 1,
        items: [makeSearchItem('already/found', 1)],
      },
    });

    // Intercept Phase 3 call specifically. Since vetIssue also calls search,
    // use mockImplementation to check the query and return Phase 3 results when
    // the query includes 'archived:false'.
    mockOctokitInstance.search.issuesAndPullRequests.mockImplementation((params: any) => {
      if (params?.q?.includes('archived:false')) {
        return Promise.resolve({
          data: {
            total_count: 2,
            items: [makeSearchItem('already/found', 2), makeSearchItem('new/repo', 3)],
          },
        });
      }
      // Default: empty results (for vetting calls)
      return Promise.resolve({ data: { total_count: 0, items: [] } });
    });
    // Restore the Phase 2 mock (first call)
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: {
        total_count: 1,
        items: [makeSearchItem('already/found', 1)],
      },
    });

    const candidates = await discovery.searchIssues({ maxResults: 5 });
    const repos = candidates.map((c) => c.issue.repo);
    expect(repos).toContain('new/repo');
    // already/found#2 should be excluded (repo already seen in Phase 2)
    expect(repos.filter((r) => r === 'already/found')).toHaveLength(1);
  });

  it('should handle Phase 3 API errors gracefully', async () => {
    // Phase 2 returns empty
    mockOctokitInstance.search.issuesAndPullRequests
      .mockResolvedValueOnce({ data: { total_count: 0, items: [] } }) // Phase 2
      .mockRejectedValueOnce(new Error('Network error')); // Phase 3

    // Should throw with Phase 3 error details included
    await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(
      /Phase 3 \(maintained repos\): Network error/,
    );
  });

  it('should return empty array when Phase 3 hits rate limit', async () => {
    mockOctokitInstance.search.issuesAndPullRequests
      .mockResolvedValueOnce({ data: { total_count: 0, items: [] } }) // Phase 2
      .mockRejectedValueOnce(Object.assign(new Error('rate limit exceeded'), { status: 403 })); // Phase 3

    const candidates = await discovery.searchIssues({ maxResults: 5 });
    expect(candidates).toEqual([]);
  });

  it('should use stars and pushed qualifiers in Phase 3 query', async () => {
    // Phase 2 empty, Phase 3 called
    mockOctokitInstance.search.issuesAndPullRequests
      .mockResolvedValueOnce({ data: { total_count: 0, items: [] } }) // Phase 2
      .mockResolvedValueOnce({ data: { total_count: 0, items: [] } }); // Phase 3

    await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow();

    // The second call is Phase 3 — verify query includes health signals
    const phase3Call = mockOctokitInstance.search.issuesAndPullRequests.mock.calls[1];
    const query = phase3Call[0].q;
    expect(query).toContain('stars:>=50');
    expect(query).toMatch(/pushed:>=/);
    expect(query).toContain('archived:false');
  });
});

describe('Search result caching (#487)', () => {
  let discovery: InstanceType<typeof IssueDiscovery>;
  let mockCache: any;

  beforeEach(async () => {
    const { getHttpCache } = await import('./http-cache.js');
    mockCache = (getHttpCache as any)();
    mockCache.getIfFresh.mockReturnValue(null);
    mockCache.set.mockClear();

    mockOctokitInstance = fullOctokitMock();
    discovery = new IssueDiscovery('fake-token');
  });

  it('should call cache.set after a fresh search API call', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: { total_count: 0, items: [] },
    });

    await expect(discovery.searchIssues({ maxResults: 1 })).rejects.toThrow();

    // cache.set should have been called for the Phase 2 search
    expect(mockCache.set).toHaveBeenCalled();
    const setCall = mockCache.set.mock.calls[0];
    expect(setCall[0]).toMatch(/^search:/); // cache key starts with search:
  });

  it('should return cached results when getIfFresh returns data', async () => {
    const cachedData = { total_count: 0, items: [] };
    mockCache.getIfFresh.mockReturnValue(cachedData);

    await expect(discovery.searchIssues({ maxResults: 1 })).rejects.toThrow();

    // Octokit search should NOT have been called (cached results used)
    expect(mockOctokitInstance.search.issuesAndPullRequests).not.toHaveBeenCalled();
  });
});

describe('DOC_ONLY_LABELS', () => {
  it('should contain the expected documentation labels', () => {
    expect(DOC_ONLY_LABELS.has('documentation')).toBe(true);
    expect(DOC_ONLY_LABELS.has('docs')).toBe(true);
    expect(DOC_ONLY_LABELS.has('typo')).toBe(true);
    expect(DOC_ONLY_LABELS.has('spelling')).toBe(true);
  });

  it('should not contain non-doc labels', () => {
    expect(DOC_ONLY_LABELS.has('bug')).toBe(false);
    expect(DOC_ONLY_LABELS.has('good first issue')).toBe(false);
    expect(DOC_ONLY_LABELS.has('enhancement')).toBe(false);
  });
});

// ---------- helpers for saveSearchResults / formatCandidate ----------

function makeCandidate(repo: string, number: number, score: number): any {
  return {
    issue: {
      id: number,
      url: `https://github.com/${repo}/issues/${number}`,
      repo,
      number,
      title: `Test issue ${number}`,
      status: 'candidate',
      labels: ['bug'],
      createdAt: '2025-06-01T00:00:00Z',
      updatedAt: '2025-06-15T00:00:00Z',
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
      repo,
      lastCommitAt: '2025-06-10T00:00:00Z',
      daysSinceLastCommit: 5,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: 'passing' as const,
      isActive: true,
      stargazersCount: 500,
      checkFailed: false,
    },
    viabilityScore: score,
    recommendation: 'approve' as const,
    reasonsToApprove: [],
    reasonsToSkip: [],
    searchPriority: 'normal' as const,
  };
}

// Clean up temp directory after all tests
afterAll(() => {
  if (testDataDir && fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});

describe('saveSearchResults', () => {
  it('should write a markdown file and return the path', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidates = [makeCandidate('org/repo', 1, 75)];

    const outputFile = discovery.saveSearchResults(candidates);

    expect(outputFile).toContain('found-issues.md');
    expect(fs.existsSync(outputFile)).toBe(true);
  });

  it('should contain a markdown header and legend', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidates = [makeCandidate('org/repo', 1, 80)];

    const outputFile = discovery.saveSearchResults(candidates);
    const content = fs.readFileSync(outputFile, 'utf-8');

    expect(content).toContain('# Found Issues');
    expect(content).toContain('## Legend');
    expect(content).toContain('Viability score');
  });

  it('should sort candidates by viability score descending', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidates = [
      makeCandidate('org/repo', 1, 60),
      makeCandidate('org/repo', 2, 95),
      makeCandidate('org/repo', 3, 75),
    ];

    const outputFile = discovery.saveSearchResults(candidates);
    const content = fs.readFileSync(outputFile, 'utf-8');

    // Issue #2 (score 95) should appear before #3 (75) which should appear before #1 (60)
    const pos95 = content.indexOf('#2');
    const pos75 = content.indexOf('#3');
    const pos60 = content.indexOf('#1');
    expect(pos95).toBeLessThan(pos75);
    expect(pos75).toBeLessThan(pos60);
  });

  it('should include repo, issue number, and recommendation icon', () => {
    const discovery = new IssueDiscovery('test-token');
    const approved = makeCandidate('owner/project', 42, 80);
    approved.recommendation = 'approve';
    const skipped = makeCandidate('owner/project', 43, 30);
    skipped.recommendation = 'skip';

    const outputFile = discovery.saveSearchResults([approved, skipped]);
    const content = fs.readFileSync(outputFile, 'utf-8');

    expect(content).toContain('owner/project');
    expect(content).toContain('[#42]');
    expect(content).toContain('[#43]');
    // Y for approve, N for skip
    expect(content).toContain('| Y |');
    expect(content).toContain('| N |');
  });
});

describe('formatCandidate', () => {
  it('should return formatted markdown with repo and issue number', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidate = makeCandidate('org/repo', 42, 85);

    const output = discovery.formatCandidate(candidate);

    expect(output).toContain('org/repo#42');
    expect(output).toContain('Test issue 42');
    expect(output).toContain('bug');
  });

  it('should show approve icon and reasons for approved candidates', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidate = makeCandidate('org/repo', 42, 85);
    candidate.recommendation = 'approve';
    candidate.reasonsToApprove = ['Good first issue', 'Active maintainers'];

    const output = discovery.formatCandidate(candidate);

    expect(output).toContain('\u2705'); // checkmark emoji
    expect(output).toContain('APPROVE');
    expect(output).toContain('Good first issue');
    expect(output).toContain('Active maintainers');
  });

  it('should show skip icon and reasons for rejected candidates', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidate = makeCandidate('org/repo', 10, 30);
    candidate.recommendation = 'skip';
    candidate.reasonsToSkip = ['Too complex', 'Stale project'];

    const output = discovery.formatCandidate(candidate);

    expect(output).toContain('\u274C'); // cross emoji
    expect(output).toContain('SKIP');
    expect(output).toContain('Too complex');
    expect(output).toContain('Stale project');
  });

  it('should show warning icon for needs_review candidates', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidate = makeCandidate('org/repo', 5, 50);
    candidate.recommendation = 'needs_review';

    const output = discovery.formatCandidate(candidate);

    expect(output).toContain('\u26A0\uFE0F'); // warning emoji
    expect(output).toContain('NEEDS_REVIEW');
  });

  it('should include vetting check results', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidate = makeCandidate('org/repo', 7, 60);

    const output = discovery.formatCandidate(candidate);

    expect(output).toContain('Vetting Results');
    // Checks should be rendered with pass/fail markers
    expect(output).toContain('\u2713'); // checkmark for passing checks
  });

  it('should include project health information', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidate = makeCandidate('org/repo', 7, 60);

    const output = discovery.formatCandidate(candidate);

    expect(output).toContain('Project Health');
    expect(output).toContain('5 days ago');
    expect(output).toContain('passing');
  });

  it('should show unknown for project health when check failed', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidate = makeCandidate('org/repo', 7, 60);
    candidate.projectHealth.checkFailed = true;

    const output = discovery.formatCandidate(candidate);

    expect(output).toContain('unknown (API error)');
  });

  it('should include notes when present', () => {
    const discovery = new IssueDiscovery('test-token');
    const candidate = makeCandidate('org/repo', 7, 60);
    candidate.vettingResult.notes = ['Has 3 linked PRs', 'Recently discussed'];

    const output = discovery.formatCandidate(candidate);

    expect(output).toContain('Has 3 linked PRs');
    expect(output).toContain('Recently discussed');
  });
});

// ── Orchestration tests: fetchStarredRepos, getStarredReposWithRefresh, searchIssues ──

const { checkRateLimit } = await import('./github.js');

describe('fetchStarredRepos', () => {
  let discovery: InstanceType<typeof IssueDiscovery>;

  /** Set the paginate mock to yield the given pages */
  function mockPaginator(pages: Array<{ data: any[] }>): void {
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue(
      (async function* () {
        for (const page of pages) yield page;
      })(),
    );
  }

  beforeEach(() => {
    mockStateForSearch();
    mockOctokitInstance = fullOctokitMock();
    discovery = new IssueDiscovery('fake-token');
  });

  it('should paginate through starred repos', async () => {
    mockPaginator([
      { data: [{ full_name: 'org/repo1' }, { full_name: 'org/repo2' }] },
      { data: [{ full_name: 'org/repo3' }] },
    ]);

    const repos = await discovery.fetchStarredRepos();
    expect(repos).toEqual(['org/repo1', 'org/repo2', 'org/repo3']);
  });

  it('should handle Repository response type with full_name directly on object', async () => {
    mockPaginator([{ data: [{ full_name: 'direct/repo' }] }]);

    const repos = await discovery.fetchStarredRepos();
    expect(repos).toContain('direct/repo');
  });

  it('should handle StarredRepository response type with nested repo.full_name', async () => {
    mockPaginator([{ data: [{ repo: { full_name: 'nested/repo' } }] }]);

    const repos = await discovery.fetchStarredRepos();
    expect(repos).toContain('nested/repo');
  });

  it('should limit to 5 pages', async () => {
    let pagesYielded = 0;
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue(
      (async function* () {
        for (let page = 0; page < 10; page++) {
          pagesYielded++;
          yield { data: [{ full_name: `org/repo${page}` }] };
        }
      })(),
    );

    const repos = await discovery.fetchStarredRepos();
    expect(repos).toHaveLength(5);
    expect(pagesYielded).toBe(5);
  });

  it('should fall back to cached repos on API error', async () => {
    mockStateForSearch({ starredRepos: ['cached/repo1', 'cached/repo2'] });
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('API error')) };
      },
    });
    discovery = new IssueDiscovery('fake-token');

    const repos = await discovery.fetchStarredRepos();
    expect(repos).toEqual(['cached/repo1', 'cached/repo2']);
  });

  it('should warn when no cached repos available on error', async () => {
    mockStateForSearch({ starredRepos: [] });
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('Network timeout')) };
      },
    });
    discovery = new IssueDiscovery('fake-token');

    const repos = await discovery.fetchStarredRepos();
    expect(repos).toEqual([]);
  });
});

describe('getStarredReposWithRefresh', () => {
  it('should fetch from API when cache is stale', async () => {
    mockStateForSearch({ starredRepos: ['old/repo'], isStarredReposStale: true });
    mockOctokitInstance = fullOctokitMock();
    mockOctokitInstance.paginate = {
      iterator: vi.fn().mockReturnValue(
        (async function* () {
          yield { data: [{ full_name: 'fresh/repo' }] };
        })(),
      ),
    };
    const discovery = new IssueDiscovery('fake-token');

    const repos = await discovery.getStarredReposWithRefresh();
    expect(repos).toContain('fresh/repo');
  });

  it('should return cached repos when cache is fresh', async () => {
    mockStateForSearch({ starredRepos: ['cached/repo'], isStarredReposStale: false });
    mockOctokitInstance = fullOctokitMock();
    const discovery = new IssueDiscovery('fake-token');

    const repos = await discovery.getStarredReposWithRefresh();
    expect(repos).toEqual(['cached/repo']);
  });
});

describe('searchIssues orchestration', () => {
  beforeEach(async () => {
    // Restore http-cache mocks (clearAllMocks would wipe their implementations)
    const httpCache = await import('./http-cache.js');
    const mockCache = {
      getIfFresh: vi.fn().mockReturnValue(null),
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      hasInflight: vi.fn().mockReturnValue(false),
      getInflight: vi.fn().mockReturnValue(undefined),
      setInflight: vi.fn().mockReturnValue(() => {}),
    };
    vi.mocked(httpCache.getHttpCache).mockReturnValue(mockCache as any);
    vi.mocked(httpCache.cachedTimeBased).mockImplementation(
      async (cache: any, _key: string, _maxAgeMs: number, fetcher: () => Promise<unknown>) => {
        const cached = cache.getIfFresh(_key, _maxAgeMs);
        if (cached) return cached;
        const result = await fetcher();
        cache.set(_key, '', result);
        return result;
      },
    );
    vi.mocked(httpCache.cachedRequest).mockImplementation(
      async (_cache: unknown, _url: string, fetcher: (h: Record<string, string>) => Promise<{ data: unknown }>) => {
        const response = await fetcher({});
        return response.data;
      },
    );
    // Restore default rate limit mock
    vi.mocked(checkRateLimit).mockResolvedValue({
      remaining: 30,
      limit: 30,
      resetAt: new Date().toISOString(),
    });
  });

  describe('Phase 0: merged-PR and open-PR repos', () => {
    it('should search merged-PR repos with established query (no label filter)', async () => {
      mockStateForSearch({ mergedPRRepos: ['merged/repo1'] });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('repo:merged/repo1')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('merged/repo1', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(candidates[0].issue.repo).toBe('merged/repo1');
    });

    it('should search open-PR repos after merged-PR repos', async () => {
      mockStateForSearch({
        mergedPRRepos: ['merged/repo'],
        openPRRepos: ['open/repo'],
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('repo:open/repo')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('open/repo', 1)] },
          });
        }
        if (params.q?.includes('repo:merged/repo')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('merged/repo', 2)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 10 });
      const repos = candidates.map((c) => c.issue.repo);
      expect(repos).toContain('merged/repo');
      expect(repos).toContain('open/repo');
    });

    it('should skip Phase 0 when no merged/open PR repos', async () => {
      mockStateForSearch({ mergedPRRepos: [], openPRRepos: [] });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('phase2/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 5 });
      // Should still find results from later phases
      expect(candidates.length).toBeGreaterThanOrEqual(1);

      // Verify no batched repo: queries were made (Phase 0 uses `searchInRepos` which builds
      // queries with "(repo:a OR repo:b)" syntax — distinct from vetting's single repo: queries)
      const calls = mockOctokitInstance.search.issuesAndPullRequests.mock.calls;
      const batchedRepoCalls = calls.filter((c: any[]) => {
        const q = c[0]?.q ?? '';
        return q.includes('(repo:') && q.includes(' OR ');
      });
      expect(batchedRepoCalls).toHaveLength(0);
    });

    it('should cap Phase 0 repos at 10', async () => {
      const manyRepos = Array.from({ length: 15 }, (_, i) => `org/repo${i}`);
      mockStateForSearch({ mergedPRRepos: manyRepos });
      mockOctokitInstance = fullOctokitMock(() => Promise.resolve({ data: { total_count: 0, items: [] } }));
      const discovery = new IssueDiscovery('fake-token');

      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(/No issue candidates found/);

      // Check that repo: queries don't include repos beyond the cap
      const calls = mockOctokitInstance.search.issuesAndPullRequests.mock.calls;
      const allQueries = calls.map((c: any[]) => c[0]?.q ?? '').join(' ');
      // repo10 through repo14 should not appear (slice(0,10) keeps repo0-repo9)
      expect(allQueries).not.toContain('repo:org/repo10');
      expect(allQueries).not.toContain('repo:org/repo14');
    });

    it('should search open-PR repos independently when merged repos fill Phase 0a', async () => {
      // Open-PR repos that are NOT in mergedPRRepos — covers the openPhase0Repos branch
      mockStateForSearch({
        mergedPRRepos: ['merged/repo'],
        openPRRepos: ['open/repo'],
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('repo:merged/repo') && !params.q?.includes('repo:open/repo')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('merged/repo', 1)] },
          });
        }
        if (params.q?.includes('repo:open/repo')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('open/repo', 2)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 10 });
      const repos = candidates.map((c) => c.issue.repo);
      expect(repos).toContain('open/repo');
    });

    it('should omit language filter when languages includes "any"', async () => {
      mockStateForSearch({
        config: { languages: ['any'] },
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('any/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates.length).toBeGreaterThanOrEqual(1);

      // Verify no language: filter in the query
      const calls = mockOctokitInstance.search.issuesAndPullRequests.mock.calls;
      const hasLanguageFilter = calls.some((c: any[]) => c[0]?.q?.includes('language:'));
      expect(hasLanguageFilter).toBe(false);
    });

    it('should track phase0Error when all batches fail', async () => {
      mockStateForSearch({ mergedPRRepos: ['merged/repo1'] });
      const error = new Error('Server error');
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('repo:')) {
          return Promise.reject(error);
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      // Should still throw since no results were found anywhere
      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(/Phase 0/);
    });

    it('should track rateLimitHit from Phase 0', async () => {
      mockStateForSearch({ mergedPRRepos: ['merged/repo1'] });
      const rateLimitError = Object.assign(new Error('rate limit exceeded'), { status: 403 });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('repo:')) {
          return Promise.reject(rateLimitError);
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      // With rate limit and no results, should return [] with rateLimitWarning
      const candidates = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates).toEqual([]);
      expect(discovery.rateLimitWarning).toBeTruthy();
    });
  });

  describe('Phase 0.5: preferred orgs', () => {
    it('should search preferred orgs with org: filter', async () => {
      mockStateForSearch({ config: { preferredOrgs: ['myorg'] } });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('org:myorg')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('myorg/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(candidates.some((c) => c.issue.repo === 'myorg/repo')).toBe(true);
    });

    it('should skip orgs already covered by Phase 0 repos', async () => {
      mockStateForSearch({
        mergedPRRepos: ['myorg/repo1'],
        config: { preferredOrgs: ['myorg'] },
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('repo:myorg/repo1')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('myorg/repo1', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      await discovery.searchIssues({ maxResults: 10 });

      // No org: query should have been made since myorg is covered by Phase 0
      const calls = mockOctokitInstance.search.issuesAndPullRequests.mock.calls;
      const orgCalls = calls.filter((c: any[]) => c[0]?.q?.includes('org:myorg'));
      expect(orgCalls).toHaveLength(0);
    });

    it('should handle API error in preferred org search', async () => {
      mockStateForSearch({ config: { preferredOrgs: ['failorg'] } });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('org:failorg')) {
          return Promise.reject(new Error('API error'));
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      // Should include error details for the org phase
      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(/Phase 0\.5/);
    });

    it('should track rateLimitHit from preferred org search', async () => {
      mockStateForSearch({ config: { preferredOrgs: ['limitorg'] } });
      const rateLimitError = Object.assign(new Error('rate limit exceeded'), { status: 403 });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('org:limitorg')) {
          return Promise.reject(rateLimitError);
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates).toEqual([]);
      expect(discovery.rateLimitWarning).toBeTruthy();
    });
  });

  describe('Phase 1: starred repos', () => {
    it('should search starred repos excluding Phase 0 repos', async () => {
      mockStateForSearch({
        mergedPRRepos: ['merged/repo'],
        starredRepos: ['merged/repo', 'starred/repo'],
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('repo:starred/repo')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('starred/repo', 1)] },
          });
        }
        if (params.q?.includes('repo:merged/repo')) {
          return Promise.resolve({ data: { total_count: 0, items: [] } });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 10 });
      const repos = candidates.map((c) => c.issue.repo);
      expect(repos).toContain('starred/repo');
    });

    it('should skip Phase 1 when maxResults already met', async () => {
      mockStateForSearch({
        mergedPRRepos: ['merged/repo'],
        starredRepos: ['starred/repo'],
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('repo:merged/repo')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('merged/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 1 });
      expect(candidates).toHaveLength(1);

      // Verify starred/repo was NOT searched
      const calls = mockOctokitInstance.search.issuesAndPullRequests.mock.calls;
      const starredCalls = calls.filter((c: any[]) => c[0]?.q?.includes('repo:starred/repo'));
      expect(starredCalls).toHaveLength(0);
    });
  });

  describe('Phase 2: multi-tier interleaving', () => {
    it('should fire one query per scope tier when multiple scopes', async () => {
      mockStateForSearch({
        config: {
          scope: ['beginner', 'intermediate'],
          labels: [],
        },
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('beginner/repo', 1)] },
          });
        }
        if (params.q?.includes('help wanted')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('intermediate/repo', 2)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 10 });
      // Should have results from both tiers
      expect(candidates.length).toBeGreaterThanOrEqual(1);
    });

    it('should use single tier when only one scope', async () => {
      mockStateForSearch({
        config: { scope: ['beginner'], labels: [] },
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('only/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 10 });
      expect(candidates.length).toBeGreaterThanOrEqual(1);
    });

    it('should re-throw 401 errors', async () => {
      mockStateForSearch();
      const authError = Object.assign(new Error('Bad credentials'), { status: 401 });
      mockOctokitInstance = fullOctokitMock(() => Promise.reject(authError));
      const discovery = new IssueDiscovery('fake-token');

      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow('Bad credentials');
    });

    it('should handle scope with no labels gracefully', async () => {
      // Use an invalid scope that has no SCOPE_LABELS entry
      mockStateForSearch({
        config: {
          scope: ['beginner', 'nonexistent_scope' as any],
          labels: [],
        },
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('beginner/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      // Should still find results from valid scope, invalid scope is skipped
      const candidates = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates.length).toBeGreaterThanOrEqual(1);
    });

    it('should create custom pseudo-tier for labels not in any scope', async () => {
      mockStateForSearch({
        config: {
          scope: ['beginner', 'intermediate'],
          labels: ['custom-label'],
        },
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('custom-label')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('custom/repo', 1)] },
          });
        }
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('beginner/repo', 2)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 10 });
      expect(candidates.length).toBeGreaterThanOrEqual(1);

      // Verify the custom label was queried
      const calls = mockOctokitInstance.search.issuesAndPullRequests.mock.calls;
      const customCalls = calls.filter((c: any[]) => c[0]?.q?.includes('custom-label'));
      expect(customCalls.length).toBeGreaterThan(0);
    });

    it('should interleave results from multiple tiers', async () => {
      mockStateForSearch({
        config: {
          scope: ['beginner', 'intermediate'],
          labels: [],
        },
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue') && !params.q?.includes('help wanted')) {
          return Promise.resolve({
            data: {
              total_count: 2,
              items: [makeSearchItem('beginner/repo1', 1), makeSearchItem('beginner/repo2', 2)],
            },
          });
        }
        if (params.q?.includes('help wanted')) {
          return Promise.resolve({
            data: {
              total_count: 1,
              items: [makeSearchItem('intermediate/repo1', 3)],
            },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 10 });
      // Should have results from both tiers
      const repos = candidates.map((c) => c.issue.repo);
      const hasBeginner = repos.some((r) => r.startsWith('beginner/'));
      const hasIntermediate = repos.some((r) => r.startsWith('intermediate/'));
      expect(hasBeginner || hasIntermediate).toBe(true);
    });
  });

  describe('result aggregation and sorting', () => {
    it('should sort by priority > recommendation > score', async () => {
      mockStateForSearch({
        mergedPRRepos: ['merged/repo'],
        starredRepos: ['starred/repo'],
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('repo:merged/repo')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('merged/repo', 1)] },
          });
        }
        if (params.q?.includes('repo:starred/repo')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('starred/repo', 2)] },
          });
        }
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('general/repo', 3)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 10 });
      expect(candidates.length).toBeGreaterThanOrEqual(2);
      // merged_pr priority should come before starred/normal
      const mergedIdx = candidates.findIndex((c) => c.searchPriority === 'merged_pr');
      const normalIdx = candidates.findIndex((c) => c.searchPriority === 'normal');
      expect(mergedIdx).toBeGreaterThanOrEqual(0);
      expect(normalIdx).toBeGreaterThanOrEqual(0);
      expect(mergedIdx).toBeLessThan(normalIdx);
    });

    it('should apply per-repo cap of 2', async () => {
      mockStateForSearch();
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: {
              total_count: 4,
              items: [
                makeSearchItem('same/repo', 1),
                makeSearchItem('same/repo', 2),
                makeSearchItem('same/repo', 3),
                makeSearchItem('other/repo', 4),
              ],
            },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 10 });
      const sameRepoCount = candidates.filter((c) => c.issue.repo === 'same/repo').length;
      expect(sameRepoCount).toBeLessThanOrEqual(2);
    });

    it('should respect maxResults limit', async () => {
      mockStateForSearch();
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: {
              total_count: 5,
              items: [
                makeSearchItem('repo/a', 1),
                makeSearchItem('repo/b', 2),
                makeSearchItem('repo/c', 3),
                makeSearchItem('repo/d', 4),
                makeSearchItem('repo/e', 5),
              ],
            },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 3 });
      expect(candidates.length).toBeLessThanOrEqual(3);
    });
  });

  describe('Phase 2/3 vetting failures', () => {
    it('should track allVetFailed in Phase 2 when all vetting fails', async () => {
      mockStateForSearch();
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('vet-fail/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      // Make issues.get throw to cause vetting failure
      mockOctokitInstance.issues.get.mockRejectedValue(new Error('Not Found'));
      const discovery = new IssueDiscovery('fake-token');

      // When vetting fails but no rate limit, we get a ValidationError
      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(/No issue candidates found/);
    });

    it('should track rateLimitHit from Phase 2 vetting', async () => {
      mockStateForSearch();
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('ratelimit/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      // Make repos.get throw with rate limit to trigger rateLimitHit from vetter
      const rateLimitError = Object.assign(new Error('rate limit exceeded'), { status: 403 });
      mockOctokitInstance.issues.get.mockRejectedValue(rateLimitError);
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates).toEqual([]);
      expect(discovery.rateLimitWarning).toBeTruthy();
    });

    it('should track Phase 3 vetting failure', async () => {
      mockStateForSearch();
      mockOctokitInstance = fullOctokitMock((params) => {
        // Phase 2 returns empty, Phase 3 finds an issue
        if (params.q?.includes('archived:false')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('maintained/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      // Make all vetting fail
      mockOctokitInstance.issues.get.mockRejectedValue(new Error('Not Found'));
      const discovery = new IssueDiscovery('fake-token');

      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(/No issue candidates found/);
    });

    it('should track Phase 3 rateLimitHit from vetting', async () => {
      mockStateForSearch();
      mockOctokitInstance = fullOctokitMock((params) => {
        // Phase 2 returns empty, Phase 3 finds an issue
        if (params.q?.includes('archived:false')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('maintained/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      // Make vetting hit rate limit
      const rateLimitError = Object.assign(new Error('rate limit exceeded'), { status: 403 });
      mockOctokitInstance.issues.get.mockRejectedValue(rateLimitError);
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates).toEqual([]);
      expect(discovery.rateLimitWarning).toBeTruthy();
    });
  });

  describe('rate limit handling', () => {
    it('should set rateLimitWarning on low pre-flight quota', async () => {
      mockStateForSearch();
      vi.mocked(checkRateLimit).mockResolvedValueOnce({
        remaining: 2,
        limit: 30,
        resetAt: new Date().toISOString(),
      });
      mockOctokitInstance = fullOctokitMock((params) => {
        if (params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('any/repo', 1)] },
          });
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      await discovery.searchIssues({ maxResults: 5 });
      // With adaptive execution, low quota triggers phase skipping and a budget warning
      expect(discovery.rateLimitWarning).toBeTruthy();
      expect(discovery.rateLimitWarning).toContain('API quota');
    });

    it('should return [] when all phases fail due to rate limits', async () => {
      mockStateForSearch();
      const rateLimitError = Object.assign(new Error('rate limit exceeded'), { status: 403 });
      mockOctokitInstance = fullOctokitMock(() => Promise.reject(rateLimitError));
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates).toEqual([]);
      expect(discovery.rateLimitWarning).toBeTruthy();
    });

    it('should throw ValidationError when no results and no rate limits', async () => {
      mockStateForSearch();
      mockOctokitInstance = fullOctokitMock(() => Promise.resolve({ data: { total_count: 0, items: [] } }));
      const discovery = new IssueDiscovery('fake-token');

      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(/No issue candidates found/);
    });

    it('should skip phases 0.5, 1, 2, 3 when budget is critical (< 10)', async () => {
      mockStateForSearch({
        mergedPRRepos: ['merged/repo'],
        starredRepos: ['starred/repo1'],
        preferredOrgs: ['preferred-org'],
      });
      vi.mocked(checkRateLimit).mockResolvedValueOnce({
        remaining: 5, // below CRITICAL_BUDGET_THRESHOLD (10)
        limit: 30,
        resetAt: new Date().toISOString(),
      });
      const queriesIssued: string[] = [];
      mockOctokitInstance = fullOctokitMock((params) => {
        queriesIssued.push(params.q || '');
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      await discovery.searchIssues({ maxResults: 5 });

      // Only Phase 0 queries should be present (repo: queries for merged repos)
      // No org: queries (Phase 0.5), no starred repo queries (Phase 1),
      // no general label queries (Phase 2), no maintained-repo queries (Phase 3)
      const hasOrgQuery = queriesIssued.some((q) => q.includes('org:'));
      const hasGeneralQuery = queriesIssued.some((q) => q.includes('good first issue') && !q.includes('repo:'));
      const hasMaintainedQuery = queriesIssued.some((q) => q.includes('archived:false'));
      expect(hasOrgQuery).toBe(false);
      expect(hasGeneralQuery).toBe(false);
      expect(hasMaintainedQuery).toBe(false);
      expect(discovery.rateLimitWarning).toContain('critically low API quota');
    });

    it('should skip phases 2 and 3 but run 0.5 and 1 when budget is low (< 20)', async () => {
      mockStateForSearch({
        starredRepos: ['starred/repo1'],
        preferredOrgs: ['preferred-org'],
      });
      vi.mocked(checkRateLimit).mockResolvedValueOnce({
        remaining: 15, // between CRITICAL (10) and LOW (20) thresholds
        limit: 30,
        resetAt: new Date().toISOString(),
      });
      const queriesIssued: string[] = [];
      mockOctokitInstance = fullOctokitMock((params) => {
        queriesIssued.push(params.q || '');
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      await discovery.searchIssues({ maxResults: 5 });

      // Phase 0.5 (org:) and Phase 1 (starred repo:) should run
      // Phase 2 (general label search) and Phase 3 (maintained repos) should be skipped
      const hasGeneralQuery = queriesIssued.some(
        (q) => q.includes('good first issue') && !q.includes('repo:') && !q.includes('org:'),
      );
      const hasMaintainedQuery = queriesIssued.some((q) => q.includes('archived:false'));
      expect(hasGeneralQuery).toBe(false);
      expect(hasMaintainedQuery).toBe(false);
      expect(discovery.rateLimitWarning).toContain('low API quota');
    });

    it('should use conservative budget when checkRateLimit fails', async () => {
      mockStateForSearch();
      vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('Network timeout'));
      mockOctokitInstance = fullOctokitMock(() => Promise.resolve({ data: { total_count: 0, items: [] } }));
      const discovery = new IssueDiscovery('fake-token');

      await discovery.searchIssues({ maxResults: 5 });

      // Conservative budget should skip heavy phases and set warning
      expect(discovery.rateLimitWarning).toContain('API quota');
    });

    it('should set partial warning on rate-limited search with some results', async () => {
      mockStateForSearch();
      let callCount = 0;
      const rateLimitError = Object.assign(new Error('rate limit exceeded'), { status: 403 });
      mockOctokitInstance = fullOctokitMock((params) => {
        callCount++;
        // First call (Phase 2) returns results, Phase 3 hits rate limit
        if (callCount === 1 && params.q?.includes('good first issue')) {
          return Promise.resolve({
            data: { total_count: 1, items: [makeSearchItem('partial/repo', 1)] },
          });
        }
        if (params.q?.includes('archived:false')) {
          return Promise.reject(rateLimitError);
        }
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      });
      const discovery = new IssueDiscovery('fake-token');

      const candidates = await discovery.searchIssues({ maxResults: 10 });
      expect(candidates.length).toBeGreaterThan(0);
      expect(discovery.rateLimitWarning).toContain('incomplete');
    });
  });
});
