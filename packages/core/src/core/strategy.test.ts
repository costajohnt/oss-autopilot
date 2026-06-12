/**
 * Tests for `computeStrategy` (#1243).
 *
 * Pin the deterministic compute layer (style classification, language
 * weighting, capacity overextension, trajectory direction). The
 * interpretive narrative belongs to the agent prompt and is not under
 * test here.
 */

import { describe, it, expect } from 'vitest';
import {
  computeStrategy,
  shouldComputeStrategy,
  STRATEGY_CADENCE_DAYS,
  STRATEGY_CADENCE_MERGED_DELTA,
  STRATEGY_MIN_PRS,
} from './strategy.js';
import { AgentStateSchema } from './state-schema.js';
import type { AgentState } from './state-schema.js';

function makeMergedPR(repo: string, n: number, opts: { title?: string; mergedAt?: string } = {}) {
  return {
    url: `https://github.com/${repo}/pull/${n}`,
    title: opts.title ?? `feat: PR #${n}`,
    mergedAt: opts.mergedAt ?? new Date().toISOString(),
  };
}

function makeState(
  // Same shape as test-utils' makeAgentState: config may be partial because
  // AgentStateSchema.parse fills the remaining defaults.
  overrides: Omit<Partial<AgentState>, 'config'> & { config?: Partial<AgentState['config']> } = {},
): AgentState {
  return AgentStateSchema.parse({ version: 4, ...overrides });
}

describe('computeStrategy — minimum data gate', () => {
  it('returns null when fewer than STRATEGY_MIN_PRS merged PRs are tracked', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: STRATEGY_MIN_PRS - 1 }, (_, i) => makeMergedPR('o/r', i + 1)),
    });
    expect(computeStrategy(state)).toBeNull();
  });

  it('returns a result at exactly STRATEGY_MIN_PRS merged PRs', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: STRATEGY_MIN_PRS }, (_, i) => makeMergedPR('o/r', i + 1)),
    });
    expect(computeStrategy(state)).not.toBeNull();
  });
});

describe('computeStrategy — profile', () => {
  it('classifies a heavy single-repo contributor as maintainer', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: 12 }, (_, i) => makeMergedPR('vercel/next.js', i + 1)),
    });
    const result = computeStrategy(state);
    expect(result?.profile.style).toBe('maintainer');
    expect(result?.profile.favoriteRepos).toEqual(['vercel/next.js']);
  });

  it('classifies a 4+ repo contributor as generalist', () => {
    const state = makeState({
      mergedPRs: [
        ...Array.from({ length: 3 }, (_, i) => makeMergedPR('a/r', i + 1)),
        ...Array.from({ length: 3 }, (_, i) => makeMergedPR('b/r', i + 1)),
        ...Array.from({ length: 3 }, (_, i) => makeMergedPR('c/r', i + 1)),
        ...Array.from({ length: 3 }, (_, i) => makeMergedPR('d/r', i + 1)),
      ],
    });
    const result = computeStrategy(state);
    expect(result?.profile.style).toBe('generalist');
    expect(result?.profile.favoriteRepos).toHaveLength(4);
  });

  it('weights primary languages by repo PR count', () => {
    const repoScore = (language: string) => ({
      repo: 'placeholder',
      score: 7,
      mergedPRCount: 0,
      closedWithoutMergeCount: 0,
      avgResponseDays: null,
      lastEvaluatedAt: new Date().toISOString(),
      signals: {
        hasActiveMaintainers: true,
        isResponsive: true,
        hasHostileComments: false,
      },
      language,
    });
    const state = makeState({
      mergedPRs: [
        ...Array.from({ length: 5 }, (_, i) => makeMergedPR('a/r', i + 1)),
        ...Array.from({ length: 5 }, (_, i) => makeMergedPR('b/r', i + 1)),
      ],
      repoScores: {
        'a/r': repoScore('TypeScript'),
        'b/r': repoScore('Go'),
      },
    });
    const result = computeStrategy(state);
    expect(result?.profile.primaryLanguages.sort()).toEqual(['Go', 'TypeScript'].sort());
  });

  it('computes merge rate from merged + closed totals', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: 10 }, (_, i) => makeMergedPR('a/r', i + 1)),
      closedPRs: [
        { url: 'https://github.com/a/r/pull/100', title: 'closed', closedAt: new Date().toISOString() },
        { url: 'https://github.com/a/r/pull/101', title: 'closed', closedAt: new Date().toISOString() },
      ],
    });
    const result = computeStrategy(state);
    expect(result?.profile.totalPRs).toBe(12);
    expect(result?.profile.mergedCount).toBe(10);
    expect(result?.profile.mergeRate).toBeCloseTo(10 / 12);
  });
});

