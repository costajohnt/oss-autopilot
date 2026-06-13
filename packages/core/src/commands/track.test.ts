/**
 * Tests for track/untrack commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  requireGitHubToken: vi.fn(),
  getOctokit: vi.fn(),
}));

vi.mock('../core/urls.js', () => ({
  parseGitHubUrl: vi.fn(),
}));

vi.mock('./validation.js', () => ({
  validateUrl: vi.fn(),
  PR_URL_PATTERN: /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/,
  validateGitHubUrl: vi.fn(),
}));

import { requireGitHubToken, getOctokit } from '../core/index.js';
import { parseGitHubUrl } from '../core/urls.js';
import { runTrack } from './track.js';

const mockRequireGitHubToken = vi.mocked(requireGitHubToken);
const mockGetOctokit = vi.mocked(getOctokit);
const mockParseGitHubUrl = vi.mocked(parseGitHubUrl);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('runTrack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ type: 'pull', owner: 'owner', repo: 'repo', number: 42 });
    mockGetOctokit.mockReturnValue({
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: { title: 'Test PR', number: 42 },
        }),
      },
    } as any);
  });

  it('should fetch PR info and return it', async () => {
    const result = await runTrack({ prUrl: TEST_PR_URL });

    expect(result).toEqual({
      pr: { repo: 'owner/repo', number: 42, title: 'Test PR', url: TEST_PR_URL },
    });
  });

  it('should throw for invalid PR URL', async () => {
    mockParseGitHubUrl.mockReturnValue(null as any);

    await expect(runTrack({ prUrl: 'bad-url' })).rejects.toThrow('Invalid PR URL');
  });

  it('should propagate API errors from octokit (#414)', async () => {
    mockGetOctokit.mockReturnValue({
      pulls: {
        get: vi.fn().mockRejectedValue(new Error('Not Found')),
      },
    } as any);

    await expect(runTrack({ prUrl: TEST_PR_URL })).rejects.toThrow('Not Found');
  });
});

// runUntrack was removed in v4 (#1133). Use runMove (target 'shelved') to hide a PR from the
// daily digest.
