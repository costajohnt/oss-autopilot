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

  it('should report failing when one check passes but another still fails', async () => {
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
