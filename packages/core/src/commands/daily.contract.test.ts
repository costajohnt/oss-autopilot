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
import { summarizeAttentionBuckets } from '../core/pr-attention.js';
import {
  DailyOutputSchema,
  CompactDailyOutputSchema,
  toCompactDailyOutput,
  type DailyOutput,
} from '../formatters/json.js';
import { makeFetchedPR, makeDailyDigest, makeCapacityAssessment, schemaIssues } from '../core/test-utils.js';

/**
 * Goldens pin the serialized shape; this pins the goldens to the exported
 * schemas. Without it a fixture missing a required field (tests are excluded
 * from tsc) produces goldens that match yet fail `DailyOutputSchema` for
 * every real consumer (#1418).
 */
function expectSchemaValid(result: DailyOutput): void {
  expect(schemaIssues(DailyOutputSchema, result)).toEqual([]);
  expect(schemaIssues(CompactDailyOutputSchema, toCompactDailyOutput(result))).toEqual([]);
}

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
    // Mirrors production wiring: executeDailyCheckInternal computes
    // `attention` with this same classifier over the active PRs (#1352).
    attention: summarizeAttentionBuckets([pr1, pr2]),
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
    expectSchemaValid(result);
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
        attention: summarizeAttentionBuckets([]),
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
    expectSchemaValid(result);
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
    expectSchemaValid(result);
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/daily.degraded.json');
  });

  it('merge-free output carries no listUpdates key (#1463 — pins golden stability)', () => {
    const result = toDailyOutput(makeFixture());
    expect('listUpdates' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('listUpdates');
  });

  it('auto-marked list entries pass through and validate against the schema (#1463)', () => {
    const result = toDailyOutput(
      makeFixture({
        listUpdates: [
          {
            prUrl: 'https://github.com/octocat/spoon-knife/pull/44',
            issueUrl: 'https://github.com/octocat/spoon-knife/issues/40',
            listPath: '/home/user/open-source/potential-issue-list.md',
            repoHeadingStruck: false,
          },
        ],
      }),
    );
    expectSchemaValid(result);
    expect(result.listUpdates).toHaveLength(1);
    expect(result.listUpdates![0].issueUrl).toBe('https://github.com/octocat/spoon-knife/issues/40');
  });
});
