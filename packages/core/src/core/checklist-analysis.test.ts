/**
 * Tests for checklist-analysis.ts — PR body checklist analysis and conditional item filtering.
 */

import { describe, it, expect } from 'vitest';
import { isConditionalChecklistItem, analyzeChecklist } from './checklist-analysis.js';

describe('isConditionalChecklistItem', () => {
  it('should detect "(if the PR is ...)" patterns', () => {
    expect(isConditionalChecklistItem('- [ ] Update docs (if the PR changes API)')).toBe(true);
  });

  it('should detect "if applicable"', () => {
    expect(isConditionalChecklistItem('- [ ] Add tests if applicable')).toBe(true);
  });

  it('should detect "if needed"', () => {
    expect(isConditionalChecklistItem('- [ ] Update changelog if needed')).toBe(true);
  });

  it('should detect "(optional)"', () => {
    expect(isConditionalChecklistItem('- [ ] Screenshot (optional)')).toBe(true);
  });

  it('should detect "N/A"', () => {
    expect(isConditionalChecklistItem('- [ ] N/A - not applicable')).toBe(true);
  });

  it('should detect "not applicable"', () => {
    expect(isConditionalChecklistItem('- [ ] Not applicable for this change')).toBe(true);
  });

  it('should return false for non-conditional items', () => {
    expect(isConditionalChecklistItem('- [ ] Add unit tests')).toBe(false);
    expect(isConditionalChecklistItem('- [ ] Update documentation')).toBe(false);
  });
});

