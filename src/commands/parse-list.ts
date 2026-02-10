/**
 * Parse issue list command (#82)
 * Parses markdown issue lists into structured JSON with tier classification
 */

import * as fs from 'fs';
import * as path from 'path';
import { outputJson, outputJsonError, type ParseIssueListOutput, type ParsedIssueItem } from '../formatters/json.js';

interface ParseListOptions {
  filePath: string;
  json?: boolean;
}

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
  // Remove markdown link syntax: [title](url) → title
  let cleaned = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove bare URLs
  cleaned = cleaned.replace(/https?:\/\/\S+/g, '');
  // Remove list markers (-, *, +, numbered)
  cleaned = cleaned.replace(/^\s*[-*+]\s*/, '').replace(/^\s*\d+\.\s*/, '');
  // Remove checkboxes
  cleaned = cleaned.replace(/\[[ xX]\]\s*/, '');
  // Remove strikethrough markers
  cleaned = cleaned.replace(/~~/g, '');
  // Remove "Done" markers
  cleaned = cleaned.replace(/\b(Done|DONE|done)\b/g, '');
  // Remove leading/trailing punctuation and whitespace
  cleaned = cleaned.replace(/^[\s\-–—:]+/, '').replace(/[\s\-–—:]+$/, '');
  return cleaned.trim();
}

/** Determine if a line represents a completed item */
function isCompleted(line: string): boolean {
  // Strikethrough: ~~text~~
  if (/~~.+~~/.test(line)) return true;
  // Checked checkbox: [x] or [X]
  if (/\[[xX]\]/.test(line)) return true;
  // "Done" marker (standalone word, case insensitive)
  if (/\bdone\b/i.test(line)) return true;
  return false;
}

/** Parse a markdown string into structured issue items */
export function parseIssueList(content: string): ParseIssueListOutput {
  const lines = content.split('\n');
  const available: ParsedIssueItem[] = [];
  const completed: ParsedIssueItem[] = [];
  let currentTier = 'Uncategorized';

  for (const line of lines) {
    // Check for section headings (# or ##)
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      currentTier = headingMatch[1].trim();
      continue;
    }

    // Skip empty lines and non-list items
    if (!line.trim() || !/^\s*[-*+]|\s*\d+\.|\s*\[[ xX]\]/.test(line)) {
      continue;
    }

    // Extract GitHub URL — skip lines without one
    const ghUrl = extractGitHubUrl(line);
    if (!ghUrl) continue;

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
    } else {
      available.push(item);
    }
  }

  return {
    available,
    completed,
    availableCount: available.length,
    completedCount: completed.length,
  };
}

export async function runParseList(options: ParseListOptions): Promise<void> {
  const filePath = path.resolve(options.filePath);

  if (!fs.existsSync(filePath)) {
    if (options.json) {
      outputJsonError(`File not found: ${filePath}`);
    } else {
      console.error(`Error: File not found: ${filePath}`);
    }
    process.exit(1);
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (options.json) {
      outputJsonError(`Failed to read file: ${msg}`);
    } else {
      console.error(`Error: Failed to read file: ${msg}`);
    }
    process.exit(1);
  }

  const result = parseIssueList(content);

  if (options.json) {
    outputJson<ParseIssueListOutput>(result);
  } else {
    console.log(`\n📋 Issue List: ${filePath}\n`);
    console.log(`Available: ${result.availableCount} | Completed: ${result.completedCount}\n`);

    if (result.available.length > 0) {
      console.log('--- Available ---');
      for (const item of result.available) {
        console.log(`  [${item.tier}] ${item.repo}#${item.number}: ${item.title}`);
      }
    }

    if (result.completed.length > 0) {
      console.log('\n--- Completed ---');
      for (const item of result.completed) {
        console.log(`  [${item.tier}] ${item.repo}#${item.number}: ${item.title}`);
      }
    }
  }
}
