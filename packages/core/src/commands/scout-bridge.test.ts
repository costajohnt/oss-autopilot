/**
 * Tests for scout-bridge buildScoutState()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  requireGitHubToken: vi.fn(),
}));

vi.mock('@oss-scout/core', () => ({
  createScout: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { buildScoutState } from './scout-bridge.js';
import { makeAgentState, makeStateManagerMock } from '../core/test-utils.js';

const mockGetStateManager = vi.mocked(getStateManager);

describe('buildScoutState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should map all standard config fields correctly', () => {
    const state = makeAgentState({
      config: {
        githubUsername: 'octocat',
        languages: ['TypeScript', 'Rust'],
        labels: ['good first issue', 'help wanted'],
        scope: ['all'],
        excludeRepos: ['owner/excluded'],
        excludeOrgs: ['bad-org'],
        aiPolicyBlocklist: ['matplotlib/matplotlib'],
        preferredOrgs: ['microsoft', 'vercel'],
        projectCategories: ['web', 'cli'],
        minStars: 100,
        maxIssueAgeDays: 30,
        includeDocIssues: false,
        minRepoScoreThreshold: 6,
        persistence: 'local',
        starredRepos: ['owner/starred'],
        starredReposLastFetched: '2026-01-01T00:00:00Z',
      },
      repoScores: {
        'owner/repo': {
          repo: 'owner/repo',
          score: 7,
          mergedPRCount: 2,
          closedWithoutMergeCount: 0,
          avgResponseDays: null,
          lastEvaluatedAt: '2026-01-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
      },
      lastRunAt: '2026-03-01T12:00:00Z',
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.version).toBe(1);
    expect(result.preferences.githubUsername).toBe('octocat');
    expect(result.preferences.languages).toEqual(['TypeScript', 'Rust']);
    expect(result.preferences.labels).toEqual(['good first issue', 'help wanted']);
    expect(result.preferences.scope).toEqual(['all']);
    expect(result.preferences.excludeRepos).toEqual(['owner/excluded']);
    expect(result.preferences.excludeOrgs).toEqual(['bad-org']);
    expect(result.preferences.aiPolicyBlocklist).toEqual(['matplotlib/matplotlib']);
    expect(result.preferences.projectCategories).toEqual(['web', 'cli']);
    expect(result.preferences.minStars).toBe(100);
    expect(result.preferences.maxIssueAgeDays).toBe(30);
    expect(result.preferences.includeDocIssues).toBe(false);
    expect(result.preferences.minRepoScoreThreshold).toBe(6);
    expect(result.preferences.persistence).toBe('local');
    expect(result.starredRepos).toEqual(['owner/starred']);
    expect(result.starredReposLastFetched).toBe('2026-01-01T00:00:00Z');
    expect(result.repoScores).toBe(state.repoScores);
    expect(result.lastRunAt).toBe('2026-03-01T12:00:00Z');
    expect(result.savedResults).toEqual([]);
  });

  it.each([
    ['excludeOrgs', 'excludeOrgs'],
    ['projectCategories', 'projectCategories'],
  ] as const)('should default %s to [] when undefined in config', (field) => {
    const state = makeAgentState({ config: { [field]: undefined } });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.preferences[field]).toEqual([]);
  });

  it('should correctly project mergedPRs to url, title, mergedAt', () => {
    const state = makeAgentState({
      mergedPRs: [
        { url: 'https://github.com/owner/repo/pull/1', title: 'feat: add button', mergedAt: '2026-02-01T00:00:00Z' },
        {
          url: 'https://github.com/owner/repo/pull/2',
          title: 'fix: typo',
          mergedAt: '2026-02-15T00:00:00Z',
          learningsExtractedAt: '2026-02-16T00:00:00Z',
        },
      ],
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.mergedPRs).toHaveLength(2);
    expect(result.mergedPRs[0]).toEqual({
      url: 'https://github.com/owner/repo/pull/1',
      title: 'feat: add button',
      mergedAt: '2026-02-01T00:00:00Z',
    });
    expect(result.mergedPRs[1]).toEqual({
      url: 'https://github.com/owner/repo/pull/2',
      title: 'fix: typo',
      mergedAt: '2026-02-15T00:00:00Z',
    });
    // learningsExtractedAt should not be projected
    expect((result.mergedPRs[1] as any).learningsExtractedAt).toBeUndefined();
  });

  it('should correctly project closedPRs to url, title, closedAt', () => {
    const state = makeAgentState({
      closedPRs: [
        { url: 'https://github.com/owner/repo/pull/3', title: 'wip: unfinished', closedAt: '2026-01-10T00:00:00Z' },
      ],
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.closedPRs).toHaveLength(1);
    expect(result.closedPRs[0]).toEqual({
      url: 'https://github.com/owner/repo/pull/3',
      title: 'wip: unfinished',
      closedAt: '2026-01-10T00:00:00Z',
    });
  });

  it.each([
    ['mergedPRs', [] as any[]],
    ['mergedPRs', undefined],
    ['closedPRs', [] as any[]],
    ['closedPRs', undefined],
  ] as const)('should return [] for %s when value is %j', (field, value) => {
    const state = makeAgentState({ [field]: value });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result[field]).toEqual([]);
  });

  it('should always set savedResults to an empty array', () => {
    const state = makeAgentState();
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.savedResults).toEqual([]);
  });
});
