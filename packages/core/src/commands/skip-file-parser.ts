/**
 * Parser for the skipped-issues markdown file (#989).
 *
 * The file format is one entry per line:
 *   2026-04-15 https://github.com/owner/repo/issues/123
 * Lines starting with `#` and blank lines are ignored.
 *
 * Produces SkippedIssue entries that plug directly into oss-scout's ScoutState
 * so the search engine filters already-skipped URLs out of results.
 */

import * as fs from 'fs';
import type { SkippedIssue } from '@oss-scout/core';
import { warn } from '../core/logger.js';
import { errorMessage } from '../core/errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/;

/**
 * Parse the raw text of a skipped-issues file into SkippedIssue entries.
 * Pure function — no I/O. Malformed lines are warned and skipped; the rest
 * pass through unchanged.
 */
export function parseSkippedIssuesContent(content: string): SkippedIssue[] {
  const results: SkippedIssue[] = [];

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // Split on first whitespace run: "YYYY-MM-DD <url>"
    const match = line.match(/^(\S+)\s+(\S+)\s*$/);
    if (!match) {
      warn('skip-file-parser', `Ignoring malformed line (expected "<date> <url>"): ${line}`);
      continue;
    }

    const [, dateStr, url] = match;

    if (!DATE_RE.test(dateStr)) {
      warn('skip-file-parser', `Ignoring line with invalid date (expected YYYY-MM-DD): ${line}`);
      continue;
    }

    const dateMs = Date.parse(`${dateStr}T00:00:00.000Z`);
    if (Number.isNaN(dateMs)) {
      warn('skip-file-parser', `Ignoring line with unparseable date: ${line}`);
      continue;
    }

    const urlMatch = url.match(GITHUB_URL_RE);
    if (!urlMatch) {
      warn('skip-file-parser', `Ignoring line with non-GitHub-issue URL: ${line}`);
      continue;
    }

    const [, repo, numberStr] = urlMatch;
    const number = Number.parseInt(numberStr, 10);

    results.push({
      url,
      repo,
      number,
      title: '',
      skippedAt: new Date(dateMs).toISOString(),
    });
  }

  return results;
}

/**
 * Read the skipped-issues file from disk and parse it.
 * Returns `[]` when:
 *   - `path` is undefined or empty,
 *   - the file does not exist,
 *   - the file cannot be read (a warning is logged).
 */
export function loadSkippedIssues(path: string | undefined): SkippedIssue[] {
  if (!path) return [];
  if (!fs.existsSync(path)) return [];

  let content: string;
  try {
    content = fs.readFileSync(path, 'utf-8');
  } catch (err) {
    warn('skip-file-parser', `Failed to read skipped-issues file at ${path}: ${errorMessage(err)}`);
    return [];
  }

  return parseSkippedIssuesContent(content);
}
