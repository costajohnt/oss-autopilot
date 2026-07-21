import { describe, it, expect } from 'vitest';
import { computeSuccessGrade, deriveGradeSignals, reconcileRecommendation } from './issue-grading.js';

// Success score is on a 1-10 scale (#249 follow-up). The three signal bands
// map to 10 / 7 / 4 / 1 (best→worst); the overall score is the worst of the
// three and drops one band if any signal is unknown.
describe('computeSuccessGrade', () => {
  describe('responsiveness signal', () => {
    it('scores 10 when maintainers respond in under 3 days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 2,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(10);
    });

    it('scores 7 for 3–14 day responsiveness', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 10,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(7);
    });

    it('scores 4 for 14–60 day responsiveness', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 40,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(4);
    });

    it('scores 1 when responsiveness exceeds 60 days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 90,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(1);
    });

    it('scores exactly 60 days as 4 (boundary inclusive)', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 60,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(4);
    });

    it('treats NaN, negative, or infinite response days as unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: NaN,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      // Known signals score 10; one unknown drops one band → 7.
      expect(result.score).toBe(7);
      expect(result.reason).toMatch(/unknown/i);
    });
  });

  describe('merge-rate signal', () => {
    it('scores 10 when merge rate exceeds 70%', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.85,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(10);
    });

    it('scores 7 for 40–70% merge rate', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.55,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(7);
    });

    it('scores 4 for 10–40% merge rate', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.2,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(4);
    });

    it('scores 1 below 10% merge rate', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.05,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(1);
    });
  });

  describe('activity signal', () => {
    it('scores 10 for commits within 7 days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.9,
        daysSinceLastCommit: 3,
      });
      expect(result.score).toBe(10);
    });

    it('scores 7 for commits 7–30 days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.9,
        daysSinceLastCommit: 20,
      });
      expect(result.score).toBe(7);
    });

    it('scores 4 for commits 30–90 days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.9,
        daysSinceLastCommit: 60,
      });
      expect(result.score).toBe(4);
    });

    it('scores 1 for no commits in 90+ days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.9,
        daysSinceLastCommit: 120,
      });
      expect(result.score).toBe(1);
    });
  });

  describe('worst-of-three aggregation', () => {
    it('lets a single low signal dominate', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.05,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(1);
    });

    it('picks worst across mixed scores', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 10,
        mergeRate: 0.2,
        daysSinceLastCommit: 3,
      });
      expect(result.score).toBe(4);
    });
  });

  describe('unknown-degrades rule', () => {
    it('drops 10 to 7 when one signal is unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: null,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(7);
    });

    it('drops 4 to 1 when one signal is unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 40,
        mergeRate: null,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(1);
    });

    it('leaves 1 at 1 when a signal is unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 90,
        mergeRate: null,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(1);
    });

    it('treats multiple unknowns the same as a single unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: null,
        mergeRate: null,
        daysSinceLastCommit: 1,
      });
      // Known signal scores 10, drop one band for unknowns → 7
      expect(result.score).toBe(7);
    });

    it('scores 1 when every signal is unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: null,
        mergeRate: null,
        daysSinceLastCommit: null,
      });
      expect(result.score).toBe(1);
      expect(result.reason).toMatch(/unknown/i);
    });
  });

  describe('deriveGradeSignals', () => {
    it('maps projectHealth fields straight through', () => {
      const signals = deriveGradeSignals({
        projectHealth: { avgIssueResponseDays: 5, daysSinceLastCommit: 2 },
        repoScore: null,
      });
      expect(signals.avgResponseDays).toBe(5);
      expect(signals.daysSinceLastCommit).toBe(2);
    });

    it('computes merge rate from repoScore counts', () => {
      const signals = deriveGradeSignals({
        projectHealth: { avgIssueResponseDays: 1, daysSinceLastCommit: 1 },
        repoScore: { mergedPRCount: 17, closedWithoutMergeCount: 3 },
      });
      expect(signals.mergeRate).toBeCloseTo(17 / 20);
    });

    it('returns null mergeRate when no repoScore is available', () => {
      const signals = deriveGradeSignals({
        projectHealth: { avgIssueResponseDays: 1, daysSinceLastCommit: 1 },
        repoScore: null,
      });
      expect(signals.mergeRate).toBeNull();
    });

    it('returns null mergeRate when repoScore has no PR history', () => {
      const signals = deriveGradeSignals({
        projectHealth: { avgIssueResponseDays: 1, daysSinceLastCommit: 1 },
        repoScore: { mergedPRCount: 0, closedWithoutMergeCount: 0 },
      });
      expect(signals.mergeRate).toBeNull();
    });

    it('prefers repoScore.avgResponseDays over scout placeholder', () => {
      const signals = deriveGradeSignals({
        // Scout always returns 0 as a placeholder — see oss-scout repo-health.
        projectHealth: { avgIssueResponseDays: 0, daysSinceLastCommit: 1 },
        repoScore: { mergedPRCount: 5, closedWithoutMergeCount: 0, avgResponseDays: 12 },
      });
      expect(signals.avgResponseDays).toBe(12);
    });

    it('returns null avgResponseDays when neither source has real data', () => {
      const signals = deriveGradeSignals({
        projectHealth: { avgIssueResponseDays: 0, daysSinceLastCommit: 1 },
        repoScore: { mergedPRCount: 5, closedWithoutMergeCount: 0, avgResponseDays: null },
      });
      expect(signals.avgResponseDays).toBeNull();
    });

    it('returns null signals when checkFailed is set', () => {
      const signals = deriveGradeSignals({
        projectHealth: { avgIssueResponseDays: 0, daysSinceLastCommit: 999, checkFailed: true },
        repoScore: null,
      });
      expect(signals.avgResponseDays).toBeNull();
      expect(signals.daysSinceLastCommit).toBeNull();
    });

    it('treats out-of-range mergeRate as null', () => {
      const signals = deriveGradeSignals({
        projectHealth: { avgIssueResponseDays: 1, daysSinceLastCommit: 1 },
        repoScore: { mergedPRCount: -3, closedWithoutMergeCount: 10 },
      });
      expect(signals.mergeRate).toBeNull();
    });

    // #248: prefer scout's repo-intrinsic merge rate so a healthy repo we've
    // never contributed to grades on its own merits instead of collapsing to F.
    it('prefers repo-intrinsic recentMergeRate over relationship counts', () => {
      const signals = deriveGradeSignals({
        projectHealth: {
          avgIssueResponseDays: 1,
          daysSinceLastCommit: 1,
          recentMergeRate: 0.85,
        },
        // Relationship says 0.2, but the repo-intrinsic rate must win.
        repoScore: { mergedPRCount: 1, closedWithoutMergeCount: 4 },
      });
      expect(signals.mergeRate).toBeCloseTo(0.85);
    });

    it('gives a new repo (no repoScore) a merge rate from recentMergeRate', () => {
      const signals = deriveGradeSignals({
        projectHealth: {
          avgIssueResponseDays: 2,
          daysSinceLastCommit: 1,
          recentMergeRate: 0.9,
        },
        repoScore: null,
      });
      // Previously null → grade collapsed to F; now a real, healthy rate.
      expect(signals.mergeRate).toBeCloseTo(0.9);
      expect(computeSuccessGrade(signals).score).toBeGreaterThan(4);
    });

    it('falls back to relationship counts when recentMergeRate is absent', () => {
      const signals = deriveGradeSignals({
        projectHealth: { avgIssueResponseDays: 1, daysSinceLastCommit: 1 },
        repoScore: { mergedPRCount: 17, closedWithoutMergeCount: 3 },
      });
      expect(signals.mergeRate).toBeCloseTo(17 / 20);
    });

    it('ignores recentMergeRate when the health check failed', () => {
      const signals = deriveGradeSignals({
        projectHealth: {
          avgIssueResponseDays: 0,
          daysSinceLastCommit: 999,
          recentMergeRate: 0.9,
          checkFailed: true,
        },
        repoScore: null,
      });
      expect(signals.mergeRate).toBeNull();
    });
  });

  describe('reconcileRecommendation (#1575 defect 2)', () => {
    it('downgrades approve to needs_review at the bottom grade band', () => {
      expect(reconcileRecommendation('approve', { score: 1, reason: 'unknown' })).toBe('needs_review');
    });

    it('keeps approve when the grade is trustworthy', () => {
      expect(reconcileRecommendation('approve', { score: 7, reason: 'merges 80%' })).toBe('approve');
    });

    it('keeps approve exactly at the keep threshold (score 4)', () => {
      expect(reconcileRecommendation('approve', { score: 4, reason: 'merges 30%' })).toBe('approve');
    });

    it('leaves non-approve recommendations unchanged', () => {
      const worst = { score: 1, reason: 'unknown' };
      expect(reconcileRecommendation('skip', worst)).toBe('skip');
      expect(reconcileRecommendation('needs_review', worst)).toBe('needs_review');
    });
  });

  describe('reason string', () => {
    it('mentions the driving signal for a low score', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 90,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(1);
      expect(result.reason).toMatch(/respons/i);
    });

    it('mentions the driving signal for a mid score', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 40,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(4);
      expect(result.reason).toMatch(/40.*day|respons/i);
    });

    it('mentions that data is missing when degraded by unknowns', () => {
      const result = computeSuccessGrade({
        avgResponseDays: null,
        mergeRate: null,
        daysSinceLastCommit: 1,
      });
      expect(result.score).toBe(7);
      expect(result.reason).toMatch(/unknown|missing/i);
    });
  });
});
