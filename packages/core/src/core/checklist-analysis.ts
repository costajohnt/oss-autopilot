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

// Matches markdown headings; `\S` after whitespace prevents backtracking with `.*` (#1718)
const HEADING_RE = /^#{1,6}\s+(\S.*)/;

/**
 * Matches headings that indicate a mutually-exclusive "type of change" radio group
 * where exactly one option should be selected. (#1718)
 */
const TYPE_OF_CHANGE_RE = /type\s+of\s+change|kind\s+of\s+change|category/i;

interface CheckboxSection {
  // Heading text, or null for content that appears before the first heading.
  heading: string | null;
  lines: string[];
}

/**
 * Split a PR body into sections delimited by markdown headings.
 * Content before the first heading is returned as a section with heading = null.
 */
function parseSections(body: string): CheckboxSection[] {
  const lines = body.split('\n');
  const sections: CheckboxSection[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      if (currentHeading !== null || currentLines.length > 0) {
        sections.push({ heading: currentHeading, lines: currentLines });
      }
      currentHeading = headingMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush the final section
  if (currentHeading !== null || currentLines.length > 0) {
    sections.push({ heading: currentHeading, lines: currentLines });
  }

  return sections;
}

/**
 * Return true if a section contains a "leave unchecked where/if not applicable" note
 * in the first few non-checkbox lines, signalling that unchecked boxes are intentional.
 * (#1718)
 */
function hasLeaveUncheckedNote(section: CheckboxSection): boolean {
  const nonCheckboxLines = section.lines.filter((l) => !/- \[x\]/i.test(l));
  // Only inspect the first 5 non-checkbox lines — the note is always near the top
  return nonCheckboxLines.slice(0, 5).some((l) => {
    const lower = l.toLowerCase();
    return lower.includes('leave unchecked') && (lower.includes('not applicable') || lower.includes('n/a'));
  });
}

interface SectionResult {
  checked: number;
  nonConditionalUnchecked: number;
}

/**
 * Analyze a single checkbox section and return its effective counts.
 * Returns null if the section should be entirely skipped.
 */
function analyzeSectionItems(section: CheckboxSection): SectionResult | null {
  const sectionText = section.lines.join('\n');
  const checked = (sectionText.match(/- \[x\]/gi) ?? []).length;
  const uncheckedLines = section.lines.filter((l) => /^.*- \[ \].*$/.test(l));

  if (checked === 0 && uncheckedLines.length === 0) return null;
  if (hasLeaveUncheckedNote(section)) return null;

  // Type-of-change radio group: when ≥1 box is checked, remaining unchecked boxes are
  // intentional (single-select) and must not be counted as incomplete. (#1718)
  const isTypeOfChange = section.heading !== null && TYPE_OF_CHANGE_RE.test(section.heading);
  if (isTypeOfChange && checked >= 1) return { checked, nonConditionalUnchecked: 0 };

  const nonConditionalUnchecked = uncheckedLines.filter((l) => !isConditionalChecklistItem(l));
  return { checked, nonConditionalUnchecked: nonConditionalUnchecked.length };
}

/**
 * Analyze PR body for incomplete checklists (unchecked markdown checkboxes).
 * Looks for patterns like "- [ ]" (unchecked) vs "- [x]" (checked).
 * Only flags if there ARE checkboxes and some are unchecked.
 * Conditional items (containing "if applicable", "(if ...)", etc.) are
 * excluded from the incomplete count (#152).
 *
 * Checkbox groups are parsed by markdown headings. Special handling applies (#1718):
 * - Sections containing "leave unchecked where/if not applicable" are skipped entirely.
 * - Sections whose heading matches "type of change" / "kind of change" / "category"
 *   are treated as single-select radio groups: satisfied when at least one box is
 *   checked, so the remaining unchecked boxes are not counted as incomplete.
 */
export function analyzeChecklist(body: string): {
  hasIncompleteChecklist: boolean;
  checklistStats?: FetchedPR['checklistStats'];
} {
  if (!body) return { hasIncompleteChecklist: false };

  const sections = parseSections(body);
  let totalChecked = 0;
  let totalNonConditionalUnchecked = 0;

  for (const section of sections) {
    // null means no checkboxes or section is intentionally skipped
    const result = analyzeSectionItems(section);
    if (result === null) continue;
    totalChecked += result.checked;
    totalNonConditionalUnchecked += result.nonConditionalUnchecked;
  }

  const effectiveTotal = totalChecked + totalNonConditionalUnchecked;

  // No checkboxes, or every section was skipped (leave-unchecked) or fully conditional
  if (effectiveTotal === 0) return { hasIncompleteChecklist: false };

  return {
    hasIncompleteChecklist: totalNonConditionalUnchecked > 0,
    checklistStats: { checked: totalChecked, total: effectiveTotal },
  };
}
