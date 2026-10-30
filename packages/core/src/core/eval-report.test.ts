import { describe, it, expect } from 'vitest';
import { computeEvalReport, formatEvalMarkdown } from './eval-report.js';
import { makeAgentState, makeFetchedPR } from './test-utils.js';
import type { AgentState, PickSnapshot } from './types.js';

const pick = (grade: number, source: PickSnapshot['source'] = 'vet'): PickSnapshot => ({
  issueUrl: 'https://github.com/o/r/issues/1',
  grade,
  recommendation: 'approve',
  source,
  capturedAt: '2026-01-01T00:00:00Z',
});

const merged = (n: number, extra = {}) => ({
  url: `https://github.com/o/r/pull/${n}`,
  title: 't',
  mergedAt: '2026-09-10T00:00:00Z',
  openedAt: '2026-09-09T00:00:00Z',
  ...extra,
});
const closed = (n: number, extra = {}) => ({
  url: `https://github.com/o/r/pull/${n}`,
  title: 't',
  closedAt: '2026-10-05T00:00:00Z',
  ...extra,
});

function state(overrides: Partial<AgentState>): AgentState {
  return makeAgentState({
    repoScores: {
      'o/r': {
        repo: 'o/r',
        score: 5,
        mergedPRCount: 0,
        closedWithoutMergeCount: 0,
        avgResponseDays: null,
        lastEvaluatedAt: '2026-01-01T00:00:00Z',
        signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        stargazersCount: 5000,
      },
    },
    ...overrides,
  });
}

describe('computeEvalReport (#1825)', () => {
  it('counts dormant PRs against the merge rate and computes medians', () => {
    const report = computeEvalReport(
      state({
        mergedPRs: [merged(1), merged(2, { openedAt: '2026-09-07T00:00:00Z' })],
        closedPRs: [closed(3, { closeReason: 'rejected' })],
        lastDigest: {
          openPRs: [makeFetchedPR({ url: 'https://github.com/o/r/pull/4', repo: 'o/r', stalenessTier: 'dormant' })],
        } as AgentState['lastDigest'],
      }),
    );
    expect(report.totals).toMatchObject({ n: 4, merged: 2, closed: 1, dormant: 1, mergeRate: 0.5 });
    expect(report.totals.medianHoursToMerge).toBe(48);
    expect(report.headlines.mergeRate1kStars.n).toBe(4);
    expect(report.headlines.approachClosuresByMonth).toEqual({ '2026-10': 1 });
    expect(report.closeReasons).toEqual({ rejected: 1 });
  });

  it('computes the calibration gap from vet grades only, once both sides have enough outcomes', () => {
    const highClosed = Array.from({ length: 5 }, (_, i) => closed(10 + i, { pick: pick(8) }));
    const lowMerged = Array.from({ length: 4 }, (_, i) => merged(20 + i, { pick: pick(4) }));
    const listPicks = Array.from({ length: 5 }, (_, i) => merged(30 + i, { pick: pick(9, 'list') }));

    const thin = computeEvalReport(state({ mergedPRs: [...lowMerged, ...listPicks], closedPRs: highClosed }));
    expect(thin.headlines.calibration).toEqual({ gap: null, highN: 5, lowN: 4 });
    expect(thin.calibrationPairs).toBe(9);
    expect(thin.flags).toEqual(['vet 7-8: high-grade picks merge at 0% (n=5)']);

    const full = computeEvalReport(
      state({ mergedPRs: [...lowMerged, merged(40, { pick: pick(5) }), ...listPicks], closedPRs: highClosed }),
    );
    expect(full.headlines.calibration).toEqual({ gap: -1, highN: 5, lowN: 5 });
    expect(full.byGrade.map((b) => b.key)).toEqual(['vet 7-8', 'vet 5-6', 'vet 1-4', 'list 9-10']);
    expect(full.flags).toContain(
      'vet grades do not separate outcomes: grade>=7 merges at 0% (n=5), grade<=5 at 100% (n=5)',
    );
  });

  it('reports quality shares only over PRs with recorded review state', () => {
    const report = computeEvalReport(
      state({
        mergedPRs: [merged(1, { lastReviewDecision: 'approved', lastCiStatus: 'passing' }), merged(2)],
        closedPRs: [closed(3, { lastReviewDecision: 'changes_requested', lastCiStatus: 'failing' })],
      }),
    );
    expect(report.quality).toEqual({ withReviewState: 2, changesRequestedShare: 0.5, ciFailingShare: 0.5 });
  });

  it('renders an empty ledger without throwing', () => {
    const md = formatEvalMarkdown(computeEvalReport(state({}), new Date('2026-10-29T00:00:00Z')));
    expect(md).toContain('# oss-autopilot eval (2026-10-29)');
    expect(md).toContain(
      'Calibration gap, vet grades (grade>=7 minus grade<=5 merge rate): **n/a** (n=0 vs 0; needs 5 each)',
    );
    expect(md).not.toContain('## Flags');
  });
});
