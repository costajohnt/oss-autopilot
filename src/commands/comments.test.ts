/**
 * Tests for comments, post, and claim commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  getOctokit: vi.fn(),
  parseGitHubUrl: vi.fn(),
  formatRelativeTime: vi.fn(),
  getGitHubToken: vi.fn(),
}));

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

import { getStateManager, getOctokit, parseGitHubUrl, getGitHubToken } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';
import { runComments, runPost, runClaim } from './comments.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockGetOctokit = vi.mocked(getOctokit);
const mockParseGitHubUrl = vi.mocked(parseGitHubUrl);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockOutputJson = vi.mocked(outputJson);
const mockOutputJsonError = vi.mocked(outputJsonError);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';
const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/10';

describe('runComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { githubUsername: 'testuser' } }),
    } as any);
  });

  it('should exit with error when no GitHub token', async () => {
    mockGetGitHubToken.mockReturnValue(null as any);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runComments({ prUrl: TEST_PR_URL, json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('GitHub authentication required'));
    mockExit.mockRestore();
  });

  it('should exit with error for invalid PR URL', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue(null as any);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runComments({ prUrl: 'invalid-url', json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith('Invalid PR URL format');
    mockExit.mockRestore();
  });

  it('should fetch and return comments in JSON mode', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });

    const mockPullsGet = vi.fn().mockResolvedValue({
      data: {
        title: 'Test PR',
        state: 'open',
        mergeable: true,
        head: { ref: 'feature' },
        base: { ref: 'main' },
        html_url: TEST_PR_URL,
      },
    });
    const mockListReviewComments = vi.fn().mockResolvedValue({ data: [] });
    const mockListComments = vi.fn().mockResolvedValue({ data: [] });
    const mockListReviews = vi.fn().mockResolvedValue({
      data: [
        {
          user: { login: 'reviewer', type: 'User' },
          state: 'APPROVED',
          body: 'LGTM',
          submitted_at: '2026-01-15T10:00:00Z',
        },
      ],
    });

    mockGetOctokit.mockReturnValue({
      pulls: { get: mockPullsGet, listReviewComments: mockListReviewComments, listReviews: mockListReviews },
      issues: { listComments: mockListComments },
    } as any);

    await runComments({ prUrl: TEST_PR_URL, json: true });

    expect(mockOutputJson).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: expect.objectContaining({ title: 'Test PR', state: 'open' }),
        reviews: [{ user: 'reviewer', state: 'APPROVED', body: 'LGTM', submittedAt: '2026-01-15T10:00:00Z' }],
        summary: { reviewCount: 1, inlineCommentCount: 0, discussionCommentCount: 0 },
      }),
    );
  });

  it('should filter out own comments', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });

    const mockPullsGet = vi.fn().mockResolvedValue({
      data: {
        title: 'Test PR',
        state: 'open',
        mergeable: true,
        head: { ref: 'feature' },
        base: { ref: 'main' },
        html_url: TEST_PR_URL,
      },
    });
    const mockListReviewComments = vi.fn().mockResolvedValue({ data: [] });
    const mockListComments = vi.fn().mockResolvedValue({
      data: [
        { user: { login: 'testuser', type: 'User' }, body: 'My own comment', created_at: '2026-01-15T10:00:00Z' },
        { user: { login: 'other', type: 'User' }, body: 'Other comment', created_at: '2026-01-15T11:00:00Z' },
      ],
    });
    const mockListReviews = vi.fn().mockResolvedValue({ data: [] });

    mockGetOctokit.mockReturnValue({
      pulls: { get: mockPullsGet, listReviewComments: mockListReviewComments, listReviews: mockListReviews },
      issues: { listComments: mockListComments },
    } as any);

    await runComments({ prUrl: TEST_PR_URL, json: true });

    const outputData = mockOutputJson.mock.calls[0][0] as any;
    expect(outputData.issueComments).toHaveLength(1);
    expect(outputData.issueComments[0].user).toBe('other');
  });
});

describe('runPost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should exit with error when no GitHub token', async () => {
    mockGetGitHubToken.mockReturnValue(null as any);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runPost({ url: TEST_PR_URL, message: 'Hello', json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('GitHub authentication required'));
    mockExit.mockRestore();
  });

  it('should exit with error when no message provided', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runPost({ url: TEST_PR_URL, json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith('No message provided');
    mockExit.mockRestore();
  });

  it('should exit with error for invalid URL', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue(null as any);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runPost({ url: 'bad-url', message: 'Hello', json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith('Invalid GitHub URL format');
    mockExit.mockRestore();
  });

  it('should post a comment and output JSON', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });

    const mockCreateComment = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/owner/repo/pull/42#issuecomment-1' },
    });
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    } as any);

    await runPost({ url: TEST_PR_URL, message: 'Thanks!', json: true });

    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      body: 'Thanks!',
    });
    expect(mockOutputJson).toHaveBeenCalledWith({
      commentUrl: 'https://github.com/owner/repo/pull/42#issuecomment-1',
      url: TEST_PR_URL,
    });
  });
});

describe('runClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should exit with error when no GitHub token', async () => {
    mockGetGitHubToken.mockReturnValue(null as any);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runClaim({ issueUrl: TEST_ISSUE_URL, json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('GitHub authentication required'));
    mockExit.mockRestore();
  });

  it('should exit with error for non-issue URL', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runClaim({ issueUrl: TEST_PR_URL, json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith('Invalid issue URL format (must be an issue, not a PR)');
    mockExit.mockRestore();
  });

  it('should claim an issue and track it', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 10, type: 'issues' });

    const mockCreateComment = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/owner/repo/issues/10#issuecomment-1' },
    });
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    } as any);
    const mockAddIssue = vi.fn();
    const mockSave = vi.fn();
    mockGetStateManager.mockReturnValue({
      addIssue: mockAddIssue,
      save: mockSave,
    } as any);

    await runClaim({ issueUrl: TEST_ISSUE_URL, json: true });

    expect(mockCreateComment).toHaveBeenCalled();
    expect(mockAddIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        url: TEST_ISSUE_URL,
        repo: 'owner/repo',
        number: 10,
        status: 'claimed',
      }),
    );
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({
      commentUrl: 'https://github.com/owner/repo/issues/10#issuecomment-1',
      issueUrl: TEST_ISSUE_URL,
    });
  });
});
