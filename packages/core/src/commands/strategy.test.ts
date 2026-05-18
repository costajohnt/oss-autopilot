/**
 * Tests for the `strategy` command (#1243 step 4).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runStrategy } from './strategy.js';
import { STRATEGY_MIN_PRS } from '../core/strategy.js';

const mockGetStateManager = vi.mocked(getStateManager);

function makeMergedPR(repo: string, n: number, title = 'feat: ship something') {
  return {
    url: `https://github.com/${repo}/pull/${n}`,
    title,
    mergedAt: '2026-05-01T00:00:00Z',
  };
}

function buildState(merged: ReturnType<typeof makeMergedPR>[], extras: Record<string, unknown> = {}) {
  return {
    mergedPRs: merged,
    closedPRs: [],
    repoScores: {},
    lastDigest: null,
    ...extras,
  };
}

function setMockState(state: ReturnType<typeof buildState>) {
  mockGetStateManager.mockReturnValue({
    getState: vi.fn().mockReturnValue(state),
  } as never);
}

describe('runStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null with an explanatory message when below the merged-PR floor', async () => {
    // Half the floor — gate should hold.
    const merged = Array.from({ length: Math.floor(STRATEGY_MIN_PRS / 2) }, (_, i) =>
      makeMergedPR('owner/repo', i + 1),
    );
    setMockState(buildState(merged));

    const result = await runStrategy();

    expect(result.strategy).toBeNull();
    expect(result.message).toBeDefined();
    expect(result.message).toContain(String(STRATEGY_MIN_PRS));
    expect(result.message).toContain(String(merged.length));
  });

  it('returns null with message=0 when nothing is tracked yet', async () => {
    setMockState(buildState([]));

    const result = await runStrategy();

    expect(result.strategy).toBeNull();
    expect(result.message).toContain('currently tracking 0');
  });

  it('returns the typed strategy result when the floor is met', async () => {
    const merged = Array.from({ length: STRATEGY_MIN_PRS + 2 }, (_, i) => makeMergedPR('owner/repo', i + 1));
    setMockState(buildState(merged));

    const result = await runStrategy();

    expect(result.strategy).not.toBeNull();
    expect(result.message).toBeUndefined();
    expect(result.strategy?.profile.totalPRs).toBe(merged.length);
    expect(result.strategy?.profile.mergedCount).toBe(merged.length);
    expect(result.strategy?.profile.style).toMatch(/^(maintainer|explorer|specialist|generalist)$/);
  });
});
