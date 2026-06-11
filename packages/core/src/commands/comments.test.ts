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
  maybeCheckpoint: vi.fn().mockResolvedValue(null),
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
      getStateStaleness: vi.fn().mockReturnValue(null),
    } as any);
  });

  it('should throw error for invalid PR URL', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue(null as any);

    await expect(runComments({ prUrl: 'invalid-url' })).rejects.toThrow('Invalid PR URL');
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
        reviews: [
          {
            user: 'reviewer',
            state: 'APPROVED',
            // Bodies are emitted `<github-content>`-fenced (#1372).
            body: '<github-content label="owner/repo#42" author="reviewer" source="pr-review">LGTM</github-content>',
            submittedAt: '2026-01-15T10:00:00Z',
          },
        ],
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

    await expect(runPost({ url: 'bad-url', message: 'Hello' })).rejects.toThrow('Invalid issue or PR URL');
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

    await expect(runClaim({ issueUrl: TEST_PR_URL })).rejects.toThrow('Invalid issue URL');
  });

  it('should throw error when claim message exceeds maximum length', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    const oversizedMessage = 'b'.repeat(1001);

    await expect(runClaim({ issueUrl: TEST_ISSUE_URL, message: oversizedMessage })).rejects.toThrow(
      'Message exceeds maximum length',
    );
  });

  it('should claim an issue and return result with real title from issues.get', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 10, type: 'issues' });

    const mockCreateComment = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/owner/repo/issues/10#issuecomment-1' },
    });
    const mockIssuesGet = vi.fn().mockResolvedValue({
      data: {
        title: 'Fix the thing',
        labels: [{ name: 'bug' }, { name: 'good first issue' }],
        created_at: '2026-04-20T10:00:00Z',
      },
    });
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment, get: mockIssuesGet },
    } as any);
    const mockAddIssue = vi.fn();
    mockGetStateManager.mockReturnValue({
      addIssue: mockAddIssue,
    } as any);

    const result = await runClaim({ issueUrl: TEST_ISSUE_URL });

    expect(mockCreateComment).toHaveBeenCalled();
    // Issue metadata enrichment landed in state — no permanent "(claimed)" placeholder.
    expect(mockAddIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        url: TEST_ISSUE_URL,
        repo: 'owner/repo',
        number: 10,
        status: 'claimed',
        title: 'Fix the thing',
        labels: ['bug', 'good first issue'],
        createdAt: '2026-04-20T10:00:00Z',
      }),
    );
    expect(result).toEqual({
      commentUrl: 'https://github.com/owner/repo/issues/10#issuecomment-1',
      issueUrl: TEST_ISSUE_URL,
    });
  });

  it('should fall back to (claimed) placeholder if issues.get fails', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 10, type: 'issues' });

    const mockCreateComment = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/owner/repo/issues/10#issuecomment-1' },
    });
    const mockIssuesGet = vi.fn().mockRejectedValue(new Error('Server Error'));
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment, get: mockIssuesGet },
    } as any);
    const mockAddIssue = vi.fn();
    mockGetStateManager.mockReturnValue({
      addIssue: mockAddIssue,
    } as any);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runClaim({ issueUrl: TEST_ISSUE_URL });

    expect(result.commentUrl).toBe('https://github.com/owner/repo/issues/10#issuecomment-1');
    expect(mockCreateComment).toHaveBeenCalled();
    expect(mockAddIssue).toHaveBeenCalledWith(expect.objectContaining({ title: '(claimed)', labels: [] }));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WARN] [comments] Failed to enrich issue metadata'),
    );
    consoleSpy.mockRestore();
  });

  it('should abort before posting the claim comment when enrichment hits a rate limit (#1391)', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 10, type: 'issues' });

    const mockCreateComment = vi.fn();
    const mockIssuesGet = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('API rate limit exceeded'), { status: 429 }));
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment, get: mockIssuesGet },
    } as any);
    const mockAddIssue = vi.fn();
    mockGetStateManager.mockReturnValue({
      addIssue: mockAddIssue,
    } as any);

    await expect(runClaim({ issueUrl: TEST_ISSUE_URL })).rejects.toThrow('API rate limit exceeded');
    // Enrichment runs before the comment post, so a rate-limit abort leaves
    // no orphaned claim comment and no half-saved state.
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(mockAddIssue).not.toHaveBeenCalled();
  });

  it('should abort before posting the claim comment when enrichment hits an auth error (401) (#1391)', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 10, type: 'issues' });

    const mockCreateComment = vi.fn();
    const mockIssuesGet = vi.fn().mockRejectedValue(Object.assign(new Error('Bad credentials'), { status: 401 }));
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment, get: mockIssuesGet },
    } as any);
    const mockAddIssue = vi.fn();
    mockGetStateManager.mockReturnValue({
      addIssue: mockAddIssue,
    } as any);

    await expect(runClaim({ issueUrl: TEST_ISSUE_URL })).rejects.toThrow('Bad credentials');
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(mockAddIssue).not.toHaveBeenCalled();
  });

  it('should still return success when state save fails (comment already posted)', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 10, type: 'issues' });

    const mockCreateComment = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/owner/repo/issues/10#issuecomment-1' },
    });
    const mockIssuesGet = vi.fn().mockResolvedValue({
      data: { title: 'x', labels: [], created_at: '2026-04-20T10:00:00Z' },
    });
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment, get: mockIssuesGet },
    } as any);

    mockGetStateManager.mockReturnValue({
      addIssue: vi.fn().mockImplementation(() => {
        throw new Error('Disk full');
      }),
      save: vi.fn(),
    } as any);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runClaim({ issueUrl: TEST_ISSUE_URL });

    expect(result.commentUrl).toBe('https://github.com/owner/repo/issues/10#issuecomment-1');
    // Structured warning breadcrumb via logger.warn (#1056 M24).
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[WARN] [comments] Comment posted on'));
    consoleSpy.mockRestore();
  });

  it('should propagate API errors', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 10, type: 'issues' });

    const mockCreateComment = vi.fn().mockRejectedValue(new Error('Permission denied'));
    const mockIssuesGet = vi.fn().mockResolvedValue({
      data: { title: 'x', labels: [], created_at: '2026-04-20T10:00:00Z' },
    });
    mockGetOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment, get: mockIssuesGet },
    } as any);

    await expect(runClaim({ issueUrl: TEST_ISSUE_URL })).rejects.toThrow('Permission denied');
  });
});
