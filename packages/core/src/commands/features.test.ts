/**
 * Tests for features command (scout 0.9.0 #97/#98/#99).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFeatures = vi.fn();

vi.mock('./scout-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('./scout-bridge.js')>('./scout-bridge.js');
  return {
    ...actual,
    createAutopilotScout: vi.fn(async () => ({
      features: mockFeatures,
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
import { runFeatures } from './features.js';

const mockGetStateManager = vi.mocked(getStateManager);

function makeScoutFeatureCandidate(overrides: Record<string, unknown> = {}) {
  return {
    issue: {
      repo: 'owner/repo',
      number: 5,
      title: 'Add cool feature',
      url: 'https://github.com/owner/repo/issues/5',
      labels: ['enhancement'],
    },
    recommendation: 'approve' as const,
    reasonsToApprove: ['Maintainer is responsive'],
    reasonsToSkip: [],
    searchPriority: 'merged_pr' as const,
    viabilityScore: 80,
    horizon: 'quick-win' as const,
    ...overrides,
  };
}

describe('runFeatures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: {} }),
      getRepoScore: vi.fn().mockReturnValue(null),
    } as never);
  });

  it('passes options through to scout.features (count + per-call overrides)', async () => {
    mockFeatures.mockResolvedValue({
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: null,
    });

    await runFeatures({ maxResults: 7, anchorThreshold: 5, splitRatio: 0.7 });

    expect(mockFeatures).toHaveBeenCalledWith({
      count: 7,
      anchorThreshold: 5,
      splitRatio: 0.7,
    });
  });

  it('omits per-call overrides when caller does not provide them', async () => {
    mockFeatures.mockResolvedValue({
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: null,
    });

    await runFeatures({ maxResults: 10 });

    expect(mockFeatures).toHaveBeenCalledWith({
      count: 10,
      anchorThreshold: undefined,
      splitRatio: undefined,
    });
  });

  it('returns both buckets, anchorRepos, and a null message when scout reports a clean run', async () => {
    mockFeatures.mockResolvedValue({
      quickWins: [makeScoutFeatureCandidate({ horizon: 'quick-win' })],
      biggerBets: [
        makeScoutFeatureCandidate({
          issue: {
            repo: 'owner/other',
            number: 12,
            title: 'Big bet',
            url: 'https://github.com/owner/other/issues/12',
            labels: ['feature', 'roadmap'],
          },
          horizon: 'bigger-bet',
        }),
      ],
      anchorRepos: ['owner/repo', 'owner/other'],
      message: null,
    });

    const result = await runFeatures({ maxResults: 5 });

    expect(result.anchorRepos).toEqual(['owner/repo', 'owner/other']);
    expect(result.message).toBeNull();
    expect(result.quickWins).toHaveLength(1);
    expect(result.biggerBets).toHaveLength(1);
    expect(result.quickWins[0]).toEqual(
      expect.objectContaining({
        issue: expect.objectContaining({
          repo: 'owner/repo',
          repoUrl: 'https://github.com/owner/repo',
        }),
        horizon: 'quick-win',
      }),
    );
    expect(result.biggerBets[0].horizon).toBe('bigger-bet');
  });

  it('stamps a horizon literal on every candidate in each bucket', async () => {
    mockFeatures.mockResolvedValue({
      quickWins: [makeScoutFeatureCandidate({ horizon: 'quick-win' })],
      biggerBets: [makeScoutFeatureCandidate({ horizon: 'bigger-bet' })],
      anchorRepos: ['owner/repo'],
      message: null,
    });

    const result = await runFeatures({ maxResults: 5 });

    for (const c of result.quickWins) expect(c.horizon).toBe('quick-win');
    for (const c of result.biggerBets) expect(c.horizon).toBe('bigger-bet');
  });

  it('sanitizes an out-of-contract viabilityScore from scout (#1043 boundary)', async () => {
    mockFeatures.mockResolvedValue({
      quickWins: [makeScoutFeatureCandidate({ viabilityScore: 999 })],
      biggerBets: [],
      anchorRepos: ['owner/repo'],
      message: null,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runFeatures({ maxResults: 5 });

    expect(result.quickWins[0].viabilityScore).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('out-of-contract viabilityScore'));
    errSpy.mockRestore();
  });

  it('assigns a grade letter to every candidate', async () => {
    mockFeatures.mockResolvedValue({
      quickWins: [makeScoutFeatureCandidate()],
      biggerBets: [],
      anchorRepos: ['owner/repo'],
      message: null,
    });

    const result = await runFeatures({ maxResults: 5 });

    // Repo has no autopilot-tracked score and projectHealth is sentinel-unknown,
    // so the grader degrades to 'F' — same policy as runSearch (#1043).
    expect(result.quickWins[0].grade.letter).toBe('F');
  });

  it('returns the scout-side message verbatim when no anchors qualify', async () => {
    mockFeatures.mockResolvedValue({
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: 'No anchor repos yet (need 3+ merged PRs in a repo). Try `scout search` to build relationships first.',
    });

    const result = await runFeatures({ maxResults: 5 });

    expect(result.quickWins).toEqual([]);
    expect(result.biggerBets).toEqual([]);
    expect(result.anchorRepos).toEqual([]);
    expect(result.message).toMatch(/No anchor repos/);
  });

  it('includes repoScore on candidates whose repo is autopilot-tracked', async () => {
    mockFeatures.mockResolvedValue({
      quickWins: [
        makeScoutFeatureCandidate({ issue: { repo: 'scored/repo', number: 1, title: 't', url: 'u', labels: [] } }),
      ],
      biggerBets: [],
      anchorRepos: ['scored/repo'],
      message: null,
    });
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: {} }),
      getRepoScore: vi.fn().mockReturnValue({
        score: 8,
        mergedPRCount: 4,
        closedWithoutMergeCount: 1,
        signals: { isResponsive: true },
        lastMergedAt: '2026-02-01T00:00:00Z',
      }),
    } as never);

    const result = await runFeatures({ maxResults: 3 });

    expect(result.quickWins[0].repoScore).toEqual({
      score: 8,
      mergedPRCount: 4,
      closedWithoutMergeCount: 1,
      isResponsive: true,
      lastMergedAt: '2026-02-01T00:00:00Z',
    });
  });

  it('propagates errors from scout.features (auth/rate-limit pass-through)', async () => {
    mockFeatures.mockRejectedValue(new Error('API rate limit exceeded'));

    await expect(runFeatures({ maxResults: 5 })).rejects.toThrow('API rate limit exceeded');
  });
});
