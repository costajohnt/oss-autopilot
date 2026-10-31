/**
 * Tests for vet command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVetIssue = vi.fn();
const mockGetRepoScore = vi.fn();
const mockRecordPickSnapshots = vi.fn();
const mockGetState = vi.fn();

vi.mock('./scout-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('./scout-bridge.js')>('./scout-bridge.js');
  return {
    ...actual,
    createAutopilotScout: vi.fn(async () => ({
      vetIssue: mockVetIssue,
    })),
  };
});

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    fetchIssueAuthorTraits: async () => ({}),
    getOctokit: () => ({}),
    requireGitHubToken: () => 'fake-token',
    getStateManager: () => ({
      getRepoScore: mockGetRepoScore,
      getState: mockGetState,
      recordPickSnapshots: mockRecordPickSnapshots,
      isGistMode: () => false,
      reloadIfChanged: () => false,
    }),
  };
});

import { runVet } from './vet.js';

const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/5';

describe('runVet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({ config: { githubUsername: 'costajohnt' } });
  });

  it('marks the result with repoCap when the repo is at its open-PR cap', async () => {
    mockGetState.mockReturnValue({
      config: { githubUsername: 'costajohnt', maxOpenPRsPerRepo: 2, maxOpenPRsColdRepo: 1, excludeRepos: [] },
      lastDigest: { openPRs: [{ repo: 'owner/repo' }] },
    });
    mockVetIssue.mockResolvedValue({
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: [] },
      recommendation: 'approve' as const,
      reasonsToApprove: [],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    });
    mockGetRepoScore.mockReturnValue(undefined);

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(result.repoCap).toMatchObject({ repo: 'owner/repo', openPRCount: 1, cap: 1, cold: true, atCap: true });
  });

  it('should vet an issue and return structured result', async () => {
    const candidate = {
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: ['bug'] },
      recommendation: 'approve' as const,
      reasonsToApprove: ['Active maintainers', 'Good first issue label'],
      reasonsToSkip: [],
      projectHealth: { avgIssueResponseDays: 2, daysSinceLastCommit: 1 },
      vettingResult: { isViable: true },
    };
    mockVetIssue.mockResolvedValue(candidate);
    mockGetRepoScore.mockReturnValue({ mergedPRCount: 17, closedWithoutMergeCount: 3 });

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(mockVetIssue).toHaveBeenCalledWith(TEST_ISSUE_URL);
    expect(mockGetRepoScore).toHaveBeenCalledWith('owner/repo');
    expect(result).toEqual({
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: ['bug'] },
      recommendation: 'approve',
      reasonsToApprove: ['Active maintainers', 'Good first issue label'],
      reasonsToSkip: [],
      projectHealth: { avgIssueResponseDays: 2, daysSinceLastCommit: 1 },
      vettingResult: { isViable: true },
      antiLLMPolicy: undefined,
      linkedPRClassification: 'none',
      slmTriage: null,
      grade: { score: 10, reason: expect.stringMatching(/respons|merge|commit/i) },
    });
  });

  it('records the vet-time prediction for calibration (#1824)', async () => {
    mockVetIssue.mockResolvedValue({
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: [] },
      recommendation: 'approve' as const,
      reasonsToApprove: [],
      reasonsToSkip: [],
      projectHealth: { avgIssueResponseDays: 1, daysSinceLastCommit: 1, stargazersCount: 1200 },
      vettingResult: {},
    });
    mockGetRepoScore.mockReturnValue(undefined);

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(mockRecordPickSnapshots).toHaveBeenCalledWith([
      {
        issueUrl: TEST_ISSUE_URL,
        grade: result.grade.score,
        recommendation: result.recommendation,
        stargazersCount: 1200,
        source: 'vet',
        capturedAt: expect.any(String),
        labels: [],
        competingPRs: 0,
        firstInRepo: true,
      },
    ]);
  });

  it('includes grade with unknown merge rate when no repo score exists', async () => {
    const candidate = {
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: [] },
      recommendation: 'approve' as const,
      reasonsToApprove: [],
      reasonsToSkip: [],
      projectHealth: { avgIssueResponseDays: 1, daysSinceLastCommit: 1 },
      vettingResult: {},
    };
    mockVetIssue.mockResolvedValue(candidate);
    mockGetRepoScore.mockReturnValue(undefined);

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    // Two 10 signals + one unknown → dropped one band to 7
    expect(result.grade.score).toBe(7);
    expect(result.grade.reason).toMatch(/unknown/i);
  });

  it('should reject a non-GitHub issue URL', async () => {
    await expect(runVet({ issueUrl: 'https://example.com/not-github' })).rejects.toThrow('Invalid issue URL');
  });

  it('should reject a PR URL (not an issue URL)', async () => {
    await expect(runVet({ issueUrl: 'https://github.com/owner/repo/pull/5' })).rejects.toThrow('Invalid issue URL');
  });

  it('should reject a URL that exceeds maximum length', async () => {
    const longUrl = 'https://github.com/' + 'a'.repeat(2100);

    await expect(runVet({ issueUrl: longUrl })).rejects.toThrow('exceeds maximum length');
  });

  it('should propagate errors from vetIssue', async () => {
    mockVetIssue.mockRejectedValue(new Error('Issue not found'));

    await expect(runVet({ issueUrl: TEST_ISSUE_URL })).rejects.toThrow('Issue not found');
  });
});
