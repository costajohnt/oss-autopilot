import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted; closures over module-level vars don't work.
// Use vi.hoisted() so the mocks share an identity with the test references.
const mocks = vi.hoisted(() => ({
  fetchPRCommentBundlesBatch: vi.fn(),
  getGuidelines: vi.fn(),
  setGuidelines: vi.fn(),
  deleteGuidelines: vi.fn(),
  isGuidelinesAvailable: vi.fn(),
  getMergedPRs: vi.fn(),
  getClosedPRs: vi.fn(),
  markPRCommentsFetched: vi.fn(),
  maybeCheckpoint: vi.fn(),
  username: vi.fn(() => 'me'),
}));

vi.mock('../core/pr-comments-fetcher.js', () => ({
  fetchPRCommentBundlesBatch: mocks.fetchPRCommentBundlesBatch,
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => ({
      getGuidelines: mocks.getGuidelines,
      setGuidelines: mocks.setGuidelines,
      deleteGuidelines: mocks.deleteGuidelines,
      isGuidelinesAvailable: mocks.isGuidelinesAvailable,
      getMergedPRs: mocks.getMergedPRs,
      getClosedPRs: mocks.getClosedPRs,
      markPRCommentsFetched: mocks.markPRCommentsFetched,
      getState: () => ({ config: { githubUsername: mocks.username() } }),
    }),
    requireGitHubToken: () => 'ghp_test',
    getOctokit: () => ({}) as never,
    maybeCheckpoint: mocks.maybeCheckpoint,
  };
});

const mockFetchPRCommentBundlesBatch = mocks.fetchPRCommentBundlesBatch;
const mockGetGuidelines = mocks.getGuidelines;
const mockSetGuidelines = mocks.setGuidelines;
const mockDeleteGuidelines = mocks.deleteGuidelines;
const mockIsGuidelinesAvailable = mocks.isGuidelinesAvailable;
const mockGetMergedPRs = mocks.getMergedPRs;
const mockGetClosedPRs = mocks.getClosedPRs;
const mockMarkPRCommentsFetched = mocks.markPRCommentsFetched;
const mockMaybeCheckpoint = mocks.maybeCheckpoint;

import { runGuidelinesView, runGuidelinesStore, runGuidelinesReset, runFetchCorpus } from './guidelines.js';
import { GuidelinesNotAvailableError } from '../core/index.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMergedPRs.mockReturnValue([]);
  mockGetClosedPRs.mockReturnValue([]);
  mockIsGuidelinesAvailable.mockReturnValue(true);
});

describe('runGuidelinesView', () => {
  it('returns content + byteSize when guidelines exist', async () => {
    mockGetGuidelines.mockReturnValue('# rules\n- be nice');
    const out = await runGuidelinesView({ repo: 'owner/repo' });
    expect(out.content).toBe('# rules\n- be nice');
    expect(out.byteSize).toBe(Buffer.byteLength('# rules\n- be nice', 'utf8'));
    expect(out.exists).toBe(true);
    expect(out.storageMode).toBe('gist');
  });

  it('returns null content + byteSize 0 when no guidelines exist', async () => {
    mockGetGuidelines.mockReturnValue(null);
    const out = await runGuidelinesView({ repo: 'owner/repo' });
    expect(out.content).toBeNull();
    expect(out.byteSize).toBe(0);
    expect(out.exists).toBe(false);
  });

  it("reports 'local-unavailable' when not in Gist mode", async () => {
    mockGetGuidelines.mockReturnValue(null);
    mockIsGuidelinesAvailable.mockReturnValue(false);
    const out = await runGuidelinesView({ repo: 'owner/repo' });
    expect(out.storageMode).toBe('local-unavailable');
  });

  it('throws on a malformed repo identifier', async () => {
    await expect(runGuidelinesView({ repo: 'not-a-repo' })).rejects.toThrow(/Invalid repo identifier/);
  });
});

describe('runGuidelinesStore', () => {
  it('persists content and returns byte size', async () => {
    const out = await runGuidelinesStore({ repo: 'owner/repo', content: 'guidelines text' });
    expect(out.stored).toBe(true);
    expect(out.byteSize).toBe(Buffer.byteLength('guidelines text', 'utf8'));
    expect(mockSetGuidelines).toHaveBeenCalledWith('owner/repo', 'guidelines text');
  });

  it('checkpoints to Gist after a successful store (#1200)', async () => {
    await runGuidelinesStore({ repo: 'owner/repo', content: 'x' });
    expect(mockMaybeCheckpoint).toHaveBeenCalledOnce();
  });

  it('does not checkpoint when setGuidelines throws', async () => {
    mockSetGuidelines.mockImplementation(() => {
      throw new GuidelinesNotAvailableError();
    });
    await expect(runGuidelinesStore({ repo: 'owner/repo', content: 'x' })).rejects.toThrow();
    expect(mockMaybeCheckpoint).not.toHaveBeenCalled();
  });

  it('throws when content is empty (use reset instead)', async () => {
    await expect(runGuidelinesStore({ repo: 'owner/repo', content: '' })).rejects.toThrow(/Cannot store empty content/);
    expect(mockSetGuidelines).not.toHaveBeenCalled();
  });

  it("propagates GuidelinesNotAvailableError when StateManager isn't in Gist mode", async () => {
    mockSetGuidelines.mockImplementation(() => {
      throw new GuidelinesNotAvailableError();
    });
    await expect(runGuidelinesStore({ repo: 'owner/repo', content: 'x' })).rejects.toThrow(
      /Per-repo guidelines require/,
    );
  });
});

