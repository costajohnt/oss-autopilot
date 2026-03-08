/**
 * Tests for shelve/unshelve commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PR_URL_PATTERN } from './shelve.js';

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
}));

import { getStateManager } from '../core/index.js';
import { runShelve, runUnshelve } from './shelve.js';

const mockGetStateManager = vi.mocked(getStateManager);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/1';

describe('runShelve', () => {
  const mockSave = vi.fn();
  const mockShelvePR = vi.fn();
  const mockClearStatusOverride = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      shelvePR: mockShelvePR,
      clearStatusOverride: mockClearStatusOverride,
      save: mockSave,
    } as any);
  });

  it('should shelve a PR and save state', async () => {
    mockShelvePR.mockReturnValue(true);
    const result = await runShelve({ prUrl: TEST_PR_URL });

    expect(mockShelvePR).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ shelved: true, url: TEST_PR_URL });
  });

  it('should not save state when PR is already shelved and no override', async () => {
    mockShelvePR.mockReturnValue(false);
    mockClearStatusOverride.mockReturnValue(false);
    const result = await runShelve({ prUrl: TEST_PR_URL });

    expect(mockSave).not.toHaveBeenCalled();
    expect(result).toEqual({ shelved: false, url: TEST_PR_URL });
  });

  it('should save state when already shelved but override was cleared', async () => {
    mockShelvePR.mockReturnValue(false);
    mockClearStatusOverride.mockReturnValue(true);
    const result = await runShelve({ prUrl: TEST_PR_URL });

    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ shelved: false, url: TEST_PR_URL });
  });
});

describe('runUnshelve', () => {
  const mockSave = vi.fn();
  const mockUnshelvePR = vi.fn();
  const mockClearStatusOverride = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      unshelvePR: mockUnshelvePR,
      clearStatusOverride: mockClearStatusOverride,
      save: mockSave,
    } as any);
  });

  it('should unshelve a PR and save state', async () => {
    mockUnshelvePR.mockReturnValue(true);
    const result = await runUnshelve({ prUrl: TEST_PR_URL });

    expect(mockUnshelvePR).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ unshelved: true, url: TEST_PR_URL });
  });

  it('should not save state when PR was not shelved and no override', async () => {
    mockUnshelvePR.mockReturnValue(false);
    mockClearStatusOverride.mockReturnValue(false);
    const result = await runUnshelve({ prUrl: TEST_PR_URL });

    expect(mockSave).not.toHaveBeenCalled();
    expect(result).toEqual({ unshelved: false, url: TEST_PR_URL });
  });

  it('should save state when not shelved but override was cleared', async () => {
    mockUnshelvePR.mockReturnValue(false);
    mockClearStatusOverride.mockReturnValue(true);
    const result = await runUnshelve({ prUrl: TEST_PR_URL });

    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ unshelved: false, url: TEST_PR_URL });
  });
});
