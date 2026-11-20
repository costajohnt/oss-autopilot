/**
 * Tests for comments, post, and claim commands
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  getOctokit: vi.fn(),
  parseGitHubUrl: vi.fn(),
  formatRelativeTime: vi.fn(),
  requireGitHubToken: vi.fn(),
  maybeCheckpoint: vi.fn().mockResolvedValue(null),
}));

import { getStateManager, getOctokit, parseGitHubUrl, requireGitHubToken, maybeCheckpoint } from '../core/index.js';
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

  it('should filter own comments case-insensitively (#1456)', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });
    // Configured username uses non-canonical case relative to the GitHub login.
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { githubUsername: 'TestUser' } }),
      getStateStaleness: vi.fn().mockReturnValue(null),
    } as any);

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

  it('should surface a warning when comment pagination truncates (#1456)', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });

    const mockPullsGet = vi.fn().mockResolvedValue({
      data: {
        title: 'Huge PR',
        state: 'open',
        mergeable: true,
        head: { ref: 'feature' },
        base: { ref: 'main' },
        html_url: TEST_PR_URL,
      },
    });
    // Every page returns a full 100 entries, so paginateAllDetailed hits the
    // 10-page cap and flags truncation.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      user: { login: 'other', type: 'User' },
      body: `comment ${i}`,
      created_at: '2026-01-15T10:00:00Z',
    }));
    const mockListReviewComments = vi.fn().mockResolvedValue({ data: [] });
    const mockListComments = vi.fn().mockResolvedValue({ data: fullPage });
    const mockListReviews = vi.fn().mockResolvedValue({ data: [] });

    mockGetOctokit.mockReturnValue({
      pulls: { get: mockPullsGet, listReviewComments: mockListReviewComments, listReviews: mockListReviews },
      issues: { listComments: mockListComments },
    } as any);

    const result = await runComments({ prUrl: TEST_PR_URL });

    expect(result.issueComments).toHaveLength(1000);
    expect(result.warnings).toBeDefined();
    const truncation = result.warnings!.find((w) => w.operation === 'fetch PR comments (truncated)');
    expect(truncation).toBeDefined();
    expect(truncation!.phase).toBe('fetch');
    expect(truncation!.message).toContain('discussion comments');
    expect(truncation!.message).toContain('owner/repo#42');
  });

  it('should not emit a truncation warning when all pages fit (#1456)', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });

    const mockPullsGet = vi.fn().mockResolvedValue({
      data: {
        title: 'Small PR',
        state: 'open',
        mergeable: true,
        head: { ref: 'feature' },
        base: { ref: 'main' },
        html_url: TEST_PR_URL,
      },
    });
    const mockListReviewComments = vi.fn().mockResolvedValue({ data: [] });
    const mockListComments = vi.fn().mockResolvedValue({
      data: [{ user: { login: 'other', type: 'User' }, body: 'hi', created_at: '2026-01-15T10:00:00Z' }],
    });
    const mockListReviews = vi.fn().mockResolvedValue({ data: [] });

    mockGetOctokit.mockReturnValue({
      pulls: { get: mockPullsGet, listReviewComments: mockListReviewComments, listReviews: mockListReviews },
      issues: { listComments: mockListComments },
    } as any);

    const result = await runComments({ prUrl: TEST_PR_URL });

    expect(result.warnings).toBeUndefined();
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

/** A full 100-entry page, so paginateAllDetailed hits its page cap and flags truncation. */
const fullPage = (n: number) =>
  Array.from({ length: 100 }, (_, i) => ({
    user: { login: 'other', type: 'User' },
    body: `b${n}-${i}`,
    path: 'a.ts',
    created_at: '2026-01-15T10:00:00Z',
    submitted_at: '2026-01-15T10:00:00Z',
    state: 'COMMENTED',
  }));

