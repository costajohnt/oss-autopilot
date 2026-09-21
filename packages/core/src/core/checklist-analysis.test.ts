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
});
