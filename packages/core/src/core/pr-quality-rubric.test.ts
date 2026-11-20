/**
 * Tests for the canonical PR quality rubric (#1252).
 *
 * Pins the structural invariants of the rubric so an edit that
 * breaks the contract between skill and agent surfaces at CI time.
 */

import { describe, it, expect } from 'vitest';
import {
  PR_QUALITY_RUBRIC,
  totalScoredWeight,
  FOCUSED_CHANGES_THRESHOLDS,
  TITLE_LENGTH_BUDGET,
} from './pr-quality-rubric.js';

const getRubricCheck = (id: string) => PR_QUALITY_RUBRIC.find((c) => c.id === id);

describe('PR_QUALITY_RUBRIC', () => {
  it('scored weights total exactly 100', () => {
    expect(totalScoredWeight()).toBe(100);
  });

  it('every check id is unique', () => {
    const ids = PR_QUALITY_RUBRIC.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every required check has a weight', () => {
    const required = PR_QUALITY_RUBRIC.filter((c) => c.tier === 'required');
    for (const c of required) {
      // "Minimal Diff" is required for the skill but not part of the
      // automated score — that's an explicit null weight, not a bug.
      if (c.id === 'minimalDiff') continue;
      expect(c.weight, `required check "${c.id}" should have a weight`).not.toBeNull();
    }
  });

  it('optional and conditional checks may have null weight', () => {
    // Just exercise the path so the weight field can be null without
    // tripping the previous assertion.
    const docs = getRubricCheck('docs');
    expect(docs?.weight).toBeNull();
  });

  it('lookup returns the canonical entry', () => {
    expect(getRubricCheck('issueReference')?.label).toBe('Issue Reference');
    expect(getRubricCheck('focusedChanges')?.weight).toBe(20);
  });

  it('focused-changes description embeds the canonical thresholds', () => {
    const focused = getRubricCheck('focusedChanges');
    expect(focused?.description).toContain(`< ${FOCUSED_CHANGES_THRESHOLDS.passFiles} files`);
    expect(focused?.description).toContain(`< ${FOCUSED_CHANGES_THRESHOLDS.passLines} lines`);
  });

  it('TITLE_LENGTH_BUDGET is positive', () => {
    expect(TITLE_LENGTH_BUDGET).toBeGreaterThan(0);
  });
});
