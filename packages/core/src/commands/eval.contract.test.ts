/**
 * --json contract test for the `eval` command (#1825).
 *
 * Golden-file test: a fixed ledger fixture (vet pick with traits, list pick,
 * repeat merge in one repo, close reason, review state, dormant PR) and a
 * pinned clock.
 * Update goldens on intentional shape changes with:
 *   npx vitest run -u src/commands/eval.contract.test.ts
 */

import { describe, it, vi, beforeEach, afterEach, expect } from 'vitest';
import { makeAgentState, makeFetchedPR } from '../core/test-utils.js';

vi.mock('../core/index.js', () => ({ getStateManager: vi.fn() }));

import { getStateManager } from '../core/index.js';
import { runEval } from './eval.js';

describe('eval --json contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
    const state = makeAgentState({
      mergedPRs: [
        {
          url: 'https://github.com/octo/alpha/pull/1',
          title: 'Fix parser',
          mergedAt: '2026-10-10T00:00:00Z',
          openedAt: '2026-10-08T00:00:00Z',
          firstMaintainerResponseAt: '2026-10-08T06:00:00Z',
          lastReviewDecision: 'approved',
          lastCiStatus: 'passing',
          pick: {
            issueUrl: 'https://github.com/octo/alpha/issues/9',
            grade: 8,
            recommendation: 'approve',
            stargazersCount: 2500,
            source: 'vet',
            capturedAt: '2026-10-07T00:00:00Z',
            labels: ['bug', 'good first issue'],
            issueAuthorAssociation: 'MEMBER',
            competingPRs: 0,
            firstInRepo: true,
            commentCount: 2,
          },
        },
        {
          url: 'https://github.com/octo/alpha/pull/6',
          title: 'Fix lexer',
          mergedAt: '2026-10-20T00:00:00Z',
          openedAt: '2026-10-18T00:00:00Z',
        },
        {
          url: 'https://github.com/octo/beta/pull/2',
          title: 'Add flag',
          mergedAt: '2026-09-20T00:00:00Z',
          pick: {
            issueUrl: 'https://github.com/octo/beta/issues/3',
            grade: 7,
            recommendation: 'approve',
            source: 'list',
          },
        },
      ],
      closedPRs: [
        {
          url: 'https://github.com/octo/alpha/pull/4',
          title: 'Refactor',
          closedAt: '2026-10-12T00:00:00Z',
          closeReason: 'rejected',
          lastReviewDecision: 'changes_requested',
          lastCiStatus: 'failing',
        },
      ],
      lastDigest: {
        openPRs: [
          makeFetchedPR({
            url: 'https://github.com/octo/beta/pull/5',
            repo: 'octo/beta',
            stalenessTier: 'dormant',
            createdAt: '2026-09-25T00:00:00Z',
          }),
        ],
      } as never,
    });
    vi.mocked(getStateManager).mockReturnValue({ getState: () => state } as unknown as ReturnType<
      typeof getStateManager
    >);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('output matches the golden shape', async () => {
    const result = await runEval();
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/eval.json');
  });
});
