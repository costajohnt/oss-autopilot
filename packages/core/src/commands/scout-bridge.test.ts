/**
 * Tests for scout-bridge buildScoutState()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: vi.fn(),
    requireGitHubToken: vi.fn(),
  };
});

vi.mock('@oss-scout/core', () => ({
  createScout: vi.fn(),
}));

vi.mock('./skip-file-parser.js', () => ({
  loadSkippedIssuesDetailed: vi.fn(() => ({ issues: [] })),
}));

import { getStateManager } from '../core/index.js';
import {
  adaptScoutLinkedPR,
  buildCandidateLinkedPR,
  buildScoutState,
  type ScoutBridgeDiagnostics,
} from './scout-bridge.js';
import { loadSkippedIssuesDetailed } from './skip-file-parser.js';
import { makeAgentState, makeDailyDigest, makeFetchedPR, makeStateManagerMock } from '../core/test-utils.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockLoadSkippedIssuesDetailed = vi.mocked(loadSkippedIssuesDetailed);

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
        scope: ['beginner'],
        excludeRepos: ['owner/excluded'],
        excludeOrgs: ['bad-org'],
        aiPolicyBlocklist: ['matplotlib/matplotlib'],
        preferredOrgs: ['microsoft', 'vercel'],
        projectCategories: ['devtools', 'infrastructure'],
        minStars: 100,
        maxIssueAgeDays: 30,
        skipBroadWhenSufficientResults: 3,
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
    expect(result.preferences.scope).toEqual(['beginner']);
    expect(result.preferences.excludeRepos).toEqual(['owner/excluded']);
    expect(result.preferences.excludeOrgs).toEqual(['bad-org']);
    expect(result.preferences.preferredOrgs).toEqual(['microsoft', 'vercel']);
    expect(result.preferences.aiPolicyBlocklist).toEqual(['matplotlib/matplotlib']);
    expect(result.preferences.projectCategories).toEqual(['devtools', 'infrastructure']);
    expect(result.preferences.minStars).toBe(100);
    expect(result.preferences.maxIssueAgeDays).toBe(30);
    // Read from config (not the old hardcoded 15) so users can tune/disable it.
    expect(result.preferences.skipBroadWhenSufficientResults).toBe(3);
    expect(result.preferences.includeDocIssues).toBe(false);
    expect(result.preferences.minRepoScoreThreshold).toBe(6);
    expect(result.preferences.persistence).toBe('local');
    expect(result.starredRepos).toEqual(['owner/starred']);
    expect(result.starredReposLastFetched).toBe('2026-01-01T00:00:00Z');
    expect(result.repoScores).toBe(state.repoScores);
    expect(result.lastRunAt).toBe('2026-03-01T12:00:00Z');
    expect(result.savedResults).toEqual([]);
  });

  it('reads avoidRepos and boostIssueTypes from config into ScoutPreferences (#1464)', () => {
    const state = makeAgentState({
      config: {
        avoidRepos: ['owner/meh', 'other/noisy'],
        boostIssueTypes: ['bug', 'good first issue'],
      },
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.preferences.avoidRepos).toEqual(['owner/meh', 'other/noisy']);
    expect(result.preferences.boostIssueTypes).toEqual(['bug', 'good first issue']);
  });

  it.each(['avoidRepos', 'boostIssueTypes'] as const)('should default %s to [] when undefined in config', (field) => {
    const state = makeAgentState({ config: { [field]: undefined } });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.preferences[field]).toEqual([]);
  });

  it('threads strategy-derived bias into ScoutPreferences once the merged-PR floor is met (#1464)', () => {
    // 10 merged PRs in one repo crosses STRATEGY_MIN_PRS, so computeStrategy
    // recommends that repo and its language — the same derivation runSearch
    // passes per-call (#1244) must land in the bridge-built preferences so
    // surfaces without per-call knobs (features) share the bias.
    const mergedPRs = Array.from({ length: 10 }, (_, i) => ({
      url: `https://github.com/owner/fav/pull/${i + 1}`,
      title: `fix: thing ${i + 1}`,
      mergedAt: '2026-02-01T00:00:00Z',
    }));
    const state = makeAgentState({
      mergedPRs,
      repoScores: {
        'owner/fav': {
          repo: 'owner/fav',
          score: 8,
          mergedPRCount: 10,
          closedWithoutMergeCount: 0,
          avgResponseDays: null,
          lastEvaluatedAt: '2026-02-01T00:00:00Z',
          language: 'TypeScript',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
      },
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.preferences.preferRepos).toEqual(['owner/fav']);
    expect(result.preferences.preferLanguages).toEqual(['TypeScript']);
    expect(result.preferences.diversityRatio).toBe(0.2);
  });

  it('falls back to no-bias preferences below the strategy merged-PR floor (#1464)', () => {
    const state = makeAgentState();
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.preferences.preferRepos).toEqual([]);
    expect(result.preferences.preferLanguages).toEqual([]);
    expect(result.preferences.avoidRepos).toEqual([]);
    expect(result.preferences.boostIssueTypes).toEqual([]);
  });

  it.each(['excludeOrgs', 'projectCategories', 'preferredOrgs'] as const)(
    'should default %s to [] when undefined in config',
    (field) => {
      const state = makeAgentState({ config: { [field]: undefined } });
      mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

      const result = buildScoutState();

      expect(result.preferences[field]).toEqual([]);
    },
  );

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

  it('sets savedResults to an empty array when the seen-set is empty', () => {
    const state = makeAgentState();
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.savedResults).toEqual([]);
  });

  it('maps the search seen-set into savedResults for rotation (#1528)', () => {
    const lastSeenAt = '2026-06-20T00:00:00.000Z';
    const state = makeAgentState({
      searchSeen: [{ url: 'https://github.com/o/r/issues/1', lastSeenAt }],
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));

    const result = buildScoutState();

    expect(result.savedResults).toHaveLength(1);
    // Only issueUrl + lastSeenAt drive scout's rotation; both must round-trip.
    expect(result.savedResults[0].issueUrl).toBe('https://github.com/o/r/issues/1');
    expect(result.savedResults[0].lastSeenAt).toBe(lastSeenAt);
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
    mockLoadSkippedIssuesDetailed.mockReturnValueOnce({ issues: skipped });

    const result = buildScoutState();

    expect(mockLoadSkippedIssuesDetailed).toHaveBeenCalledWith('/vault/open-source/skipped-issues.md');
    expect(result.skippedIssues).toEqual(skipped);
  });

  it('should default skippedIssues to [] when parser returns empty', () => {
    const state = makeAgentState({ config: { skippedIssuesPath: undefined } });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));
    mockLoadSkippedIssuesDetailed.mockReturnValueOnce({ issues: [] });

    const result = buildScoutState();

    expect(result.skippedIssues).toEqual([]);
  });

  it('sets diagnostics.skipListUnavailable when the skip file read fails (#1448)', () => {
    const state = makeAgentState({
      config: { skippedIssuesPath: '/vault/open-source/skipped-issues.md' },
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));
    mockLoadSkippedIssuesDetailed.mockReturnValueOnce({ issues: [], readError: 'EACCES: permission denied' });

    const diagnostics: ScoutBridgeDiagnostics = {};
    const result = buildScoutState(diagnostics);

    expect(diagnostics.skipListUnavailable).toBe(true);
    expect(result.skippedIssues).toEqual([]);
  });

  it('sets diagnostics.skipListUnavailable when the configured skip file is missing (#1528)', () => {
    const state = makeAgentState({
      config: { skippedIssuesPath: 'open-source/skipped-issues.md' },
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));
    mockLoadSkippedIssuesDetailed.mockReturnValueOnce({
      issues: [],
      notFound: true,
      resolvedPath: '/somewhere/open-source/skipped-issues.md',
    });

    const diagnostics: ScoutBridgeDiagnostics = {};
    const result = buildScoutState(diagnostics);

    expect(diagnostics.skipListUnavailable).toBe(true);
    expect(result.skippedIssues).toEqual([]);
  });

  it('leaves diagnostics.skipListUnavailable unset when the skip file loads cleanly (#1448)', () => {
    const state = makeAgentState({
      config: { skippedIssuesPath: '/vault/open-source/skipped-issues.md' },
    });
    mockGetStateManager.mockReturnValue(makeStateManagerMock({ state, config: state.config }));
    mockLoadSkippedIssuesDetailed.mockReturnValueOnce({ issues: [] });

    const diagnostics: ScoutBridgeDiagnostics = {};
    buildScoutState(diagnostics);

    expect(diagnostics.skipListUnavailable).toBeUndefined();
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

describe('buildCandidateLinkedPR', () => {
  it('returns undefined when scout has no linked PR', () => {
    expect(buildCandidateLinkedPR(null)).toBeUndefined();
    expect(buildCandidateLinkedPR(undefined)).toBeUndefined();
  });

  it('returns the autopilot-shaped linkedPR slice with isStalled=false for a fresh open PR', () => {
    // Use a far-future "now" to keep this stable; updatedAt set to ~today.
    const recent = new Date().toISOString();
    const result = buildCandidateLinkedPR({
      number: 42,
      author: 'octocat',
      state: 'open',
      merged: false,
      url: 'https://github.com/owner/repo/pull/42',
      updatedAt: recent,
    });
    expect(result).toEqual({
      number: 42,
      state: 'open',
      url: 'https://github.com/owner/repo/pull/42',
      updatedAt: recent,
      isStalled: false,
    });
  });

  it('flags isStalled=true for an open PR with updatedAt > 30 days ago', () => {
    const result = buildCandidateLinkedPR({
      number: 7,
      author: 'octocat',
      state: 'open',
      merged: false,
      url: 'https://github.com/owner/repo/pull/7',
      updatedAt: '2020-01-01T00:00:00Z',
    });
    expect(result?.isStalled).toBe(true);
  });

  it('folds merged=true into state="merged" and never marks merged PRs as stalled', () => {
    const result = buildCandidateLinkedPR({
      number: 9,
      author: 'octocat',
      state: 'closed',
      merged: true,
      url: 'https://github.com/owner/repo/pull/9',
      updatedAt: '2020-01-01T00:00:00Z',
    });
    expect(result?.state).toBe('merged');
    expect(result?.isStalled).toBe(false);
  });

  it('omits updatedAt entirely when scout did not provide one', () => {
    const result = buildCandidateLinkedPR({
      number: 5,
      author: 'octocat',
      state: 'open',
      merged: false,
      url: 'https://github.com/owner/repo/pull/5',
    });
    expect(result).toBeDefined();
    expect('updatedAt' in (result as object)).toBe(false);
    // Without updatedAt, isStalled cannot be proved — defaults to false.
    expect(result?.isStalled).toBe(false);
  });
});