describe('runGuidelinesReset', () => {
  it('returns deleted: true when an existing file was tombstoned', async () => {
    mockGetGuidelines.mockReturnValue('existing content');
    const out = await runGuidelinesReset({ repo: 'owner/repo' });
    expect(out.deleted).toBe(true);
    expect(mockDeleteGuidelines).toHaveBeenCalledWith('owner/repo');
  });

  it('returns deleted: false when no file existed', async () => {
    mockGetGuidelines.mockReturnValue(null);
    const out = await runGuidelinesReset({ repo: 'owner/repo' });
    expect(out.deleted).toBe(false);
    expect(mockDeleteGuidelines).not.toHaveBeenCalled();
  });

  it('checkpoints to Gist after a successful reset (#1200)', async () => {
    mockGetGuidelines.mockReturnValue('existing content');
    await runGuidelinesReset({ repo: 'owner/repo' });
    expect(mockMaybeCheckpoint).toHaveBeenCalledOnce();
  });

  it('does not checkpoint when no file existed', async () => {
    mockGetGuidelines.mockReturnValue(null);
    await runGuidelinesReset({ repo: 'owner/repo' });
    expect(mockMaybeCheckpoint).not.toHaveBeenCalled();
  });

  it('throws GuidelinesNotAvailableError in local mode', async () => {
    mockIsGuidelinesAvailable.mockReturnValue(false);
    await expect(runGuidelinesReset({ repo: 'owner/repo' })).rejects.toThrow(/Per-repo guidelines require/);
  });
});

