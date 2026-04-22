/**
 * Tests for maintainer-analysis.ts — action hint extraction from maintainer comments.
 */

import { describe, it, expect } from 'vitest';
import { extractMaintainerActionHints } from './maintainer-analysis.js';

describe('extractMaintainerActionHints', () => {
  it('should return changes_requested when reviewDecision is changes_requested', () => {
    const result = extractMaintainerActionHints(undefined, 'changes_requested');
    expect(result).toContain('changes_requested');
  });

  it('should return empty array when no comment and no changes_requested', () => {
    const result = extractMaintainerActionHints(undefined, 'approved');
    expect(result).toEqual([]);
  });

  it('should detect demo_requested keywords', () => {
    expect(extractMaintainerActionHints('Could you add a screenshot?', 'approved')).toContain('demo_requested');
    expect(extractMaintainerActionHints('Please add a demo', 'approved')).toContain('demo_requested');
    expect(extractMaintainerActionHints('Can you show a before/after?', 'approved')).toContain('demo_requested');
  });

  it('should detect tests_requested keywords', () => {
    expect(extractMaintainerActionHints('Please add tests for this', 'approved')).toContain('tests_requested');
    expect(extractMaintainerActionHints('Missing test coverage here', 'approved')).toContain('tests_requested');
    expect(extractMaintainerActionHints('Write test cases', 'approved')).toContain('tests_requested');
  });

  it('should detect docs_requested keywords', () => {
    expect(extractMaintainerActionHints('Update the documentation', 'approved')).toContain('docs_requested');
    expect(extractMaintainerActionHints('Add docs for the new API', 'approved')).toContain('docs_requested');
  });

  it('should detect rebase_requested keywords', () => {
    expect(extractMaintainerActionHints('Please rebase on main', 'approved')).toContain('rebase_requested');
    expect(extractMaintainerActionHints('This has a merge conflict', 'approved')).toContain('rebase_requested');
  });

  it('should detect multiple hints in one comment', () => {
    const comment = 'Please add a screenshot and also add unit tests for the changes';
    const result = extractMaintainerActionHints(comment, 'changes_requested');
    expect(result).toContain('changes_requested');
    expect(result).toContain('demo_requested');
    expect(result).toContain('tests_requested');
  });

  /**
   * False-positive resistance tests (#1057 M30).
   *
   * These comments mention hint keywords *incidentally* — as past-tense status
   * statements, unrelated context, or quoted patterns — and should NOT trigger
   * action hints. When a test here fails, that means the pattern matcher got
   * looser (or broader) and is now over-detecting. Tighten the rule, not this
   * test.
   *
   * The repo's gold-standard for this style of pinning is
   * anti-llm-policy.test.ts (13+ false-positive-resistance cases).
   */
  describe('false-positive resistance', () => {
    describe('rebase_requested should NOT fire on past-tense rebase mentions', () => {
      // These were the cases the umbrella audit called out — the old
      // `includes('rebase')` matcher fired on them; the word-boundary regex
      // tightening lets them through.
      it.each(['After rebasing this was fine', 'I already rebased onto main', 'The rebaser rewrote history here'])(
        'does not flag %p',
        (comment) => {
          const result = extractMaintainerActionHints(comment, 'approved');
          expect(result).not.toContain('rebase_requested');
        },
      );
    });

    describe('unrelated commentary on hint topics should NOT fire', () => {
      // These are cases where the substring matcher has a known limitation —
      // it fires on incidental mentions (e.g. a user saying "the screenshot
      // shows X" as context, not as a request). They are intentionally kept
      // here as `.todo` so a future tightening pass (imperative-context
      // detection) has a regression checkpoint. Removing `.todo` and making
      // them assert `not.toContain(...)` is the definition of success.
      it.todo("should not flag demo_requested on 'the screenshot shows the bug'");
      it.todo("should not flag tests_requested on 'the existing unit tests pass'");
      it.todo("should not flag docs_requested on 'the documentation confused me'");
    });

    // Reassure ourselves the tightening didn't break real requests.
    it('still catches real rebase requests after tightening', () => {
      expect(extractMaintainerActionHints('Please rebase', 'approved')).toContain('rebase_requested');
      expect(extractMaintainerActionHints('rebase on main first', 'approved')).toContain('rebase_requested');
      expect(extractMaintainerActionHints('Could you rebase this?', 'approved')).toContain('rebase_requested');
    });
  });
});