describe('computeStrategy — pr type distribution', () => {
  it('classifies titles by Conventional Commits prefix and keyword fallbacks', () => {
    const recent = new Date().toISOString();
    const state = makeState({
      mergedPRs: [
        makeMergedPR('a/r', 1, { title: 'docs: update README', mergedAt: recent }),
        makeMergedPR('a/r', 2, { title: 'fix(api): correct timeout', mergedAt: recent }),
        makeMergedPR('a/r', 3, { title: 'feat: add login', mergedAt: recent }),
        makeMergedPR('a/r', 4, { title: 'refactor: simplify state machine', mergedAt: recent }),
        makeMergedPR('a/r', 5, { title: 'test: cover edge case', mergedAt: recent }),
        makeMergedPR('a/r', 6, { title: 'crash on null payload', mergedAt: recent }),
        makeMergedPR('a/r', 7, { title: 'add support for foo', mergedAt: recent }),
        makeMergedPR('a/r', 8, { title: 'something else entirely', mergedAt: recent }),
        makeMergedPR('a/r', 9, { title: 'docs: another doc fix', mergedAt: recent }),
        makeMergedPR('a/r', 10, { title: 'feat: another feature', mergedAt: recent }),
      ],
    });
    const dist = computeStrategy(state)?.patterns.prTypeDistribution;
    // `add support for foo` keyword-falls-through to features (catches
    // the `add` / `support` heuristic), so 3 features total.
    expect(dist?.docs).toBe(2);
    expect(dist?.fixes).toBe(2);
    expect(dist?.features).toBe(3);
    expect(dist?.refactors).toBe(1);
    expect(dist?.tests).toBe(1);
    expect(dist?.other).toBe(1);
  });

  it('excludes PRs older than the recent window from distribution', () => {
    const state = makeState({
      mergedPRs: [
        ...Array.from({ length: 9 }, (_, i) =>
          makeMergedPR('a/r', i + 1, {
            title: 'feat: recent',
            mergedAt: new Date().toISOString(),
          }),
        ),
        makeMergedPR('a/r', 10, {
          title: 'feat: ancient',
          mergedAt: new Date('2020-01-01').toISOString(),
        }),
      ],
    });
    const dist = computeStrategy(state)?.patterns.prTypeDistribution;
    expect(dist?.features).toBe(9);
  });
});

