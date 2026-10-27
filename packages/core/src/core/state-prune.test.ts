import { describe, it, expect } from 'vitest';
import {
  pruneStateForPersist,
  serializeState,
  SEARCH_SEEN_RETENTION_DAYS,
  SCOUT_ROTATION_TTL_DAYS,
  REPO_SCORE_RETENTION_DAYS,
} from './state-prune.js';
import { AgentStateSchema } from './state-schema.js';
import { makeAgentState, makeDailyDigest, makeFetchedPR, makeRepoScore } from './test-utils.js';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => {
  const t = new Date(NOW - d * DAY_MS);
  return t.toISOString();
};
const repoSet = (state: Parameters<typeof pruneStateForPersist>[0]) =>
  new Set(Object.keys(pruneStateForPersist(state, NOW).repoScores));

describe('pruneStateForPersist: searchSeen', () => {
  it('keeps the window scout rotation still reads', () => {
    expect(SEARCH_SEEN_RETENTION_DAYS).toBeGreaterThan(SCOUT_ROTATION_TTL_DAYS);
  });

  it('drops entries older than the retention window and keeps the rest', () => {
    const state = makeAgentState({
      searchSeen: [
        { url: 'https://github.com/o/r/issues/1', lastSeenAt: daysAgo(SCOUT_ROTATION_TTL_DAYS) },
        { url: 'https://github.com/o/r/issues/2', lastSeenAt: daysAgo(SEARCH_SEEN_RETENTION_DAYS - 0.5) },
        { url: 'https://github.com/o/r/issues/3', lastSeenAt: daysAgo(SEARCH_SEEN_RETENTION_DAYS + 1) },
        { url: 'https://github.com/o/r/issues/4', lastSeenAt: 'not-a-date' },
      ],
    });
    const pruned = pruneStateForPersist(state, NOW);
    expect(pruned.searchSeen.map((e) => e.url)).toEqual([
      'https://github.com/o/r/issues/1',
      'https://github.com/o/r/issues/2',
    ]);
    expect(state.searchSeen).toHaveLength(4); // input not mutated
  });
});

describe('pruneStateForPersist: repoScores', () => {
  const stale = daysAgo(REPO_SCORE_RETENTION_DAYS + 1);

  it('drops stale scores for repos with no history and nothing tracked', () => {
    const state = makeAgentState({
      repoScores: {
        'a/stale': makeRepoScore({ repo: 'a/stale', lastEvaluatedAt: stale }),
        'a/fresh': makeRepoScore({ repo: 'a/fresh', lastEvaluatedAt: daysAgo(1) }),
        'a/baddate': makeRepoScore({ repo: 'a/baddate', lastEvaluatedAt: 'garbage' }),
      },
    });
    expect(repoSet(state)).toEqual(new Set(['a/baddate', 'a/fresh']));
    expect(Object.keys(state.repoScores)).toHaveLength(3);
  });

  it('never drops repos with merge/close history, however old', () => {
    const state = makeAgentState({
      repoScores: {
        'a/merged': makeRepoScore({ repo: 'a/merged', mergedPRCount: 1, lastEvaluatedAt: stale }),
        'a/closed': makeRepoScore({ repo: 'a/closed', closedWithoutMergeCount: 1, lastEvaluatedAt: stale }),
      },
    });
    expect(repoSet(state)).toEqual(new Set(['a/closed', 'a/merged']));
  });

  it('never drops repos with open, shelved, ledgered PRs or active issues', () => {
    const repos = ['o/open', 'o/shelved', 'o/shelvedurl', 'o/merged', 'o/closed', 'o/issue'];
    const state = makeAgentState({
      repoScores: Object.fromEntries(repos.map((r) => [r, makeRepoScore({ repo: r, lastEvaluatedAt: stale })])),
      lastDigest: makeDailyDigest({
        openPRs: [makeFetchedPR({ repo: 'o/open' })],
        shelvedPRs: [
          {
            number: 1,
            url: 'https://github.com/o/shelved/pull/1',
            title: 't',
            repo: 'o/shelved',
            daysSinceActivity: 1,
            status: 'waiting_on_maintainer',
          },
        ],
      }),
      mergedPRs: [{ url: 'https://github.com/o/merged/pull/2', title: 't', mergedAt: stale }],
      closedPRs: [{ url: 'https://github.com/o/closed/pull/3', title: 't', closedAt: stale }],
      activeIssues: [
        {
          id: 1,
          url: 'https://github.com/o/issue/issues/4',
          repo: 'o/issue',
          number: 4,
          title: 't',
          status: 'claimed',
          labels: [],
          createdAt: stale,
          updatedAt: stale,
          vetted: false,
        } as never,
      ],
      config: { shelvedPRUrls: ['https://github.com/o/shelvedurl/pull/5'] },
    });
    expect(repoSet(state)).toEqual(new Set(repos));
  });
});

describe('lastDigest: each PR persisted once', () => {
  const needs = makeFetchedPR({ repo: 'o/a', number: 1, status: 'needs_addressing' });
  const waiting = makeFetchedPR({ repo: 'o/b', number: 2, status: 'waiting_on_maintainer' });
  const digest = makeDailyDigest({
    openPRs: [needs, waiting],
    needsAddressingPRs: [needs],
    waitingOnMaintainerPRs: [waiting],
  });

  it('serializes the status partitions empty', () => {
    const raw = JSON.parse(serializeState(makeAgentState({ lastDigest: digest })));
    expect(raw.lastDigest.openPRs).toHaveLength(2);
    expect(raw.lastDigest.needsAddressingPRs).toEqual([]);
    expect(raw.lastDigest.waitingOnMaintainerPRs).toEqual([]);
  });

  it('re-derives the partitions from openPRs on load (round trip is lossless)', () => {
    const persisted: unknown = JSON.parse(serializeState(makeAgentState({ lastDigest: digest })));
    const loaded = AgentStateSchema.parse(persisted);
    expect(loaded.lastDigest?.needsAddressingPRs.map((p) => p.url)).toEqual([needs.url]);
    expect(loaded.lastDigest?.waitingOnMaintainerPRs.map((p) => p.url)).toEqual([waiting.url]);
  });

  it('still loads a digest written by an older version with full partitions', () => {
    const legacy = structuredClone(makeAgentState({ lastDigest: digest }));
    const loaded = AgentStateSchema.parse(legacy);
    expect(loaded.lastDigest?.needsAddressingPRs.map((p) => p.url)).toEqual([needs.url]);
    expect(loaded.lastDigest?.waitingOnMaintainerPRs.map((p) => p.url)).toEqual([waiting.url]);
  });

  it('does not mutate the in-memory digest', () => {
    const state = makeAgentState({ lastDigest: digest });
    serializeState(state);
    expect(state.lastDigest?.needsAddressingPRs).toHaveLength(1);
  });
});
