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

  it('computes the calibration gap and flags high grades that do not merge', () => {
    const highClosed = Array.from({ length: 5 }, (_, i) => closed(10 + i, { pick: pick(8) }));
    const report = computeEvalReport(
      state({
        mergedPRs: [merged(1, { pick: pick(4) }), merged(2, { pick: pick(9, 'list') })],
        closedPRs: highClosed,
      }),
    );
    // grade>=7: 1 merged of 6; grade<=5: 1 merged of 1.
    expect(report.headlines.calibrationGap).toBe(-0.83);
    expect(report.calibrationPairs).toBe(7);
    expect(report.byGrade.map((b) => b.key)).toEqual(['vet 7-8', 'vet 1-4', 'list 9-10']);
    expect(report.flags).toEqual([
      'vet 7-8: high-grade picks merge at 0% (n=5)',
      'grades do not separate outcomes: grade>=7 merges at 0.17, grade<=5 at 1',
    ]);
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
    expect(md).toContain('Calibration gap (grade>=7 minus grade<=5 merge rate): **n/a**');
    expect(md).not.toContain('## Flags');
  });
});
