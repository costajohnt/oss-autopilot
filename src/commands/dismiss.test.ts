/**
 * Tests for dismiss/undismiss commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ISSUE_URL_PATTERN } from './dismiss.js';

describe('ISSUE_URL_PATTERN', () => {
  it.each([
    ['https://github.com/owner/repo/issues/123', 'standard URL'],
    ['https://github.com/my-org/my-repo/issues/1', 'hyphenated names'],
    ['https://github.com/owner/repo.js/issues/42', 'dotted repo name'],
    ['https://github.com/my_org/my_repo/issues/7', 'underscored names'],
    ['https://github.com/owner/repo/issues/99999', 'large issue number'],
  ])('should match %s (%s)', (url) => {
    expect(ISSUE_URL_PATTERN.test(url)).toBe(true);
  });

  it.each([
    ['https://github.com/owner/repo/pull/123', 'PR URL'],
    ['https://gitlab.com/owner/repo/issues/1', 'non-GitHub host'],
    ['http://github.com/owner/repo/issues/1', 'HTTP (non-HTTPS)'],
    ['https://github.com/owner/repo/issues/123/', 'trailing slash'],
    ['https://github.com/owner/repo/issues/123?q=test', 'query parameters'],
    ['https://github.com/owner/repo/issues/123#comment', 'fragment identifier'],
    ['https://github.com/owner/repo/issues/', 'missing issue number'],
    ['https://github.com/owner/repo', 'bare repo URL'],
    ['', 'empty string'],
    ['https://github.com/owner/repo/issues/123/timeline', 'extra path segments'],
  ])('should reject %s (%s)', (url) => {
    expect(ISSUE_URL_PATTERN.test(url)).toBe(false);
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
import { runDismiss, runUndismiss } from './dismiss.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockOutputJson = vi.mocked(outputJson);

const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/1';

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
    await runDismiss({ issueUrl: TEST_ISSUE_URL, json: true });

    expect(mockDismissIssue).toHaveBeenCalledWith(TEST_ISSUE_URL, expect.any(String));
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ dismissed: true, url: TEST_ISSUE_URL });
  });

  it('should not save state when issue is already dismissed', async () => {
    mockDismissIssue.mockReturnValue(false);
    await runDismiss({ issueUrl: TEST_ISSUE_URL, json: true });

    expect(mockSave).not.toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ dismissed: false, url: TEST_ISSUE_URL });
  });

  it('should output text when dismiss succeeds', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockDismissIssue.mockReturnValue(true);
    await runDismiss({ issueUrl: TEST_ISSUE_URL, json: false });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Dismissed');
    expect(allOutput).toContain('muted');
    consoleSpy.mockRestore();
  });

  it('should output text when issue is already dismissed', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockDismissIssue.mockReturnValue(false);
    await runDismiss({ issueUrl: TEST_ISSUE_URL, json: false });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('already dismissed');
    consoleSpy.mockRestore();
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
    await runUndismiss({ issueUrl: TEST_ISSUE_URL, json: true });

    expect(mockUndismissIssue).toHaveBeenCalledWith(TEST_ISSUE_URL);
    expect(mockSave).toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ undismissed: true, url: TEST_ISSUE_URL });
  });

  it('should not save state when issue was not dismissed', async () => {
    mockUndismissIssue.mockReturnValue(false);
    await runUndismiss({ issueUrl: TEST_ISSUE_URL, json: true });

    expect(mockSave).not.toHaveBeenCalled();
    expect(mockOutputJson).toHaveBeenCalledWith({ undismissed: false, url: TEST_ISSUE_URL });
  });

  it('should output text when undismiss succeeds', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockUndismissIssue.mockReturnValue(true);
    await runUndismiss({ issueUrl: TEST_ISSUE_URL, json: false });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Undismissed');
    expect(allOutput).toContain('active again');
    consoleSpy.mockRestore();
  });

  it('should output text when issue was not dismissed', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockUndismissIssue.mockReturnValue(false);
    await runUndismiss({ issueUrl: TEST_ISSUE_URL, json: false });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('was not dismissed');
    consoleSpy.mockRestore();
  });
});
