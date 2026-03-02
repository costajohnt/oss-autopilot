/**
 * Tests for dismiss/undismiss commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// Pattern tests are in validation.test.ts (canonical home for URL patterns)

// Mock getStateManager for command-level tests
vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runDismiss, runUndismiss } from './dismiss.js';

const mockGetStateManager = vi.mocked(getStateManager);

const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/1';
const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('runDismiss', () => {
  const mockSave = vi.fn();
  const mockDismissIssue = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      dismissIssue: mockDismissIssue,
      save: mockSave,
    } as any);
  });

  it('should dismiss an issue and save state', async () => {
    mockDismissIssue.mockReturnValue(true);
    const result = await runDismiss({ url: TEST_ISSUE_URL });

    expect(mockDismissIssue).toHaveBeenCalledWith(TEST_ISSUE_URL, expect.any(String));
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ dismissed: true, url: TEST_ISSUE_URL });
  });

  it('should dismiss a PR URL and save state (#416)', async () => {
    mockDismissIssue.mockReturnValue(true);
    const result = await runDismiss({ url: TEST_PR_URL });

    expect(mockDismissIssue).toHaveBeenCalledWith(TEST_PR_URL, expect.any(String));
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ dismissed: true, url: TEST_PR_URL });
  });

  it('should not save state when issue is already dismissed', async () => {
    mockDismissIssue.mockReturnValue(false);
    const result = await runDismiss({ url: TEST_ISSUE_URL });

    expect(mockSave).not.toHaveBeenCalled();
    expect(result).toEqual({ dismissed: false, url: TEST_ISSUE_URL });
  });
});

describe('runUndismiss', () => {
  const mockSave = vi.fn();
  const mockUndismissIssue = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      undismissIssue: mockUndismissIssue,
      save: mockSave,
    } as any);
  });

  it('should undismiss an issue and save state', async () => {
    mockUndismissIssue.mockReturnValue(true);
    const result = await runUndismiss({ url: TEST_ISSUE_URL });

    expect(mockUndismissIssue).toHaveBeenCalledWith(TEST_ISSUE_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ undismissed: true, url: TEST_ISSUE_URL });
  });

  it('should undismiss a PR URL and save state (#416)', async () => {
    mockUndismissIssue.mockReturnValue(true);
    const result = await runUndismiss({ url: TEST_PR_URL });

    expect(mockUndismissIssue).toHaveBeenCalledWith(TEST_PR_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(result).toEqual({ undismissed: true, url: TEST_PR_URL });
  });

  it('should not save state when issue was not dismissed', async () => {
    mockUndismissIssue.mockReturnValue(false);
    const result = await runUndismiss({ url: TEST_ISSUE_URL });

    expect(mockSave).not.toHaveBeenCalled();
    expect(result).toEqual({ undismissed: false, url: TEST_ISSUE_URL });
  });
});
