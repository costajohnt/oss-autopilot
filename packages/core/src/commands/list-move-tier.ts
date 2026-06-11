/**
 * list-move-tier command (#1107).
 *
 * Move an issue line — and any indented sub-bullets that belong to it —
 * between the `## Pursue`, `## Maybe`, and `## Skip` sections of a curated
 * issue-list markdown file. Replaces the model-driven prose rewrite that
 * lived in /oss-search with a deterministic file manipulation.
 *
 * Idempotent: re-running with the same target tier is a no-op. A URL that is
 * not in the list at all is an error (#1355) — the command does not create
 * entries, and callers must add the entry before moving it.
 *
 * No GitHub calls — pure read/transform/write of a local file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorMessage, ValidationError } from '../core/errors.js';

export type Tier = 'pursue' | 'maybe' | 'skip';

const TIER_HEADERS: Record<Tier, string> = {
  pursue: '## Pursue',
  maybe: '## Maybe',
  skip: '## Skip',
};

export interface ListMoveTierOptions {
  issueUrl: string;
  tier: Tier;
  listPath: string;
}

export interface ListMoveTierOutput {
  /** Whether anything moved (false only when the entry was already in the
   * target tier — a URL missing from the list entirely throws instead, #1355). */
  moved: boolean;
  /** Fully-resolved file path that was inspected. */
  filePath: string;
  /** The issue URL that was searched for. */
  url: string;
  /** The target tier (always normalized to one of pursue/maybe/skip). */
  toTier: Tier;
  /** The tier the issue was moved out of, if it had one. Also populated on the
   * already-in-target no-op; absent when the source block sat under no tier header. */
  fromTier?: string;
  /** Number of matching entries moved. Should normally be 1; >1 means the list contained duplicate entries (all moved). */
  count: number;
  /** Human-readable explanation when `moved` is false. */
  reason?: string;
}

interface IssueBlock {
  /** Index of the issue line itself in the source `lines` array. */
  start: number;
  /** Exclusive end index — first line not part of this block. */
  end: number;
  /** The tier this block was found under, or undefined if unsectioned. */
  tier: string | undefined;
}

/** Extract the heading text from a line that starts with `## ` (returns undefined otherwise).
 * Avoids regex on the heading body so a long whitespace prefix can't trigger
 * backtracking in static analyzers (CodeQL js/polynomial-redos).
 */
function parseLevel2Heading(line: string): string | undefined {
  if (line.startsWith('## ')) return line.slice(3).trim();
  return undefined;
}

/** Identify which "## Pursue|Maybe|Skip" section a line index sits under, if any. */
function tierForLine(lines: string[], lineIndex: number): string | undefined {
  for (let i = lineIndex - 1; i >= 0; i--) {
    const heading = parseLevel2Heading(lines[i]);
    if (heading !== undefined) return heading;
    // A higher-level heading also resets — we don't reach back across `# Foo`.
    if (lines[i].startsWith('# ')) return undefined;
  }
  return undefined;
}

/** Locate every issue block (issue line + any sub-bullets) that mentions the URL. */
function findIssueBlocks(lines: string[], issueUrl: string): IssueBlock[] {
  const blocks: IssueBlock[] = [];
  // Use exact substring match on the URL — no regex escaping pitfalls and
  // the URL itself contains no markdown delimiters that would split a line.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Top-level list item — `- `, `* `, `+ `, or `1.` at the start (with no leading whitespace).
    const isTopLevelListItem = /^[*+-]\s|^\d+\.\s/.test(line);
    if (!isTopLevelListItem || !line.includes(issueUrl)) continue;

    // Capture indented sub-bullets that follow this line.
    let end = i + 1;
    while (end < lines.length && /^\s{2,}/.test(lines[end])) {
      end++;
    }
    blocks.push({ start: i, end, tier: tierForLine(lines, i) });
    i = end - 1; // continue past the captured sub-bullets
  }
  return blocks;
}

/** Find the line index of the target tier's `## ...` header, or undefined if absent. */
function findTierHeaderIndex(lines: string[], tier: Tier): number | undefined {
  const expected = TIER_HEADERS[tier].toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const heading = parseLevel2Heading(lines[i]);
    if (heading !== undefined && `## ${heading}`.toLowerCase() === expected) {
      return i;
    }
  }
  return undefined;
}

/** Find the insertion point for a new entry under a tier's header — the first
 * blank line or next-section boundary after the header. Returns an index where
 * splice() can insert. */
