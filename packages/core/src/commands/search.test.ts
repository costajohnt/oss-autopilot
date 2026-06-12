/**
 * Tests for search command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearch = vi.fn();

vi.mock('./scout-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('./scout-bridge.js')>('./scout-bridge.js');
  return {
    ...actual,
    createAutopilotScout: vi.fn(async () => ({
      search: mockSearch,
    })),
  };
});

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: vi.fn(),
  };
});

import { getStateManager } from '../core/index.js';
import { createAutopilotScout, type ScoutBridgeDiagnostics } from './scout-bridge.js';
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

  it('passes the diversity counterweight ratio to scout (#1244)', async () => {
    mockSearch.mockResolvedValue({
      candidates: [],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ['broad'],
    });

    await runSearch({ maxResults: 5 });

    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ diversityRatio: 0.2 }));
  });

  it('surfaces diversitySlot on candidates and omits it when absent (#1244)', async () => {
    const base = {
      recommendation: 'approve',
      reasonsToApprove: [],
      reasonsToSkip: [],
      searchPriority: 'normal',
      viabilityScore: 50,
    };
    mockSearch.mockResolvedValue({
      candidates: [
        {
          ...base,
          issue: { repo: 'a/b', number: 1, title: 'slot', url: 'https://github.com/a/b/issues/1', labels: [] },
          // Scout 1.0 folded the flat boost/diversity fields into `personalization` (#158).
          personalization: { kind: 'diversity' },
        },
        {
          ...base,
          issue: { repo: 'a/b', number: 2, title: 'boosted', url: 'https://github.com/a/b/issues/2', labels: [] },
          personalization: { kind: 'boosted', score: 3, reasons: ['language match: TypeScript'] },
        },
      ],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ['broad'],
    });

    const result = await runSearch({ maxResults: 5 });

    expect(result.candidates[0].diversitySlot).toBe(true);
    expect('diversitySlot' in result.candidates[1]).toBe(false);
    expect(result.candidates[1].boostReasons).toEqual(['language match: TypeScript']);
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

    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 10, diversityRatio: 0.2 }));
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

  it('surfaces skipListUnavailable when the bridge reports an unreadable skip file, and omits it otherwise (#1448)', async () => {
    mockSearch.mockResolvedValue({
      candidates: [],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: [],
    });

    // Clean run: flag must be absent, not false (contract goldens stay byte-identical).
    const cleanResult = await runSearch({ maxResults: 10 });
    expect('skipListUnavailable' in cleanResult).toBe(false);

    // Degraded run: bridge flags the unreadable skip file via the diagnostics out-param.
    vi.mocked(createAutopilotScout).mockImplementationOnce(async (diagnostics?: ScoutBridgeDiagnostics) => {
      if (diagnostics) diagnostics.skipListUnavailable = true;
      return { search: mockSearch } as any;
    });
    const degradedResult = await runSearch({ maxResults: 10 });
    expect(degradedResult.skipListUnavailable).toBe(true);
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

  // ── #1043 data-contract defenses ─────────────────────────────────────

  it('assigns a grade letter to every candidate (#1043)', async () => {
    mockSearch.mockResolvedValue({
      candidates: [
        {
          issue: {
            repo: 'unknown/repo',
            number: 1,
            title: 'Issue',
            url: 'https://github.com/unknown/repo/issues/1',
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

    const result = await runSearch({ maxResults: 5 });

    // Repo has no autopilot-tracked score, scout-side signals are treated as
    // unknown — every signal missing degrades to F per issue-grading policy.
    expect(result.candidates[0].grade.letter).toBe('F');
    expect(result.candidates[0].grade.reason).toMatch(/unknown/i);
  });

  it('computes a higher grade when a healthy repoScore is known (#1043)', async () => {
    mockSearch.mockResolvedValue({
      candidates: [
        {
          issue: {
            repo: 'healthy/repo',
            number: 1,
            title: 'Issue',
            url: 'https://github.com/healthy/repo/issues/1',
            labels: [],
          },
          recommendation: 'approve',
          reasonsToApprove: [],
          reasonsToSkip: [],
          searchPriority: 'high',
          viabilityScore: 88,
        },
      ],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ['merged'],
    });
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: { excludeRepos: [], aiPolicyBlocklist: [] } }),
      getRepoScore: vi.fn().mockReturnValue({
        score: 9,
        mergedPRCount: 20,
        closedWithoutMergeCount: 3,
        avgResponseDays: 2,
        signals: { isResponsive: true },
      }),
    } as any);

    const result = await runSearch({ maxResults: 5 });

    // High merge rate (20/23 ≈ 87%) + fast response → at worst C after the
    // one-step degrade for unknown commit activity. Assert it beat F.
    expect(result.candidates[0].grade.letter).not.toBe('F');
  });

  it('surfaces a linkedPR slice with isStalled=true for an open PR last updated >30 days ago', async () => {
    mockSearch.mockResolvedValue({
      candidates: [
        {
          issue: {
            repo: 'foo/bar',
            number: 1,
            title: 'Issue with stalled linked PR',
            url: 'https://github.com/foo/bar/issues/1',
            labels: [],
          },
          recommendation: 'needs_review',
          reasonsToApprove: [],
          reasonsToSkip: [],
          searchPriority: 'normal',
          viabilityScore: 50,
          vettingResult: {
            linkedPR: {
              number: 88,
              author: 'someone',
              state: 'open',
              merged: false,
              url: 'https://github.com/foo/bar/pull/88',
              updatedAt: '2020-01-01T00:00:00Z',
            },
          },
        },
      ],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ['broad'],
    });

    const result = await runSearch({ maxResults: 5 });

    expect(result.candidates[0].linkedPR).toEqual({
      number: 88,
      state: 'open',
      url: 'https://github.com/foo/bar/pull/88',
      updatedAt: '2020-01-01T00:00:00Z',
      isStalled: true,
    });
  });

  it('omits linkedPR from output when scout reported no linked PR', async () => {
    mockSearch.mockResolvedValue({
      candidates: [
        {
          issue: {
            repo: 'foo/bar',
            number: 1,
            title: 'Plain issue',
            url: 'https://github.com/foo/bar/issues/1',
            labels: [],
          },
          recommendation: 'approve',
          reasonsToApprove: [],
          reasonsToSkip: [],
          searchPriority: 'normal',
          viabilityScore: 70,
          vettingResult: { linkedPR: null },
        },
      ],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ['broad'],
    });

    const result = await runSearch({ maxResults: 5 });

    expect('linkedPR' in result.candidates[0]).toBe(false);
  });

  it('sanitizes an out-of-contract viabilityScore from scout (#1043)', async () => {
    mockSearch.mockResolvedValue({
      candidates: [
        {
          issue: {
            repo: 'sketchy/repo',
            number: 1,
            title: 'Issue',
            url: 'https://github.com/sketchy/repo/issues/1',
            labels: [],
          },
          recommendation: 'approve',
          reasonsToApprove: [],
          reasonsToSkip: [],
          searchPriority: 'medium',
          viabilityScore: 999, // out-of-contract (should be 0-100)
        },
      ],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ['broad'],
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runSearch({ maxResults: 5 });

    expect(result.candidates[0].viabilityScore).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('out-of-contract viabilityScore'));
    errSpy.mockRestore();
  });

  describe('own-PR filtering (#1354)', () => {
    function candidateWithLinkedPR(number: number, author: string | null, state: string, merged = false) {
      return {
        issue: {
          repo: 'foo/bar',
          number,
          title: `Issue ${number}`,
          url: `https://github.com/foo/bar/issues/${number}`,
          labels: [],
        },
        recommendation: 'approve',
        reasonsToApprove: [],
        reasonsToSkip: [],
        searchPriority: 'normal',
        viabilityScore: 50,
        vettingResult: {
          linkedPR: {
            number: number * 10,
            author,
            state,
            merged,
            url: `https://github.com/foo/bar/pull/${number * 10}`,
            updatedAt: '2026-06-01T00:00:00Z',
          },
        },
      };
    }

    function stateWithUsername(githubUsername?: string) {
      mockGetStateManager.mockReturnValue({
        getState: vi.fn().mockReturnValue({
          config: { excludeRepos: [], aiPolicyBlocklist: [], ...(githubUsername ? { githubUsername } : {}) },
        }),
        getRepoScore: vi.fn().mockReturnValue(null),
      } as any);
    }

    it("drops candidates linked to the user's own open PR and reports the count", async () => {
      stateWithUsername('OctoCat');
      mockSearch.mockResolvedValue({
        candidates: [
          candidateWithLinkedPR(1, 'octocat', 'open'), // own (case-insensitive) → hidden
          candidateWithLinkedPR(2, 'rival', 'open'), // someone else's → visible
          candidateWithLinkedPR(3, 'octocat', 'closed'), // own but closed → visible
        ],
        excludedRepos: [],
        aiPolicyBlocklist: [],
        strategiesUsed: ['broad'],
      });

      const result = await runSearch({ maxResults: 5 });

      expect(result.hiddenOwnPRCount).toBe(1);
      expect(result.candidates.map((c) => c.issue.number)).toEqual([2, 3]);
    });

    it('hides nothing when githubUsername is not configured', async () => {
      stateWithUsername(undefined);
      mockSearch.mockResolvedValue({
        candidates: [candidateWithLinkedPR(1, 'octocat', 'open')],
        excludedRepos: [],
        aiPolicyBlocklist: [],
        strategiesUsed: ['broad'],
      });

      const result = await runSearch({ maxResults: 5 });

      expect(result.hiddenOwnPRCount).toBe(0);
      expect(result.candidates).toHaveLength(1);
    });

    it('reports hiddenOwnPRCount: 0 when no candidate has a linked PR', async () => {
      stateWithUsername('octocat');
      mockSearch.mockResolvedValue({
        candidates: [
          {
            issue: {
              repo: 'foo/bar',
              number: 1,
              title: 'Plain issue',
              url: 'https://github.com/foo/bar/issues/1',
              labels: [],
            },
            recommendation: 'approve',
            reasonsToApprove: [],
            reasonsToSkip: [],
            searchPriority: 'normal',
            viabilityScore: 50,
          },
        ],
        excludedRepos: [],
        aiPolicyBlocklist: [],
        strategiesUsed: ['broad'],
      });

      const result = await runSearch({ maxResults: 5 });

      expect(result.hiddenOwnPRCount).toBe(0);
      expect(result.candidates).toHaveLength(1);
    });
  });
});
