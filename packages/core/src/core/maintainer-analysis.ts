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
  // Skip a keyword preceded by a negation ("don't add tests", "no need to add test"),
  // unless a clause boundary sits between them ("no blockers, add tests").
  const negatedBefore = (idx: number) => {
    const m = /\b(?:no|not|don['’]?t|without|unnecessary|skip)\b([^.!?,;:\n]{0,20})$/.exec(lower.slice(0, idx));
    return m !== null && !/\b(?:and|but|until|then|so)\b/.test(m[1]);
  };
  if (
    testKeywords.some((kw) => {
      for (let i = lower.indexOf(kw); i !== -1; i = lower.indexOf(kw, i + 1)) {
        if (!negatedBefore(i)) return true;
      }
      return false;
    })
  ) {
    hints.push('tests_requested');
  }

  // Documentation requests
  const docKeywords = ['documentation', 'readme', 'jsdoc', 'docstring', 'add docs', 'update docs', 'document this'];
  if (docKeywords.some((kw) => lower.includes(kw))) {
    hints.push('docs_requested');
  }

  // Rebase requests.
  //
  // The `rebase` term uses a word-boundary regex so past-tense mentions like
  // "after rebasing this was fine" or "I already rebased this" don't trigger
  // a rebase_requested hint (#1057 M30). The other phrases are specific
  // enough that plain substring matching is sufficient.
  const rebasePhrases = ['merge conflict', 'out of date', 'behind main', 'behind master'];
  const hasRebaseWord = /\brebase\b/i.test(commentBody);
  if (hasRebaseWord || rebasePhrases.some((kw) => lower.includes(kw))) {
    hints.push('rebase_requested');
  }

  return hints;
}
