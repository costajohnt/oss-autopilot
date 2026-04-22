/**
 * Tests for vet-list command (#764)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VetOutput } from '../formatters/json.js';

const mockVetIssue = vi.fn();

vi.mock('./scout-bridge.js', () => ({
  createAutopilotScout: vi.fn(async () => ({
    vetIssue: mockVetIssue,
  })),
}));

vi.mock('./startup.js', () => ({
  detectIssueList: vi.fn(),
}));

vi.mock('./parse-list.js', () => ({
  runParseList: vi.fn(),
}));

import { detectIssueList } from './startup.js';
import { runParseList } from './parse-list.js';
import { runVetList, classifyListStatus } from './vet-list.js';

const mockDetectIssueList = vi.mocked(detectIssueList);
const mockRunParseList = vi.mocked(runParseList);

function makeVetOutput(overrides: Partial<VetOutput> = {}): VetOutput {
  return {
    issue: {
      repo: 'owner/repo',
      number: 1,
      title: 'Test issue',
      url: 'https://github.com/owner/repo/issues/1',
      labels: ['bug'],
    },
    recommendation: 'approve',
    reasonsToApprove: ['Active project'],
    reasonsToSkip: [],
    projectHealth: { stars: 500 },
    vettingResult: { isViable: true },
    grade: { letter: 'B', reason: 'test fixture' },
    ...overrides,
  };
}

describe('classifyListStatus', () => {
  it('should return still_available for approved issues', () => {
    const result = classifyListStatus(makeVetOutput({ recommendation: 'approve', reasonsToSkip: [] }));
    expect(result).toBe('still_available');
  });

  it('should return still_available for needs_review issues', () => {
    const result = classifyListStatus(makeVetOutput({ recommendation: 'needs_review', reasonsToSkip: [] }));
    expect(result).toBe('still_available');
  });

  it('should return closed when skip reasons mention closed', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Issue is closed'],
      }),
    );
    expect(result).toBe('closed');
  });

  it('should return claimed when skip reasons mention claimed', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Issue is already claimed by another user'],
      }),
    );
    expect(result).toBe('claimed');
  });

  it('should return claimed when skip reasons mention assigned', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Issue is assigned to someone'],
      }),
    );
    expect(result).toBe('claimed');
  });

  it('should return has_pr when skip reasons mention existing PR', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Has existing PR addressing this'],
      }),
    );
    expect(result).toBe('has_pr');
  });

  it('should return has_pr when skip reasons mention linked PR', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Has linked PR #42'],
      }),
    );
    expect(result).toBe('has_pr');
  });

  it('should return has_pr when skip reasons mention pull request', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Open pull request found'],
      }),
    );
    expect(result).toBe('has_pr');
  });

  it('should return still_available for skipped issues with other reasons', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Project is inactive'],
      }),
    );
    expect(result).toBe('still_available');
  });

  it('should prioritize closed over claimed', () => {
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Issue is closed', 'Issue was claimed'],
      }),
    );
    expect(result).toBe('closed');
  });

  // ── #1043 structured skipReason preference ───────────────────────────

  it('prefers scout-emitted skipReason enum over substring match (#1043)', () => {
    // Scout could reword the free-text ("Issue was resolved") so the
    // substring match against 'closed' no longer fires. The enum takes
    // precedence and routes correctly.
    const result = classifyListStatus(
      makeVetOutput({
        recommendation: 'skip',
        reasonsToSkip: ['Issue was resolved'],
      }),
      'issue_closed',
    );
    expect(result).toBe('closed');
  });

  it('routes via enum to claimed/has_pr when scout emits the enum (#1043)', () => {
    expect(classifyListStatus(makeVetOutput({ recommendation: 'skip', reasonsToSkip: [] }), 'claimed')).toBe('claimed');
    expect(classifyListStatus(makeVetOutput({ recommendation: 'skip', reasonsToSkip: [] }), 'has_linked_pr')).toBe(
      'has_pr',
    );
  });

  it('falls through to recommendation-based branches for non-routing enum values (#1043)', () => {
    // score_too_low and anti_llm_policy are skip reasons that shouldn't
    // change the list status — let the recommendation drive it.
    expect(classifyListStatus(makeVetOutput({ recommendation: 'approve' }), 'score_too_low')).toBe('still_available');
    expect(classifyListStatus(makeVetOutput({ recommendation: 'skip' }), 'anti_llm_policy')).toBe('still_available');
  });
});

describe('extractSkipReason', () => {
  it('returns the scout-emitted enum value', async () => {
    const { extractSkipReason } = await import('./vet-list.js');
    expect(extractSkipReason({ skipReason: 'issue_closed' })).toBe('issue_closed');
  });

  it('returns undefined when skipReason is missing', async () => {
    const { extractSkipReason } = await import('./vet-list.js');
    expect(extractSkipReason({ other: 'field' })).toBeUndefined();
  });

  it('ignores unknown enum values (forward-compat poison guard)', async () => {
    const { extractSkipReason } = await import('./vet-list.js');
    expect(extractSkipReason({ skipReason: 'future_value_not_in_enum' })).toBeUndefined();
  });

  it('ignores non-string values', async () => {
    const { extractSkipReason } = await import('./vet-list.js');
    expect(extractSkipReason({ skipReason: 42 })).toBeUndefined();
    expect(extractSkipReason(null)).toBeUndefined();
    expect(extractSkipReason('not an object')).toBeUndefined();
  });
});

describe('runVetList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw when no issue list is found and no path provided', async () => {
    mockDetectIssueList.mockReturnValue(undefined);

    await expect(runVetList()).rejects.toThrow('No issue list found');
  });

  it('should return empty results for an empty list', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 0,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({ available: [], completed: [], availableCount: 0, completedCount: 0 });

    const result = await runVetList();

    expect(result.results).toEqual([]);
    expect(result.summary).toEqual({ total: 0, stillAvailable: 0, claimed: 0, closed: 0, hasPR: 0, errors: 0 });
  });

  it('should vet available issues and return results', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 2,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Fix bug',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/1',
        },
        {
          repo: 'other/lib',
          number: 2,
          title: 'Add feature',
          tier: 'Maybe',
          url: 'https://github.com/other/lib/issues/2',
        },
      ],
      completed: [],
      availableCount: 2,
      completedCount: 0,
    });

    const candidate1 = {
      issue: {
        repo: 'owner/repo',
        number: 1,
        title: 'Fix bug',
        url: 'https://github.com/owner/repo/issues/1',
        labels: ['bug'],
      },
      recommendation: 'approve' as const,
      reasonsToApprove: ['Good first issue'],
      reasonsToSkip: [],
      projectHealth: { stars: 100 },
      vettingResult: { isViable: true },
    };
    const candidate2 = {
      issue: {
        repo: 'other/lib',
        number: 2,
        title: 'Add feature',
        url: 'https://github.com/other/lib/issues/2',
        labels: ['enhancement'],
      },
      recommendation: 'skip' as const,
      reasonsToApprove: [],
      reasonsToSkip: ['Issue is closed'],
      projectHealth: { stars: 50 },
      vettingResult: { isViable: false },
    };
    mockVetIssue.mockResolvedValueOnce(candidate1).mockResolvedValueOnce(candidate2);

    const result = await runVetList();

    expect(result.results).toHaveLength(2);
    expect(result.results[0].listStatus).toBe('still_available');
    expect(result.results[0].issue.repo).toBe('owner/repo');
    expect(result.results[1].listStatus).toBe('closed');
    expect(result.results[1].issue.repo).toBe('other/lib');
    expect(result.summary.total).toBe(2);
    expect(result.summary.stillAvailable).toBe(1);
    expect(result.summary.closed).toBe(1);
  });

  it('should handle per-issue errors without failing the batch', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 2,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Fix bug',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/1',
        },
        {
          repo: 'other/lib',
          number: 2,
          title: 'Add feature',
          tier: 'Maybe',
          url: 'https://github.com/other/lib/issues/2',
        },
      ],
      completed: [],
      availableCount: 2,
      completedCount: 0,
    });

    const candidate1 = {
      issue: {
        repo: 'owner/repo',
        number: 1,
        title: 'Fix bug',
        url: 'https://github.com/owner/repo/issues/1',
        labels: ['bug'],
      },
      recommendation: 'approve' as const,
      reasonsToApprove: ['Active project'],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    };
    mockVetIssue.mockResolvedValueOnce(candidate1).mockRejectedValueOnce(new Error('Rate limit exceeded'));

    const result = await runVetList({ concurrency: 1 });

    expect(result.results).toHaveLength(2);
    expect(result.results[0].listStatus).toBe('still_available');
    expect(result.results[1].listStatus).toBe('error');
    expect(result.results[1].errorMessage).toBe('Rate limit exceeded');
    expect(result.results[1].recommendation).toBe('skip');
    expect(result.summary.errors).toBe(1);
    expect(result.summary.stillAvailable).toBe(1);
  });

  it('should use provided path instead of auto-detecting', async () => {
    mockRunParseList.mockResolvedValue({ available: [], completed: [], availableCount: 0, completedCount: 0 });

    await runVetList({ issueListPath: '/custom/path.md' });

    expect(mockDetectIssueList).not.toHaveBeenCalled();
    expect(mockRunParseList).toHaveBeenCalledWith({ filePath: '/custom/path.md' });
  });

  it('should use detectIssueList when no path is provided', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/detected/issues.md',
      source: 'auto-detected',
      availableCount: 0,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({ available: [], completed: [], availableCount: 0, completedCount: 0 });

    await runVetList();

    expect(mockDetectIssueList).toHaveBeenCalled();
    expect(mockRunParseList).toHaveBeenCalledWith({ filePath: '/detected/issues.md' });
  });

  it('should respect concurrency option', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 3,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        { repo: 'a/b', number: 1, title: 'One', tier: 'T1', url: 'https://github.com/a/b/issues/1' },
        { repo: 'c/d', number: 2, title: 'Two', tier: 'T1', url: 'https://github.com/c/d/issues/2' },
        { repo: 'e/f', number: 3, title: 'Three', tier: 'T1', url: 'https://github.com/e/f/issues/3' },
      ],
      completed: [],
      availableCount: 3,
      completedCount: 0,
    });

    const makeCandidate = (repo: string, num: number, title: string, url: string) => ({
      issue: { repo, number: num, title, url, labels: [] },
      recommendation: 'approve' as const,
      reasonsToApprove: ['OK'],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    });

    mockVetIssue
      .mockResolvedValueOnce(makeCandidate('a/b', 1, 'One', 'https://github.com/a/b/issues/1'))
      .mockResolvedValueOnce(makeCandidate('c/d', 2, 'Two', 'https://github.com/c/d/issues/2'))
      .mockResolvedValueOnce(makeCandidate('e/f', 3, 'Three', 'https://github.com/e/f/issues/3'));

    const result = await runVetList({ concurrency: 2 });

    expect(result.results).toHaveLength(3);
    expect(result.summary.total).toBe(3);
    expect(result.summary.stillAvailable).toBe(3);
  });

  it('should handle non-Error thrown values in per-issue errors', async () => {
    mockDetectIssueList.mockReturnValue({
      path: '/tmp/issues.md',
      source: 'configured',
      availableCount: 1,
      completedCount: 0,
    });
    mockRunParseList.mockResolvedValue({
      available: [
        {
          repo: 'owner/repo',
          number: 1,
          title: 'Fix bug',
          tier: 'Pursue',
          url: 'https://github.com/owner/repo/issues/1',
        },
      ],
      completed: [],
      availableCount: 1,
      completedCount: 0,
    });

    mockVetIssue.mockRejectedValueOnce('string error');

    const result = await runVetList();

    expect(result.results).toHaveLength(1);
    expect(result.results[0].listStatus).toBe('error');
    expect(result.results[0].errorMessage).toBe('string error');
  });
});
