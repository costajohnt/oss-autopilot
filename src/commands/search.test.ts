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
}));

import { getGitHubToken, getStateManager } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import { runSearch } from './search.js';

const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockGetStateManager = vi.mocked(getStateManager);
const mockOutputJson = vi.mocked(outputJson);

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

  it('should display candidates in text mode', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockSearchIssues.mockResolvedValue([
      {
        issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: 'https://github.com/owner/repo/issues/5', labels: ['bug'] },
        recommendation: 'approve',
        reasonsToApprove: ['Active maintainers'],
        reasonsToSkip: [],
        searchPriority: 'high',
        viabilityScore: 85,
      },
    ]);
    mockFormatCandidate.mockReturnValue('Formatted candidate text');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runSearch({ maxResults: 10, json: false });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Searching for issues');
    expect(allOutput).toContain('Found 1 candidates');
    expect(allOutput).toContain('Formatted candidate text');
    expect(allOutput).toContain('---');
    consoleSpy.mockRestore();
  });

  it('should display rate limit warning in text mode', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockSearchIssues.mockResolvedValue([
      {
        issue: { repo: 'a/b', number: 1, title: 'X', url: 'https://github.com/a/b/issues/1', labels: [] },
        recommendation: 'approve',
        reasonsToApprove: [],
        reasonsToSkip: [],
        searchPriority: 'normal',
        viabilityScore: 60,
      },
    ]);
    mockFormatCandidate.mockReturnValue('candidate');
    mockRateLimitWarning = 'Rate limit is low';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSearch({ maxResults: 10, json: false });

    const warnOutput = warnSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(warnOutput).toContain('Rate limit is low');
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
