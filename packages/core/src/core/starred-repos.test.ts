/**
 * Tests for starred-repo cache refresh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetOctokit = vi.fn();
const mockRequireGitHubToken = vi.fn(() => 'test-token');

vi.mock('./github.js', () => ({
  getOctokit: (token: string) => mockGetOctokit(token),
}));

vi.mock('./auth.js', () => ({
  requireGitHubToken: () => mockRequireGitHubToken(),
}));

import { refreshStarredReposIfStale, type StarredReposState } from './starred-repos.js';

/** Build a fake octokit whose paginate.iterator yields the given pages. */
function fakeOctokit(pages: Array<Array<{ full_name?: string }>>): unknown {
  return {
    activity: { listReposStarredByAuthenticatedUser: vi.fn() },
    paginate: {
      iterator: async function* () {
        for (const data of pages) {
          yield { data };
        }
      },
    },
  };
}

function makeState(overrides: Partial<StarredReposState> & { stale: boolean; cached?: string[] }): {
  state: StarredReposState;
  setStarredRepos: ReturnType<typeof vi.fn>;
} {
  let cached = overrides.cached ?? [];
  const setStarredRepos = vi.fn((repos: string[]) => {
    cached = repos;
  });
  const state: StarredReposState = {
    isStarredReposStale: () => overrides.stale,
    getStarredRepos: () => cached,
    setStarredRepos,
  };
  return { state, setStarredRepos };
}

describe('refreshStarredReposIfStale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireGitHubToken.mockReturnValue('test-token');
  });

  it('propagates a missing-token error instead of swallowing it', async () => {
    mockRequireGitHubToken.mockImplementation(() => {
      throw new Error('GitHub authentication required');
    });
    const { state, setStarredRepos } = makeState({ stale: true, cached: [] });

    await expect(refreshStarredReposIfStale(state)).rejects.toThrow(
      'GitHub authentication required',
    );
    expect(mockGetOctokit).not.toHaveBeenCalled();
    expect(setStarredRepos).not.toHaveBeenCalled();
  });

  it('fetches and caches starred repos when the cache is stale', async () => {
    mockGetOctokit.mockReturnValue(
      fakeOctokit([
        [{ full_name: 'a/one' }, { full_name: 'b/two' }],
        [{ full_name: 'c/three' }],
      ]),
    );
    const { state, setStarredRepos } = makeState({ stale: true });

    const count = await refreshStarredReposIfStale(state);

    expect(count).toBe(3);
    expect(setStarredRepos).toHaveBeenCalledWith(['a/one', 'b/two', 'c/three']);
  });

  it('skips the fetch entirely when the cache is fresh', async () => {
    const { state, setStarredRepos } = makeState({
      stale: false,
      cached: ['x/y', 'z/w'],
    });

    const count = await refreshStarredReposIfStale(state);

    expect(count).toBe(2);
    expect(mockGetOctokit).not.toHaveBeenCalled();
    expect(setStarredRepos).not.toHaveBeenCalled();
  });

  it('drops entries without a full_name', async () => {
    mockGetOctokit.mockReturnValue(
      fakeOctokit([[{ full_name: 'a/one' }, {}, { full_name: 'b/two' }]]),
    );
    const { state, setStarredRepos } = makeState({ stale: true });

    await refreshStarredReposIfStale(state);

    expect(setStarredRepos).toHaveBeenCalledWith(['a/one', 'b/two']);
  });

  it('keeps the existing cache when the fetch returns zero repos', async () => {
    // A transient/partial empty response must not wipe a good cache and stamp it
    // fresh for 24h, which would silently re-disable the starred phase.
    mockGetOctokit.mockReturnValue(fakeOctokit([[]]));
    const { state, setStarredRepos } = makeState({
      stale: true,
      cached: ['kept/repo'],
    });

    const count = await refreshStarredReposIfStale(state);

    expect(count).toBe(1);
    expect(setStarredRepos).not.toHaveBeenCalled();
  });

  it('fails soft and keeps the existing cache when the fetch throws', async () => {
    mockGetOctokit.mockImplementation(() => {
      throw new Error('GitHub down');
    });
    const { state, setStarredRepos } = makeState({
      stale: true,
      cached: ['old/repo'],
    });

    const count = await refreshStarredReposIfStale(state);

    expect(count).toBe(1);
    expect(setStarredRepos).not.toHaveBeenCalled();
  });
});