describe('computeStrategy — capacity', () => {
  it('flags overExtended when dormant PRs span 2+ repos', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: 10 }, (_, i) => makeMergedPR('a/r', i + 1)),
      lastDigest: {
        generatedAt: new Date().toISOString(),
        openPRs: [],
        needsAddressingPRs: [],
        waitingOnMaintainerPRs: [
          { url: 'https://github.com/x/y/pull/1' },
          { url: 'https://github.com/m/n/pull/2' },
        ] as any,
        recentlyClosedPRs: [],
        recentlyMergedPRs: [],
        shelvedPRs: [],
        autoUnshelvedPRs: [],
        summary: { totalActivePRs: 5, totalNeedingAttention: 2, totalMergedAllTime: 10, mergeRate: 1 },
      },
    });
    const cap = computeStrategy(state)?.capacity;
    expect(cap?.overExtended).toBe(true);
    expect(cap?.suggestedAction).toBe('follow_up_dormant');
  });

  it('does not flag overExtended when dormant PRs are all in one repo', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: 10 }, (_, i) => makeMergedPR('a/r', i + 1)),
      lastDigest: {
        generatedAt: new Date().toISOString(),
        openPRs: [],
        needsAddressingPRs: [],
        waitingOnMaintainerPRs: [
          { url: 'https://github.com/x/y/pull/1' },
          { url: 'https://github.com/x/y/pull/2' },
        ] as any,
        recentlyClosedPRs: [],
        recentlyMergedPRs: [],
        shelvedPRs: [],
        autoUnshelvedPRs: [],
        summary: { totalActivePRs: 5, totalNeedingAttention: 2, totalMergedAllTime: 10, mergeRate: 1 },
      },
    });
    const cap = computeStrategy(state)?.capacity;
    expect(cap?.overExtended).toBe(false);
  });

  it('derives the waiting bucket from openPRs through the override map (#1416)', () => {
    // Dashboard-written digests keep RAW statuses in openPRs; a live
    // override flipping needs_addressing -> waiting must count as dormant.
    const state = makeState({
      mergedPRs: Array.from({ length: 10 }, (_, i) => makeMergedPR('a/r', i + 1)),
      config: {
        statusOverrides: {
          'https://github.com/x/y/pull/1': {
            status: 'waiting_on_maintainer',
            setAt: '2026-05-02T00:00:00Z',
            lastActivityAt: '2026-05-01T00:00:00Z',
          },
        },
      },
      lastDigest: {
        generatedAt: new Date().toISOString(),
        openPRs: [
          { url: 'https://github.com/x/y/pull/1', status: 'needs_addressing', updatedAt: '2026-05-01T00:00:00Z' },
          { url: 'https://github.com/m/n/pull/2', status: 'waiting_on_maintainer', updatedAt: '2026-05-01T00:00:00Z' },
        ] as any,
        needsAddressingPRs: [],
        // Stored raw-basis array deliberately disagrees — it must be ignored
        // when openPRs is available.
        waitingOnMaintainerPRs: [{ url: 'https://github.com/m/n/pull/2' }] as any,
        recentlyClosedPRs: [],
        recentlyMergedPRs: [],
        shelvedPRs: [],
        autoUnshelvedPRs: [],
        summary: { totalActivePRs: 2, totalNeedingAttention: 0, totalMergedAllTime: 10, mergeRate: 1 },
      },
    });
    const cap = computeStrategy(state)?.capacity;
    // Both PRs are waiting on the override-applied basis, across 2 repos.
    expect(cap?.dormantPRCount).toBe(2);
    expect(cap?.overExtended).toBe(true);
  });

  it('ignores a stale override (newer PR activity) when deriving the waiting bucket', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: 10 }, (_, i) => makeMergedPR('a/r', i + 1)),
      config: {
        statusOverrides: {
          'https://github.com/x/y/pull/1': {
            status: 'waiting_on_maintainer',
            setAt: '2026-04-02T00:00:00Z',
            lastActivityAt: '2026-04-01T00:00:00Z',
          },
        },
      },
      lastDigest: {
        generatedAt: new Date().toISOString(),
        openPRs: [
          // Activity is NEWER than the override's lastActivityAt: same rule
          // as getStatusOverride, the override no longer applies.
          { url: 'https://github.com/x/y/pull/1', status: 'needs_addressing', updatedAt: '2026-05-01T00:00:00Z' },
        ] as any,
        needsAddressingPRs: [],
        waitingOnMaintainerPRs: [] as any,
        recentlyClosedPRs: [],
        recentlyMergedPRs: [],
        shelvedPRs: [],
        autoUnshelvedPRs: [],
        summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 10, mergeRate: 1 },
      },
    });
    const cap = computeStrategy(state)?.capacity;
    expect(cap?.dormantPRCount).toBe(0);
  });

  it('suggests open_more when no PRs are open and no dormant follow-ups', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: 10 }, (_, i) => makeMergedPR('a/r', i + 1)),
      lastDigest: {
        generatedAt: new Date().toISOString(),
        openPRs: [],
        needsAddressingPRs: [],
        waitingOnMaintainerPRs: [],
        recentlyClosedPRs: [],
        recentlyMergedPRs: [],
        shelvedPRs: [],
        autoUnshelvedPRs: [],
        summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 10, mergeRate: 1 },
      },
    });
    expect(computeStrategy(state)?.capacity.suggestedAction).toBe('open_more');
  });
});

describe('computeStrategy — trajectory', () => {
  it('returns steady when monthly history is too thin', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: 10 }, (_, i) => makeMergedPR('a/r', i + 1)),
    });
    expect(computeStrategy(state)?.patterns.trajectoryDirection).toBe('steady');
  });

  it('returns growing when recent 3-month merge count is >=20% above prior 3 months', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: 10 }, (_, i) => makeMergedPR('a/r', i + 1)),
      monthlyMergedCounts: {
        '2025-09': 1,
        '2025-10': 2,
        '2025-11': 1,
        '2025-12': 4,
        '2026-01': 5,
        '2026-02': 6,
      },
    });
    expect(computeStrategy(state)?.patterns.trajectoryDirection).toBe('growing');
  });

  it('returns declining when recent 3-month merge count is <=20% below prior 3 months', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: 10 }, (_, i) => makeMergedPR('a/r', i + 1)),
      monthlyMergedCounts: {
        '2025-09': 5,
        '2025-10': 6,
        '2025-11': 4,
        '2025-12': 1,
        '2026-01': 0,
        '2026-02': 1,
      },
    });
    expect(computeStrategy(state)?.patterns.trajectoryDirection).toBe('declining');
  });
});

