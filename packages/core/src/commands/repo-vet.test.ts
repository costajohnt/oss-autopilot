/**
 * Tests for the repo-vet command wrapper (#1373).
 *
 * Focused on the listReleases error-handling contract: rate-limit/auth
 * errors abort the run, 404 is genuine absence, and 5xx/network errors
 * degrade gracefully with the `releasesIncomplete` flag set so a vet
 * batch under throttling can't silently report "no releases".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getOctokit: vi.fn(),
  requireGitHubToken: vi.fn(),
  getStateManager: vi.fn(),
}));

vi.mock('../core/logger.js', () => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { requireGitHubToken, getOctokit, getStateManager } from '../core/index.js';
import { warn } from '../core/logger.js';
import { runRepoVet } from './repo-vet.js';
import { RepoVetOutputSchema } from '../formatters/json.js';

const mockRequireGitHubToken = vi.mocked(requireGitHubToken);
const mockGetOctokit = vi.mocked(getOctokit);
const mockGetStateManager = vi.mocked(getStateManager);
const mockWarn = vi.mocked(warn);

/**
 * Stub StateManager carrying only the repoScores surface runRepoVet reads.
 * Keyed records mimic `state.repoScores` (#1465).
 */
function stubStateManager(repoScores: Record<string, { repo: string; score: number }>) {
  return {
    getRepoScore: (repo: string) => repoScores[repo],
    getState: () => ({ repoScores }),
  } as unknown as ReturnType<typeof getStateManager>;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const NOT_FOUND = httpError(404, 'Not Found');

/** Minimal octokit stub; override `listReleases` per test. */
function buildOctokit(listReleases: ReturnType<typeof vi.fn>) {
  return {
    repos: {
      get: vi.fn().mockResolvedValue({
        data: {
          stargazers_count: 100,
          forks_count: 10,
          open_issues_count: 5,
          subscribers_count: 8,
          archived: false,
          pushed_at: '2026-06-01T00:00:00Z',
          created_at: '2020-01-01T00:00:00Z',
        },
      }),
      listCommits: vi.fn().mockResolvedValue({ data: [] }),
      listReleases,
      // Community-health probes: every path 404s (definitive absence) so
      // the release-path behavior under test is isolated.
      getContent: vi.fn().mockRejectedValue(NOT_FOUND),
    },
    pulls: {
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
  } as unknown as ReturnType<typeof getOctokit>;
}

describe('runRepoVet release handling (#1373)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockGetStateManager.mockReturnValue(stubStateManager({}));
  });

  it('rethrows a 429 rate-limit error from listReleases', async () => {
    mockGetOctokit.mockReturnValue(buildOctokit(vi.fn().mockRejectedValue(httpError(429, 'API rate limit exceeded'))));

    await expect(runRepoVet({ repo: 'owner/repo' })).rejects.toThrow('API rate limit exceeded');
  });

  it('rethrows a 403 rate-limit error from listReleases', async () => {
    mockGetOctokit.mockReturnValue(
      buildOctokit(vi.fn().mockRejectedValue(httpError(403, 'API rate limit exceeded for installation'))),
    );

    await expect(runRepoVet({ repo: 'owner/repo' })).rejects.toThrow('rate limit');
  });

  it('treats a 404 as genuine absence: null lastReleaseISO, no incomplete flag, no warning', async () => {
    mockGetOctokit.mockReturnValue(buildOctokit(vi.fn().mockRejectedValue(NOT_FOUND)));

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.maintainerActivity.lastReleaseISO).toBeNull();
    expect(result.maintainerActivity.releasesIncomplete).toBe(false);
    const warnMessages = mockWarn.mock.calls.map((c) => String(c[1]));
    expect(warnMessages.some((m) => m.includes('release'))).toBe(false);
  });

  it('degrades gracefully on a 500: releasesIncomplete true, null lastReleaseISO, warning emitted', async () => {
    mockGetOctokit.mockReturnValue(buildOctokit(vi.fn().mockRejectedValue(httpError(500, 'Internal Server Error'))));

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.maintainerActivity.lastReleaseISO).toBeNull();
    expect(result.maintainerActivity.releasesIncomplete).toBe(true);
    expect(mockWarn).toHaveBeenCalledWith(
      'repo-vet',
      expect.stringMatching(/owner\/repo.*release-recency signal is incomplete/),
    );
  });

  it('degrades gracefully on a network error (no HTTP status)', async () => {
    mockGetOctokit.mockReturnValue(
      buildOctokit(vi.fn().mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))),
    );

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.maintainerActivity.releasesIncomplete).toBe(true);
    expect(result.maintainerActivity.lastReleaseISO).toBeNull();
  });

  it('reports releasesIncomplete false on success and the flag survives the JSON schema', async () => {
    mockGetOctokit.mockReturnValue(
      buildOctokit(
        vi
          .fn()
          .mockResolvedValue({ data: [{ published_at: '2026-05-01T00:00:00Z', created_at: '2026-05-01T00:00:00Z' }] }),
      ),
    );

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.maintainerActivity.lastReleaseISO).toBe('2026-05-01T00:00:00Z');
    expect(result.maintainerActivity.releasesIncomplete).toBe(false);

    // formatJson validates with RepoVetOutputSchema, which strips unknown
    // keys — guard against the flag silently vanishing from --json output.
    const parsed = RepoVetOutputSchema.parse(result);
    expect(parsed.maintainerActivity.releasesIncomplete).toBe(false);
  });
});

