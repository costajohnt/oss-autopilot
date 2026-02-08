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
    getHighScoringRepos: () => [],
    getLowScoringRepos: () => [],
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
    });
    // 50 + 10 + 15 + 15 + 10 - 20 = 80
    expect(score).toBe(80);
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
