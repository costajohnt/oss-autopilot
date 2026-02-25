/**
 * Tests for track/untrack commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTrackPR = vi.fn();

vi.mock('../core/index.js', () => {
  const MockPRMonitor = vi.fn(function (this: any) {
    this.trackPR = mockTrackPR;
  });
  return {
    getStateManager: vi.fn(),
    PRMonitor: MockPRMonitor,
    getGitHubToken: vi.fn(),
  };
});

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

import { getStateManager, getGitHubToken } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';
import { runTrack, runUntrack } from './track.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockOutputJson = vi.mocked(outputJson);
const mockOutputJsonError = vi.mocked(outputJsonError);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('runTrack', () => {
  const mockSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      save: mockSave,
    } as any);
  });

  it('should exit with error when no GitHub token is available', async () => {
    mockGetGitHubToken.mockReturnValue(null as any);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(runTrack({ prUrl: TEST_PR_URL, json: true })).rejects.toThrow('exit');

    expect(mockOutputJsonError).toHaveBeenCalledWith(expect.stringContaining('GitHub authentication required'));
    mockExit.mockRestore();
  });

  it('should track a PR and save state', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    const trackedPR = { repo: 'owner/repo', number: 42, title: 'Test PR' };
    mockTrackPR.mockResolvedValue(trackedPR);

    await runTrack({ prUrl: TEST_PR_URL, json: true });

    expect(mockTrackPR).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ pr: trackedPR });
  });

  it('should output text when not in JSON mode', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_test123');
    const trackedPR = { repo: 'owner/repo', number: 42, title: 'Test PR' };
    mockTrackPR.mockResolvedValue(trackedPR);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runTrack({ prUrl: TEST_PR_URL, json: false });

    expect(consoleSpy).toHaveBeenCalled();
    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('owner/repo#42');
    consoleSpy.mockRestore();
  });
});

describe('runUntrack', () => {
  const mockSave = vi.fn();
  const mockUntrackPR = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      untrackPR: mockUntrackPR,
      save: mockSave,
    } as any);
  });

  it('should untrack a PR and save state when PR exists', async () => {
    mockUntrackPR.mockReturnValue(true);

    await runUntrack({ prUrl: TEST_PR_URL, json: true });

    expect(mockUntrackPR).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ removed: true, url: TEST_PR_URL });
  });

  it('should not save state when PR was not tracked', async () => {
    mockUntrackPR.mockReturnValue(false);

    await runUntrack({ prUrl: TEST_PR_URL, json: true });

    expect(mockSave).not.toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ removed: false, url: TEST_PR_URL });
  });
});
