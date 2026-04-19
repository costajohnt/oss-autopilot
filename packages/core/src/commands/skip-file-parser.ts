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
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;

    // Split on first whitespace run: "YYYY-MM-DD <url>"
    const match = line.match(/^(\S+)\s+(\S+)\s*$/);
    if (!match) {
      warn('skip-file-parser', `Line ${lineNumber}: malformed (expected "<date> <url>"): ${line}`);
      continue;
    }

    const [, dateStr, url] = match;

    if (!DATE_RE.test(dateStr)) {
      warn('skip-file-parser', `Line ${lineNumber}: invalid date format (expected YYYY-MM-DD): ${line}`);
      continue;
    }

    const dateMs = Date.parse(`${dateStr}T00:00:00.000Z`);
    if (Number.isNaN(dateMs)) {
      warn('skip-file-parser', `Line ${lineNumber}: unparseable date: ${line}`);
      continue;
    }

    // Guard against JS Date normalization — Date.parse silently shifts
    // invalid calendar dates (e.g. 2026-02-30 → 2026-03-02). Without this
    // round-trip check the entry would be stored under the wrong date and
    // scout's 90-day cull would run against a shifted value.
    const roundTrip = new Date(dateMs).toISOString().slice(0, 10);
    if (roundTrip !== dateStr) {
      warn(
        'skip-file-parser',
        `Line ${lineNumber}: invalid calendar date ${dateStr} (would be normalized to ${roundTrip}): ${line}`,
      );
      continue;
    }

    const urlMatch = url.match(GITHUB_URL_RE);
    if (!urlMatch) {
      warn('skip-file-parser', `Line ${lineNumber}: non-GitHub-issue URL: ${line}`);
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
