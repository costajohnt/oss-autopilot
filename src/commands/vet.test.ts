/**
 * Tests for vet command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVetIssue = vi.fn();
const mockFormatCandidate = vi.fn();

vi.mock('../core/index.js', () => {
  const MockIssueDiscovery = vi.fn(function (this: any) {
    this.vetIssue = mockVetIssue;
    this.formatCandidate = mockFormatCandidate;
  });
  return {
    IssueDiscovery: MockIssueDiscovery,
    getGitHubToken: vi.fn(),
  };
});

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
}));

import { getGitHubToken } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import { runVet } from './vet.js';

const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockOutputJson = vi.mocked(outputJson);

const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/5';

describe('runVet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should vet an issue and output JSON result', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    const candidate = {
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: ['bug'] },
      recommendation: 'approve' as const,
      reasonsToApprove: ['Active maintainers', 'Good first issue label'],
      reasonsToSkip: [],
      projectHealth: { stars: 1000, openIssues: 50 },
      vettingResult: { isViable: true },
    };
    mockVetIssue.mockResolvedValue(candidate);

    await runVet({ issueUrl: TEST_ISSUE_URL, json: true });

    expect(mockVetIssue).toHaveBeenCalledWith(TEST_ISSUE_URL);
    expect(mockOutputJson).toHaveBeenCalledWith({
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: ['bug'] },
      recommendation: 'approve',
      reasonsToApprove: ['Active maintainers', 'Good first issue label'],
      reasonsToSkip: [],
      projectHealth: { stars: 1000, openIssues: 50 },
      vettingResult: { isViable: true },
    });
  });

  it('should output formatted text in non-JSON mode', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    const candidate = {
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: [] },
      recommendation: 'skip' as const,
      reasonsToApprove: [],
      reasonsToSkip: ['Inactive project'],
      projectHealth: {},
      vettingResult: { isViable: false },
    };
    mockVetIssue.mockResolvedValue(candidate);
    mockFormatCandidate.mockReturnValue('Formatted output');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runVet({ issueUrl: TEST_ISSUE_URL, json: false });

    expect(mockFormatCandidate).toHaveBeenCalledWith(candidate);
    expect(consoleSpy).toHaveBeenCalledWith('Formatted output');
    consoleSpy.mockRestore();
  });
});