function findTierInsertionIndex(lines: string[], headerIndex: number): number {
  for (let i = headerIndex + 1; i < lines.length; i++) {
    // Stop at the next heading of the same or shallower depth.
    if (/^#{1,2}\s+/.test(lines[i])) return i;
  }
  return lines.length;
}

/**
 * Pure transform — accepts the file content and returns the rewritten content
 * plus a summary of what changed. Exported for unit testing.
 */
/** Discriminates the two `moved: false` outcomes of {@link moveIssueToTier}. */
export type MoveNoOpReason = 'not-found' | 'already-in-target';

export function moveIssueToTier(
  content: string,
  issueUrl: string,
  targetTier: Tier,
): {
  content: string;
  moved: boolean;
  fromTier?: string;
  count: number;
  reason?: string;
  /** Set only when `moved` is false — why nothing changed. */
  reasonCode?: MoveNoOpReason;
} {
  // Preserve the trailing newline if present so we don't accidentally strip it.
  const hadTrailingNewline = content.endsWith('\n');
  const lines = (hadTrailingNewline ? content.slice(0, -1) : content).split('\n');

  const blocks = findIssueBlocks(lines, issueUrl);
  if (blocks.length === 0) {
    return {
      content,
      moved: false,
      count: 0,
      reason: 'issue URL not found in the list',
      reasonCode: 'not-found',
    };
  }

  const targetHeader = TIER_HEADERS[targetTier];
  // If every match is already in the target tier, no-op (idempotent).
  if (blocks.every((b) => b.tier !== undefined && `## ${b.tier}`.toLowerCase() === targetHeader.toLowerCase())) {
    return {
      content,
      moved: false,
      fromTier: blocks[0].tier,
      count: blocks.length,
      reason: 'already in target tier',
      reasonCode: 'already-in-target',
    };
  }

  // Extract the blocks (highest start index first so earlier indices stay
  // valid as we splice). Capture the original tier for reporting.
  const sortedBlocks = [...blocks].sort((a, b) => b.start - a.start);
  const extracted: { tier: string | undefined; lines: string[] }[] = [];
  for (const block of sortedBlocks) {
    extracted.push({ tier: block.tier, lines: lines.slice(block.start, block.end) });
    lines.splice(block.start, block.end - block.start);
  }
  // We popped in reverse order; reverse to restore source order.
  extracted.reverse();

  // Ensure the target section exists. If not, append a new header at the end
  // of the document.
  let headerIndex = findTierHeaderIndex(lines, targetTier);
  if (headerIndex === undefined) {
    // Append a blank line (if none precedes) and the new header.
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
    lines.push(targetHeader);
    headerIndex = lines.length - 1;
    // Add a blank line after the header so insertion below stays clean.
    lines.push('');
  }

  // Insert the extracted blocks at the top of the target section (just after
  // the header, after any leading blank line).
  let insertAt = headerIndex + 1;
  // Skip a single immediate blank line so entries land before the blank that
  // already separates the section header from its first item, not before the
  // header.
  if (insertAt < lines.length && lines[insertAt].trim() === '') {
    insertAt += 1;
  }
  // Don't cross into a different section.
  const sectionBoundary = findTierInsertionIndex(lines, headerIndex);
  if (insertAt > sectionBoundary) insertAt = sectionBoundary;

  const flattened: string[] = [];
  for (const e of extracted) {
    flattened.push(...e.lines);
  }
  lines.splice(insertAt, 0, ...flattened);

  let next = lines.join('\n');
  if (hadTrailingNewline) next += '\n';

  // Report fromTier as the original tier of the first match. (Multi-match
  // moves across multiple source tiers are uncommon enough that one label is
  // fine; the count surfaces the multiplicity if needed.)
  return {
    content: next,
    moved: true,
    fromTier: extracted[0].tier,
    count: extracted.length,
  };
}

export async function runListMoveTier(options: ListMoveTierOptions): Promise<ListMoveTierOutput> {
  const filePath = path.resolve(options.listPath);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read file: ${errorMessage(error)}`, { cause: error });
  }

  const result = moveIssueToTier(content, options.issueUrl, options.tier);

  // #1355: a missing entry is a caller error, not a quiet success. Idempotent
  // re-runs (already-in-target) still resolve normally.
  if (result.reasonCode === 'not-found') {
    throw new ValidationError(
      `Issue URL not found in the list: ${options.issueUrl} (${filePath}). ` +
        'Add the entry to the list first, then re-run list-move-tier.',
    );
  }

  if (result.moved) {
    try {
      fs.writeFileSync(filePath, result.content, 'utf8');
    } catch (error) {
      throw new Error(`Failed to write file: ${errorMessage(error)}`, { cause: error });
    }
  }

  return {
    moved: result.moved,
    filePath,
    url: options.issueUrl,
    toTier: options.tier,
    fromTier: result.fromTier,
    count: result.count,
    reason: result.reason,
  };
}
