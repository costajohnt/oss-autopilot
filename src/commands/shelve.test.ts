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

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import { runShelve, runUnshelve } from './shelve.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockOutputJson = vi.mocked(outputJson);

const TEST_PR_URL = 'https://github.com/owner/repo/pull/1';

describe('runShelve', () => {
  const mockSave = vi.fn();
  const mockShelvePR = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      shelvePR: mockShelvePR,
      save: mockSave,
    } as any);
  });

  it('should shelve a PR and save state', async () => {
    mockShelvePR.mockReturnValue(true);
    await runShelve({ prUrl: TEST_PR_URL, json: true });

    expect(mockShelvePR).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ shelved: true, url: TEST_PR_URL });
  });

  it('should not save state when PR is already shelved', async () => {
    mockShelvePR.mockReturnValue(false);
    await runShelve({ prUrl: TEST_PR_URL, json: true });

    expect(mockSave).not.toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ shelved: false, url: TEST_PR_URL });
  });
});

describe('runUnshelve', () => {
  const mockSave = vi.fn();
  const mockUnshelvePR = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      unshelvePR: mockUnshelvePR,
      save: mockSave,
    } as any);
  });

  it('should unshelve a PR and save state', async () => {
    mockUnshelvePR.mockReturnValue(true);
    await runUnshelve({ prUrl: TEST_PR_URL, json: true });

    expect(mockUnshelvePR).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ unshelved: true, url: TEST_PR_URL });
  });

  it('should not save state when PR was not shelved', async () => {
    mockUnshelvePR.mockReturnValue(false);
    await runUnshelve({ prUrl: TEST_PR_URL, json: true });

    expect(mockSave).not.toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ unshelved: false, url: TEST_PR_URL });
  });
});
