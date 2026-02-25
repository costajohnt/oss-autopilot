/**
 * Tests for init command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTrackPR = vi.fn();

vi.mock('../core/index.js', () => {
  const MockPRMonitor = vi.fn(function (this: any) {
    this.trackPR = mockTrackPR;
  });
  return {
    getStateManager: vi.fn(),
    PRMonitor: MockPRMonitor,
    getOctokit: vi.fn(),
    getGitHubToken: vi.fn(),
  };
});

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

import { getStateManager, getOctokit, getGitHubToken } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';
import { runInit } from './init.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockGetOctokit = vi.mocked(getOctokit);
const mockOutputJson = vi.mocked(outputJson);
const mockOutputJsonError = vi.mocked(outputJsonError);

describe('runInit', () => {
  const mockSave = vi.fn();
  const mockUpdateConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      updateConfig: mockUpdateConfig,
      save: mockSave,
    } as any);
  });

  it('should exit with error when no GitHub token is available', async () => {
    mockGetGitHubToken.mockReturnValue(null as any);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runInit({ username: 'testuser', json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('GitHub authentication required'));
    mockExit.mockRestore();
  });

  it('should import open PRs for a user', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    const mockSearch = vi.fn().mockResolvedValue({
      data: {
        total_count: 2,
        items: [
          {
            html_url: 'https://github.com/owner/repo/pull/1',
            pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' },
          },
          {
            html_url: 'https://github.com/owner/repo/pull/2',
            pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/2' },
          },
        ],
      },
    });
    mockGetOctokit.mockReturnValue({
      search: { issuesAndPullRequests: mockSearch },
    } as any);
    mockTrackPR
      .mockResolvedValueOnce({ repo: 'owner/repo', number: 1, title: 'First PR' })
      .mockResolvedValueOnce({ repo: 'owner/repo', number: 2, title: 'Second PR' });

    await runInit({ username: 'testuser', json: true });

    expect(mockUpdateConfig).toHaveBeenCalledWith({ githubUsername: 'testuser' });
    expect(mockTrackPR).toHaveBeenCalledTimes(2);
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({
      username: 'testuser',
      totalFound: 2,
      imported: [
        { repo: 'owner/repo', number: 1, title: 'First PR' },
        { repo: 'owner/repo', number: 2, title: 'Second PR' },
      ],
      errors: [],
    });
  });

  it('should handle errors when tracking individual PRs', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    const mockSearch = vi.fn().mockResolvedValue({
      data: {
        total_count: 1,
        items: [
          {
            html_url: 'https://github.com/owner/repo/pull/1',
            pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' },
          },
        ],
      },
    });
    mockGetOctokit.mockReturnValue({
      search: { issuesAndPullRequests: mockSearch },
    } as any);
    mockTrackPR.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    await runInit({ username: 'testuser', json: true });

    expect(mockOutputJson).toHaveBeenCalledWith({
      username: 'testuser',
      totalFound: 1,
      imported: [],
      errors: [{ url: 'https://github.com/owner/repo/pull/1', error: 'API rate limit exceeded' }],
    });
  });

  it('should skip items without pull_request property', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    const mockSearch = vi.fn().mockResolvedValue({
      data: {
        total_count: 1,
        items: [{ html_url: 'https://github.com/owner/repo/issues/5' }],
      },
    });
    mockGetOctokit.mockReturnValue({
      search: { issuesAndPullRequests: mockSearch },
    } as any);

    await runInit({ username: 'testuser', json: true });

    expect(mockTrackPR).not.toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({
      username: 'testuser',
      totalFound: 1,
      imported: [],
      errors: [],
    });
  });
});
