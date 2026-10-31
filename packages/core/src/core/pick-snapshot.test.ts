import { describe, it, expect, vi } from 'vitest';
import type { VetOutput } from '../formatters/json.js';
import { pickSnapshotFromVet, persistPickSnapshots, isFirstInRepo, traitsFromVerification } from './pick-snapshot.js';
import type { StateManager } from './state.js';
import type { IssueVerification, VerifiedLinkedPR } from './issue-verification.js';

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
  it('records labels, raw author association, bot flag, comments and first-in-repo', () => {
    const snap = pickSnapshotFromVet(vet({ issue: { ...vet().issue, labels: ['bug', 'help wanted'] } }), 'vet', {
      issueAuthorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      issueAuthorIsBot: false,
      commentCount: 3,
      firstInRepo: true,
    });
    expect(snap).toMatchObject({
      labels: ['bug', 'help wanted'],
      issueAuthorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      issueAuthorIsBot: false,
      commentCount: 3,
      firstInRepo: true,
    });
  });

  it('records mentioningPRs when the caller has it', () => {
    expect(pickSnapshotFromVet(vet(), 'vet', { competingPRs: 0, mentioningPRs: 3 })).toMatchObject({
      competingPRs: 0,
      mentioningPRs: 3,
    });
  });

  it('leaves traits out when the caller has none', () => {
    const snap = pickSnapshotFromVet(vet(), 'vet')!;
    expect(snap).not.toHaveProperty('issueAuthorAssociation');
    expect(snap).not.toHaveProperty('firstInRepo');
    expect(snap).not.toHaveProperty('competingPRs');
  });

  it('competingPRs: caller count wins, else 0/1 from the linked-PR classification', () => {
    expect(
      pickSnapshotFromVet(vet({ linkedPRClassification: 'other_open' }), 'vet', { competingPRs: 3 })!.competingPRs,
    ).toBe(3);
    expect(pickSnapshotFromVet(vet({ linkedPRClassification: 'other_open' }), 'vet')!.competingPRs).toBe(1);
    expect(pickSnapshotFromVet(vet({ linkedPRClassification: 'none' }), 'vet')!.competingPRs).toBe(0);
  });
});

const pr = (overrides: Partial<VerifiedLinkedPR>): VerifiedLinkedPR => ({
  number: 2,
  url: 'https://github.com/o/r/pull/2',
  title: 't',
  state: 'open',
  isDraft: false,
  author: 'someone',
  isOwn: false,
  linkType: 'cross-referenced',
  updatedAt: null,
  ...overrides,
});

const verification = (overrides: Partial<IssueVerification>) =>
  ({
    owner: 'o',
    repo: 'r',
    linkedPRs: [pr({ linkType: 'closing' })],
    author: 'dependabot',
    authorAssociation: 'NONE',
    authorIsBot: true,
    commentCount: 4,
    ...overrides,
  }) as IssueVerification;

describe('traitsFromVerification', () => {
  it('carries author, comments and the competing count', () => {
    expect(traitsFromVerification(verification({}))).toEqual({
      issueAuthorAssociation: 'NONE',
      issueAuthorIsBot: true,
      commentCount: 4,
      competingPRs: 1,
      mentioningPRs: 0,
    });
  });

  it('counts only closing PRs as competing; open cross-references are mentions', () => {
    const linkedPRs = [
      pr({ linkType: 'closing' }), // competing
      pr({ url: 'https://github.com/fork/r/pull/9', linkType: 'closing' }), // cross-repo closing: competing
      pr({ linkType: 'closing', isDraft: true }), // draft: not competing
      pr({}), // same-repo mention
      pr({ url: 'https://github.com/other/x/pull/3', isDraft: true }), // mention, drafts included
      pr({ isOwn: true, linkType: 'closing' }),
      pr({ state: 'merged', linkType: 'closing' }),
    ];
    expect(traitsFromVerification(verification({ linkedPRs }))).toMatchObject({ competingPRs: 2, mentioningPRs: 2 });
  });

  it('leaves out traits GitHub did not return', () => {
    const traits = traitsFromVerification(verification({ authorAssociation: null, commentCount: null }));
    expect(traits).not.toHaveProperty('issueAuthorAssociation');
    expect(traits).not.toHaveProperty('commentCount');
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
