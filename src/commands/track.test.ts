/**
 * Tests for track/untrack commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  getGitHubToken: vi.fn(),
  getOctokit: vi.fn(),
}));

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

vi.mock('../core/utils.js', () => ({
  parseGitHubUrl: vi.fn(),
}));

import { getGitHubToken, getOctokit } from '../core/index.js';
import { parseGitHubUrl } from '../core/utils.js';
import { outputJson } from '../formatters/json.js';
import { runTrack, runUntrack } from './track.js';

const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockGetOctokit = vi.mocked(getOctokit);
const mockParseGitHubUrl = vi.mocked(parseGitHubUrl);
const mockOutputJson = vi.mocked(outputJson);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('runTrack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    mockParseGitHubUrl.mockReturnValue({ type: 'pull', owner: 'owner', repo: 'repo', number: 42 });
    mockGetOctokit.mockReturnValue({
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: { title: 'Test PR', number: 42 },
        }),
      },
    } as any);
  });

  it('should fetch PR info and output it', async () => {
    await runTrack({ prUrl: TEST_PR_URL, json: true });

    expect(mockOutputJson).toHaveBeenCalledWith({
      pr: { repo: 'owner/repo', number: 42, title: 'Test PR', url: TEST_PR_URL },
    });
  });

  it('should output text when not in JSON mode', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runTrack({ prUrl: TEST_PR_URL, json: false });

    expect(consoleSpy).toHaveBeenCalled();
    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('owner/repo#42');
    consoleSpy.mockRestore();
  });
});

describe('runUntrack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should output v2 info message in JSON mode', async () => {
    await runUntrack({ prUrl: TEST_PR_URL, json: true });

    expect(mockOutputJson).toHaveBeenCalledWith(expect.objectContaining({ removed: false, url: TEST_PR_URL }));
  });

  it('should output v2 info message in text mode', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUntrack({ prUrl: TEST_PR_URL, json: false });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