describe('runRepoVet history score (#1465)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockGetOctokit.mockReturnValue(buildOctokit(vi.fn().mockRejectedValue(NOT_FOUND)));
  });

  it('includes historyScore alongside rubricScore when a cached score exists for the slug', async () => {
    mockGetStateManager.mockReturnValue(stubStateManager({ 'owner/repo': { repo: 'owner/repo', score: 8 } }));

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.historyScore).toBe(8);
    expect(typeof result.rubricScore).toBe('number');
  });

  it('degrades to no history (not a throw) when state is unreadable (#1465 review)', async () => {
    mockGetStateManager.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.historyScore).toBeUndefined();
    expect(typeof result.rubricScore).toBe('number');
  });

  it('omits historyScore entirely when the user has no cached score (back-compat)', async () => {
    mockGetStateManager.mockReturnValue(stubStateManager({}));

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect('historyScore' in result).toBe(false);
  });

  it('matches the cached score case-insensitively (state keys preserve URL casing)', async () => {
    mockGetStateManager.mockReturnValue(stubStateManager({ 'Owner/Repo': { repo: 'Owner/Repo', score: 6 } }));

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.historyScore).toBe(6);
  });

  it('does not attribute a different repo cached score to the vetted slug', async () => {
    mockGetStateManager.mockReturnValue(stubStateManager({ 'other/repo': { repo: 'other/repo', score: 9 } }));

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect('historyScore' in result).toBe(false);
  });

  it('historyScore survives the --json schema validation (and stays absent when absent)', async () => {
    mockGetStateManager.mockReturnValue(stubStateManager({ 'owner/repo': { repo: 'owner/repo', score: 8 } }));
    const withHistory = RepoVetOutputSchema.parse(await runRepoVet({ repo: 'owner/repo' }));
    expect(withHistory.historyScore).toBe(8);

    mockGetStateManager.mockReturnValue(stubStateManager({}));
    const withoutHistory = RepoVetOutputSchema.parse(await runRepoVet({ repo: 'owner/repo' }));
    expect(withoutHistory.historyScore).toBeUndefined();
  });
});

// The shared stub returns empty PR and commit lists, so every number above is
// the empty-input value. This feeds lists that straddle the 30/90-day windows.
describe('runRepoVet health numbers from non-empty history', () => {
  const NOW = new Date('2026-06-30T00:00:00Z');
  const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockGetStateManager.mockReturnValue(stubStateManager({}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts merges, opens, commits, and contributors inside their windows only', async () => {
    const octokit = buildOctokit(vi.fn().mockRejectedValue(NOT_FOUND)) as unknown as {
      pulls: { list: ReturnType<typeof vi.fn> };
      repos: { listCommits: ReturnType<typeof vi.fn> };
    };
    octokit.pulls.list.mockResolvedValue({
      data: [
        // Opened and merged inside the 90-day window: 2 and 4 days to merge.
        { created_at: daysAgo(10), merged_at: daysAgo(8), updated_at: daysAgo(8) },
        { created_at: daysAgo(30), merged_at: daysAgo(26), updated_at: daysAgo(26) },
        // Opened before the window, merged inside it: counts as merged only.
        { created_at: daysAgo(120), merged_at: daysAgo(60), updated_at: daysAgo(60) },
        // Opened and merged before the window: ignored.
        { created_at: daysAgo(200), merged_at: daysAgo(100), updated_at: daysAgo(100) },
        // Opened inside the window, closed unmerged.
        { created_at: daysAgo(5), merged_at: null, updated_at: daysAgo(4) },
      ],
    });
    octokit.repos.listCommits.mockResolvedValue({
      data: [
        { commit: { author: { date: daysAgo(1) } }, author: { login: 'alice' } },
        { commit: { author: { date: daysAgo(20) } }, author: { login: 'bob' } },
        { commit: { author: { date: daysAgo(10) } }, author: null },
        { commit: { author: { date: daysAgo(45) } }, author: { login: 'alice' } },
        { commit: { author: { date: daysAgo(100) } }, author: { login: 'carol' } },
        { commit: { author: null }, author: { login: 'dave' } },
      ],
    });
    mockGetOctokit.mockReturnValue(octokit as unknown as ReturnType<typeof getOctokit>);

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.mergeRate).toMatchObject({ merged: 3, opened: 3, percent: 100 });
    expect(result.prMergeTime).toMatchObject({ sampleSize: 3, medianDays: 4, avgDays: 22 });
    expect(result.maintainerActivity.contributorsLast90d).toBe(2);
    expect(result.maintainerActivity.lastCommitISO).toBe(daysAgo(1));
    // commitsLast30Days only reaches the output through the rubric score.
    // 3 commits in 30 days (1, 10, 20 days old) gives activity 3/30; with
    // merge rate 1.0, PR speed 0 (22-day average), no guidelines, and half
    // stability (no release): (0.1*0.25 + 0.2 + 0.5*0.05) / 0.85 = 2.9.
    // 2 or 4 commits would give 2.8 or 3.0.
    expect(result.rubricScore).toBe(2.9);
  });
});
