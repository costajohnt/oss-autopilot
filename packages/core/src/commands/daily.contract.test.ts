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
import { wrapUntrustedContent } from '../core/untrusted-content.js';

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

  it('closedPRStatusUpdates passes through full and compact output and validates (#1863)', () => {
    const updates = [
      {
        prUrl: 'https://github.com/octocat/spoon-knife/pull/41',
        issueUrl: 'https://github.com/octocat/spoon-knife/issues/40',
        closedAt: '2026-06-02T00:00:00Z',
      },
    ];
    const result = toDailyOutput(makeFixture({ closedPRStatusUpdates: updates }));
    expectSchemaValid(result);
    expect(result.closedPRStatusUpdates).toEqual(updates);
    const compact = toCompactDailyOutput(result);
    expect(compact.closedPRStatusUpdates).toEqual(updates);
    expect(CompactDailyOutputSchema.parse(compact).closedPRStatusUpdates).toEqual(updates);
    // Runs with nothing to update carry no key at all, so goldens are unchanged.
    expect('closedPRStatusUpdates' in toDailyOutput(makeFixture())).toBe(false);
  });

  it('mergedPRNotes passes through full and compact output with fenced excerpts and validates (#1861)', () => {
    const entry = {
      prUrl: 'https://github.com/octocat/spoon-knife/pull/44',
      repo: 'octocat/spoon-knife',
      number: 44,
      title: 'Merged fix',
      mergedAt: '2026-06-02T00:00:00Z',
      notes: [
        { author: 'maintainer', createdAt: '2026-06-02T00:01:00Z', kind: 'comment' as const, excerpt: 'Thanks!' },
        {
          author: 'maintainer',
          createdAt: '2026-06-01T00:00:00Z',
          kind: 'commit' as const,
          excerpt: 'Cover edge case',
        },
      ],
      maintainerCommits: 1,
      thanksOnly: false,
      ackCoveredBy: 'https://github.com/octocat/spoon-knife/pull/45',
    };
    const result = toDailyOutput(makeFixture({ mergedPRNotes: [entry] }));
    expectSchemaValid(result);
    // Excerpts are GitHub-controlled text and arrive fenced; everything else is verbatim.
    expect(result.mergedPRNotes).toHaveLength(1);
    const fenced = result.mergedPRNotes![0];
    expect({ ...fenced, notes: undefined }).toEqual({ ...entry, notes: undefined });
    expect(fenced.notes.map((n) => n.excerpt)).toEqual([
      wrapUntrustedContent('Thanks!', 'octocat/spoon-knife#44', { author: 'maintainer', source: 'pr-comment' }),
      wrapUntrustedContent('Cover edge case', 'octocat/spoon-knife#44', { author: 'maintainer', source: 'pr-commit' }),
    ]);
    expect(fenced.notes.map((n) => [n.author, n.createdAt, n.kind])).toEqual(
      entry.notes.map((n) => [n.author, n.createdAt, n.kind]),
    );
    const compact = toCompactDailyOutput(result);
    expect(compact.mergedPRNotes).toEqual(result.mergedPRNotes);
    expect(CompactDailyOutputSchema.parse(compact).mergedPRNotes).toEqual(result.mergedPRNotes);
    // Runs with no notes carry no key at all, so goldens are unchanged.
    expect('mergedPRNotes' in toDailyOutput(makeFixture())).toBe(false);
  });

  it('recentlyClosedPRs keep their issueUrl through schema validation (#1863)', () => {
    const closed = {
      url: 'https://github.com/octocat/spoon-knife/pull/41',
      repo: 'octocat/spoon-knife',
      number: 41,
      title: 'Closed attempt',
      closedAt: '2026-06-02T00:00:00Z',
      issueUrl: 'https://github.com/octocat/spoon-knife/issues/40',
    };
    const fixture = makeFixture();
    fixture.digest.recentlyClosedPRs = [closed];
    const parsed = DailyOutputSchema.parse(toDailyOutput(fixture));
    expect(parsed.digest.recentlyClosedPRs[0].issueUrl).toBe(closed.issueUrl);
  });

  it('merge-free output carries no listUpdates key (#1463 — pins golden stability)', () => {
    const result = toDailyOutput(makeFixture());
    expect('listUpdates' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('listUpdates');
  });

  it('pendingLearnings passes through full and compact output and validates (#1696)', () => {
    const pending = { repos: ['octocat/spoon-knife'], prCount: 2 };
    const result = toDailyOutput(makeFixture({ pendingLearnings: pending }));
    expectSchemaValid(result);
    expect(result.pendingLearnings).toEqual(pending);
    const compact = toCompactDailyOutput(result);
    expect(compact.pendingLearnings).toEqual(pending);
    expect(CompactDailyOutputSchema.parse(compact).pendingLearnings).toEqual(pending);
    expect('pendingLearnings' in toDailyOutput(makeFixture())).toBe(false);
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

// Separate describe: the main one sits at the max-lines-per-function ceiling.
describe('daily --json contract: review follow-ups (#1857)', () => {
  it('reviewedPRs passes through full and compact output with fenced excerpts and subjects and validates (#1857)', () => {
    const entry = {
      prUrl: 'https://github.com/octocat/spoon-knife/pull/46',
      repo: 'octocat/spoon-knife',
      number: 46,
      title: 'Add retries',
      author: 'contributor',
      reviewedAt: '2026-06-01T00:00:00Z',
      reviewedSha: 'aaaaaaa',
      headSha: 'bbbbbbb',
      compareRange: 'aaaaaaa...bbbbbbb',
      compareUrl: 'https://github.com/octocat/spoon-knife/compare/aaaaaaa...bbbbbbb',
      rebased: false,
      mergedUpstream: false,
      baseUnknown: false,
      commits: [{ sha: 'bbbbbbb', author: 'contributor', date: '2026-06-02T00:00:00Z', subject: 'Split the helper' }],
      moreCommits: 0,
      authorComments: 1,
      questions: [
        {
          author: 'contributor',
          createdAt: '2026-06-02T00:01:00Z',
          kind: 'review_comment' as const,
          reason: 'reply' as const,
          excerpt: 'Is a 30s cap enough?',
          url: 'https://github.com/octocat/spoon-knife/pull/46#discussion_r1',
        },
      ],
      moreQuestions: 0,
      latestActivityAt: '2026-06-02T00:01:00Z',
    };
    const result = toDailyOutput(makeFixture({ reviewedPRs: [entry] }));
    expectSchemaValid(result);
    expect(result.reviewedPRs).toHaveLength(1);
    const fenced = result.reviewedPRs![0];
    expect({ ...fenced, questions: undefined, commits: undefined }).toEqual({
      ...entry,
      questions: undefined,
      commits: undefined,
    });
    expect(fenced.questions.map((q) => q.excerpt)).toEqual([
      wrapUntrustedContent('Is a 30s cap enough?', 'octocat/spoon-knife#46', {
        author: 'contributor',
        source: 'pr-comment',
      }),
    ]);
    expect(fenced.commits.map((c) => c.subject)).toEqual([
      wrapUntrustedContent('Split the helper', 'octocat/spoon-knife#46', {
        author: 'contributor',
        source: 'pr-commit',
      }),
    ]);
    expect({ ...fenced.questions[0], excerpt: undefined }).toEqual({ ...entry.questions[0], excerpt: undefined });
    const compact = toCompactDailyOutput(result);
    expect(compact.reviewedPRs).toEqual(result.reviewedPRs);
    expect(CompactDailyOutputSchema.parse(compact).reviewedPRs).toEqual(result.reviewedPRs);
    // A minimal entry (no reviewed SHA, no range, plain-comment base) validates too.
    const rebased = toDailyOutput(
      makeFixture({
        reviewedPRs: [
          {
            ...entry,
            reviewedSha: undefined,
            compareRange: undefined,
            compareUrl: undefined,
            baseUnknown: true,
            questions: [],
          },
        ],
      }),
    );
    expectSchemaValid(rebased);
    // Runs with no follow-ups carry no key at all, so goldens are unchanged.
    expect('reviewedPRs' in toDailyOutput(makeFixture())).toBe(false);
  });
});

describe('daily --json contract: work claims (#1856, #1852)', () => {
  const claim = {
    kind: 'implementation' as const,
    url: 'https://github.com/owner/repo/issues/7',
    session: 'air/20261102T1200',
    startedAt: '2026-11-02T12:00:00.000Z',
    expiresAt: '2026-11-03T12:00:00.000Z',
    status: 'finished' as const,
    branch: 'fix/thing',
    worktree: '/work/wt/a',
  };

  it('workClaims passes through full and compact output and validates', () => {
    const result = toDailyOutput(makeFixture({ workClaims: [claim] }));
    expect(result.workClaims).toEqual([claim]);
    expect(toCompactDailyOutput(result).workClaims).toEqual([claim]);
    expectSchemaValid(result);
  });

  it('a run without live claims carries no workClaims key (pins golden stability)', () => {
    const result = toDailyOutput(makeFixture());
    expect('workClaims' in result).toBe(false);
    expect(toCompactDailyOutput(result).workClaims).toBeUndefined();
  });
});
