import { describe, it, expect, vi } from 'vitest';
import type { VetOutput } from '../formatters/json.js';
import {
  pickSnapshotFromVet,
  persistPickSnapshots,
  issueAuthorRole,
  isFirstInRepo,
  fetchIssueAuthorTraits,
} from './pick-snapshot.js';
import type { StateManager } from './state.js';
import type { Octokit } from '@octokit/rest';

const vet = (overrides: Partial<VetOutput> = {}): VetOutput => ({
  issue: { repo: 'o/r', number: 1, title: 't', url: 'https://github.com/o/r/issues/1', labels: [] },
  recommendation: 'approve',
  reasonsToApprove: [],
  reasonsToSkip: [],
  projectHealth: { stargazersCount: 42 },
  vettingResult: {},
  grade: { score: 8, reason: 'r' },
  ...overrides,
});

const manager = (overrides: Partial<Record<keyof StateManager, unknown>> = {}) =>
  ({
    reloadIfChanged: vi.fn(() => false),
    recordPickSnapshots: vi.fn(),
    isGistMode: () => false,
    ...overrides,
  }) as unknown as StateManager;

describe('pickSnapshotFromVet (#1824)', () => {
  it('captures grade, recommendation and stars', () => {
    expect(pickSnapshotFromVet(vet(), 'vet')).toMatchObject({
      grade: 8,
      recommendation: 'approve',
      stargazersCount: 42,
    });
  });

  it('skips issues the user already has a PR for (post-hoc verdict)', () => {
    expect(pickSnapshotFromVet(vet({ linkedPRClassification: 'user_open' }), 'vet')).toBeUndefined();
    expect(pickSnapshotFromVet(vet({ linkedPRClassification: 'other_open' }), 'vet')).toBeDefined();
  });
});

describe('pick traits', () => {
  it('records labels, mapped author role, comments and first-in-repo', () => {
    const snap = pickSnapshotFromVet(vet({ issue: { ...vet().issue, labels: ['bug', 'help wanted'] } }), 'vet', {
      authorAssociation: 'MEMBER',
      commentCount: 3,
      firstInRepo: true,
    });
    expect(snap).toMatchObject({
      labels: ['bug', 'help wanted'],
      issueAuthorRole: 'maintainer',
      commentCount: 3,
      firstInRepo: true,
    });
  });

  it('leaves traits out when the caller has none', () => {
    const snap = pickSnapshotFromVet(vet(), 'vet')!;
    expect(snap).not.toHaveProperty('issueAuthorRole');
    expect(snap).not.toHaveProperty('firstInRepo');
    expect(snap).not.toHaveProperty('competingPRs');
  });

  it('maps author associations to roles', () => {
    expect(['OWNER', 'MEMBER', 'COLLABORATOR'].map((a) => issueAuthorRole(a))).toEqual([
      'maintainer',
      'maintainer',
      'maintainer',
    ]);
    expect(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE'].map((a) => issueAuthorRole(a))).toEqual([
      'contributor',
      'contributor',
      'contributor',
    ]);
    expect(issueAuthorRole('MANNEQUIN')).toBe('unknown');
  });

  it('competingPRs: caller count wins, else 0/1 from the linked-PR classification', () => {
    expect(
      pickSnapshotFromVet(vet({ linkedPRClassification: 'other_open' }), 'vet', { competingPRs: 3 })!.competingPRs,
    ).toBe(3);
    expect(pickSnapshotFromVet(vet({ linkedPRClassification: 'other_open' }), 'vet')!.competingPRs).toBe(1);
    expect(pickSnapshotFromVet(vet({ linkedPRClassification: 'none' }), 'vet')!.competingPRs).toBe(0);
  });
});

describe('isFirstInRepo', () => {
  const merged = [{ url: 'https://github.com/Owner/Repo/pull/9' }];
  it('is false when the repo score or the ledger shows a merge', () => {
    expect(isFirstInRepo('o/r', { mergedPRCount: 2 }, [])).toBe(false);
    expect(isFirstInRepo('owner/repo', undefined, merged)).toBe(false);
  });
  it('is true otherwise, and does not match a repo-name prefix', () => {
    expect(isFirstInRepo('owner/repo', { mergedPRCount: 0 }, undefined)).toBe(true);
    expect(isFirstInRepo('owner/rep', undefined, merged)).toBe(true);
  });
});

describe('fetchIssueAuthorTraits', () => {
  it('reads author association and comment count', async () => {
    const get = vi.fn(async () => ({ data: { author_association: 'OWNER', comments: 4 } }));
    const octokit = { issues: { get } } as unknown as Octokit;
    expect(await fetchIssueAuthorTraits(octokit, 'https://github.com/o/r/issues/7')).toEqual({
      authorAssociation: 'OWNER',
      commentCount: 4,
    });
    expect(get).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: 7 });
  });

  it('returns {} when the lookup fails', async () => {
    const octokit = {
      issues: {
        get: async () => {
          throw new Error('rate limited');
        },
      },
    } as unknown as Octokit;
    expect(await fetchIssueAuthorTraits(octokit, 'https://github.com/o/r/issues/7')).toEqual({});
  });
});

describe('persistPickSnapshots (#1824)', () => {
  it('reloads before recording so the save lands on fresh state', async () => {
    const sm = manager();
    const snap = pickSnapshotFromVet(vet(), 'vet')!;
    expect(await persistPickSnapshots(sm, [snap])).toEqual({});
    expect(sm.reloadIfChanged).toHaveBeenCalled();
    expect(sm.recordPickSnapshots).toHaveBeenCalledWith([snap]);
  });

  it('never throws: a failed save comes back as pickRecordError', async () => {
    const sm = manager({
      recordPickSnapshots: () => {
        throw new Error('state changed on disk');
      },
    });
    const result = await persistPickSnapshots(sm, [pickSnapshotFromVet(vet(), 'vet')!]);
    expect(result.pickRecordError).toMatch(/state changed on disk/);
  });

  it('does nothing for an empty batch', async () => {
    const sm = manager();
    expect(await persistPickSnapshots(sm, [])).toEqual({});
    expect(sm.recordPickSnapshots).not.toHaveBeenCalled();
  });
});
