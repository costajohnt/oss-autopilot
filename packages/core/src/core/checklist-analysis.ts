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
 * Matches an HTML comment that introduces a pick-one (single-select) group of
 * checkboxes. Supported phrases: "exactly one", "pick one", "choose one".
 * Intentionally excludes bare "one of" to avoid false positives on explanatory
 * prose like "Complete one of the following only if it applies". (#1760)
 */
const PICK_ONE_COMMENT_RE = /<!--[^>]*(?:exactly\s+one|pick\s+one|choose\s+one)[^>]*-->/i;

/** Matches any checkbox line (checked or unchecked). */
const ANY_CHECKBOX_RE = /^.*- \[[ x]\].*$/i;

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

/**
 * Mark unchecked lines in a single pick-one run as exempt if exactly one box is
 * checked. Extracted to keep `collectPickOneExemptLineIndices` within complexity
 * limits.
 */
function markPickOneRunExempt(lines: string[], runStart: number, runEnd: number, exempt: Set<number>): void {
  const checkedInRun = lines.slice(runStart, runEnd).filter((l) => /- \[x\]/i.test(l)).length;
  if (checkedInRun !== 1) return;
  for (let k = runStart; k < runEnd; k++) {
    if (/- \[ \]/.test(lines[k])) exempt.add(k);
  }
}

/**
 * Returns the set of line indices (within `lines`) that are unchecked checkbox lines
 * belonging to a satisfied pick-one group. A pick-one group is a contiguous checkbox
 * run immediately following an HTML comment matching PICK_ONE_COMMENT_RE. The group is
 * satisfied when exactly one box in the run is checked; in that case the unchecked
 * alternatives are intentional and must not be counted as incomplete. (#1760)
 */
function collectPickOneExemptLineIndices(lines: string[]): ReadonlySet<number> {
  const exempt = new Set<number>();
  let i = 0;

  while (i < lines.length) {
    if (!PICK_ONE_COMMENT_RE.test(lines[i])) {
      i++;
      continue;
    }

    // Advance past the comment, skipping any blank lines before the checkbox run
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;

    // Collect the contiguous checkbox run
    const runStart = j;
    while (j < lines.length && ANY_CHECKBOX_RE.test(lines[j])) j++;

    markPickOneRunExempt(lines, runStart, j, exempt);
    i = j;
  }

  return exempt;
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

  // Pick-one groups: unchecked alternatives in a satisfied pick-one group are exempt. (#1760)
  const pickOneExempt = collectPickOneExemptLineIndices(section.lines);

  const nonConditionalUnchecked = section.lines.filter(
    (l, idx) => /^.*- \[ \].*$/.test(l) && !isConditionalChecklistItem(l) && !pickOneExempt.has(idx),
  );
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
