/**
 * --json contract test for the `daily` command (#965, #986).
 *
 * Rather than mock the full PR-monitor / scout / state pipeline,
 * this test pins the shape of `toDailyOutput` — the pure
 * transformation from DailyCheckResult (the internal representation)
 * to DailyOutput (what consumers see). Any shape drift in the
 * deduplicated output still fails this test.
 *
 * The full end-to-end pipeline is not under contract here because the
 * pipeline's behaviour is covered by its unit tests; what's
 * externally load-bearing is the compact JSON shape, and that lives
 * entirely in `toDailyOutput`.
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/daily.contract.test.ts
 */

import { describe, it, expect } from 'vitest';
import { toDailyOutput, type DailyCheckResult } from './daily.js';
import { makeFetchedPR, makeDailyDigest, makeCapacityAssessment } from '../core/test-utils.js';

function makeFixture(overrides: Partial<DailyCheckResult> = {}): DailyCheckResult {
  const pr1 = makeFetchedPR({
    repo: 'octocat/spoon-knife',
    number: 42,
    status: 'needs_addressing',
    displayLabel: '[CI Failing]',
    ciStatus: 'failing',
    failingCheckNames: ['Node 20 / ubuntu-latest'],
  });
  const pr2 = makeFetchedPR({
    repo: 'octocat/spoon-knife',
    number: 43,
    status: 'waiting_on_maintainer',
  });

  return {
    digest: makeDailyDigest({
      openPRs: [pr1, pr2],
      needsAddressingPRs: [pr1],
      waitingOnMaintainerPRs: [pr2],
      summary: { totalActivePRs: 2, totalNeedingAttention: 1, totalMergedAllTime: 12, mergeRate: 0.85 },
    }),
    capacity: makeCapacityAssessment({ activePRCount: 2 }),
    summary: 'One PR needs attention; one waiting on review.',
    briefSummary: '2 active PRs: 1 needs attention',
    actionableIssues: [{ type: 'ci_failing', pr: pr1, label: '[CI Failing]', isNewContribution: false }],
    actionMenu: {
      items: [
        {
          key: 'address_all',
          label: 'Address this issue (Recommended)',
          description: 'Fix the issue blocking your PR',
        },
        { key: 'search', label: 'Search for new issues', description: 'Find a new contribution' },
        { key: 'done', label: 'Done', description: 'Exit' },
      ],
      context: {
        hasActionableIssues: true,
        actionableCount: 1,
        hasCapacity: true,
        hasIssueResponses: false,
        issueResponseCount: 0,
      },
    },
    commentedIssues: [],
    repoGroups: [{ repo: 'octocat/spoon-knife', prs: [pr1, pr2] }],
    failures: [],
    warnings: [],
    ...overrides,
  };
}

describe('daily --json contract', () => {
  it('typical-day output matches the golden shape', async () => {
    const result = toDailyOutput(makeFixture());
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/daily.typical.json');
  });

  it('empty-day output (no PRs, no actions) matches the golden shape', async () => {
    const result = toDailyOutput(
      makeFixture({
        digest: makeDailyDigest(),
        capacity: makeCapacityAssessment({ activePRCount: 0 }),
        summary: 'No open PRs.',
        briefSummary: 'No open PRs',
        actionableIssues: [],
        actionMenu: {
          items: [
            { key: 'search', label: 'Search for new issues', description: 'Find a new contribution' },
            { key: 'done', label: 'Done', description: 'Exit' },
          ],
          context: {
            hasActionableIssues: false,
            actionableCount: 0,
            hasCapacity: true,
            hasIssueResponses: false,
            issueResponseCount: 0,
          },
        },
        repoGroups: [],
      }),
    );
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/daily.empty.json');
  });

  it('degraded-day output surfaces warnings for ancillary failures (#1042)', async () => {
    const result = toDailyOutput(
      makeFixture({
        warnings: [
          { phase: 'fetch', operation: 'fetch recently merged PRs', message: 'Network error' },
          { phase: 'repo-scores', operation: 'fetch repo metadata', message: 'Secondary rate limit' },
          { phase: 'gist-checkpoint', operation: 'Gist checkpoint', message: 'Unauthorized' },
        ],
      }),
    );
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/daily.degraded.json');
  });
});
