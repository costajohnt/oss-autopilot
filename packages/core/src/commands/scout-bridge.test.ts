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

vi.mock('./skip-file-parser.js', () => ({
  loadSkippedIssues: vi.fn(() => []),
}));

import { getStateManager } from '../core/index.js';
import { buildScoutState, adaptScoutLinkedPR } from './scout-bridge.js';
import { loadSkippedIssues } from './skip-file-parser.js';
import { makeAgentState, makeDailyDigest, makeFetchedPR, makeStateManagerMock } from '../core/test-utils.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockLoadSkippedIssues = vi.mocked(loadSkippedIssues);

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

  it('should project ephemeral openPRs from last digest into scout openPRs (url, title, openedAt)', () => {
    const state = makeAgentState({
      lastDigest: makeDailyDigest({
        openPRs: [
          makeFetchedPR({
            repo: 'owner/repo',
            number: 42,
            title: 'feat: add thing',
            createdAt: '2026-03-01T00:00:00Z',
          }),
          makeFetchedPR({
            repo: 'other/repo',
            number: 7,
            title: 'fix: bug',
            createdAt: '2026-03-15T00:00:00Z',
          }),
        ],
      }),
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.openPRs).toHaveLength(2);
    expect(result.openPRs[0]).toEqual({
      url: 'https://github.com/owner/repo/pull/42',
      title: 'feat: add thing',
      openedAt: '2026-03-01T00:00:00Z',
    });
    expect(result.openPRs[1]).toEqual({
      url: 'https://github.com/other/repo/pull/7',
      title: 'fix: bug',
      openedAt: '2026-03-15T00:00:00Z',
    });
  });

  it('should return [] for openPRs when no digest is present', () => {
    const state = makeAgentState({ lastDigest: undefined });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.openPRs).toEqual([]);
  });

  it('should always set savedResults to an empty array', () => {
    const state = makeAgentState();
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.savedResults).toEqual([]);
  });

  it('should populate skippedIssues from the parsed skip file', () => {
    const state = makeAgentState({
      config: { skippedIssuesPath: '/vault/open-source/skipped-issues.md' },
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const skipped = [
      {
        url: 'https://github.com/owncast/owncast/issues/4883',
        repo: 'owncast/owncast',
        number: 4883,
        title: '',
        skippedAt: '2026-04-15T00:00:00.000Z',
      },
    ];
    mockLoadSkippedIssues.mockReturnValueOnce(skipped);

    const result = buildScoutState();

    expect(mockLoadSkippedIssues).toHaveBeenCalledWith('/vault/open-source/skipped-issues.md');
    expect(result.skippedIssues).toEqual(skipped);
  });

  it('should default skippedIssues to [] when parser returns empty', () => {
    const state = makeAgentState({ config: { skippedIssuesPath: undefined } });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));
    mockLoadSkippedIssues.mockReturnValueOnce([]);

    const result = buildScoutState();

    expect(result.skippedIssues).toEqual([]);
  });
});

describe('adaptScoutLinkedPR', () => {
  it('returns null for null/undefined input', () => {
    expect(adaptScoutLinkedPR(null)).toBeNull();
    expect(adaptScoutLinkedPR(undefined)).toBeNull();
  });

  it('folds merged=true into state="merged"', () => {
    const result = adaptScoutLinkedPR({
      number: 1,
      author: 'octocat',
      state: 'closed',
      merged: true,
      url: 'https://github.com/owner/repo/pull/1',
    });
    expect(result).toEqual({ author: { login: 'octocat' }, state: 'merged' });
  });

  it('preserves "open" state when merged=false', () => {
    const result = adaptScoutLinkedPR({
      number: 1,
      author: 'octocat',
      state: 'open',
      merged: false,
      url: 'https://github.com/owner/repo/pull/1',
    });
    expect(result).toEqual({ author: { login: 'octocat' }, state: 'open' });
  });

  it('propagates updatedAt when present (scout 0.9.0)', () => {
    const result = adaptScoutLinkedPR({
      number: 1,
      author: 'octocat',
      state: 'open',
      merged: false,
      url: 'https://github.com/owner/repo/pull/1',
      updatedAt: '2026-04-01T12:34:56Z',
    });
    expect(result).toEqual({
      author: { login: 'octocat' },
      state: 'open',
      updatedAt: '2026-04-01T12:34:56Z',
    });
  });

  it('omits updatedAt entirely when scout did not provide one', () => {
    const result = adaptScoutLinkedPR({
      number: 1,
      author: 'octocat',
      state: 'open',
      merged: false,
      url: 'https://github.com/owner/repo/pull/1',
    });
    expect(result).not.toBeNull();
    // Use `in` to assert the field is absent rather than just undefined,
    // since downstream JSON serializers strip explicit `undefined` values
    // and we want the absence to be a structural property of the object.
    expect('updatedAt' in (result as object)).toBe(false);
  });
});
