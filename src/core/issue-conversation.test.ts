/**
 * Tests for IssueConversationMonitor — comment detection, bot filtering,
 * acknowledgment filtering, issue exclusion, and edge cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockOctokitInstance: any;

// Default state config — reset in beforeEach and overridable per test
const defaultState = () => ({
  config: {
    githubUsername: 'testuser',
    excludeRepos: [] as string[],
    excludeOrgs: [] as string[],
    aiPolicyBlocklist: ['blocked/repo'],
  },
  activeIssues: [] as Array<{ repo: string; number: number; status: string }>,
});

let mockState = defaultState();

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => mockOctokitInstance),
}));

vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: () => mockState,
  })),
}));

const { IssueConversationMonitor, isAcknowledgmentComment } = await import('./issue-conversation.js');

// Helper to build a search result item
function makeSearchItem(overrides: Record<string, any> = {}) {
  return {
    html_url: 'https://github.com/owner/repo/issues/42',
    number: 42,
    title: 'Test issue',
    labels: [{ name: 'bug' }],
    pull_request: undefined,
    user: { login: 'someone-else' },
    ...overrides,
  };
}

// Helper to build a comment
function makeComment(author: string, body: string, created_at: string) {
  return {
    user: { login: author },
    body,
    created_at,
  };
}

describe('isAcknowledgmentComment', () => {
  it('should detect "thanks" as acknowledgment', () => {
    expect(isAcknowledgmentComment('Thanks for the PR!')).toBe(true);
  });

  it('should detect "LGTM" as acknowledgment', () => {
    expect(isAcknowledgmentComment('LGTM')).toBe(true);
  });

  it('should detect "will review" as acknowledgment', () => {
    expect(isAcknowledgmentComment('Will review this soon')).toBe(true);
  });

  it('should NOT treat questions as acknowledgments', () => {
    expect(isAcknowledgmentComment('Thanks, but can you add tests?')).toBe(false);
  });

  it('should NOT treat long comments as acknowledgments', () => {
    const longComment = 'Thanks! '.repeat(20); // > 100 chars
    expect(isAcknowledgmentComment(longComment)).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isAcknowledgmentComment('')).toBe(false);
  });

  it('should return false for non-acknowledgment comment', () => {
    expect(isAcknowledgmentComment('Please fix the lint errors')).toBe(false);
  });
});

describe('IssueConversationMonitor', () => {
  beforeEach(() => {
    mockState = defaultState();
    mockOctokitInstance = {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: { items: [], total_count: 0 },
        }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({
          data: [],
        }),
      },
    };
  });

  it('should detect maintainer response after user comment', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem()],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [
        makeComment('testuser', 'Is this still relevant?', '2026-02-01T10:00:00Z'),
        makeComment('maintainer', 'Yes, go for it!', '2026-02-02T10:00:00Z'),
      ],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues, failures } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe('new_response');
    expect(issues[0].lastResponseAuthor).toBe('maintainer');
    expect(issues[0].lastResponseBody).toContain('Yes, go for it!');
    expect(failures).toHaveLength(0);
  });

  it('should ignore bot comments', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem()],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [
        makeComment('testuser', 'I can work on this', '2026-02-01T10:00:00Z'),
        makeComment('stale[bot]', 'This issue has been automatically marked as stale.', '2026-02-05T10:00:00Z'),
      ],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    // Bot comment should be ignored, so user is last commenter
    expect(issues[0].status).toBe('acknowledged');
  });

  it('should set waiting status when only acknowledgment responses exist', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem()],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [
        makeComment('testuser', 'I would like to work on this', '2026-02-01T10:00:00Z'),
        makeComment('maintainer', 'Thanks!', '2026-02-02T10:00:00Z'),
      ],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    // "Thanks!" is an acknowledgment — filtered from lastResponse, but maintainer
    // is the last non-bot commenter, so status is 'waiting' not 'new_response'
    expect(issues[0].status).toBe('waiting');
  });

  it('should filter out user-authored issues', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          makeSearchItem({ user: { login: 'testuser' } }), // authored by user
        ],
        total_count: 1,
      },
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(0);
  });

  it('should filter out already-tracked issues', async () => {
    mockState = {
      ...defaultState(),
      config: {
        ...defaultState().config,
        aiPolicyBlocklist: [],
      },
      activeIssues: [{
        repo: 'owner/repo',
        number: 42,
        status: 'claimed',
      }],
    };

    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem()],
        total_count: 1,
      },
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(0);
  });

  it('should handle empty comment threads', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem({
          html_url: 'https://github.com/owner/repo/issues/99',
          number: 99,
        })],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [], // no comments
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    // No user comment found in timeline, analyzeIssueConversation returns null
    expect(issues).toHaveLength(0);
  });

  it('should use case-insensitive username matching', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem()],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [
        makeComment('TestUser', 'Can I work on this?', '2026-02-01T10:00:00Z'),  // Different case
        makeComment('maintainer', 'Sure, go ahead!', '2026-02-02T10:00:00Z'),
      ],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe('new_response');
  });

  it('should filter out pull requests from search results', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          makeSearchItem({ pull_request: { url: 'https://api.github.com/...' } }), // is a PR
        ],
        total_count: 1,
      },
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(0);
  });

  it('should filter out blocklisted repos', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          makeSearchItem({
            html_url: 'https://github.com/blocked/repo/issues/1',
            number: 1,
          }),
        ],
        total_count: 1,
      },
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(0);
  });

  it('should set acknowledged status when user is the last commenter', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem()],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [
        makeComment('other-person', 'Some context on this issue', '2026-01-30T10:00:00Z'),
        makeComment('testuser', 'I can work on this', '2026-02-01T10:00:00Z'),
      ],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe('acknowledged');
  });

  it('should truncate long response bodies to 200 chars', async () => {
    const longBody = 'A'.repeat(300);

    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem()],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [
        makeComment('testuser', 'Question', '2026-02-01T10:00:00Z'),
        makeComment('maintainer', longBody, '2026-02-02T10:00:00Z'),
      ],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].lastResponseBody!.length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it('should sort results with new_response first', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          makeSearchItem({
            html_url: 'https://github.com/owner/repo/issues/1',
            number: 1,
            title: 'Waiting issue',
          }),
          makeSearchItem({
            html_url: 'https://github.com/owner/repo/issues/2',
            number: 2,
            title: 'Responded issue',
          }),
        ],
        total_count: 2,
      },
    });

    // First call for issue 1 (no response)
    // Second call for issue 2 (has response)
    let callCount = 0;
    mockOctokitInstance.issues.listComments.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Issue 1: user commented, no response
        return Promise.resolve({
          data: [
            makeComment('testuser', 'I can help', '2026-02-01T10:00:00Z'),
          ],
        });
      } else {
        // Issue 2: user commented, maintainer responded
        return Promise.resolve({
          data: [
            makeComment('testuser', 'Can I work on this?', '2026-02-01T10:00:00Z'),
            makeComment('maintainer', 'Yes please!', '2026-02-02T10:00:00Z'),
          ],
        });
      }
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(2);
    // new_response should come first
    expect(issues[0].status).toBe('new_response');
    expect(issues[0].number).toBe(2);
    expect(issues[1].status).toBe('acknowledged');
    expect(issues[1].number).toBe(1);
  });

  it('should include labels from the issue', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem({
          labels: [{ name: 'bug' }, { name: 'help wanted' }],
        })],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [
        makeComment('testuser', 'I can help', '2026-02-01T10:00:00Z'),
        makeComment('maintainer', 'Great, go ahead', '2026-02-02T10:00:00Z'),
      ],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].labels).toEqual(['bug', 'help wanted']);
  });

  it('should throw when githubUsername is not configured', async () => {
    mockState = {
      ...defaultState(),
      config: {
        ...defaultState().config,
        githubUsername: '',
      },
    };

    const monitor = new IssueConversationMonitor('fake-token');
    await expect(monitor.fetchCommentedIssues()).rejects.toThrow('No GitHub username configured');
  });

  it('should continue processing when one issue analysis fails', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          makeSearchItem({ html_url: 'https://github.com/owner/repo/issues/1', number: 1 }),
          makeSearchItem({ html_url: 'https://github.com/owner/repo/issues/2', number: 2 }),
        ],
        total_count: 2,
      },
    });

    let callCount = 0;
    mockOctokitInstance.issues.listComments.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('API rate limit exceeded'));
      }
      return Promise.resolve({
        data: [
          makeComment('testuser', 'Question', '2026-02-01T10:00:00Z'),
          makeComment('maintainer', 'Answer', '2026-02-02T10:00:00Z'),
        ],
      });
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues, failures } = await monitor.fetchCommentedIssues();

    // One failed, one succeeded
    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe('new_response');
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toContain('rate limit');
  });

  it('should filter out excludeRepos', async () => {
    mockState = {
      ...defaultState(),
      config: {
        ...defaultState().config,
        excludeRepos: ['excluded/repo'],
        aiPolicyBlocklist: [],
      },
    };

    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          makeSearchItem({ html_url: 'https://github.com/excluded/repo/issues/1', number: 1 }),
        ],
        total_count: 1,
      },
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(0);
  });

  it('should use case-sensitive matching for excludeRepos (matches PRMonitor)', async () => {
    mockState = {
      ...defaultState(),
      config: {
        ...defaultState().config,
        excludeRepos: ['Excluded/Repo'],
        aiPolicyBlocklist: [],
      },
    };

    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          makeSearchItem({ html_url: 'https://github.com/excluded/repo/issues/1', number: 1 }),
        ],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [
        { user: { login: 'testuser' }, body: 'I can help', created_at: '2026-02-01T10:00:00Z' },
        { user: { login: 'maintainer' }, body: 'Go ahead', created_at: '2026-02-02T10:00:00Z' },
      ],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    // Case mismatch: 'Excluded/Repo' does not match 'excluded/repo', so issue is NOT filtered
    expect(issues).toHaveLength(1);
  });

  it('should filter out excludeOrgs', async () => {
    mockState = {
      ...defaultState(),
      config: {
        ...defaultState().config,
        excludeOrgs: ['excludedorg'],
        aiPolicyBlocklist: [],
      },
    };

    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          makeSearchItem({ html_url: 'https://github.com/ExcludedOrg/some-repo/issues/5', number: 5 }),
        ],
        total_count: 1,
      },
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    // Case-insensitive: 'ExcludedOrg' should match 'excludedorg'
    expect(issues).toHaveLength(0);
  });

  it('should filter out issues in user-owned repos', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          // Repo owned by testuser — someone else opened the issue
          makeSearchItem({
            html_url: 'https://github.com/testuser/my-project/issues/10',
            number: 10,
            user: { login: 'contributor' },
          }),
        ],
        total_count: 1,
      },
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(0);
  });

  it('should return empty failures array on success', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: { items: [], total_count: 0 },
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues, failures } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(0);
    expect(failures).toHaveLength(0);
  });

  it('should propagate search API failure as thrown error', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockRejectedValue(
      new Error('API rate limit exceeded'),
    );

    const monitor = new IssueConversationMonitor('fake-token');
    await expect(monitor.fetchCommentedIssues()).rejects.toThrow('API rate limit exceeded');
  });

  it('should skip comments from deleted accounts (null user.login)', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem()],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [
        makeComment('testuser', 'I can work on this', '2026-02-01T10:00:00Z'),
        { user: null, body: 'Ghost comment from deleted account', created_at: '2026-02-02T10:00:00Z' },
        makeComment('maintainer', 'Sure, assigned!', '2026-02-03T10:00:00Z'),
      ],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe('new_response');
    // The deleted account comment is skipped; maintainer response is detected
    expect(issues[0].lastResponseAuthor).toBe('maintainer');
  });

  it('should use the latest maintainer response when multiple exist', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem()],
        total_count: 1,
      },
    });

    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [
        makeComment('testuser', 'Can I work on this?', '2026-02-01T10:00:00Z'),
        makeComment('maintainerA', 'Let me check...', '2026-02-02T10:00:00Z'),
        makeComment('maintainerB', 'Yes, go ahead and submit a PR', '2026-02-03T10:00:00Z'),
      ],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe('new_response');
    // "Last wins" — maintainerB's response (latest) should be the one surfaced
    expect(issues[0].lastResponseAuthor).toBe('maintainerB');
    expect(issues[0].lastResponseBody).toContain('go ahead and submit a PR');
  });

  it('should record null analysis results in failures array', async () => {
    mockOctokitInstance.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [makeSearchItem()],
        total_count: 1,
      },
    });

    // Empty comment thread — analyzeIssueConversation returns null
    mockOctokitInstance.issues.listComments.mockResolvedValue({
      data: [],
    });

    const monitor = new IssueConversationMonitor('fake-token');
    const { issues, failures } = await monitor.fetchCommentedIssues();

    expect(issues).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].issueUrl).toBe('https://github.com/owner/repo/issues/42');
    expect(failures[0].error).toContain('No user comment found');
  });
});
