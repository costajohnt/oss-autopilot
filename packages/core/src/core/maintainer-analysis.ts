/**
 * Maintainer Analysis - Action hint extraction from maintainer comments.
 * Extracted from PRMonitor to isolate maintainer-comment-related logic (#263).
 */

import { MaintainerActionHint, ReviewDecision } from './types.js';

/**
 * Extract action hints from maintainer comments using keyword matching.
 * Returns an array of hints about what the maintainer is asking for.
 */
export function extractMaintainerActionHints(
  commentBody: string | undefined,
  reviewDecision: ReviewDecision,
): MaintainerActionHint[] {
  const hints: MaintainerActionHint[] = [];

  if (reviewDecision === 'changes_requested') {
    hints.push('changes_requested');
  }

  if (!commentBody) return hints;

  const lower = commentBody.toLowerCase();

  // Demo/screenshot requests
  const demoKeywords = [
    'screenshot',
    'demo',
    'recording',
    'screen recording',
    'before/after',
    'before and after',
    'gif',
    'video',
    'screencast',
    'show me',
    'can you show',
  ];
  if (demoKeywords.some((kw) => lower.includes(kw))) {
    hints.push('demo_requested');
  }

  // Test requests
  const testKeywords = [
    'add test',
    'test coverage',
    'unit test',
    'missing test',
    'add a test',
    'write test',
    'needs test',
    'need test',
  ];
  if (testKeywords.some((kw) => lower.includes(kw))) {
    hints.push('tests_requested');
  }

  // Documentation requests
  const docKeywords = ['documentation', 'readme', 'jsdoc', 'docstring', 'add docs', 'update docs', 'document this'];
  if (docKeywords.some((kw) => lower.includes(kw))) {
    hints.push('docs_requested');
  }

  // Rebase requests
  const rebaseKeywords = ['rebase', 'merge conflict', 'out of date', 'behind main', 'behind master'];
  if (rebaseKeywords.some((kw) => lower.includes(kw))) {
    hints.push('rebase_requested');
  }

  return hints;
}