describe('shouldComputeStrategy — cadence gate (#1270 Step 2)', () => {
  const NOW = '2026-05-09T12:00:00.000Z';
  const NOW_MS = Date.parse(NOW);
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  function isoDaysAgo(days: number): string {
    return new Date(NOW_MS - days * ONE_DAY_MS).toISOString();
  }

  it('returns false below the merge floor regardless of timestamps', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: STRATEGY_MIN_PRS - 1 }, (_, i) =>
        makeMergedPR('a/r', i + 1, { mergedAt: isoDaysAgo(60) }),
      ),
    });
    expect(shouldComputeStrategy(state, NOW)).toBe(false);
  });

  it('returns true on the first run (lastStrategyAt absent) above the merge floor', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: STRATEGY_MIN_PRS }, (_, i) =>
        makeMergedPR('a/r', i + 1, { mergedAt: isoDaysAgo(60) }),
      ),
    });
    expect(shouldComputeStrategy(state, NOW)).toBe(true);
  });

  it('returns false when last snapshot is recent and merge delta is below the threshold', () => {
    // 5 days ago, with 2 PRs merged since — both gates should be silent.
    const state = makeState({
      mergedPRs: [
        ...Array.from({ length: STRATEGY_MIN_PRS }, (_, i) => makeMergedPR('a/r', i + 1, { mergedAt: isoDaysAgo(60) })),
        makeMergedPR('a/r', 99, { mergedAt: isoDaysAgo(2) }),
        makeMergedPR('a/r', 100, { mergedAt: isoDaysAgo(1) }),
      ],
      lastStrategyAt: isoDaysAgo(5),
    });
    expect(shouldComputeStrategy(state, NOW)).toBe(false);
  });

  it(`returns true when ${STRATEGY_CADENCE_DAYS}+ days have elapsed since the last snapshot`, () => {
    const state = makeState({
      mergedPRs: Array.from({ length: STRATEGY_MIN_PRS }, (_, i) =>
        makeMergedPR('a/r', i + 1, { mergedAt: isoDaysAgo(120) }),
      ),
      lastStrategyAt: isoDaysAgo(STRATEGY_CADENCE_DAYS + 1),
    });
    expect(shouldComputeStrategy(state, NOW)).toBe(true);
  });

  it(`returns true when ${STRATEGY_CADENCE_MERGED_DELTA}+ PRs merged since the last snapshot`, () => {
    const state = makeState({
      mergedPRs: [
        ...Array.from({ length: STRATEGY_MIN_PRS }, (_, i) => makeMergedPR('a/r', i + 1, { mergedAt: isoDaysAgo(60) })),
        ...Array.from({ length: STRATEGY_CADENCE_MERGED_DELTA }, (_, i) =>
          makeMergedPR('a/r', 100 + i, { mergedAt: isoDaysAgo(1) }),
        ),
      ],
      lastStrategyAt: isoDaysAgo(3),
    });
    expect(shouldComputeStrategy(state, NOW)).toBe(true);
  });

  it('does not double-count PRs merged before the last snapshot', () => {
    // 6 PRs merged 60 days ago, snapshot taken 10 days ago, no PRs since.
    const state = makeState({
      mergedPRs: Array.from({ length: STRATEGY_MIN_PRS + 6 }, (_, i) =>
        makeMergedPR('a/r', i + 1, { mergedAt: isoDaysAgo(60) }),
      ),
      lastStrategyAt: isoDaysAgo(10),
    });
    expect(shouldComputeStrategy(state, NOW)).toBe(false);
  });

  it('fails open and returns true when timestamps are unparseable rather than silently never re-firing', () => {
    const state = makeState({
      mergedPRs: Array.from({ length: STRATEGY_MIN_PRS }, (_, i) => makeMergedPR('a/r', i + 1)),
      lastStrategyAt: 'not-an-iso-string',
    });
    expect(shouldComputeStrategy(state, NOW)).toBe(true);
  });
});
