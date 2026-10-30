import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearch = vi.fn();
const mockGetState = vi.fn();

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => ({ getState: mockGetState }),
    requireGitHubToken: () => 'token',
    getOctokit: () => ({ search: { issuesAndPullRequests: mockSearch } }),
  };
});

import { runRepoCap } from './repo-cap.js';

describe('runRepoCap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({
      config: { githubUsername: 'octo', maxOpenPRsPerRepo: 0, maxOpenPRsColdRepo: 1, excludeRepos: [] },
      repoScores: {},
      // The digest is stale (no open PRs); the live count must win.
      lastDigest: { openPRs: [] },
    });
  });

  it('counts open PRs live from GitHub', async () => {
    mockSearch.mockResolvedValue({ data: { total_count: 1 } });

    const result = await runRepoCap({ repo: 'owner/repo' });

    expect(mockSearch).toHaveBeenCalledWith({ q: 'is:pr is:open author:octo repo:owner/repo', per_page: 1 });
    expect(result).toMatchObject({ openPRCount: 1, countSource: 'github', cold: true, cap: 1, atCap: true });
  });

  it('rejects a malformed repo before calling GitHub', async () => {
    await expect(runRepoCap({ repo: 'not-a-repo' })).rejects.toThrow(/owner\/repo/);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('requires githubUsername', async () => {
    mockGetState.mockReturnValue({ config: { githubUsername: '' } });
    await expect(runRepoCap({ repo: 'owner/repo' })).rejects.toThrow(/githubUsername/);
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
