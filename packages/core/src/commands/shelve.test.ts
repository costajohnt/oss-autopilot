/**
 * Tests for shelve/unshelve commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PR_URL_PATTERN, runShelve, runUnshelve } from './shelve.js';

describe('PR_URL_PATTERN', () => {
  it.each([
    ['https://github.com/owner/repo/pull/123', 'standard URL'],
    ['https://github.com/my-org/my-repo/pull/1', 'hyphenated names'],
    ['https://github.com/owner/repo.js/pull/42', 'dotted repo name'],
    ['https://github.com/my_org/my_repo/pull/7', 'underscored names'],
    ['https://github.com/owner/repo/pull/99999', 'large PR number'],
  ])('should match %s (%s)', (url) => {
    expect(PR_URL_PATTERN.test(url)).toBe(true);
  });

  it.each([
    ['https://github.com/owner/repo/issues/123', 'issue URL'],
    ['https://gitlab.com/owner/repo/pull/1', 'non-GitHub host'],
    ['http://github.com/owner/repo/pull/1', 'HTTP (non-HTTPS)'],
    ['https://github.com/owner/repo/pull/123/', 'trailing slash'],
    ['https://github.com/owner/repo/pull/123?diff=split', 'query parameters'],
    ['https://github.com/owner/repo/pull/123#discussion', 'fragment identifier'],
    ['https://github.com/owner/repo/pull/', 'missing PR number'],
    ['https://github.com/owner/repo', 'bare repo URL'],
    ['', 'empty string'],
    ['https://github.com/owner/repo/pull/123/files', 'extra path segments'],
  ])('should reject %s (%s)', (url) => {
    expect(PR_URL_PATTERN.test(url)).toBe(false);
  });
});

// Mock getStateManager for command-level tests
vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  maybeCheckpoint: vi.fn().mockResolvedValue(null),
}));

import { getStateManager, maybeCheckpoint } from '../core/index.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockMaybeCheckpoint = vi.mocked(maybeCheckpoint);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/1';

describe('runShelve', () => {
  const mockShelvePR = vi.fn();
  const mockClearStatusOverride = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      shelvePR: mockShelvePR,
      clearStatusOverride: mockClearStatusOverride,
      batch: (fn: () => void) => fn(),
    } as any);
  });

  it('should shelve a PR and clear status override', async () => {
    mockShelvePR.mockReturnValue(true);
    const result = await runShelve({ prUrl: TEST_PR_URL });

    expect(mockShelvePR).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockClearStatusOverride).toHaveBeenCalledWith(TEST_PR_URL);
    expect(result).toEqual({ shelved: true, url: TEST_PR_URL });
  });

  it('calls maybeCheckpoint exactly once per successful shelve (#1036)', async () => {
    mockShelvePR.mockReturnValue(true);
    await runShelve({ prUrl: TEST_PR_URL });

    expect(mockMaybeCheckpoint).toHaveBeenCalledTimes(1);
    // Args: (stateManager, moduleName) — the state manager is the one
    // returned by the mocked getStateManager, moduleName is 'shelve'.
    expect(mockMaybeCheckpoint).toHaveBeenCalledWith(expect.anything(), 'shelve');
  });

  it('does not fail the command when Gist checkpoint fails (best-effort)', async () => {
    mockShelvePR.mockReturnValue(true);
    mockMaybeCheckpoint.mockRejectedValueOnce(new Error('network down'));
    // maybeCheckpoint internally catches; if a future refactor propagates,
    // runShelve should still fail loud. Keep the assertion explicit.
    await expect(runShelve({ prUrl: TEST_PR_URL })).rejects.toThrow('network down');
    // Restore default for subsequent tests in this describe block.
    mockMaybeCheckpoint.mockResolvedValue(null);
  });

  it('threads the checkpoint warning into gistSyncWarning when the Gist push fails (#1370)', async () => {
    mockShelvePR.mockReturnValue(true);
    const warning = 'Gist checkpoint push failed after retry; the local mutation is saved';
    mockMaybeCheckpoint.mockResolvedValueOnce(warning);

    const result = await runShelve({ prUrl: TEST_PR_URL });

    expect(result).toEqual({ shelved: true, url: TEST_PR_URL, gistSyncWarning: warning });
  });

  it('omits gistSyncWarning entirely when the checkpoint succeeds (#1370)', async () => {
    mockShelvePR.mockReturnValue(true);
    mockMaybeCheckpoint.mockResolvedValueOnce(null);

    const result = await runShelve({ prUrl: TEST_PR_URL });

    expect(result).not.toHaveProperty('gistSyncWarning');
    expect(result).toEqual({ shelved: true, url: TEST_PR_URL });
  });

  it('should report not shelved when PR is already shelved', async () => {
    mockShelvePR.mockReturnValue(false);
    mockClearStatusOverride.mockReturnValue(false);
    const result = await runShelve({ prUrl: TEST_PR_URL });

    expect(result).toEqual({ shelved: false, url: TEST_PR_URL });
  });

  it('should still clear override when already shelved', async () => {
    mockShelvePR.mockReturnValue(false);
    mockClearStatusOverride.mockReturnValue(true);
    const result = await runShelve({ prUrl: TEST_PR_URL });

    expect(mockClearStatusOverride).toHaveBeenCalledWith(TEST_PR_URL);
    expect(result).toEqual({ shelved: false, url: TEST_PR_URL });
  });

  it('should reject invalid URLs', async () => {
    await expect(runShelve({ prUrl: 'not-a-url' })).rejects.toThrow();
  });

  it('should reject non-PR GitHub URLs', async () => {
    await expect(runShelve({ prUrl: 'https://github.com/owner/repo/issues/1' })).rejects.toThrow();
  });

  it('should reject empty URLs', async () => {
    await expect(runShelve({ prUrl: '' })).rejects.toThrow();
  });

  it('should reject GitHub URLs with trailing slash', async () => {
    await expect(runShelve({ prUrl: 'https://github.com/owner/repo/pull/123/' })).rejects.toThrow();
  });

  it('should reject GitHub URLs with query parameters', async () => {
    await expect(runShelve({ prUrl: 'https://github.com/owner/repo/pull/123?diff=split' })).rejects.toThrow();
  });

  it('should reject GitHub URLs with extra path segments', async () => {
    await expect(runShelve({ prUrl: 'https://github.com/owner/repo/pull/123/files' })).rejects.toThrow();
  });
});

describe('runUnshelve', () => {
  const mockUnshelvePR = vi.fn();
  const mockClearStatusOverride = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      unshelvePR: mockUnshelvePR,
      clearStatusOverride: mockClearStatusOverride,
      batch: (fn: () => void) => fn(),
    } as any);
  });

  it('should unshelve a PR and clear status override', async () => {
    mockUnshelvePR.mockReturnValue(true);
    const result = await runUnshelve({ prUrl: TEST_PR_URL });

    expect(mockUnshelvePR).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockClearStatusOverride).toHaveBeenCalledWith(TEST_PR_URL);
    expect(result).toEqual({ unshelved: true, url: TEST_PR_URL });
  });

  it('should report not unshelved when PR was not shelved', async () => {
    mockUnshelvePR.mockReturnValue(false);
    mockClearStatusOverride.mockReturnValue(false);
    const result = await runUnshelve({ prUrl: TEST_PR_URL });

    expect(result).toEqual({ unshelved: false, url: TEST_PR_URL });
  });

  it('should still clear override when not shelved', async () => {
    mockUnshelvePR.mockReturnValue(false);
    mockClearStatusOverride.mockReturnValue(true);
    const result = await runUnshelve({ prUrl: TEST_PR_URL });

    expect(mockClearStatusOverride).toHaveBeenCalledWith(TEST_PR_URL);
    expect(result).toEqual({ unshelved: false, url: TEST_PR_URL });
  });

  it('should reject invalid URLs', async () => {
    await expect(runUnshelve({ prUrl: 'not-a-url' })).rejects.toThrow();
  });

  it('should reject non-PR GitHub URLs', async () => {
    await expect(runUnshelve({ prUrl: 'https://github.com/owner/repo/issues/1' })).rejects.toThrow();
  });

  it('should reject empty URLs', async () => {
    await expect(runUnshelve({ prUrl: '' })).rejects.toThrow();
  });
});
