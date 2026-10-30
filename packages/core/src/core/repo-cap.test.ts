import { describe, it, expect } from 'vitest';
import { AgentConfigSchema, AgentStateSchema, type AgentState } from './state-schema.js';
import { getRepoCapStatus, openPRCountsByRepo, repoCapField, reposAtCap } from './repo-cap.js';

function makeState(opts: {
  openRepos?: string[];
  merged?: Record<string, number>;
  ledgerMergedUrls?: string[];
  config?: Record<string, unknown>;
}): AgentState {
  return AgentStateSchema.parse({
    version: 4,
    config: opts.config ?? {},
    repoScores: Object.fromEntries(
      Object.entries(opts.merged ?? {}).map(([repo, mergedPRCount]) => [
        repo,
        {
          repo,
          mergedPRCount,
          score: 5,
          closedWithoutMergeCount: 0,
          avgResponseDays: null,
          lastEvaluatedAt: '',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
      ]),
    ),
    mergedPRs: (opts.ledgerMergedUrls ?? []).map((url) => ({ url, title: 't', mergedAt: '2026-01-01T00:00:00Z' })),
    lastDigest: {
      generatedAt: '2026-10-30T00:00:00Z',
      openPRs: (opts.openRepos ?? []).map((repo, i) => ({
        repo,
        url: `https://github.com/${repo}/pull/${i + 1}`,
        number: i + 1,
        status: 'waiting_on_maintainer',
      })),
      needsAddressingPRs: [],
      waitingOnMaintainerPRs: [],
      recentlyClosedPRs: [],
      recentlyMergedPRs: [],
      shelvedPRs: [],
      autoUnshelvedPRs: [],
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
    },
  });
}

describe('per-repo cap config', () => {
  it('defaults to the cold cap only: 1 for a cold repo, warm cap off', () => {
    const config = AgentConfigSchema.parse({});
    expect(config.maxOpenPRsPerRepo).toBe(0);
    expect(config.maxOpenPRsColdRepo).toBe(1);
  });

  it('rejects negative caps', () => {
    expect(() => AgentConfigSchema.parse({ maxOpenPRsPerRepo: -1 })).toThrow();
    expect(() => AgentConfigSchema.parse({ maxOpenPRsColdRepo: -1 })).toThrow();
  });
});

describe('getRepoCapStatus', () => {
  it('applies the cold cap while no PR in the repo has merged', () => {
    const s = getRepoCapStatus(makeState({ openRepos: ['a/b'] }), 'a/b');
    expect(s).toMatchObject({
      openPRCount: 1,
      countSource: 'digest',
      mergedPRCount: 0,
      cold: true,
      cap: 1,
      atCap: true,
      excluded: false,
    });
    expect(s.reason).toContain('none of your PRs have merged');
  });

  it('never caps a warm repo by default', () => {
    const state = makeState({ openRepos: ['a/b', 'a/b', 'a/b', 'a/b', 'a/b'], merged: { 'a/b': 3 } });
    expect(getRepoCapStatus(state, 'a/b')).toMatchObject({ cold: false, cap: 0, atCap: false });
    expect(getRepoCapStatus(state, 'a/b').reason).toBeUndefined();
  });

  it('applies maxOpenPRsPerRepo to warm repos when set', () => {
    const config = { maxOpenPRsPerRepo: 2 };
    const one = makeState({ openRepos: ['a/b'], merged: { 'a/b': 3 }, config });
    expect(getRepoCapStatus(one, 'a/b')).toMatchObject({ cap: 2, atCap: false });
    const two = makeState({ openRepos: ['a/b', 'a/b'], merged: { 'a/b': 3 }, config });
    expect(getRepoCapStatus(two, 'a/b')).toMatchObject({ cap: 2, atCap: true });
  });

  it('uses a live count when given one', () => {
    const s = getRepoCapStatus(makeState({}), 'a/b', { openPRCount: 1 });
    expect(s).toMatchObject({ openPRCount: 1, countSource: 'github', atCap: true });
  });

  it('counts merges from the ledger when repoScores has none', () => {
    const state = makeState({ openRepos: ['a/b'], ledgerMergedUrls: ['https://github.com/A/B/pull/9'] });
    expect(getRepoCapStatus(state, 'a/b')).toMatchObject({ mergedPRCount: 1, cold: false, atCap: false });
  });

  it('matches repos case-insensitively', () => {
    expect(getRepoCapStatus(makeState({ openRepos: ['Owner/Repo'] }), 'owner/repo').openPRCount).toBe(1);
  });

  it('0 disables the cold cap', () => {
    const cold0 = makeState({ openRepos: ['a/b', 'a/b', 'a/b'], config: { maxOpenPRsColdRepo: 0 } });
    expect(getRepoCapStatus(cold0, 'a/b')).toMatchObject({ cap: 0, atCap: false });
  });

  it('the tighter cap wins when both apply', () => {
    const state = makeState({ openRepos: ['a/b', 'a/b'], config: { maxOpenPRsPerRepo: 2, maxOpenPRsColdRepo: 5 } });
    expect(getRepoCapStatus(state, 'a/b')).toMatchObject({ cap: 2, atCap: true });
  });

  it('flags excludeRepos even under the cap', () => {
    const s = getRepoCapStatus(makeState({ config: { excludeRepos: ['A/B'] } }), 'a/b');
    expect(s).toMatchObject({ atCap: false, excluded: true });
    expect(s.reason).toContain('excludeRepos');
  });

  it('repoCapField is empty when the repo is fine', () => {
    expect(repoCapField(makeState({}), 'a/b')).toEqual({});
    expect(repoCapField(makeState({ openRepos: ['a/b'] }), 'a/b').repoCap?.atCap).toBe(true);
  });

  it('openPRCountsByRepo is empty without a digest', () => {
    expect(openPRCountsByRepo(AgentStateSchema.parse({ version: 4 })).size).toBe(0);
  });
});

describe('reposAtCap', () => {
  it('lists only capped repos, once each, with the first spelling seen', () => {
    const state = makeState({
      openRepos: ['Cold/Repo', 'cold/repo', 'warm/repo', 'warm/repo'],
      merged: { 'warm/repo': 4 },
    });
    expect(reposAtCap(state)).toEqual(['Cold/Repo']);
  });

  it('is empty without a digest', () => {
    expect(reposAtCap(AgentStateSchema.parse({ version: 4 }))).toEqual([]);
  });
});
