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

/** State with a last daily digest listing the given open PR URLs; the only field dismiss reads (#1885). */
function digestWithOpenPRs(...urls: string[]) {
  return { lastDigest: { openPRs: urls.map((url) => ({ url, repo: 'owner/repo', number: 42 })) } };
}

describe('runDismiss', () => {
  const mockDismissIssue = vi.fn();
  const mockGetState = vi.fn();
  const mockIsPRShelved = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({});
    mockIsPRShelved.mockReturnValue(false);
    mockGetStateManager.mockReturnValue({
      dismissIssue: mockDismissIssue,
      getState: mockGetState,
      isPRShelved: mockIsPRShelved,
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

  it('records the head for a PR URL, lowercased (review follow-ups skip, #1857)', async () => {
    mockDismissIssue.mockReturnValue(true);
    const head = 'ABCDEF0123456789abcdef0123456789abcdef01';
    const result = await runDismiss({ url: TEST_PR_URL, head });

    expect(mockDismissIssue).toHaveBeenCalledWith(TEST_PR_URL, expect.any(String), {
      refresh: true,
      headSha: head.toLowerCase(),
    });
    expect(result).toEqual({ dismissed: true, url: TEST_PR_URL });
  });

  it('rejects a short or malformed head, and a head with an issue URL, before touching state', async () => {
    const { ValidationError } = await import('../core/errors.js');
    await expect(runDismiss({ url: TEST_PR_URL, head: 'abc1234' })).rejects.toThrow(ValidationError);
    await expect(runDismiss({ url: TEST_PR_URL, head: 'g'.repeat(40) })).rejects.toThrow(ValidationError);
    await expect(runDismiss({ url: TEST_ISSUE_URL, head: 'a'.repeat(40) })).rejects.toThrow(/PR URLs only/);
    expect(mockDismissIssue).not.toHaveBeenCalled();
  });

  it('treats the /issues/N form of a PR dismissed as /pull/N as that PR: refreshes and accepts --head (#2001)', async () => {
    mockDismissIssue.mockReturnValue(true);
    mockGetState.mockReturnValue({ config: { dismissedIssues: { [TEST_PR_URL]: '2026-11-01T00:00:00.000Z' } } });
    const issuesForm = 'https://github.com/Owner/Repo/issues/42';
    const head = 'a'.repeat(40);
    await runDismiss({ url: issuesForm, head });

    expect(mockDismissIssue).toHaveBeenCalledWith(issuesForm, expect.any(String), { refresh: true, headSha: head });
  });

  it('should report not dismissed when issue is already dismissed', async () => {
    mockDismissIssue.mockReturnValue(false);
    const result = await runDismiss({ url: TEST_ISSUE_URL });

    expect(result).toEqual({ dismissed: false, url: TEST_ISSUE_URL });
  });

  describe('open authored PR warning (#1885)', () => {
    it('records the dismiss and warns that move <pr-url> waiting clears the PR when it is open in the last digest', async () => {
      mockDismissIssue.mockReturnValue(true);
      mockGetState.mockReturnValue(digestWithOpenPRs('https://github.com/owner/repo/pull/7', TEST_PR_URL));

      const result = await runDismiss({ url: TEST_PR_URL });

      expect(mockDismissIssue).toHaveBeenCalledWith(TEST_PR_URL, expect.any(String), { refresh: true });
      expect(result).toEqual({
        dismissed: true,
        url: TEST_PR_URL,
        warning: expect.stringContaining(`move ${TEST_PR_URL} waiting`),
      });
      expect(result.warning).toContain('does not clear the PR from Needs Attention');
    });

    it('warns with --head too (the review follow-up skip path)', async () => {
      mockDismissIssue.mockReturnValue(true);
      mockGetState.mockReturnValue(digestWithOpenPRs(TEST_PR_URL));

      const result = await runDismiss({ url: TEST_PR_URL, head: 'a'.repeat(40) });

      expect(result.warning).toContain(`move ${TEST_PR_URL} waiting`);
    });

    it('gives no warning when the open PR is shelved: it is not in Needs Attention and move waiting would unshelve it', async () => {
      mockDismissIssue.mockReturnValue(true);
      mockGetState.mockReturnValue(digestWithOpenPRs(TEST_PR_URL));
      mockIsPRShelved.mockReturnValue(true);

      const result = await runDismiss({ url: TEST_PR_URL });

      expect(mockIsPRShelved).toHaveBeenCalledWith(TEST_PR_URL);
      expect(result).toEqual({ dismissed: true, url: TEST_PR_URL });
      expect(result).not.toHaveProperty('warning');
    });

    it('matches the open PR case-insensitively and suggests move with the stored (GitHub) casing', async () => {
      mockDismissIssue.mockReturnValue(true);
      mockGetState.mockReturnValue(digestWithOpenPRs(TEST_PR_URL));
      const typedUrl = 'https://github.com/Owner/REPO/pull/42';

      const result = await runDismiss({ url: typedUrl });

      expect(mockIsPRShelved).toHaveBeenCalledWith(TEST_PR_URL);
      expect(result.url).toBe(typedUrl);
      expect(result.warning).toContain(`move ${TEST_PR_URL} waiting`);
      expect(result.warning).not.toContain(typedUrl);
    });

    it('warns for the /issues/N form of an open PR already dismissed as /pull/N (#2048)', async () => {
      mockDismissIssue.mockReturnValue(true);
      mockGetState.mockReturnValue({
        ...digestWithOpenPRs(TEST_PR_URL),
        config: { dismissedIssues: { [TEST_PR_URL]: '2026-11-01T00:00:00.000Z' } },
      });
      const issueForm = 'https://github.com/owner/repo/issues/42';

      const result = await runDismiss({ url: issueForm });

      expect(mockDismissIssue).toHaveBeenCalledWith(issueForm, expect.any(String), { refresh: true });
      expect(result.warning).toContain(`move ${TEST_PR_URL} waiting`);
    });

    it('gives no warning for a PR URL that is not an open PR in the last digest (merged or unknown)', async () => {
      mockDismissIssue.mockReturnValue(true);
      mockGetState.mockReturnValue(digestWithOpenPRs('https://github.com/owner/repo/pull/7'));

      const result = await runDismiss({ url: TEST_PR_URL });

      expect(result).toEqual({ dismissed: true, url: TEST_PR_URL });
      expect(result).not.toHaveProperty('warning');
    });

    it('gives no warning when no daily digest has been persisted yet', async () => {
      mockDismissIssue.mockReturnValue(true);
      mockGetState.mockReturnValue({});

      const result = await runDismiss({ url: TEST_PR_URL });

      expect(result).toEqual({ dismissed: true, url: TEST_PR_URL });
    });

    it('leaves issue URLs unchanged even when the digest is non-empty', async () => {
      mockDismissIssue.mockReturnValue(true);
      mockGetState.mockReturnValue(digestWithOpenPRs(TEST_PR_URL));

      const result = await runDismiss({ url: TEST_ISSUE_URL });

      // No warning, and still dismissed as an issue (dismiss now reads state to
      // spot the /issues/N form of a dismissed PR, #2001).
      expect(result).toEqual({ dismissed: true, url: TEST_ISSUE_URL });
      expect(mockDismissIssue).toHaveBeenCalledWith(TEST_ISSUE_URL, expect.any(String), { refresh: false });
    });
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