describe('analyzeChecklist', () => {
  it('should return no incomplete for empty body', () => {
    const result = analyzeChecklist('');
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toBeUndefined();
  });

  it('should return no incomplete when no checkboxes exist', () => {
    const result = analyzeChecklist('Just some regular text\n- a bullet point');
    expect(result.hasIncompleteChecklist).toBe(false);
  });

  it('should return no incomplete when all checkboxes are checked', () => {
    const body = '- [x] Task 1\n- [x] Task 2\n- [x] Task 3';
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toEqual({ checked: 3, total: 3 });
  });

  it('should detect incomplete checklist with unchecked items', () => {
    const body = '- [x] Task 1\n- [ ] Task 2\n- [x] Task 3';
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(true);
    expect(result.checklistStats).toEqual({ checked: 2, total: 3 });
  });

  it('should exclude conditional items from incomplete count', () => {
    const body = '- [x] Required task\n- [ ] Optional screenshot (if applicable)\n- [ ] Migration (optional)';
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toEqual({ checked: 1, total: 1 });
  });

  it('should flag when non-conditional items are unchecked', () => {
    const body = '- [x] Done\n- [ ] Required task\n- [ ] Optional (if applicable)';
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(true);
  });

  it('should handle case-insensitive [X] checkbox', () => {
    const body = '- [X] Task A\n- [x] Task B';
    const result = analyzeChecklist(body);
    expect(result.hasIncompleteChecklist).toBe(false);
    expect(result.checklistStats).toEqual({ checked: 2, total: 2 });
  });

  describe('type-of-change radio groups (#1718)', () => {
    it('should not flag incomplete when at least one box is checked in a "Type of Change" section', () => {
      const body = [
        '## Type of Change',
        '- [x] Bug fix',
        '- [ ] Feature',
        '- [ ] Documentation',
        '- [ ] Performance improvement',
        '- [ ] Refactor',
        '- [ ] Other',
        '',
        '## Checklist',
        '- [x] Tests added',
        '- [x] Docs updated',
        '- [x] Linted',
        '- [x] Changelog updated',
        '- [x] Code review done',
      ].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(false);
    });

    it('should flag incomplete when no box is checked in a "Type of Change" section', () => {
      const body = ['## Type of Change', '- [ ] Bug fix', '- [ ] Feature', '- [ ] Other'].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(true);
    });

    it('should treat "Kind of Change" heading as a radio group', () => {
      const body = ['## Kind of Change', '- [x] Enhancement', '- [ ] Bug fix', '- [ ] Other'].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(false);
    });
  });

  describe('leave-unchecked sections (#1718)', () => {
    it('should skip all boxes in a section preceded by "Leave unchecked where not applicable"', () => {
      // Directus-style: blockquote note at top of section, most boxes unchecked by design
      const body = [
        '## Checklist',
        '',
        '> Leave unchecked where not applicable',
        '',
        '- [x] I have read the contributing guidelines',
        '- [ ] Tests have been added',
        '- [ ] Documentation has been updated',
        '- [ ] Migration script included',
        '- [ ] Breaking change noted',
        '- [ ] Changelog entry added',
        '- [ ] Screenshots attached',
        '- [ ] Performance impact assessed',
        '- [ ] Security review done',
        '- [ ] Accessibility checked',
        '- [ ] i18n strings updated',
      ].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(false);
    });

    it('should skip boxes when note says "leave unchecked if not applicable"', () => {
      const body = [
        '## Checklist',
        '> Leave unchecked if not applicable',
        '- [x] Tests added',
        '- [ ] Migration included',
        '- [ ] Screenshots attached',
      ].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(false);
    });

    it('should still flag a normal incomplete checklist without a leave-unchecked note', () => {
      const body = [
        '## Checklist',
        '- [x] Tests added',
        '- [ ] Documentation updated',
        '- [ ] Changelog entry added',
      ].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(true);
    });
  });

  describe('pick-one groups (#1760)', () => {
    it('should not flag incomplete when exactly one box is checked under a pick-one comment', () => {
      // Scenario from the issue: release-impact section with "Check exactly one."
      const body = [
        '## Release impact',
        '<!-- Check exactly one. -->',
        '- [ ] **Patch** — bug fix, no new surface',
        '- [x] **Minor** — additive: new flag/subcommand/...',
        '- [ ] **Major (breaking)** — ...',
      ].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(false);
    });

    it('should flag incomplete when no box is checked in a pick-one group', () => {
      const body = [
        '## Release impact',
        '<!-- Check exactly one. -->',
        '- [ ] Patch',
        '- [ ] Minor',
        '- [ ] Major',
      ].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(true);
    });

    it('should recognise "pick one of" phrasing (via "pick one" match)', () => {
      const body = [
        '## Change type',
        '<!-- Pick one of the following. -->',
        '- [x] Bug fix',
        '- [ ] Feature',
        '- [ ] Refactor',
      ].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(false);
    });

    it('should NOT exempt when comment says "one of" without a pick/choose verb (avoids prose false positive)', () => {
      // "Complete one of the following only if it applies" — explanatory prose, not a radio group
      const body = [
        '## Optional steps',
        '<!-- Complete one of the following only if it applies to your change. -->',
        '- [x] I added unit tests',
        '- [ ] I updated integration tests',
        '- [ ] Existing tests already cover this',
      ].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(true);
    });

    it('should recognise "pick one" phrasing', () => {
      const body = ['## Severity', '<!-- pick one -->', '- [ ] Low', '- [x] Medium', '- [ ] High'].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(false);
    });

    it('should recognise "choose one" phrasing', () => {
      const body = ['## Impact', '<!-- choose one -->', '- [ ] Low', '- [ ] Medium', '- [x] High'].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(false);
    });

    it('should still flag incomplete required items outside the pick-one group', () => {
      const body = [
        '## Release impact',
        '<!-- Check exactly one. -->',
        '- [ ] Patch',
        '- [x] Minor',
        '- [ ] Major',
        '',
        '## Checklist',
        '- [x] Tests added',
        '- [ ] Docs updated',
      ].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(true);
    });

    it('should tolerate a blank line between the pick-one comment and the checkbox run', () => {
      const body = [
        '## Release impact',
        '<!-- Check exactly one. -->',
        '',
        '- [ ] Patch',
        '- [x] Minor',
        '- [ ] Major',
      ].join('\n');
      const result = analyzeChecklist(body);
      expect(result.hasIncompleteChecklist).toBe(false);
    });
  });
});

