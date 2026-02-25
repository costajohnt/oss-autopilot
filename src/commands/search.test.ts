/**
 * Tests for search command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearchIssues = vi.fn();
const mockFormatCandidate = vi.fn();
let mockRateLimitWarning: string | null = null;

vi.mock('../core/index.js', () => {
  const MockIssueDiscovery = vi.fn(function (this: any) {
    this.searchIssues = mockSearchIssues;
    this.formatCandidate = mockFormatCandidate;
    Object.defineProperty(this, 'rateLimitWarning', {
      get: () => mockRateLimitWarning,
    });
  });
  return {
    IssueDiscovery: MockIssueDiscovery,
    getGitHubToken: vi.fn(),
    getStateManager: vi.fn(),
    DEFAULT_CONFIG: {
      aiPolicyBlocklist: ['matplotlib/matplotlib'],
    },
  };
});

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

import { getGitHubToken, getStateManager } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';
import { runSearch } from './search.js';

const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockGetStateManager = vi.mocked(getStateManager);
const mockOutputJson = vi.mocked(outputJson);
const mockOutputJsonError = vi.mocked(outputJsonError);

describe('runSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitWarning = null;
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({
        config: {
          excludeRepos: ['excluded/repo'],
          aiPolicyBlocklist: ['matplotlib/matplotlib'],
        },
      }),
      getRepoScore: vi.fn().mockReturnValue(null),
    } as any);
  });

  it('should exit with error when no GitHub token is available', async () => {
    mockGetGitHubToken.mockReturnValue(null as any);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runSearch({ maxResults: 10, json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('GitHub authentication required'));
    mockExit.mockRestore();
  });

  it('should search and return candidates in JSON mode', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockSearchIssues.mockResolvedValue([
      {
        issue: {
          repo: 'owner/repo',
          number: 5,
          title: 'Fix bug',
          url: 'https://github.com/owner/repo/issues/5',
          labels: ['bug'],
        },
        recommendation: 'approve',
        reasonsToApprove: ['Active maintainers'],
        reasonsToSkip: [],
        searchPriority: 'high',
        viabilityScore: 85,
      },
    ]);

    await runSearch({ maxResults: 10, json: true });

    expect(mockSearchIssues).toHaveBeenCalledWith({ maxResults: 10 });
    expect(mockOutputJson).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({
            issue: {
              repo: 'owner/repo',
              number: 5,
              title: 'Fix bug',
              url: 'https://github.com/owner/repo/issues/5',
              labels: ['bug'],
            },
            recommendation: 'approve',
          }),
        ]),
        excludedRepos: ['excluded/repo'],
        aiPolicyBlocklist: ['matplotlib/matplotlib'],
      }),
    );
  });

  it('should include repo score when available', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockSearchIssues.mockResolvedValue([
      {
        issue: {
          repo: 'scored/repo',
          number: 1,
          title: 'Issue',
          url: 'https://github.com/scored/repo/issues/1',
          labels: [],
        },
        recommendation: 'approve',
        reasonsToApprove: [],
        reasonsToSkip: [],
        searchPriority: 'medium',
        viabilityScore: 70,
      },
    ]);
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({
        config: { excludeRepos: [], aiPolicyBlocklist: [] },
      }),
      getRepoScore: vi.fn().mockReturnValue({
        score: 8,
        mergedPRCount: 3,
        closedWithoutMergeCount: 1,
        signals: { isResponsive: true },
        lastMergedAt: '2026-01-10T00:00:00Z',
      }),
    } as any);

    await runSearch({ maxResults: 5, json: true });

    const outputData = mockOutputJson.mock.calls[0][0] as any;
    expect(outputData.candidates[0].repoScore).toEqual({
      score: 8,
      mergedPRCount: 3,
      closedWithoutMergeCount: 1,
      isResponsive: true,
      lastMergedAt: '2026-01-10T00:00:00Z',
    });
  });

  it('should include rate limit warning when present', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockSearchIssues.mockResolvedValue([]);
    mockRateLimitWarning = 'Rate limit is low';

    await runSearch({ maxResults: 10, json: true });

    const outputData = mockOutputJson.mock.calls[0][0] as any;
    expect(outputData.rateLimitWarning).toBe('Rate limit is low');
  });

  it('should handle empty results in text mode', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockSearchIssues.mockResolvedValue([]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runSearch({ maxResults: 10, json: false });

    expect(consoleSpy).toHaveBeenCalled();
    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('No matching issues found');
    consoleSpy.mockRestore();
  });
});
