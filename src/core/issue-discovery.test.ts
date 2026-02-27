/**
 * Tests for IssueDiscovery pure functions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockOctokitInstance: any;

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => mockOctokitInstance),
  checkRateLimit: vi.fn().mockResolvedValue({ remaining: 30, limit: 30, resetAt: new Date().toISOString() }),
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

const {
  IssueDiscovery,
  isLabelFarming,
  hasTemplatedTitle,
  detectLabelFarmingRepos,
  calculateRepoQualityBonus,
  isDocOnlyIssue,
  applyPerRepoCap,
  DOC_ONLY_LABELS,
  BEGINNER_LABELS: _BEGINNER_LABELS,
} = await import('./issue-discovery.js');

const { getStateManager } = await import('./state.js');

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

  it('should add +15 for merged PR in this repo (#99)', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      mergedPRCount: 1,
    });
    expect(score).toBe(50 + 15);
  });

  it('should add +15 for merged PR even with multiple merges (#99)', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      mergedPRCount: 5,
    });
    expect(score).toBe(50 + 15);
  });

  it('should NOT add merged PR bonus when mergedPRCount is 0', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      mergedPRCount: 0,
    });
    expect(score).toBe(50);
  });

  it('should stack merged PR bonus (+15) with org affinity (+5) for +20 total relationship bonus', () => {
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      mergedPRCount: 2,
      orgHasMergedPRs: true,
    });
    // 50 + 15 (merged PR) + 5 (org affinity) = 70
    expect(score).toBe(70);
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
    // No -15 penalty because mergedPRCount > 0, but +15 merged PR bonus applies
    expect(score).toBe(50 + 15);
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
    issueUpdatedAt: '2020-01-01T00:00:00Z',
    closedWithoutMergeCount: 0,
    mergedPRCount: 0,
    orgHasMergedPRs: false,
  };

  it('should add repoQualityBonus to base score', () => {
    const score = discovery.calculateViabilityScore({ ...baseParams, repoQualityBonus: 8 });
    expect(score).toBe(58); // 50 + 8
  });

  it('should default to 0 when repoQualityBonus is undefined', () => {
    const score = discovery.calculateViabilityScore(baseParams);
    expect(score).toBe(50);
  });

  it('should still clamp to 100 with quality bonus', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 1);
    const score = discovery.calculateViabilityScore({
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
    const score = discovery.calculateViabilityScore({
      ...baseParams,
      repoQualityBonus: 7, // +7
      clearRequirements: true, // +15
      isClaimed: true, // -20
    });
    // 50 + 7 + 15 - 20 = 52
    expect(score).toBe(52);
  });
});

describe('IssueDiscovery.isRateLimitError', () => {
  const isRateLimitError = (IssueDiscovery as any).isRateLimitError;

  it('should return true for HTTP 429', () => {
    const error = Object.assign(new Error('Too Many Requests'), { status: 429 });
    expect(isRateLimitError(error)).toBe(true);
  });

  it('should return true for HTTP 403 with "rate limit" in message', () => {
    const error = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    expect(isRateLimitError(error)).toBe(true);
  });

  it('should return false for HTTP 403 without rate limit message', () => {
    const error = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    expect(isRateLimitError(error)).toBe(false);
  });

  it('should return false for HTTP 500', () => {
    const error = Object.assign(new Error('Internal Server Error'), { status: 500 });
    expect(isRateLimitError(error)).toBe(false);
  });

  it('should return false for errors without status', () => {
    expect(isRateLimitError(new Error('Network timeout'))).toBe(false);
  });

  it('should return false for null/undefined', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

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

  const makeSearchItem = (repo: string, num: number) => ({
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
  });

  function mockStateWithBlocklist(aiPolicyBlocklist?: string[]): void {
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
    };
    if (aiPolicyBlocklist !== undefined) {
      config.aiPolicyBlocklist = aiPolicyBlocklist;
    }
    (getStateManager as any).mockReturnValue({
      getState: () => ({ config, repoScores: {}, activeIssues: [] }),
      getStarredRepos: () => [],
      isStarredReposStale: () => false,
      getReposWithMergedPRs: () => [],
      getReposWithOpenPRs: () => [],
      getLowScoringRepos: () => [],
      getRepoScore: () => undefined,
    });
  }

  beforeEach(() => {
    mockStateWithBlocklist(['blocked/repo']);

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
    mockStateWithBlocklist([]);
    discovery = new IssueDiscovery('fake-token');

    const candidates = await discovery.searchIssues({ maxResults: 10 });
    const repos = candidates.map((c) => c.issue.repo);
    expect(repos).toContain('blocked/repo');
    expect(repos).toContain('allowed/repo');
  });

  it('should handle undefined blocklist gracefully', async () => {
    mockStateWithBlocklist(undefined);
    discovery = new IssueDiscovery('fake-token');

    const candidates = await discovery.searchIssues({ maxResults: 10 });
    const repos = candidates.map((c) => c.issue.repo);
    // Neither test repo is in DEFAULT_CONFIG.aiPolicyBlocklist (['matplotlib/matplotlib']), so both pass through
    expect(repos).toContain('blocked/repo');
    expect(repos).toContain('allowed/repo');
  });

  it('should fall back to DEFAULT_CONFIG blocklist when config value is undefined', async () => {
    mockStateWithBlocklist(undefined);
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
