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
  /\(if\s|\bif applicable\b|\bif needed\b|\bif relevant\b|\bonly if\b|\bwhen applicable\b|\(optional\)|- \[ \]\s*optional\b|\bn\/a\b|\bnot applicable\b|\bif required\b|\bif necessary\b|\((?:not run|skipped)\s*:\s*[^\s)][^)]*\)/;

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

/**
 * A prose line that states a condition on the change for the checkbox run below
 * it, e.g. "If the code communicates with devices:" (#1796). It must start with
 * If/When/Only if, end with ":", and name what the PR changes; help lead-ins
 * ("If you have questions:") and role lead-ins ("If you are a maintainer:") do
 * not qualify, so required boxes under them still count.
 */
const CONDITIONAL_LEAD_IN_RE = /^\s*(?:if|when|only if)\s.*:\s*$/i;
const LEAD_IN_CHANGE_RE =
  /\b(?:add(?:s|ed|ing)?|chang(?:e|es|ed|ing)|modif(?:y|ies|ied|ying)|updat(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|introduc(?:e|es|ed|ing)|touch(?:es|ed|ing)?|this (?:pr|change)|the code)\b|\/changed\b/i;
const LEAD_IN_HELP_RE = /\b(?:questions?|help|unsure|stuck|in doubt)\b/i;

function isConditionalLeadIn(line: string): boolean {
  return CONDITIONAL_LEAD_IN_RE.test(line) && LEAD_IN_CHANGE_RE.test(line) && !LEAD_IN_HELP_RE.test(line);
}

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
 * checked. Extracted to keep `collectRunExemptLineIndices` within complexity
 * limits.
 */
function markPickOneRunExempt(lines: string[], runStart: number, runEnd: number, exempt: Set<number>): void {
  const checkedInRun = lines.slice(runStart, runEnd).filter((l) => /- \[x\]/i.test(l)).length;
  if (checkedInRun !== 1) return;
  for (let k = runStart; k < runEnd; k++) {
    if (/- \[ \]/.test(lines[k])) exempt.add(k);
  }
}

/** Mark every unchecked line in a run under a conditional lead-in as exempt (#1796). */
function markConditionalRunExempt(lines: string[], runStart: number, runEnd: number, exempt: Set<number>): void {
  for (let k = runStart; k < runEnd; k++) {
    if (/- \[ \]/.test(lines[k])) exempt.add(k);
  }
}

type RunMarker = (lines: string[], runStart: number, runEnd: number, exempt: Set<number>) => void;

/**
 * Returns the set of line indices (within `lines`) of unchecked checkbox lines that
 * are intentionally unchecked because of the line introducing their run:
 * - a pick-one HTML comment (PICK_ONE_COMMENT_RE) whose run has exactly one box
 *   checked, so the unchecked alternatives are intentional (#1760);
 * - a conditional lead-in line ({@link isConditionalLeadIn}), so the whole run is
 *   conditional like an "(if ...)" item (#1796).
 * A run is the contiguous checkbox lines after the introducing line, past blanks.
 */
function collectRunExemptLineIndices(lines: string[]): ReadonlySet<number> {
  const exempt = new Set<number>();
  let i = 0;

  while (i < lines.length) {
    let mark: RunMarker | undefined;
    if (PICK_ONE_COMMENT_RE.test(lines[i])) mark = markPickOneRunExempt;
    else if (isConditionalLeadIn(lines[i])) mark = markConditionalRunExempt;
    if (!mark) {
      i++;
      continue;
    }

    // Advance past the introducing line, skipping any blank lines before the checkbox run
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;

    // Collect the contiguous checkbox run
    const runStart = j;
    while (j < lines.length && ANY_CHECKBOX_RE.test(lines[j])) j++;

    mark(lines, runStart, j, exempt);
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

  // Pick-one groups (#1760) and runs under a conditional lead-in line (#1796).
  const runExempt = collectRunExemptLineIndices(section.lines);

  const nonConditionalUnchecked = section.lines.filter(
    (l, idx) => /^.*- \[ \].*$/.test(l) && !isConditionalChecklistItem(l) && !runExempt.has(idx),
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
 * - Unchecked boxes in a run under a conditional lead-in line ("If ...:") are
 *   treated as conditional (#1796).
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
