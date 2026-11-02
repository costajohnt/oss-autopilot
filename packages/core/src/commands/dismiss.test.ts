/**
 * Tests for dismiss/undismiss commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// Pattern tests are in validation.test.ts (canonical home for URL patterns)

// Mock getStateManager for command-level tests
vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  maybeCheckpoint: vi.fn().mockResolvedValue(null),
}));

import { getStateManager } from '../core/index.js';
import { runDismiss, runUndismiss } from './dismiss.js';

const mockGetStateManager = vi.mocked(getStateManager);

const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/1';
const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('runDismiss', () => {
  const mockDismissIssue = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      dismissIssue: mockDismissIssue,
    } as any);
  });

  it('should dismiss an issue', async () => {
    mockDismissIssue.mockReturnValue(true);
    const result = await runDismiss({ url: TEST_ISSUE_URL });

    expect(mockDismissIssue).toHaveBeenCalledWith(TEST_ISSUE_URL, expect.any(String), { refresh: false });
    expect(result).toEqual({ dismissed: true, url: TEST_ISSUE_URL });
  });

  it('should dismiss a PR URL with refresh so a re-dismiss moves the stamp forward (merged-PR notes, #1861)', async () => {
    mockDismissIssue.mockReturnValue(true);
    const result = await runDismiss({ url: TEST_PR_URL });

    expect(mockDismissIssue).toHaveBeenCalledWith(TEST_PR_URL, expect.any(String), { refresh: true });
    expect(result).toEqual({ dismissed: true, url: TEST_PR_URL });
  });

  it('should reject non-issue, non-PR URLs with a ValidationError', async () => {
    const { ValidationError } = await import('../core/errors.js');
    await expect(runDismiss({ url: 'https://github.com/owner/repo/discussions/7' })).rejects.toThrow(ValidationError);
    expect(mockDismissIssue).not.toHaveBeenCalled();
  });

  it('should report not dismissed when issue is already dismissed', async () => {
    mockDismissIssue.mockReturnValue(false);
    const result = await runDismiss({ url: TEST_ISSUE_URL });

    expect(result).toEqual({ dismissed: false, url: TEST_ISSUE_URL });
  });
});

describe('runUndismiss', () => {
  const mockUndismissIssue = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      undismissIssue: mockUndismissIssue,
    } as any);
  });

  it('should undismiss an issue', async () => {
    mockUndismissIssue.mockReturnValue(true);
    const result = await runUndismiss({ url: TEST_ISSUE_URL });

    expect(mockUndismissIssue).toHaveBeenCalledWith(TEST_ISSUE_URL);
    expect(result).toEqual({ undismissed: true, url: TEST_ISSUE_URL });
  });

  it('should undismiss a PR URL (merged-PR notes, #1861)', async () => {
    mockUndismissIssue.mockReturnValue(true);
    const result = await runUndismiss({ url: TEST_PR_URL });

    expect(mockUndismissIssue).toHaveBeenCalledWith(TEST_PR_URL);
    expect(result).toEqual({ undismissed: true, url: TEST_PR_URL });
  });

  it('should reject non-issue, non-PR URLs with a ValidationError', async () => {
    const { ValidationError } = await import('../core/errors.js');
    await expect(runUndismiss({ url: 'https://github.com/owner/repo/discussions/7' })).rejects.toThrow(ValidationError);
    expect(mockUndismissIssue).not.toHaveBeenCalled();
  });

  it('should report not undismissed when issue was not dismissed', async () => {
    mockUndismissIssue.mockReturnValue(false);
    const result = await runUndismiss({ url: TEST_ISSUE_URL });

    expect(result).toEqual({ undismissed: false, url: TEST_ISSUE_URL });
  });
});
