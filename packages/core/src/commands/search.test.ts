/**
 * Tests for search command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearch = vi.fn();

vi.mock('./scout-bridge.js', () => ({
  createAutopilotScout: vi.fn(async () => ({
    search: mockSearch,
  })),
}));

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runSearch } from './search.js';

const mockGetStateManager = vi.mocked(getStateManager);

describe('runSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('should search and return candidates', async () => {
    mockSearch.mockResolvedValue({
      candidates: [
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
      ],
      excludedRepos: ['excluded/repo'],
      aiPolicyBlocklist: ['matplotlib/matplotlib'],
      strategiesUsed: ['merged', 'broad'],
    });

    const result = await runSearch({ maxResults: 10 });

    expect(mockSearch).toHaveBeenCalledWith({ maxResults: 10 });
    expect(result).toEqual(
      expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({
            issue: {
              repo: 'owner/repo',
              repoUrl: 'https://github.com/owner/repo',
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
    mockSearch.mockResolvedValue({
      candidates: [
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
      ],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ['broad'],
    });
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

    const result = await runSearch({ maxResults: 5 });

    expect(result.candidates[0].repoScore).toEqual({
      score: 8,
      mergedPRCount: 3,
      closedWithoutMergeCount: 1,
      isResponsive: true,
      lastMergedAt: '2026-01-10T00:00:00Z',
    });
  });

  it('should include rate limit warning when present', async () => {
    mockSearch.mockResolvedValue({
      candidates: [],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      rateLimitWarning: 'Rate limit is low',
      strategiesUsed: [],
    });

    const result = await runSearch({ maxResults: 10 });

    expect(result.rateLimitWarning).toBe('Rate limit is low');
  });

  it('should return empty candidates array when no results', async () => {
    mockSearch.mockResolvedValue({
      candidates: [],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: [],
    });

    const result = await runSearch({ maxResults: 10 });

    expect(result.candidates).toEqual([]);
  });

  it('should include repoUrl derived from repo name (#789)', async () => {
    mockSearch.mockResolvedValue({
      candidates: [
        {
          issue: {
            repo: 'facebook/react',
            number: 42,
            title: 'Some issue',
            url: 'https://github.com/facebook/react/issues/42',
            labels: [],
          },
          recommendation: 'approve',
          reasonsToApprove: [],
          reasonsToSkip: [],
          searchPriority: 'high',
          viabilityScore: 90,
        },
      ],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ['broad'],
    });

    const result = await runSearch({ maxResults: 5 });

    expect(result.candidates[0].issue.repoUrl).toBe('https://github.com/facebook/react');
  });

  it('should propagate errors from search (#414)', async () => {
    mockSearch.mockRejectedValue(new Error('API rate limit exceeded'));

    await expect(runSearch({ maxResults: 5 })).rejects.toThrow('API rate limit exceeded');
  });
});
