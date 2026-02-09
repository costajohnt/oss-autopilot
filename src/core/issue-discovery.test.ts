/**
 * Tests for IssueDiscovery pure functions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockOctokitInstance: any;

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => mockOctokitInstance),
}));

vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: () => ({
      config: { githubUsername: 'testuser', trustedProjects: [], starredRepos: [] },
      repoScores: {},
    }),
    getStarredRepos: () => [],
    getReposWithMergedPRs: () => [],
    getLowScoringRepos: () => [],
    getRepoScore: () => undefined,
  })),
}));

const { IssueDiscovery } = await import('./issue-discovery.js');

describe('IssueDiscovery.calculateViabilityScore', () => {
  let discovery: InstanceType<typeof IssueDiscovery>;

  beforeEach(() => {
    mockOctokitInstance = {};
    discovery = new IssueDiscovery('fake-token');
  });

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
    const score = discovery.calculateViabilityScore(baseParams);
    expect(score).toBe(50);
  });

  it('should add repo score contribution (score * 2)', () => {
    const score = discovery.calculateViabilityScore({ ...baseParams, repoScore: 8 });
    expect(score).toBe(50 + 16); // 8 * 2 = 16
  });

  it('should add +20 for max repo score of 10', () => {
    const score = discovery.calculateViabilityScore({ ...baseParams, repoScore: 10 });
    expect(score).toBe(50 + 20);
  });

  it('should add +15 for clear requirements', () => {
    const score = discovery.calculateViabilityScore({ ...baseParams, clearRequirements: true });
    expect(score).toBe(50 + 15);
  });

  it('should add +15 for freshness (updated within 14 days)', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      issueUpdatedAt: recent.toISOString(),
    });
    expect(score).toBe(50 + 15);
  });

  it('should add partial freshness bonus for 15-30 day old issues', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 22); // 22 days old
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      issueUpdatedAt: recent.toISOString(),
    });
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThan(50 + 15);
  });

  it('should add no freshness bonus for 31+ day old issues', () => {
    const old = new Date();
    old.setDate(old.getDate() - 45);
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      issueUpdatedAt: old.toISOString(),
    });
    expect(score).toBe(50);
  });

  it('should add +10 for contribution guidelines', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      hasContributionGuidelines: true,
    });
    expect(score).toBe(50 + 10);
  });

  it('should subtract -30 for existing PR', () => {
    const score = discovery.calculateViabilityScore({ ...baseParams, hasExistingPR: true });
    expect(score).toBe(50 - 30);
  });

  it('should subtract -20 for claimed issue', () => {
    const score = discovery.calculateViabilityScore({ ...baseParams, isClaimed: true });
    expect(score).toBe(50 - 20);
  });

  it('should clamp to 0 when penalties exceed score', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      hasExistingPR: true,
      isClaimed: true,
    });
    expect(score).toBe(0); // 50 - 30 - 20 = 0
  });

  it('should clamp to 100 when bonuses are maxed', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 1);
    const score = discovery.calculateViabilityScore({
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
    const score = discovery.calculateViabilityScore({
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

  it('should subtract -15 for closed-without-merge history with no merges', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      closedWithoutMergeCount: 2,
      mergedPRCount: 0,
    });
    expect(score).toBe(50 - 15);
  });

  it('should NOT subtract penalty when closed PRs exist but merges also exist', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      closedWithoutMergeCount: 1,
      mergedPRCount: 2,
    });
    // No -15 penalty because mergedPRCount > 0
    expect(score).toBe(50);
  });

  it('should NOT subtract penalty when closedWithoutMergeCount is 0', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      closedWithoutMergeCount: 0,
      mergedPRCount: 0,
    });
    expect(score).toBe(50);
  });

  it('should apply closed-PR penalty alongside other penalties', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      hasExistingPR: true, // -30
      closedWithoutMergeCount: 1, // -15
      mergedPRCount: 0,
    });
    // 50 - 30 - 15 = 5
    expect(score).toBe(5);
  });

  it('should add +5 for org affinity', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      orgHasMergedPRs: true,
    });
    expect(score).toBe(55);
  });

  it('should NOT add org affinity bonus when false', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      orgHasMergedPRs: false,
    });
    expect(score).toBe(50);
  });

  it('should combine org affinity with other bonuses', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 3);
    const score = discovery.calculateViabilityScore({
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

describe('IssueDiscovery.analyzeRequirements (via vetIssue internals)', () => {
  // analyzeRequirements is private, but we can test the concept through calculateViabilityScore
  // or by accessing it via the class. For now, let's test its behavior indirectly
  // by observing that it's called in vetIssue. But since vetIssue needs API mocking,
  // let's test the logic directly via type assertion.

  let discovery: any; // Use any to access private method

  beforeEach(() => {
    mockOctokitInstance = {};
    discovery = new IssueDiscovery('fake-token');
  });

  it('should return false for empty body', () => {
    expect(discovery.analyzeRequirements('')).toBe(false);
  });

  it('should return false for very short body (< 50 chars)', () => {
    expect(discovery.analyzeRequirements('Fix the bug')).toBe(false);
  });

  it('should return true for body with numbered steps and expected behavior', () => {
    const body = `
      This feature should add pagination to the API.
      1. Add page parameter to GET /items
      2. Return 20 items per page
      3. Include next/prev links in response
      The API should return a 400 error for invalid page numbers.
    `;
    expect(discovery.analyzeRequirements(body)).toBe(true);
  });

  it('should return true for body with code block and expected behavior', () => {
    const body = `
      The function currently throws an error when passed null:
      \`\`\`
      TypeError: Cannot read property 'name' of null
      \`\`\`
      It should handle null gracefully and return an empty string instead.
    `;
    expect(discovery.analyzeRequirements(body)).toBe(true);
  });

  it('should return true for long body with bullet points', () => {
    const body = `
      We need to update the dashboard to show contribution metrics.
      - Add a new section for monthly stats
      - Include a chart showing PRs over time
      - The chart should update automatically when new data arrives
      This will help users track their contribution velocity.
    `;
    expect(discovery.analyzeRequirements(body)).toBe(true);
  });

  it('should return false for body with only length but no structure', () => {
    const body = 'a'.repeat(201); // Long but no steps, code blocks, or expected behavior
    expect(discovery.analyzeRequirements(body)).toBe(false);
  });

  it('should return true for body > 200 chars with expected behavior keywords', () => {
    const body = `
      The current implementation does not handle edge cases well. When a user
      submits a form with special characters, the system should validate the input
      and display an appropriate error message. Currently it silently drops the data.
      We want to improve user experience by providing clear feedback.
    `;
    expect(discovery.analyzeRequirements(body)).toBe(true);
  });
});

describe('IssueDiscovery.vetIssue inconclusive downgrade', () => {
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
          data: { open_issues_count: 5, pushed_at: '2026-02-01T00:00:00Z' },
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

  it('should approve when all checks pass definitively', async () => {
    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.recommendation).toBe('approve');
  });

  it('should downgrade to needs_review when checkNoExistingPR is inconclusive', async () => {
    // Make the search call throw (simulating rate limit / API error)
    mockOctokitInstance.search.issuesAndPullRequests.mockRejectedValue(
      new Error('API rate limit exceeded')
    );

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.recommendation).toBe('needs_review');
    expect(candidate.vettingResult.notes).toContainEqual(
      expect.stringContaining('Could not verify absence of existing PRs')
    );
    expect(candidate.vettingResult.notes).toContainEqual(
      expect.stringContaining('Recommendation downgraded')
    );
  });

  it('should downgrade to needs_review when checkNotClaimed is inconclusive', async () => {
    // Issue has comments, so checkNotClaimed will try to fetch them
    mockOctokitInstance.issues.get.mockResolvedValue({
      data: { ...makeGhIssue(), comments: 3 },
    });
    // Make paginate throw (simulating API error)
    mockOctokitInstance.paginate = vi.fn().mockRejectedValue(
      new Error('Server error')
    );

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.recommendation).toBe('needs_review');
    expect(candidate.vettingResult.notes).toContainEqual(
      expect.stringContaining('Could not verify claim status')
    );
  });

  it('should downgrade to needs_review when project health check fails', async () => {
    // Make repos.get throw (simulating API error)
    mockOctokitInstance.repos.get.mockRejectedValue(
      new Error('Not Found')
    );

    const candidate = await discovery.vetIssue('https://github.com/owner/repo/issues/42');
    expect(candidate.recommendation).toBe('needs_review');
    expect(candidate.vettingResult.notes).toContainEqual(
      expect.stringContaining('Could not verify project activity')
    );
  });
});
