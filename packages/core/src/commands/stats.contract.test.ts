/**
 * --json contract test for the `stats` command (#965, #986).
 *
 * Golden-file test — mocks the state manager with a deterministic
 * repoScores fixture and snapshots `runStats`' full output shape.
 * Update goldens on intentional shape changes with:
 *   npx vitest run -u src/commands/stats.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runStats } from './stats.js';

const mockGetStateManager = vi.mocked(getStateManager);

describe('stats --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({
        config: { githubUsername: 'testuser' },
        lastDigest: { summary: { totalActivePRs: 3 } },
        repoScores: {
          'octocat/spoon-knife': {
            repo: 'octocat/spoon-knife',
            score: 8,
            mergedPRCount: 5,
            closedWithoutMergeCount: 1,
            avgResponseDays: 2,
            lastEvaluatedAt: '2026-01-15T00:00:00.000Z',
            lastMergedAt: '2026-01-10T00:00:00.000Z',
            signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
          },
          'torvalds/linux': {
            repo: 'torvalds/linux',
            score: 5,
            mergedPRCount: 1,
            closedWithoutMergeCount: 0,
            avgResponseDays: 14,
            lastEvaluatedAt: '2025-11-01T00:00:00.000Z',
            signals: { hasActiveMaintainers: true, isResponsive: false, hasHostileComments: false },
          },
        },
      }),
    } as unknown as ReturnType<typeof getStateManager>);
  });

  it('output matches the golden shape', async () => {
    const result = await runStats();
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/stats.json');
  });
});
