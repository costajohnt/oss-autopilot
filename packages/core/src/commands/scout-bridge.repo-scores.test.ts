/**
 * Pinning tests for the repoScores aliasing contract documented in
 * buildScoutState (#1458).
 *
 * Unlike scout-bridge.test.ts these run against the REAL @oss-scout/core,
 * because the contract under test is scout's actual mutation behavior:
 *
 * 1. recordMergedPR/recordClosedPR deduplicate by URL against the ledger that
 *    buildScoutState maps from AgentState — so daily's deleted Phase 3.5
 *    (which replayed PRs that Phase 3 had just ledgered) never changed a
 *    repo score. This is the redundancy proof behind deleting the phase.
 * 2. checkpoint() under persistence:'provided' has no store; it reports
 *    success while persisting nothing.
 * 3. For a PR NOT in the ledger, scout's updateRepoScore mutates the SHARED
 *    repoScores object in place (the alias is real and write-through), using
 *    scout's own score formula — while its ledger append replaces the array
 *    and does NOT flow back into AgentState. Anything relying on the alias
 *    for persistence inherits exactly this partial, formula-divergent write.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: vi.fn(),
    requireGitHubToken: vi.fn(() => 'test-token'),
  };
});

vi.mock('./skip-file-parser.js', () => ({
  loadSkippedIssuesDetailed: vi.fn(() => ({ issues: [] })),
}));

import { getStateManager } from '../core/index.js';
import type { RepoScore } from '../core/types.js';
import { createAutopilotScout } from './scout-bridge.js';
import { makeAgentState, makeStateManagerMock } from '../core/test-utils.js';

const mockGetStateManager = vi.mocked(getStateManager);

const REPO = 'owner/repo';
const MERGED_URL = `https://github.com/${REPO}/pull/1`;
const CLOSED_URL = `https://github.com/${REPO}/pull/2`;

function makeRepoScore(overrides: Partial<RepoScore> = {}): RepoScore {
  return {
    repo: REPO,
    score: 7,
    mergedPRCount: 2,
    closedWithoutMergeCount: 0,
    avgResponseDays: null,
    lastEvaluatedAt: '2026-06-01T00:00:00Z',
    signals: { hasActiveMaintainers: false, isResponsive: false, hasHostileComments: false },
    ...overrides,
  };
}

describe('repoScores aliasing contract (#1458)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaying daily's deleted Phase 3.5 against an already-written ledger leaves repoScores untouched (redundancy proof)", async () => {
    // State exactly as daily Phase 3 leaves it before the deleted Phase 3.5
    // ran: the recently merged/closed PRs are already in the ledger
    // (addMergedPRs/addClosedPRs), and Phase 2 has already scored the repo.
    const state = makeAgentState({
      repoScores: { [REPO]: makeRepoScore({ lastMergedAt: '2026-06-01T00:00:00Z' }) },
      mergedPRs: [{ url: MERGED_URL, title: 'Fix the thing', mergedAt: '2026-06-01T00:00:00Z' }],
      closedPRs: [{ url: CLOSED_URL, title: 'Abandoned attempt', closedAt: '2026-06-02T00:00:00Z' }],
    });
    const manager = makeStateManagerMock({ state, config: state.config });
    mockGetStateManager.mockReturnValue(manager);
    const liveState = manager.getState();

    const scout = await createAutopilotScout();
    // The alias: scout sees the very object autopilot persists.
    expect(scout.getState().repoScores).toBe(liveState.repoScores);

    const before = structuredClone(liveState.repoScores);

    // Verbatim replay of the deleted Phase 3.5 body.
    scout.recordMergedPR({ url: MERGED_URL, title: 'Fix the thing', mergedAt: '2026-06-01T00:00:00Z', repo: REPO });
    scout.recordClosedPR({
      url: CLOSED_URL,
      title: 'Abandoned attempt',
      closedAt: '2026-06-02T00:00:00Z',
      repo: REPO,
    });
    await expect(scout.checkpoint()).resolves.toBe(true);

    // Dedup-by-URL returned before any score recalculation: nothing changed,
    // not even lastEvaluatedAt. The phase had no effect to lose by deleting it.
    expect(liveState.repoScores).toEqual(before);
    // record* never even marked the state dirty, so the (storeless)
    // checkpoint() had nothing to flush — it was dead under
    // persistence:'provided' regardless.
    expect(scout.isDirty()).toBe(false);
    // Autopilot's own ledger is also untouched.
    expect(liveState.mergedPRs).toHaveLength(1);
    expect(liveState.closedPRs).toHaveLength(1);
  });

  it('for an un-ledgered PR, scout writes through the shared repoScores object with ITS OWN formula, and its ledger append does not flow back', async () => {
    const state = makeAgentState({
      repoScores: { [REPO]: makeRepoScore({ score: 5, mergedPRCount: 0 }) },
      mergedPRs: [],
      closedPRs: [],
    });
    const manager = makeStateManagerMock({ state, config: state.config });
    mockGetStateManager.mockReturnValue(manager);
    const liveState = manager.getState();

    const scout = await createAutopilotScout();
    scout.recordMergedPR({ url: MERGED_URL, title: 'Fix the thing', mergedAt: '2026-06-01T00:00:00Z', repo: REPO });

    // In-place mutation of the shared object — visible to autopilot's state.
    const written = liveState.repoScores[REPO];
    expect(written.mergedPRCount).toBe(1);
    expect(written.lastMergedAt).toBe('2026-06-01T00:00:00Z');
    // Scout's formula: base 5 + min(merged=1, 3) = 6. Autopilot's formula
    // (repo-score-manager: log2 merge bonus + recency bonus) would say 8 —
    // the divergence is why daily must never let scout own persisted scores.
    expect(written.score).toBe(6);
    // The ledger append replaced scout's array; autopilot's stayed empty.
    // The alias was never a full sync channel — only repoScores leaks through.
    expect(liveState.mergedPRs).toEqual([]);
  });
});
