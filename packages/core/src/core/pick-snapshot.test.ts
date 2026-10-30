import { describe, it, expect, vi } from 'vitest';
import type { VetOutput } from '../formatters/json.js';
import { pickSnapshotFromVet, persistPickSnapshots } from './pick-snapshot.js';
import type { StateManager } from './state.js';

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
