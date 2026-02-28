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
});
