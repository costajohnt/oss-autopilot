/**
 * Parser for the skipped-issues markdown file (#989).
 *
 * The file format is one entry per line:
 *   2026-04-15 https://github.com/owner/repo/issues/123
 * Lines starting with `#` and blank lines are ignored. A trailing inline
 * comment is also allowed and ignored:
 *   2026-04-15 https://github.com/owner/repo/issues/123  # reason for skipping
 * The comment delimiter is whitespace followed by `#`, so a `#fragment` inside
 * the URL (no preceding whitespace) is preserved, not treated as a comment.
 *
 * Produces SkippedIssue entries that plug directly into oss-scout's ScoutState
 * so the search engine filters already-skipped URLs out of results.
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { SkippedIssue } from '@oss-scout/core';
import { warn } from '../core/logger.js';
import { errorMessage } from '../core/errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)(?:[#/?].*)?$/;

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

    // Parse "YYYY-MM-DD <url>" with an optional trailing "# comment". The
    // comment delimiter is whitespace followed by `#`, so a `#fragment` inside
    // the URL (no preceding whitespace) stays part of the URL token.
    const match = line.match(/^(\S+)\s+(\S+)(?:\s+#.*)?$/);
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

/** Result of {@link loadSkippedIssuesDetailed}: parsed entries plus read-failure signal (#1448). */
export interface SkippedIssuesLoadResult {
  issues: SkippedIssue[];
  /**
   * Set when the file exists but could not be read (`issues` is `[]` in that
   * case). Distinguishes "no skips configured" from "skip list unavailable" —
   * without it, a read failure silently resurfaces explicitly-skipped issues
   * in search results. Absent when the path is unset, the file does not
   * exist, or the read succeeded.
   */
  readError?: string;
  /**
   * Set when a path WAS configured but no file exists at the resolved location
   * (#1528). `issues` is `[]`. This is the silent-failure mode that resurfaced
   * already-skipped issues: a relative `skippedIssuesPath` resolves against the
   * process CWD, so running from the wrong directory found nothing and the skip
   * list loaded empty without any signal. Callers raise the same
   * `skipListUnavailable` diagnostic for this as for `readError`. Absent when
   * the path is unset or the file was found.
   */
  notFound?: boolean;
  /**
   * The absolute path the loader actually checked (relative paths resolved
   * against CWD). Present whenever a path was configured, so diagnostics can
   * show exactly where the lookup looked. Absent when no path was configured.
   */
  resolvedPath?: string;
}

/**
 * Read the skipped-issues file from disk and parse it, surfacing read
 * failures to the caller (#1448).
 * Returns `{ issues: [] }` (no `readError`) when `path` is undefined/empty or
 * the file does not exist; `{ issues: [], readError }` when the read throws
 * (a warning is also logged).
 */
export function loadSkippedIssuesDetailed(path: string | undefined): SkippedIssuesLoadResult {
  if (!path) return { issues: [] };

  // Resolve to absolute so a relative `skippedIssuesPath` is interpreted
  // against the CWD explicitly (#1528) and the diagnostics can report the
  // exact location that was checked.
  const resolvedPath = nodePath.resolve(path);

  if (!fs.existsSync(resolvedPath)) {
    // A configured-but-missing skip file used to be silent, which resurfaced
    // already-skipped issues whenever `/oss` ran from a directory other than
    // the one holding a relative skip path. Make it loud.
    warn(
      'skip-file-parser',
      `Configured skipped-issues file not found at ${resolvedPath} (cwd ${process.cwd()}); ` +
        `proceeding with an EMPTY skip list — previously skipped issues may resurface. ` +
        `Use an absolute skippedIssuesPath, or run from the directory that contains "${path}".`,
    );
    return { issues: [], notFound: true, resolvedPath };
  }

  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    warn('skip-file-parser', `Failed to read skipped-issues file at ${resolvedPath}: ${errorMessage(err)}`);
    return { issues: [], readError: errorMessage(err), resolvedPath };
  }

  return { issues: parseSkippedIssuesContent(content), resolvedPath };
}

/**
 * Read the skipped-issues file from disk and parse it.
 * Returns `[]` when:
 *   - `path` is undefined or empty,
 *   - the file does not exist,
 *   - the file cannot be read (a warning is logged).
 *
 * Callers that need to distinguish "unreadable" from "no skips" should use
 * {@link loadSkippedIssuesDetailed} instead.
 */
export function loadSkippedIssues(path: string | undefined): SkippedIssue[] {
  return loadSkippedIssuesDetailed(path).issues;
}
