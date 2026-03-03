/**
 * Tests for vet command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVetIssue = vi.fn();

vi.mock('../core/index.js', () => {
  const MockIssueDiscovery = vi.fn(function (this: any) {
    this.vetIssue = mockVetIssue;
  });
  return {
    IssueDiscovery: MockIssueDiscovery,
    requireGitHubToken: vi.fn(),
  };
});

import { requireGitHubToken } from '../core/index.js';
import { runVet } from './vet.js';

const mockRequireGitHubToken = vi.mocked(requireGitHubToken);

const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/5';

describe('runVet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should vet an issue and return structured result', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    const candidate = {
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: ['bug'] },
      recommendation: 'approve' as const,
      reasonsToApprove: ['Active maintainers', 'Good first issue label'],
      reasonsToSkip: [],
      projectHealth: { stars: 1000, openIssues: 50 },
      vettingResult: { isViable: true },
    };
    mockVetIssue.mockResolvedValue(candidate);

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(mockVetIssue).toHaveBeenCalledWith(TEST_ISSUE_URL);
    expect(result).toEqual({
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: ['bug'] },
      recommendation: 'approve',
      reasonsToApprove: ['Active maintainers', 'Good first issue label'],
      reasonsToSkip: [],
      projectHealth: { stars: 1000, openIssues: 50 },
      vettingResult: { isViable: true },
    });
  });

  it('should reject a non-GitHub issue URL', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');

    await expect(runVet({ issueUrl: 'https://example.com/not-github' })).rejects.toThrow('Invalid issue URL');
  });

  it('should reject a PR URL (not an issue URL)', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');

    await expect(runVet({ issueUrl: 'https://github.com/owner/repo/pull/5' })).rejects.toThrow('Invalid issue URL');
  });

  it('should reject a URL that exceeds maximum length', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    const longUrl = 'https://github.com/' + 'a'.repeat(2100);

    await expect(runVet({ issueUrl: longUrl })).rejects.toThrow('exceeds maximum length');
  });

  it('should propagate errors from vetIssue', async () => {
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
    mockVetIssue.mockRejectedValue(new Error('Issue not found'));

    await expect(runVet({ issueUrl: TEST_ISSUE_URL })).rejects.toThrow('Issue not found');
  });
});
