import { describe, it, expect } from 'vitest';
import { computeSuccessGrade, deriveGradeSignals } from './issue-grading.js';

describe('computeSuccessGrade', () => {
  describe('responsiveness signal', () => {
    it('grades A when maintainers respond in under 3 days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 2,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('A');
    });

    it('grades B for 3–14 day responsiveness', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 10,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('B');
    });

    it('grades C for 14–60 day responsiveness', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 40,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('C');
    });

    it('grades F when responsiveness exceeds 60 days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 90,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('F');
    });

    it('grades exactly 60 days as C (boundary inclusive)', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 60,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('C');
    });

    it('treats NaN, negative, or infinite response days as unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: NaN,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('B');
      expect(result.reason).toMatch(/unknown/i);
    });
  });

  describe('merge-rate signal', () => {
    it('grades A when merge rate exceeds 70%', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.85,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('A');
    });

    it('grades B for 40–70% merge rate', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.55,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('B');
    });

    it('grades C for 10–40% merge rate', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.2,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('C');
    });

    it('grades F below 10% merge rate', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.05,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('F');
    });
  });

  describe('activity signal', () => {
    it('grades A for commits within 7 days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.9,
        daysSinceLastCommit: 3,
      });
      expect(result.letter).toBe('A');
    });

    it('grades B for commits 7–30 days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.9,
        daysSinceLastCommit: 20,
      });
      expect(result.letter).toBe('B');
    });

    it('grades C for commits 30–90 days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.9,
        daysSinceLastCommit: 60,
      });
      expect(result.letter).toBe('C');
    });

    it('grades F for no commits in 90+ days', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.9,
        daysSinceLastCommit: 120,
      });
      expect(result.letter).toBe('F');
    });
  });

  describe('worst-of-three aggregation', () => {
    it('lets a single F dominate', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 1,
        mergeRate: 0.05,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('F');
    });

    it('picks worst across mixed letters', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 10,
        mergeRate: 0.2,
        daysSinceLastCommit: 3,
      });
      expect(result.letter).toBe('C');
    });
  });

  describe('unknown-degrades rule', () => {
    it('degrades A to B when one signal is unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: null,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('B');
    });

    it('degrades C to F when one signal is unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 40,
        mergeRate: null,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('F');
    });

    it('leaves F at F when a signal is unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 90,
        mergeRate: null,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('F');
    });

    it('treats multiple unknowns the same as a single unknown', () => {
      const result = computeSuccessGrade({
        avgResponseDays: null,
        mergeRate: null,
        daysSinceLastCommit: 1,
      });
      // Known signal is A, degrade once for unknowns → B
      expect(result.letter).toBe('B');
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
  });

  describe('reason string', () => {
    it('mentions the driving signal for a failing grade', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 90,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('F');
      expect(result.reason).toMatch(/respons/i);
    });

    it('mentions the driving signal for a C', () => {
      const result = computeSuccessGrade({
        avgResponseDays: 40,
        mergeRate: 0.9,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('C');
      expect(result.reason).toMatch(/40.*day|respons/i);
    });

    it('mentions that data is missing when degraded by unknowns', () => {
      const result = computeSuccessGrade({
        avgResponseDays: null,
        mergeRate: null,
        daysSinceLastCommit: 1,
      });
      expect(result.letter).toBe('B');
      expect(result.reason).toMatch(/unknown|missing/i);
    });
  });
});