describe('runFetchCorpus', () => {
  const PR_RECENT = 'https://github.com/owner/repo/pull/1';
  const PR_OLD = 'https://github.com/owner/repo/pull/2';
  const PR_OTHER_REPO = 'https://github.com/owner/other/pull/1';
  const PR_FETCHED = 'https://github.com/owner/repo/pull/3';

  function recentTimestamp(): string {
    return new Date().toISOString();
  }
  function oldTimestamp(): string {
    return new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString();
  }

  it('fetches bundles for unprocessed PRs in the requested repo within the recency cliff', async () => {
    mockGetMergedPRs.mockReturnValue([{ url: PR_RECENT, title: 't', mergedAt: recentTimestamp() }]);
    mockFetchPRCommentBundlesBatch.mockResolvedValue([
      {
        prUrl: PR_RECENT,
        prTitle: 't',
        repo: 'owner/repo',
        mergedAt: recentTimestamp(),
        reviews: [],
        reviewComments: [],
        issueComments: [],
      },
    ]);

    const out = await runFetchCorpus({ repo: 'owner/repo' });

    expect(out.prCount).toBe(1);
    expect(out.bundles).toHaveLength(1);
    expect(mockMarkPRCommentsFetched).toHaveBeenCalledWith(PR_RECENT, expect.any(String));
  });

  it('excludes PRs older than 12 months (recency cliff)', async () => {
    mockGetMergedPRs.mockReturnValue([
      { url: PR_RECENT, title: 't', mergedAt: recentTimestamp() },
      { url: PR_OLD, title: 't2', mergedAt: oldTimestamp() },
    ]);
    mockFetchPRCommentBundlesBatch.mockImplementation(async (_octokit: unknown, urls: string[]) =>
      urls.map((url) => ({
        prUrl: url,
        prTitle: 't',
        repo: 'owner/repo',
        mergedAt: '',
        reviews: [],
        reviewComments: [],
        issueComments: [],
      })),
    );

    const out = await runFetchCorpus({ repo: 'owner/repo' });

    expect(out.prCount).toBe(1);
    expect(mockFetchPRCommentBundlesBatch).toHaveBeenCalledWith(expect.anything(), [PR_RECENT], 'me');
  });

  it('excludes PRs from other repos', async () => {
    mockGetMergedPRs.mockReturnValue([
      { url: PR_OTHER_REPO, title: 'other', mergedAt: recentTimestamp() },
      { url: PR_RECENT, title: 't', mergedAt: recentTimestamp() },
    ]);
    mockFetchPRCommentBundlesBatch.mockResolvedValue([]);

    await runFetchCorpus({ repo: 'owner/repo' });

    expect(mockFetchPRCommentBundlesBatch).toHaveBeenCalledWith(expect.anything(), [PR_RECENT], 'me');
  });

  it('skips PRs with commentsFetchedAt set unless forceRefetch is true', async () => {
    mockGetMergedPRs.mockReturnValue([
      { url: PR_RECENT, title: 't', mergedAt: recentTimestamp() },
      { url: PR_FETCHED, title: 't3', mergedAt: recentTimestamp(), commentsFetchedAt: '2025-01-01T00:00:00Z' },
    ]);
    mockFetchPRCommentBundlesBatch.mockResolvedValue([]);

    const out = await runFetchCorpus({ repo: 'owner/repo' });
    expect(out.skipped).toBe(1);
    expect(mockFetchPRCommentBundlesBatch).toHaveBeenCalledWith(expect.anything(), [PR_RECENT], 'me');
  });

  it('forceRefetch reincludes already-fetched PRs', async () => {
    mockGetMergedPRs.mockReturnValue([
      { url: PR_FETCHED, title: 't', mergedAt: recentTimestamp(), commentsFetchedAt: '2025-01-01T00:00:00Z' },
    ]);
    mockFetchPRCommentBundlesBatch.mockResolvedValue([]);

    const out = await runFetchCorpus({ repo: 'owner/repo', forceRefetch: true });
    expect(out.skipped).toBe(0);
    expect(mockFetchPRCommentBundlesBatch).toHaveBeenCalledWith(expect.anything(), [PR_FETCHED], 'me');
  });

  it('checkpoints to Gist after stamping commentsFetchedAt (#1200)', async () => {
    mockGetMergedPRs.mockReturnValue([{ url: PR_RECENT, title: 't', mergedAt: recentTimestamp() }]);
    mockFetchPRCommentBundlesBatch.mockResolvedValue([
      {
        prUrl: PR_RECENT,
        prTitle: 't',
        repo: 'owner/repo',
        mergedAt: recentTimestamp(),
        reviews: [],
        reviewComments: [],
        issueComments: [],
      },
    ]);

    await runFetchCorpus({ repo: 'owner/repo' });

    expect(mockMarkPRCommentsFetched).toHaveBeenCalledWith(PR_RECENT, expect.any(String));
    expect(mockMaybeCheckpoint).toHaveBeenCalledOnce();
  });

  it('does not checkpoint when no PRs were fetched', async () => {
    mockGetMergedPRs.mockReturnValue([]);
    await runFetchCorpus({ repo: 'owner/repo' });
    expect(mockMaybeCheckpoint).not.toHaveBeenCalled();
  });

  it('respects the `limit` parameter and caps it at 10', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      url: `https://github.com/owner/repo/pull/${i + 1}`,
      title: 't',
      mergedAt: recentTimestamp(),
    }));
    mockGetMergedPRs.mockReturnValue(many);
    mockFetchPRCommentBundlesBatch.mockResolvedValue([]);

    await runFetchCorpus({ repo: 'owner/repo', limit: 100 }); // requesting 100 but capped at 10
    const call = mockFetchPRCommentBundlesBatch.mock.calls[0];
    expect(call[1]).toHaveLength(10);
  });

  it('uses default limit of 5 when limit is omitted', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      url: `https://github.com/owner/repo/pull/${i + 1}`,
      title: 't',
      mergedAt: recentTimestamp(),
    }));
    mockGetMergedPRs.mockReturnValue(many);
    mockFetchPRCommentBundlesBatch.mockResolvedValue([]);

    await runFetchCorpus({ repo: 'owner/repo' });
    const call = mockFetchPRCommentBundlesBatch.mock.calls[0];
    expect(call[1]).toHaveLength(5);
  });

  it('returns an empty corpus without fetching when no eligible PRs exist', async () => {
    mockGetMergedPRs.mockReturnValue([]);
    mockGetClosedPRs.mockReturnValue([]);
    const out = await runFetchCorpus({ repo: 'owner/repo' });
    expect(out.bundles).toEqual([]);
    expect(out.prCount).toBe(0);
    expect(mockFetchPRCommentBundlesBatch).not.toHaveBeenCalled();
  });

  it('considers closed-without-merge PRs alongside merged PRs', async () => {
    mockGetClosedPRs.mockReturnValue([
      { url: 'https://github.com/owner/repo/pull/9', title: 'closed', closedAt: recentTimestamp() },
    ]);
    mockFetchPRCommentBundlesBatch.mockResolvedValue([]);

    await runFetchCorpus({ repo: 'owner/repo' });
    expect(mockFetchPRCommentBundlesBatch).toHaveBeenCalledWith(
      expect.anything(),
      ['https://github.com/owner/repo/pull/9'],
      'me',
    );
  });

  it('throws on a malformed repo identifier', async () => {
    await expect(runFetchCorpus({ repo: 'just-a-name' })).rejects.toThrow(/Invalid repo identifier/);
  });
});