describe('runComments edge arms (#2003)', () => {
  const PR_DATA = {
    title: 'PR',
    state: 'open',
    mergeable: true,
    head: { ref: 'feature' },
    base: { ref: 'main' },
    html_url: TEST_PR_URL,
  };
  const mockOctokit = (lists: { reviews?: unknown[]; reviewComments?: unknown[]; issueComments?: unknown[] }) => {
    const pullsGet = vi.fn().mockResolvedValue({ data: PR_DATA });
    mockGetOctokit.mockReturnValue({
      pulls: {
        get: pullsGet,
        listReviewComments: vi.fn().mockResolvedValue({ data: lists.reviewComments ?? [] }),
        listReviews: vi.fn().mockResolvedValue({ data: lists.reviews ?? [] }),
      },
      issues: { listComments: vi.fn().mockResolvedValue({ data: lists.issueComments ?? [] }) },
    } as any);
    return pullsGet;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { githubUsername: 'testuser' } }),
      getStateStaleness: vi.fn().mockReturnValue(null),
    } as any);
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });
  });

  it('rejects a well-formed URL that parses as an issue, before fetching the PR', async () => {
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'issues' });
    const pullsGet = mockOctokit({});

    await expect(runComments({ prUrl: TEST_PR_URL })).rejects.toThrow('Invalid PR URL format');
    expect(pullsGet).not.toHaveBeenCalled();
  });

  it('names every truncated stream in the warning', async () => {
    mockOctokit({ reviews: fullPage(1), reviewComments: fullPage(2) });

    const result = await runComments({ prUrl: TEST_PR_URL });

    const truncation = result.warnings!.find((w) => w.operation === 'fetch PR comments (truncated)');
    expect(truncation!.message).toContain('reviews, inline review comments for owner/repo#42');
    expect(truncation!.message).not.toContain('discussion comments');
  });

  it('surfaces Gist staleness as a structured warning', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { githubUsername: 'testuser' } }),
      getStateStaleness: vi.fn().mockReturnValue({
        source: 'local-cache',
        reason: 'Gist unreachable',
        detectedAt: '2026-01-15T10:00:00Z',
        lastSuccessfulRefresh: null,
      }),
    } as any);
    mockOctokit({});

    const result = await runComments({ prUrl: TEST_PR_URL });

    expect(result.warnings).toEqual([
      expect.objectContaining({ phase: 'gist-staleness', message: expect.stringContaining('Gist unreachable') }),
    ]);
  });

  it('drops ghost-user entries, keeps bots only with showBots, and handles null bodies and dates', async () => {
    const lists = {
      reviews: [
        { user: null, state: 'APPROVED', body: 'ghost review', submitted_at: '2026-01-15T10:00:00Z' },
        { user: { login: 'late', type: 'User' }, state: 'COMMENTED', body: 'no date', submitted_at: null },
        { user: { login: 'early', type: 'User' }, state: 'APPROVED', body: 'dated', submitted_at: '2026-01-14T00:00Z' },
        {
          user: { login: 'blank', type: 'User' },
          state: 'APPROVED',
          body: ' '.repeat(3),
          submitted_at: '2026-01-15T00:00Z',
        },
      ],
      issueComments: [
        { user: { login: 'other', type: 'User' }, body: null, created_at: '2026-01-15T10:00:00Z' },
        { user: { login: 'ci-bot', type: 'Bot' }, body: 'build ok', created_at: '2026-01-15T09:00:00Z' },
      ],
    };
    mockOctokit(lists);

    const hidden = await runComments({ prUrl: TEST_PR_URL });

    // Dated review sorts before the undated one (missing submitted_at sorts as epoch).
    expect(hidden.reviews.map((r) => [r.user, r.submittedAt])).toEqual([
      ['early', '2026-01-14T00:00Z'],
      ['late', null],
    ]);
    expect(hidden.issueComments).toEqual([{ user: 'other', body: null, createdAt: '2026-01-15T10:00:00Z' }]);

    mockOctokit(lists);
    const shown = await runComments({ prUrl: TEST_PR_URL, showBots: true });
    expect(shown.issueComments.map((c) => c.user)).toEqual(['other', 'ci-bot']);
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

  it('refuses during an unattended run and never reaches GitHub', async () => {
    vi.stubEnv('OSS_AUTOPILOT_UNATTENDED', '1');
    try {
      await expect(runPost({ url: TEST_PR_URL, message: 'Thanks!' })).rejects.toThrow(/unattended run/);
      expect(mockRequireGitHubToken).not.toHaveBeenCalled();
      expect(mockGetOctokit).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['0', '', 'false'])('still refuses when the variable is set to %j', async (value) => {
    vi.stubEnv('OSS_AUTOPILOT_UNATTENDED', value);
    try {
      await expect(runPost({ url: TEST_PR_URL, message: 'Thanks!' })).rejects.toThrow(/unattended run/);
      expect(mockGetOctokit).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a message that does not match --expect-sha256, before any GitHub call (#1930)', async () => {
    const approved = createHash('sha256').update('Thanks!').digest('hex');

    await expect(runPost({ url: TEST_PR_URL, message: 'Thanks! (edited)', expectSha256: approved })).rejects.toThrow(
      /does not match the approved text/,
    );

    expect(mockRequireGitHubToken).not.toHaveBeenCalled();
    expect(mockGetOctokit).not.toHaveBeenCalled();
  });

  it('posts when the message matches --expect-sha256 (#1930)', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 42, type: 'pull' });
    const mockCreateComment = vi.fn().mockResolvedValue({ data: { html_url: `${TEST_PR_URL}#issuecomment-9` } });
    mockGetOctokit.mockReturnValue({ issues: { createComment: mockCreateComment } } as never);
    const approved = createHash('sha256').update('Thanks!').digest('hex');

    await runPost({ url: TEST_PR_URL, message: 'Thanks!', expectSha256: approved });

    expect(mockCreateComment).toHaveBeenCalledWith(expect.objectContaining({ body: 'Thanks!' }));
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

  it('refuses a well-formed URL the parser rejects, without posting', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue(null as any);

    await expect(runPost({ url: TEST_PR_URL, message: 'Hello' })).rejects.toThrow('Invalid GitHub URL format');
    expect(mockGetOctokit).not.toHaveBeenCalled();
  });
});

describe('runClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses during an unattended run and never reaches GitHub', async () => {
    vi.stubEnv('OSS_AUTOPILOT_UNATTENDED', '1');
    try {
      await expect(runClaim({ issueUrl: TEST_ISSUE_URL })).rejects.toThrow(/unattended run/);
      expect(mockRequireGitHubToken).not.toHaveBeenCalled();
      expect(mockGetOctokit).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a claim message that does not match --expect-sha256, before any GitHub call (#1930)', async () => {
    const approved = createHash('sha256').update('I can take this').digest('hex');

    await expect(
      runClaim({ issueUrl: TEST_ISSUE_URL, message: 'I can take this, and more', expectSha256: approved }),
    ).rejects.toThrow(/does not match the approved text/);

    expect(mockGetOctokit).not.toHaveBeenCalled();
    expect(mockGetStateManager).not.toHaveBeenCalled();
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

  it('threads stateSaveWarning into the envelope when addIssue throws after the comment posted (#1448)', async () => {
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
        throw new Error('CAS contention');
      }),
      save: vi.fn(),
    } as any);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runClaim({ issueUrl: TEST_ISSUE_URL });

    // The claim is live on GitHub but untracked locally — the envelope says so.
    expect(result.stateSaveWarning).toContain('failed to save to local state');
    expect(result.stateSaveWarning).toContain('CAS contention');
    // The gist checkpoint never ran (addIssue threw first), so its warning is absent.
    expect('gistSyncWarning' in result).toBe(false);
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

describe('runClaim edge arms (#2003)', () => {
  const COMMENT_URL = 'https://github.com/owner/repo/issues/10#issuecomment-1';
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ owner: 'owner', repo: 'repo', number: 10, type: 'issues' });
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return () => consoleSpy.mockRestore();
  });

  const mockIssues = (get: ReturnType<typeof vi.fn>) => {
    const createComment = vi.fn().mockResolvedValue({ data: { html_url: COMMENT_URL } });
    mockGetOctokit.mockReturnValue({ issues: { createComment, get } } as any);
    return createComment;
  };

  it('refuses a well-formed URL the parser rejects, without posting', async () => {
    mockParseGitHubUrl.mockReturnValue(null as any);

    await expect(runClaim({ issueUrl: TEST_ISSUE_URL })).rejects.toThrow('Invalid issue URL format');
    expect(mockGetOctokit).not.toHaveBeenCalled();
  });

  it('accepts string labels, drops unnamed ones, and keeps defaults for missing title/date/labels', async () => {
    const addIssue = vi.fn();
    mockGetStateManager.mockReturnValue({ addIssue } as any);
    mockIssues(
      vi.fn().mockResolvedValue({ data: { title: '', labels: ['bug', { name: null }, { name: 'help wanted' }, ''] } }),
    );

    await runClaim({ issueUrl: TEST_ISSUE_URL });

    expect(addIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: '(claimed)', labels: ['bug', 'help wanted'], createdAt: expect.any(String) }),
    );

    addIssue.mockClear();
    mockIssues(vi.fn().mockResolvedValue({ data: { title: 'T', labels: null } }));
    await runClaim({ issueUrl: TEST_ISSUE_URL });
    expect(addIssue).toHaveBeenCalledWith(expect.objectContaining({ title: 'T', labels: [] }));
  });

  it('logs a non-Error enrichment failure verbatim and still posts the claim', async () => {
    mockGetStateManager.mockReturnValue({ addIssue: vi.fn() } as any);
    const createComment = mockIssues(vi.fn().mockRejectedValue('socket hang up'));

    const result = await runClaim({ issueUrl: TEST_ISSUE_URL });

    expect(createComment).toHaveBeenCalled();
    expect(result.commentUrl).toBe(COMMENT_URL);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('claiming with placeholder: socket hang up'));
  });

  it('reports a non-Error state-save failure verbatim in stateSaveWarning', async () => {
    mockGetStateManager.mockReturnValue({
      addIssue: vi.fn().mockImplementation(() => {
        throw 'lock held';
      }),
    } as any);
    mockIssues(vi.fn().mockResolvedValue({ data: { title: 'T', labels: [] } }));

    const result = await runClaim({ issueUrl: TEST_ISSUE_URL });

    expect(result.stateSaveWarning).toBe(
      `Comment posted on ${TEST_ISSUE_URL} but failed to save to local state: lock held`,
    );
  });

  it('threads a Gist checkpoint failure into gistSyncWarning', async () => {
    vi.mocked(maybeCheckpoint).mockResolvedValueOnce('Gist push failed: conflict');
    mockGetStateManager.mockReturnValue({ addIssue: vi.fn() } as any);
    mockIssues(vi.fn().mockResolvedValue({ data: { title: 'T', labels: [] } }));

    const result = await runClaim({ issueUrl: TEST_ISSUE_URL });

    expect(result).toEqual({
      commentUrl: COMMENT_URL,
      issueUrl: TEST_ISSUE_URL,
      gistSyncWarning: 'Gist push failed: conflict',
    });
  });
});
