/**
 * Parse issue list command (#82)
 * Parses markdown issue lists into structured JSON with tier classification
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ParseIssueListOutput, ParsedIssueItem } from '../formatters/json.js';
import { errorMessage } from '../core/errors.js';

interface ParseListOptions {
  filePath: string;
}

export type { ParseIssueListOutput, ParsedIssueItem };

/** Extract GitHub issue/PR URLs from a markdown line */
function extractGitHubUrl(line: string): { repo: string; number: number; url: string } | null {
  const match = line.match(/https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (match) {
    return { repo: match[1], number: parseInt(match[2], 10), url: match[0] };
  }
  const prMatch = line.match(/https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (prMatch) {
    return { repo: prMatch[1], number: parseInt(prMatch[2], 10), url: prMatch[0] };
  }
  return null;
}

/** Extract issue title from a markdown line (text after URL or checkbox) */
function extractTitle(line: string): string {
  // Remove markdown link syntax: [title](url) -> title
  let cleaned = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove bare URLs
  cleaned = cleaned.replace(/https?:\/\/\S+/g, '');
  // Remove list markers (-, *, +, numbered)
  cleaned = cleaned.replace(/^\s*[-*+]\s*/, '').replace(/^\s*\d+\.\s*/, '');
  // Remove checkboxes
  cleaned = cleaned.replace(/\[[ x]\]\s*/i, '');
  // Remove strikethrough markers
  cleaned = cleaned.replace(/~~/g, '');
  // Remove "Done" markers
  cleaned = cleaned.replace(/\b(Done|DONE|done)\b/g, '');
  // Remove leading/trailing punctuation and whitespace
  cleaned = cleaned.replace(/^[\s\-\u2013\u2014:]+/, '').replace(/[\s\-\u2013\u2014:]+$/, '');
  return cleaned.trim();
}

/** Determine if a line represents a completed item */
function isCompleted(line: string): boolean {
  // Strikethrough: ~~text~~
  if (/~~.+~~/.test(line)) return true;
  // Checked checkbox: [x] or [X]
  if (/\[x\]/i.test(line)) return true;
  // "Done" marker (standalone word, case insensitive)
  if (/\bdone\b/i.test(line)) return true;
  return false;
}

/** Extract a score from a sub-bullet line (e.g., "Score 8/10" or "Score 7.5/10") */
function extractScore(line: string): number | undefined {
  const match = line.match(/Score\s+(\d+(?:\.\d+)?)\/10/i);
  return match ? parseFloat(match[1]) : undefined;
}

/** Check if a sub-bullet indicates the item is terminal (completed/abandoned — safe to prune) */
function isSubBulletTerminal(line: string): boolean {
  return /\*\*(?:Skip|Done|Dropped|Merged|Closed)\*\*/i.test(line);
}

/** Check if a sub-bullet indicates the item is in-progress (not available, but NOT safe to prune) */
function isSubBulletInProgress(line: string): boolean {
  return /\*\*(?:In Progress|Wait|Waiting)\*\*/i.test(line);
}

/** Parse a markdown string into structured issue items */
export function parseIssueList(content: string): ParseIssueListOutput {
  const lines = content.split('\n');
  const available: ParsedIssueItem[] = [];
  const completed: ParsedIssueItem[] = [];
  let currentTier = 'Uncategorized';
  let lastItem: ParsedIssueItem | null = null;
  // Track which array the last item was placed in so sub-bullets can move it
  let lastItemInAvailable = false;

  for (const line of lines) {
    // Check for section headings (# or ##)
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      currentTier = headingMatch[1].trim();
      lastItem = null;
      continue;
    }

    // Skip empty lines and non-list items
    if (!line.trim() || !/^\s*[-*+]|\s*\d+\.|\s*\[[ x]\]/i.test(line)) {
      continue;
    }

    // Extract GitHub URL -- skip lines without one
    const ghUrl = extractGitHubUrl(line);
    if (!ghUrl) {
      // No URL — check if this is a sub-bullet for the previous item
      if (lastItem && /^\s{2,}/.test(line)) {
        const score = extractScore(line);
        if (score !== undefined) {
          lastItem.score = score;
        }
        // Check if sub-bullet marks item as terminal or in-progress
        if (lastItemInAvailable && (isSubBulletTerminal(line) || isSubBulletInProgress(line))) {
          // Move from available to completed
          const idx = available.indexOf(lastItem);
          if (idx !== -1) {
            available.splice(idx, 1);
            completed.push(lastItem);
            lastItemInAvailable = false;
          }
        }
      }
      continue;
    }

    const title = extractTitle(line);
    const item: ParsedIssueItem = {
      repo: ghUrl.repo,
      number: ghUrl.number,
      title: title || `#${ghUrl.number}`,
      tier: currentTier,
      url: ghUrl.url,
    };

    if (isCompleted(line)) {
      completed.push(item);
      lastItemInAvailable = false;
    } else {
      available.push(item);
      lastItemInAvailable = true;
    }
    lastItem = item;
  }

  return {
    available,
    completed,
    availableCount: available.length,
    completedCount: completed.length,
  };
}

/**
 * Prune a markdown issue list: remove completed, skipped, and low-score items.
 * Rewrites the file in place, removing:
 * - Items with strikethrough, [x], Done, Skip, or Dropped status
 * - Items with score < minScore
 * - Empty section headings left after removal
 * - Sub-bullets belonging to removed items
 *
 * @returns Count of items removed
 */
export function pruneIssueList(content: string, minScore: number = 6): { pruned: string; removedCount: number } {
  const lines = content.split('\n');
  const output: string[] = [];
  let removedCount = 0;
  let skipSubBullets = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Always keep headings (we'll clean empty ones in a second pass)
    if (/^#{1,3}\s+/.test(line)) {
      skipSubBullets = false;
      output.push(line);
      continue;
    }

    // Sub-bullet of a removed item — skip it
    if (skipSubBullets && /^\s{2,}/.test(line)) {
      continue;
    }
    skipSubBullets = false;

    // Check if this is a list item
    const isList = /^\s*[-*+]\s/.test(line);

    // Remove any completed list item (even without a GitHub URL)
    if (isList && isCompleted(line)) {
      removedCount++;
      skipSubBullets = true;
      continue;
    }

    const ghUrl = extractGitHubUrl(line);
    if (ghUrl) {
      // Look ahead at sub-bullets for terminal status or low score
      let shouldRemove = false;
      let j = i + 1;
      while (j < lines.length && /^\s{2,}/.test(lines[j])) {
        if (isSubBulletTerminal(lines[j])) {
          shouldRemove = true;
        }
        const score = extractScore(lines[j]);
        if (score !== undefined && score < minScore) {
          shouldRemove = true;
        }
        j++;
      }

      if (shouldRemove) {
        removedCount++;
        skipSubBullets = true;
        continue;
      }
    }

    // Skip cruft lines: "Skip (N issues)", standalone "---", old "Removed" labels
    if (/^\s*skip\s*\(\d+\s*issues?\)/i.test(line.replace(/[#*]/g, '').trim())) {
      continue;
    }
    if (/^---\s*$/.test(line)) {
      continue;
    }
    if (/^\s*(?:###?\s*)?(?:Removed|Previously dropped)/i.test(line)) {
      continue;
    }
    // Skip blockquote metadata lines ("> Sources: ...", "> Prioritized ...")
    if (/^>\s/.test(line)) {
      continue;
    }

    // Non-list lines, metadata, and surviving items — keep
    output.push(line);
  }

  // Second pass: remove empty section headings (heading followed by another heading or end of file)
  const cleaned: string[] = [];
  for (let i = 0; i < output.length; i++) {
    const isHeading = /^#{1,3}\s+/.test(output[i]);
    if (isHeading) {
      // Check if next non-empty line is another heading or end of content
      let nextContentIdx = i + 1;
      while (nextContentIdx < output.length && output[nextContentIdx].trim() === '') {
        nextContentIdx++;
      }
      const nextIsHeadingOrEnd = nextContentIdx >= output.length || /^#{1,3}\s+/.test(output[nextContentIdx]);
      if (nextIsHeadingOrEnd) {
        // Skip this empty heading and any blank lines after it
        continue;
      }
    }
    cleaned.push(output[i]);
  }

  // Collapse consecutive blank lines into at most one
  const collapsed: string[] = [];
  for (const line of cleaned) {
    if (line.trim() === '' && collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') {
      continue;
    }
    collapsed.push(line);
  }

  // Remove trailing blank lines
  while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') {
    collapsed.pop();
  }

  return { pruned: collapsed.join('\n') + '\n', removedCount };
}

export async function runParseList(options: ParseListOptions): Promise<ParseIssueListOutput> {
  const filePath = path.resolve(options.filePath);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const msg = errorMessage(error);
    throw new Error(`Failed to read file: ${msg}`, { cause: error });
  }

  return parseIssueList(content);
}
