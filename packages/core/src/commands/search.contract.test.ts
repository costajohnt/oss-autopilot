/**
 * --json contract test for the `search` command (#965, #986).
 *
 * Mocks `@oss-scout/core`'s `search()` with a deterministic multi-candidate
 * result (covers approve + needs_review + skip recommendations) and
 * snapshots the full shape the plugin layer sees.
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/search.contract.test.ts
 *
 * Scope note: like the `vet` contract, scout's own fields passed straight
 * through (viability score, reasons, priority) are pinned to whatever the
 * mock emits. Scout-side drift must be caught by scout's own tests.
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  getRepoScore: vi.fn(),
}));

vi.mock('./scout-bridge.js', () => ({
  createAutopilotScout: vi.fn(async () => ({ search: mocks.search })),
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => ({ getRepoScore: mocks.getRepoScore }),
  };
});

import { runSearch } from './search.js';

describe('search --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getRepoScore.mockImplementation((repo: string) => {
      if (repo === 'octocat/spoon-knife') {
        return {
          repo,
          score: 8,
          mergedPRCount: 4,
          closedWithoutMergeCount: 0,
          avgResponseDays: 2,
          lastEvaluatedAt: '2026-01-15T00:00:00.000Z',
          lastMergedAt: '2026-01-10T00:00:00.000Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        };
      }
      return undefined;
    });
  });

  it('multi-candidate results match the golden shape', async () => {
    mocks.search.mockResolvedValue({
      candidates: [
        {
          issue: {
            repo: 'octocat/spoon-knife',
            number: 101,
            title: 'Solid first pick',
            url: 'https://github.com/octocat/spoon-knife/issues/101',
            labels: ['good first issue'],
          },
          recommendation: 'approve',
          reasonsToApprove: ['Active maintainers', 'Relationship history'],
          reasonsToSkip: [],
          searchPriority: 'merged_pr',
          viabilityScore: 88,
        },
        {
          issue: {
            repo: 'unknown-org/unknown-repo',
            number: 7,
            title: 'Worth a look',
            url: 'https://github.com/unknown-org/unknown-repo/issues/7',
            labels: ['help wanted'],
          },
          recommendation: 'needs_review',
          reasonsToApprove: ['Clear scope'],
          reasonsToSkip: ['No prior relationship'],
          searchPriority: 'normal',
          viabilityScore: 60,
        },
        {
          issue: {
            repo: 'stale-org/stale-repo',
            number: 1,
            title: 'Probably dormant',
            url: 'https://github.com/stale-org/stale-repo/issues/1',
            labels: [],
          },
          recommendation: 'skip',
          reasonsToApprove: [],
          reasonsToSkip: ['Maintainer unresponsive for 120 days'],
          searchPriority: 'normal',
          viabilityScore: 12,
        },
      ],
      excludedRepos: ['excluded-org/excluded-repo'],
      aiPolicyBlocklist: ['anti-llm-org/anti-llm-repo'],
    });

    const result = await runSearch({ maxResults: 10 });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/search.json');
  });

  it('rate-limited result matches the golden shape', async () => {
    mocks.search.mockResolvedValue({
      candidates: [],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      rateLimitWarning: 'GitHub Search API rate-limited; retry in 60 seconds.',
    });

    const result = await runSearch({ maxResults: 5 });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/search.rate-limited.json');
  });
});
