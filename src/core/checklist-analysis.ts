/**
 * Checklist Analysis - PR body checklist detection and conditional item filtering.
 * Extracted from PRMonitor to isolate checklist-related logic (#263).
 */

import { FetchedPR } from './types.js';

/**
 * Detect conditional checklist items that are intentionally left unchecked (#152).
 * Matches patterns like "(if the PR is ...)", "if applicable", "N/A", "optional", etc.
 * Conservative — only skips items with clear conditional language.
 */
const CONDITIONAL_CHECKLIST_PATTERN =
  /\(if\s|\bif applicable\b|\bif needed\b|\bif relevant\b|\bonly if\b|\bwhen applicable\b|\(optional\)|- \[ \]\s*optional\b|\bn\/a\b|\bnot applicable\b|\bif required\b|\bif necessary\b/;

export function isConditionalChecklistItem(line: string): boolean {
  return CONDITIONAL_CHECKLIST_PATTERN.test(line.toLowerCase());
}

/**
 * Analyze PR body for incomplete checklists (unchecked markdown checkboxes).
 * Looks for patterns like "- [ ]" (unchecked) vs "- [x]" (checked).
 * Only flags if there ARE checkboxes and some are unchecked.
 * Conditional items (containing "if applicable", "(if ...)", etc.) are
 * excluded from the incomplete count (#152).
 */
export function analyzeChecklist(body: string): {
  hasIncompleteChecklist: boolean;
  checklistStats?: FetchedPR['checklistStats'];
} {
  if (!body) return { hasIncompleteChecklist: false };

  const checkedPattern = /- \[x\]/gi;
  const uncheckedLinePattern = /^.*- \[ \].*$/gm;

  const checkedMatches = body.match(checkedPattern) || [];
  const uncheckedLines = body.match(uncheckedLinePattern) || [];

  const checked = checkedMatches.length;
  const total = checked + uncheckedLines.length;

  // No checkboxes at all - not a checklist PR
  if (total === 0) return { hasIncompleteChecklist: false };

  // Filter out conditional checklist items that are intentionally unchecked
  const nonConditionalUnchecked = uncheckedLines.filter((line) => !isConditionalChecklistItem(line));

  return {
    hasIncompleteChecklist: nonConditionalUnchecked.length > 0,
    checklistStats: { checked, total },
  };
}
