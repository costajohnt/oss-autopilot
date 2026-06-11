/**
 * Tests for the repo-vet command wrapper (#1373).
 *
 * Focused on the listReleases error-handling contract: rate-limit/auth
 * errors abort the run, 404 is genuine absence, and 5xx/network errors
 * degrade gracefully with the `releasesIncomplete` flag set so a vet
 * batch under throttling can't silently report "no releases".
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
import { runRepoVet } from './repo-vet.js';
import { RepoVetOutputSchema } from '../formatters/json.js';

const mockRequireGitHubToken = vi.mocked(requireGitHubToken);
const mockGetOctokit = vi.mocked(getOctokit);
const mockWarn = vi.mocked(warn);

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const NOT_FOUND = httpError(404, 'Not Found');

/** Minimal octokit stub; override `listReleases` per test. */
function buildOctokit(listReleases: ReturnType<typeof vi.fn>) {
  return {
    repos: {
      get: vi.fn().mockResolvedValue({
        data: {
          stargazers_count: 100,
          forks_count: 10,
          open_issues_count: 5,
          subscribers_count: 8,
          archived: false,
          pushed_at: '2026-06-01T00:00:00Z',
          created_at: '2020-01-01T00:00:00Z',
        },
      }),
      listCommits: vi.fn().mockResolvedValue({ data: [] }),
      listReleases,
      // Community-health probes: every path 404s (definitive absence) so
      // the release-path behavior under test is isolated.
      getContent: vi.fn().mockRejectedValue(NOT_FOUND),
    },
    pulls: {
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
  } as unknown as ReturnType<typeof getOctokit>;
}

describe('runRepoVet release handling (#1373)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireGitHubToken.mockReturnValue('ghp_test123');
  });

  it('rethrows a 429 rate-limit error from listReleases', async () => {
    mockGetOctokit.mockReturnValue(buildOctokit(vi.fn().mockRejectedValue(httpError(429, 'API rate limit exceeded'))));

    await expect(runRepoVet({ repo: 'owner/repo' })).rejects.toThrow('API rate limit exceeded');
  });

  it('rethrows a 403 rate-limit error from listReleases', async () => {
    mockGetOctokit.mockReturnValue(
      buildOctokit(vi.fn().mockRejectedValue(httpError(403, 'API rate limit exceeded for installation'))),
    );

    await expect(runRepoVet({ repo: 'owner/repo' })).rejects.toThrow('rate limit');
  });

  it('treats a 404 as genuine absence: null lastReleaseISO, no incomplete flag, no warning', async () => {
    mockGetOctokit.mockReturnValue(buildOctokit(vi.fn().mockRejectedValue(NOT_FOUND)));

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.maintainerActivity.lastReleaseISO).toBeNull();
    expect(result.maintainerActivity.releasesIncomplete).toBe(false);
    const warnMessages = mockWarn.mock.calls.map((c) => String(c[1]));
    expect(warnMessages.some((m) => m.includes('release'))).toBe(false);
  });

  it('degrades gracefully on a 500: releasesIncomplete true, null lastReleaseISO, warning emitted', async () => {
    mockGetOctokit.mockReturnValue(buildOctokit(vi.fn().mockRejectedValue(httpError(500, 'Internal Server Error'))));

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.maintainerActivity.lastReleaseISO).toBeNull();
    expect(result.maintainerActivity.releasesIncomplete).toBe(true);
    expect(mockWarn).toHaveBeenCalledWith(
      'repo-vet',
      expect.stringMatching(/owner\/repo.*release-recency signal is incomplete/),
    );
  });

  it('degrades gracefully on a network error (no HTTP status)', async () => {
    mockGetOctokit.mockReturnValue(
      buildOctokit(vi.fn().mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))),
    );

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.maintainerActivity.releasesIncomplete).toBe(true);
    expect(result.maintainerActivity.lastReleaseISO).toBeNull();
  });

  it('reports releasesIncomplete false on success and the flag survives the JSON schema', async () => {
    mockGetOctokit.mockReturnValue(
      buildOctokit(
        vi
          .fn()
          .mockResolvedValue({ data: [{ published_at: '2026-05-01T00:00:00Z', created_at: '2026-05-01T00:00:00Z' }] }),
      ),
    );

    const result = await runRepoVet({ repo: 'owner/repo' });

    expect(result.maintainerActivity.lastReleaseISO).toBe('2026-05-01T00:00:00Z');
    expect(result.maintainerActivity.releasesIncomplete).toBe(false);

    // formatJson validates with RepoVetOutputSchema, which strips unknown
    // keys — guard against the flag silently vanishing from --json output.
    const parsed = RepoVetOutputSchema.parse(result);
    expect(parsed.maintainerActivity.releasesIncomplete).toBe(false);
  });
});
