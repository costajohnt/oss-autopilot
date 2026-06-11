/**
 * Tests for the compliance-score command wrapper (#1373).
 *
 * Focused on the test-infrastructure probe's error-handling contract:
 * rate-limit/auth errors abort the run; other failures keep the
 * undefined-neutral fallback but emit a warning so "couldn't look" is
 * distinguishable from "no test dir" in logs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getOctokit: vi.fn(),
  requireGitHubToken: vi.fn(),
}));

vi.mock('../core/logger.js', () => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { requireGitHubToken, getOctokit } from '../core/index.js';
import { warn } from '../core/logger.js';
import { runComplianceScore } from './compliance-score.js';

const mockRequireGitHubToken = vi.mocked(requireGitHubToken);
const mockGetOctokit = vi.mocked(getOctokit);
const mockWarn = vi.mocked(warn);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** Minimal octokit stub; override `getContent` (the test-dir probe) per test. */
function buildOctokit(getContent: ReturnType<typeof vi.fn>) {
  return {
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          title: 'fix: something',
          body: '',
          head: { ref: 'fix/something' },
          changed_files: 1,
          additions: 5,
          deletions: 2,
        },
      }),
      listFiles: vi.fn().mockResolvedValue({ data: [{ filename: 'src/index.ts' }] }),
    },
    repos: { getContent },
  } as unknown as ReturnType<typeof getOctokit>;
}

describe('runComplianceScore test-infrastructure probe (#1373)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
  });

  it('rethrows a 429 rate-limit error from the test-dir probe', async () => {
    mockGetOctokit.mockReturnValue(buildOctokit(vi.fn().mockRejectedValue(httpError(429, 'API rate limit exceeded'))));

    await expect(runComplianceScore({ prUrl: TEST_PR_URL })).rejects.toThrow('API rate limit exceeded');
  });

  it('keeps undefined-neutral fallback on other probe errors and warns', async () => {
    mockGetOctokit.mockReturnValue(buildOctokit(vi.fn().mockRejectedValue(httpError(500, 'Internal Server Error'))));

    const result = await runComplianceScore({ prUrl: TEST_PR_URL });

    // The run still completes and scores; the probe failure is only logged.
    expect(result.pr.repo).toBe('owner/repo');
    expect(typeof result.score).toBe('number');
    expect(mockWarn).toHaveBeenCalledWith(
      'compliance-score',
      expect.stringMatching(/test-infrastructure probe for owner\/repo failed/),
    );
  });
});