describe('conditional checkbox runs (#1796)', () => {
  it.each([
    'If user-exposed functionality is added or changed:',
    'when the code communicates with third-party tools:',
    'Only if dependencies are updated:',
  ])('should exempt the checkbox run after "%s"', (leadIn) => {
    const result = analyzeChecklist(
      [leadIn, '', '- [x] Applicable work completed', '- [ ] Conditional work'].join('\n'),
    );
    expect(result).toEqual({
      hasIncompleteChecklist: false,
      checklistStats: { checked: 1, total: 1 },
    });
  });

  it('should handle multiple conditional runs in the reported template', () => {
    const body = [
      '## Checklist',
      '- [x] The code change is tested and works locally.',
      '- [x] Tests have been added.',
      '',
      'If user exposed functionality or configuration variables are added/changed:',
      '',
      '- [ ] Documentation added/updated for the docs site',
      '',
      'If the code communicates with devices, web services, or third-party tools:',
      '',
      '- [ ] The manifest file has all fields filled out correctly.',
      '- [ ] New dependencies have been added to the requirements file.',
      '- [ ] A diff between dependency versions is included.',
    ].join('\n');
    expect(analyzeChecklist(body)).toEqual({
      hasIncompleteChecklist: false,
      checklistStats: { checked: 2, total: 2 },
    });
  });

  it.each(['', 'Required tasks:', '## Required tasks'])(
    'should keep required work after a conditional run ending with "%s"',
    (separator) => {
      const body = [
        '- [x] Tests added',
        'If the public API changes:',
        '- [ ] Update the API reference',
        separator,
        '- [ ] I have reviewed two other open pull requests',
      ].join('\n');
      expect(analyzeChecklist(body)).toEqual({
        hasIncompleteChecklist: true,
        checklistStats: { checked: 1, total: 2 },
      });
    },
  );

  it.each(['To help with the load of incoming pull requests:', 'If the public API changes'])(
    'should keep unchecked work under a non-conditional lead-in "%s"',
    (leadIn) => {
      expect(analyzeChecklist(['- [x] Tests added', leadIn, '- [ ] Required work'].join('\n'))).toEqual({
        hasIncompleteChecklist: true,
        checklistStats: { checked: 1, total: 2 },
      });
    },
  );

  it('should not carry an individual checkbox condition into its next sibling', () => {
    const body = ['- [x] Tests added', '- [ ] Update docs (if applicable)', '- [ ] Required review'].join('\n');
    expect(analyzeChecklist(body)).toEqual({
      hasIncompleteChecklist: true,
      checklistStats: { checked: 1, total: 2 },
    });
  });

  it('should omit stats when every checkbox belongs to a conditional run', () => {
    expect(
      analyzeChecklist('If dependencies change:\n\n- [ ] Update requirements\n- [ ] Add a dependency diff'),
    ).toEqual({
      hasIncompleteChecklist: false,
    });
  });
});

describe('explained unchecked items (#1796)', () => {
  it('should keep required work beside an explained skipped item', () => {
    const body = [
      '- [x] Unit tests added',
      '- [ ] Passed the story run. (Not run: no visual change.)',
      '- [ ] I have reviewed two other open pull requests',
    ].join('\n');
    expect(analyzeChecklist(body)).toEqual({
      hasIncompleteChecklist: true,
      checklistStats: { checked: 1, total: 2 },
    });
  });

  it.each([
    '(Not run: no visual change, covered by the new UI test.)',
    '(Skipped — documentation-only change.)',
    '(Not done - generated files are unchanged.)',
    '(Not run: no visual change (covered by the new UI test).)',
  ])('should exclude a trailing status annotation "%s"', (annotation) => {
    expect(analyzeChecklist(`- [x] Unit tests added\n- [ ] Passed the story run. ${annotation}`)).toEqual({
      hasIncompleteChecklist: false,
      checklistStats: { checked: 1, total: 1 },
    });
  });

  it.each([
    '- [ ] Passed the story run. (Not run: )',
    '- [ ] Tests not run by CI must be added',
    '- [ ] Validate the skipped tests',
    '- [ ] Passed the story run. (Skipped: no visual change) and add unit tests',
  ])('should keep required work without a trailing explanation: "%s"', (unchecked) => {
    expect(analyzeChecklist(`- [x] Code reviewed\n${unchecked}`)).toEqual({
      hasIncompleteChecklist: true,
      checklistStats: { checked: 1, total: 2 },
    });
  });
});
