/**
 * Tests for PRMonitor CI status deduplication
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockOctokitInstance: any;

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => mockOctokitInstance),
}));

vi.mock('./state.js', () => ({
  getStateManager: vi.fn(() => ({
    getState: () => ({ config: { githubUsername: 'testuser' } }),
  })),
}));

// Import after mocks are set up
const { PRMonitor } = await import('./pr-monitor.js');

describe('PRMonitor CI status deduplication', () => {
  const emptyCombinedStatus = {
    data: {
      state: 'success',
      statuses: [],
    },
  };

  it('should use latest check run when same check has multiple runs', async () => {
    // Simulate owncast scenario: "Validate PR checklist" ran 4 times,
    // 2 old failures followed by 2 newer successes
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue(emptyCombinedStatus),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              {
                name: 'Validate PR checklist',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-02-07T02:02:00Z',
              },
              {
                name: 'Validate PR checklist',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-02-07T19:47:00Z',
              },
              {
                name: 'Validate PR checklist',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-07T19:16:00Z',
              },
              {
                name: 'Validate PR checklist',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-08T03:32:00Z', // Most recent
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owncast', 'owncast', 'abc123');

    expect(result.status).toBe('passing');
    expect(result.failingCheckNames).toEqual([]);
  });

  it('should report failing when the latest run of a check is a failure', async () => {
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue(emptyCombinedStatus),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              {
                name: 'Build',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-07T10:00:00Z',
              },
              {
                name: 'Build',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-02-07T12:00:00Z', // More recent failure
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', 'abc123');

    expect(result.status).toBe('failing');
    expect(result.failingCheckNames).toEqual(['Build']);
  });

  it('should handle multiple different checks independently', async () => {
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue(emptyCombinedStatus),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              // "Lint" failed then passed
              {
                name: 'Lint',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-02-07T10:00:00Z',
              },
              {
                name: 'Lint',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-07T12:00:00Z',
              },
              // "Test" only has a passing run
              {
                name: 'Test',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-07T11:00:00Z',
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', 'abc123');

    expect(result.status).toBe('passing');
    expect(result.failingCheckNames).toEqual([]);
  });

  it('should report failing when one check passes but another still fails (multi-check)', async () => {
    mockOctokitInstance = {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue(emptyCombinedStatus),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              {
                name: 'Lint',
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-02-07T12:00:00Z',
              },
              {
                name: 'Test',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-02-07T12:00:00Z',
              },
            ],
          },
        }),
      },
    };

    const monitor = new PRMonitor('fake-token');
    const result = await (monitor as any).getCIStatus('owner', 'repo', 'abc123');

    expect(result.status).toBe('failing');
    expect(result.failingCheckNames).toEqual(['Test']);
  });
});

describe('PRMonitor changes_addressed detection', () => {
  beforeEach(() => {
    mockOctokitInstance = {};
  });

  it('should return changes_addressed when commit is newer than maintainer comment', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',        // ciStatus
      false,            // hasMergeConflict
      true,             // hasUnrespondedComment
      false,            // hasIncompleteChecklist
      'changes_requested', // reviewDecision
      2,                // daysSinceActivity
      30,               // dormantThreshold
      25,               // approachingThreshold
      '2026-02-08T12:00:00Z',  // latestCommitDate (newer)
      '2026-02-07T10:00:00Z'   // lastMaintainerCommentDate (older)
    );

    expect(result).toBe('changes_addressed');
  });

  it('should return needs_response when commit is older than maintainer comment', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',
      false,
      true,             // hasUnrespondedComment
      false,
      'changes_requested',
      2,
      30,
      25,
      '2026-02-06T10:00:00Z',  // latestCommitDate (older)
      '2026-02-07T10:00:00Z'   // lastMaintainerCommentDate (newer)
    );

    expect(result).toBe('needs_response');
  });

  it('should fall back to needs_response when commit date is unavailable', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',
      false,
      true,             // hasUnrespondedComment
      false,
      'changes_requested',
      2,
      30,
      25,
      undefined,               // latestCommitDate (missing)
      '2026-02-07T10:00:00Z'  // lastMaintainerCommentDate
    );

    expect(result).toBe('needs_response');
  });

  it('should not check commit date when hasUnrespondedComment is false', () => {
    const monitor = new PRMonitor('fake-token');
    const result = (monitor as any).determineStatus(
      'passing',
      false,
      false,            // hasUnrespondedComment = false
      false,
      'approved',
      2,
      30,
      25,
      '2026-02-08T12:00:00Z',  // latestCommitDate (irrelevant)
      '2026-02-07T10:00:00Z'   // lastMaintainerCommentDate (irrelevant)
    );

    // Should be healthy (not changes_addressed) since there's no unresponded comment
    expect(result).not.toBe('changes_addressed');
    expect(result).not.toBe('needs_response');
  });
});
