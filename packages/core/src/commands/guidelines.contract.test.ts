/**
 * --json contract tests for the `guidelines` subcommands (#1208 M3).
 *
 * Mocks StateManager + the PR comment fetcher, then snapshots the full
 * shape that the plugin/MCP consume. Catches schema drift on the four new
 * mutating + read commands the same way comments.contract.test.ts does
 * for the `comments` flow.
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/guidelines.contract.test.ts
 */

import { describe, it, vi, expect, beforeEach } from 'vitest';

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
      getState: () => ({ config: { githubUsername: 'testuser' } }),
    }),
    requireGitHubToken: () => 'fake-token',
    getOctokit: () => ({}) as never,
    maybeCheckpoint: mocks.maybeCheckpoint,
  };
});

import { runGuidelinesView, runGuidelinesStore, runGuidelinesReset, runFetchCorpus } from './guidelines.js';

describe('guidelines --json contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isGuidelinesAvailable.mockReturnValue(true);
    mocks.getMergedPRs.mockReturnValue([]);
    mocks.getClosedPRs.mockReturnValue([]);
  });

  it('view: existing guidelines matches the golden shape', async () => {
    mocks.getGuidelines.mockReturnValue(
      '# Contribution Guidelines: owner/repo\n\n## Code Style\n- Use 2-space indent.\n',
    );
    const result = await runGuidelinesView({ repo: 'owner/repo' });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/guidelines.view.json');
  });

  it('view: no guidelines stored matches the golden shape', async () => {
    mocks.getGuidelines.mockReturnValue(null);
    const result = await runGuidelinesView({ repo: 'owner/repo' });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/guidelines.view-empty.json');
  });

  it('view: local-unavailable mode matches the golden shape', async () => {
    mocks.getGuidelines.mockReturnValue(null);
    mocks.isGuidelinesAvailable.mockReturnValue(false);
    const result = await runGuidelinesView({ repo: 'owner/repo' });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/guidelines.view-local.json');
  });

  it('store: persisted content matches the golden shape', async () => {
    const result = await runGuidelinesStore({ repo: 'owner/repo', content: '# Rules\n- be nice\n' });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/guidelines.store.json');
  });

  it('reset: tombstoned existing file matches the golden shape', async () => {
    mocks.getGuidelines.mockReturnValue('# old guidelines');
    const result = await runGuidelinesReset({ repo: 'owner/repo' });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/guidelines.reset.json');
  });

  it('reset: no-op when no guidelines existed matches the golden shape', async () => {
    mocks.getGuidelines.mockReturnValue(null);
    const result = await runGuidelinesReset({ repo: 'owner/repo' });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/guidelines.reset-noop.json');
  });

  it('fetch-corpus: returns bundles matching the golden shape', async () => {
    const recentTimestamp = new Date().toISOString();
    mocks.getMergedPRs.mockReturnValue([
      {
        url: 'https://github.com/owner/repo/pull/1',
        title: 'fix: parse edge case',
        mergedAt: recentTimestamp,
      },
    ]);
    mocks.fetchPRCommentBundlesBatch.mockResolvedValue({
      bundles: [
        {
          prUrl: 'https://github.com/owner/repo/pull/1',
          prTitle: 'fix: parse edge case',
          repo: 'owner/repo',
          mergedAt: recentTimestamp,
          reviews: [
            {
              author: 'maintainer',
              authorAssociation: 'OWNER',
              body: 'Looks good but please add a test.',
              submittedAt: recentTimestamp,
            },
          ],
          reviewComments: [
            {
              author: 'maintainer',
              authorAssociation: 'OWNER',
              body: 'Use the helper from utils instead.',
              path: 'src/parse.ts',
              createdAt: recentTimestamp,
            },
          ],
          issueComments: [
            {
              author: 'maintainer',
              authorAssociation: 'OWNER',
              body: 'Thanks for the contribution!',
              createdAt: recentTimestamp,
            },
          ],
        },
      ],
      failures: [],
    });

    const result = await runFetchCorpus({ repo: 'owner/repo', limit: 5 });
    // Replace the dynamic timestamp in the JSON before snapshotting so the
    // fixture is stable across test runs.
    const stable = JSON.stringify(result, null, 2).replaceAll(recentTimestamp, '2026-05-04T00:00:00.000Z');
    await expect(stable).toMatchFileSnapshot('./__golden__/guidelines.fetch-corpus.json');
  });

  it('fetch-corpus: empty corpus (no eligible PRs) matches the golden shape', async () => {
    mocks.getMergedPRs.mockReturnValue([]);
    mocks.getClosedPRs.mockReturnValue([]);
    const result = await runFetchCorpus({ repo: 'owner/repo' });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot(
      './__golden__/guidelines.fetch-corpus-empty.json',
    );
  });
});
