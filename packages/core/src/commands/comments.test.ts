/**
 * Tests for comments, post, and claim commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  getOctokit: vi.fn(),
  parseGitHubUrl: vi.fn(),
  formatRelativeTime: vi.fn(),
  requireGitHubToken: vi.fn(),
}));

import { getStateManager, getOctokit, parseGitHubUrl, requireGitHubToken } from '../core/index.js';
import { runComments, runPost, runClaim } from './comments.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockGetOctokit = vi.mocked(getOctokit);
const mockParseGitHubUrl = vi.mocked(parseGitHubUrl);
const mockRequireGitHubToken = vi.mocked(requireGitHubToken);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';
const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/10';

describe('runComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { githubUsername: 'testuser' } }),
    } as any);
  });

  it('should throw error for invalid PR URL', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue(null as any);

    await expect(runComments({ prUrl: 'invalid-url' })).rejects.toThrow('Invalid PR URL format');
  });

  it('should fetch and return comments data', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
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

    const result = await runComments({ prUrl: TEST_PR_URL });

    expect(result).toEqual(
      expect.objectContaining({
        pr: expect.objectContaining({ title: 'Test PR', state: 'open' }),
        reviews: [{ user: 'reviewer', state: 'APPROVED', body: 'LGTM', submittedAt: '2026-01-15T10:00:00Z' }],
        summary: { reviewCount: 1, inlineCommentCount: 0, discussionCommentCount: 0 },
      }),
    );
  });

  it('should filter out own comments', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
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

    const result = await runComments({ prUrl: TEST_PR_URL });

    expect(result.issueComments).toHaveLength(1);
    expect(result.issueComments[0].user).toBe('other');
  });

  it('should return empty arrays when no comments', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });

    const mockPullsGet = vi.fn().mockResolvedValue({
      data: {
        title: 'Empty PR',
        state: 'open',
        mergeable: true,
        head: { ref: 'feature' },
        base: { ref: 'main' },
        html_url: TEST_PR_URL,
      },
    });
    const mockListReviewComments = vi.fn().mockResolvedValue({ data: [] });
    const mockListComments = vi.fn().mockResolvedValue({ data: [] });
    const mockListReviews = vi.fn().mockResolvedValue({ data: [] });

    mockGetOctokit.mockReturnValue({
      pulls: { get: mockPullsGet, listReviewComments: mockListReviewComments, listReviews: mockListReviews },
      issues: { listComments: mockListComments },
    } as any);

    const result = await runComments({ prUrl: TEST_PR_URL });

    expect(result.reviews).toHaveLength(0);
    expect(result.reviewComments).toHaveLength(0);
    expect(result.issueComments).toHaveLength(0);
  });
});

describe('runPost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw error when no message provided', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');

    await expect(runPost({ url: TEST_PR_URL, message: '' })).rejects.toThrow('No message provided');
  });

  it('should throw error for invalid URL', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue(null as any);

    await expect(runPost({ url: 'bad-url', message: 'Hello' })).rejects.toThrow('Invalid GitHub URL format');
  });

  it('should throw error when message exceeds maximum length', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    const oversizedMessage = 'a'.repeat(1001);

    await expect(runPost({ url: TEST_PR_URL, message: oversizedMessage })).rejects.toThrow(
      'Message exceeds maximum length',
    );
  });

  it('should post a comment and return result', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });

    const mockCreateComment = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/owner/repo/pull/42#issuecomment-1' },
    });
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    } as any);

    const result = await runPost({ url: TEST_PR_URL, message: 'Thanks!' });

    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      body: 'Thanks!',
    });
    expect(result).toEqual({
      commentUrl: 'https://github.com/owner/repo/pull/42#issuecomment-1',
      url: TEST_PR_URL,
    });
  });

  it('should propagate API errors', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });

    const mockCreateComment = vi.fn().mockRejectedValue(new Error('API error'));
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    } as any);

    await expect(runPost({ url: TEST_PR_URL, message: 'Hello' })).rejects.toThrow('API error');
  });
});

describe('runClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw error for non-issue URL', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });

    await expect(runClaim({ issueUrl: TEST_PR_URL })).rejects.toThrow(
      'Invalid issue URL format (must be an issue, not a PR)',
    );
  });

  it('should throw error when claim message exceeds maximum length', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    const oversizedMessage = 'b'.repeat(1001);

    await expect(runClaim({ issueUrl: TEST_ISSUE_URL, message: oversizedMessage })).rejects.toThrow(
      'Message exceeds maximum length',
    );
  });

  it('should claim an issue and return result', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
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

    const result = await runClaim({ issueUrl: TEST_ISSUE_URL });

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
    expect(result).toEqual({
      commentUrl: 'https://github.com/owner/repo/issues/10#issuecomment-1',
      issueUrl: TEST_ISSUE_URL,
    });
  });

  it('should propagate API errors', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 10, type: 'issues' });

    const mockCreateComment = vi.fn().mockRejectedValue(new Error('Permission denied'));
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    } as any);

    await expect(runClaim({ issueUrl: TEST_ISSUE_URL })).rejects.toThrow('Permission denied');
  });
});
