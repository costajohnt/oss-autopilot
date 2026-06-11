/**
 * Tests for the verify-issue command wrapper (#1353, #1354).
 *
 * The classification and GraphQL mapping logic is covered in
 * core/issue-verification.test.ts; this file pins the wrapper contract:
 * URL validation, URL parsing into fetch params, and auth wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getOctokit: vi.fn(),
  requireGitHubToken: vi.fn(),
  parseGitHubUrl: vi.fn(),
  fetchIssueVerification: vi.fn(),
}));

import { getOctokit, requireGitHubToken, parseGitHubUrl, fetchIssueVerification } from '../core/index.js';
import { runVerifyIssue } from './verify-issue.js';

const mockGetOctokit = vi.mocked(getOctokit);
const mockRequireGitHubToken = vi.mocked(requireGitHubToken);
const mockParseGitHubUrl = vi.mocked(parseGitHubUrl);
const mockFetchIssueVerification = vi.mocked(fetchIssueVerification);

const ISSUE_URL = 'https://github.com/foo/bar/issues/42';
const FAKE_OCTOKIT = { graphql: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireGitHubToken.mockReturnValue('token-123');
  mockGetOctokit.mockReturnValue(FAKE_OCTOKIT as never);
  mockParseGitHubUrl.mockReturnValue({ owner: 'foo', repo: 'bar', number: 42, type: 'issues' });
});

describe('runVerifyIssue', () => {
  it('rejects non-issue URLs before any network access', async () => {
    await expect(runVerifyIssue({ issueUrl: 'https://github.com/foo/bar/pull/42' })).rejects.toMatchObject({
      name: 'ValidationError',
    });
    expect(mockRequireGitHubToken).not.toHaveBeenCalled();
    expect(mockFetchIssueVerification).not.toHaveBeenCalled();
  });

  it('rejects URLs that fail to parse even after pattern validation', async () => {
    mockParseGitHubUrl.mockReturnValue(null);
    await expect(runVerifyIssue({ issueUrl: ISSUE_URL })).rejects.toMatchObject({
      name: 'ValidationError',
    });
    expect(mockFetchIssueVerification).not.toHaveBeenCalled();
  });

  it('parses the URL into fetch params and returns the verification verbatim', async () => {
    const verification = { verdict: 'available', verdictReason: 'open, unassigned, no claiming PRs' };
    mockFetchIssueVerification.mockResolvedValue(verification as never);

    const result = await runVerifyIssue({ issueUrl: ISSUE_URL });

    expect(mockRequireGitHubToken).toHaveBeenCalledOnce();
    expect(mockGetOctokit).toHaveBeenCalledWith('token-123');
    expect(mockFetchIssueVerification).toHaveBeenCalledWith(FAKE_OCTOKIT, {
      owner: 'foo',
      repo: 'bar',
      number: 42,
    });
    expect(result).toBe(verification);
  });

  it('propagates fetch errors (rate limits, missing issue) unchanged', async () => {
    mockFetchIssueVerification.mockRejectedValue(new Error('API rate limit exceeded'));
    await expect(runVerifyIssue({ issueUrl: ISSUE_URL })).rejects.toThrow(/rate limit/);
  });
});
