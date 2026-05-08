/**
 * list-mark-done command (#1299).
 *
 * Mark an issue line in a curated list as done by wrapping it in
 * `~~strikethrough~~` and appending a `**Done** — PR [#N](url) ...` sub-bullet.
 * If every issue under the same `### repo/name` heading is now struck through,
 * also strikes through the heading. Replaces the markdown-prose strikethrough
 * logic in `draft-first-workflow.md` Step 10.
 *
 * Idempotent: re-running with an already-marked URL is a no-op.
 *
 * No GitHub calls — pure read/transform/write of a local file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorMessage } from '../core/errors.js';

export interface MarkDoneOptions {
  issueUrl: string;
  prUrl: string;
  /** Free-text trailing status, e.g. "CI passing", "merged". */
  prStatus: string;
  listPath: string;
}

export interface MarkDoneOutput {
  /** True if the line was found and updated. False on already-marked or not-found. */
  marked: boolean;
  /** Fully-resolved file path that was inspected. */
  filePath: string;
  /** The issue URL that was searched for. */
  url: string;
  /** True if the parent `### repo/name` heading was also struck through this run. */
  repoHeadingStruck: boolean;
  /** Issue lines under the same repo heading that are still open after the update. */
  remainingUnderRepo: number;
  /** Human-readable explanation when `marked` is false. */
  reason?: string;
}

interface IssueBlock {
  /** Index of the issue line itself in the source `lines` array. */
  start: number;
  /** Exclusive end index — first line not part of this block. */
  end: number;
}

interface RepoSection {
  /** Index of the `### repo/...` heading line. */
  headingIndex: number;
  /** Exclusive end index — first line not under this heading. */
  end: number;
}

const STRIKE = '~~';
const DONE_PREFIX = '  - **Done**';
const ISSUE_LINE_RE = /^[*+-]\s/;
const REPO_HEADING_RE = /^###\s/;
const SECTION_BREAK_RE = /^#{1,3}\s/;
const PR_NUMBER_RE = /\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/;

/** Extract a PR number from a GitHub PR URL, returning a string like "#42". */
function prNumberLabel(prUrl: string): string {
  const match = prUrl.match(PR_NUMBER_RE);
  return match ? `#${match[1]}` : 'PR';
}

/** Wrap a line in `~~...~~` if it isn't already. Returns the input unchanged when already wrapped. */
function strikeLine(line: string): { line: string; alreadyStruck: boolean } {
  // Strip the leading list marker so we wrap the content, not the bullet.
  const markerMatch = line.match(/^(?:[*+-]\s+|#{1,6}\s+)/);
  const prefix = markerMatch ? markerMatch[0] : '';
  const body = line.slice(prefix.length);
  if (body.startsWith(STRIKE) && body.endsWith(STRIKE) && body.length >= 4) {
    return { line, alreadyStruck: true };
  }
  return { line: `${prefix}${STRIKE}${body}${STRIKE}`, alreadyStruck: false };
}

/**
 * Match the URL only when followed by a non-digit, non-word character (or
 * end of line). A bare `includes(issueUrl)` would match `issues/1` against
 * a line containing `issues/10`, so finding/marking issue 1 would mark
 * whichever number-prefix line appears first.
 */
function lineMentionsUrl(line: string, issueUrl: string): boolean {
  const idx = line.indexOf(issueUrl);
  if (idx === -1) return false;
  const next = line.charCodeAt(idx + issueUrl.length);
  // NaN (end of string) → digit boundary OK. Otherwise reject any digit
  // immediately after the URL so 'issues/1' doesn't match 'issues/10'.
  return Number.isNaN(next) || next < 48 /* '0' */ || next > 57; /* '9' */
}

/** Find the issue block (issue line plus any indented sub-bullets) that mentions the URL. */
function findIssueBlock(lines: string[], issueUrl: string): IssueBlock | undefined {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!ISSUE_LINE_RE.test(line)) continue;
    if (!lineMentionsUrl(line, issueUrl)) continue;
    let end = i + 1;
    while (end < lines.length && /^\s{2,}/.test(lines[end])) end++;
    return { start: i, end };
  }
  return undefined;
}

/** Find the `### repo/...` heading enclosing a given line index, plus its end (next heading at depth ≤ 3). */
function findRepoSection(lines: string[], lineIndex: number): RepoSection | undefined {
  let headingIndex: number | undefined;
  for (let i = lineIndex - 1; i >= 0; i--) {
    if (REPO_HEADING_RE.test(lines[i])) {
      headingIndex = i;
      break;
    }
    if (/^#{1,2}\s/.test(lines[i])) return undefined;
  }
  if (headingIndex === undefined) return undefined;
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (SECTION_BREAK_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { headingIndex, end };
}

/** Count issue lines under a section that are NOT yet struck through. */
function countOpenIssues(lines: string[], section: RepoSection): number {
  let open = 0;
  for (let i = section.headingIndex + 1; i < section.end; i++) {
    const line = lines[i];
    if (!ISSUE_LINE_RE.test(line)) continue;
    const body = line.replace(/^[*+-]\s+/, '');
    if (!(body.startsWith(STRIKE) && body.endsWith(STRIKE))) open++;
  }
  return open;
}

/** Pure transform — exposed for unit testing. */
export function markIssueAsDone(
  content: string,
  opts: { issueUrl: string; prUrl: string; prStatus: string },
): {
  content: string;
  marked: boolean;
  repoHeadingStruck: boolean;
  remainingUnderRepo: number;
  reason?: string;
} {
  const hadTrailingNewline = content.endsWith('\n');
  const lines = (hadTrailingNewline ? content.slice(0, -1) : content).split('\n');

  const block = findIssueBlock(lines, opts.issueUrl);
  if (!block) {
    return {
      content,
      marked: false,
      repoHeadingStruck: false,
      remainingUnderRepo: 0,
      reason: 'issue URL not found in the list',
    };
  }

  const issueLine = lines[block.start];
  const issueBody = issueLine.replace(/^[*+-]\s+/, '');
  const alreadyMarked = issueBody.startsWith(STRIKE) && issueBody.endsWith(STRIKE);

  if (alreadyMarked) {
    const section = findRepoSection(lines, block.start);
    return {
      content,
      marked: false,
      repoHeadingStruck: false,
      remainingUnderRepo: section ? countOpenIssues(lines, section) : 0,
      reason: 'already marked done',
    };
  }

  // 1. Strike the issue line.
  const struck = strikeLine(issueLine);
  lines[block.start] = struck.line;

  // 2. Insert the **Done** sub-bullet after the issue line and any existing sub-bullets.
  const doneSubBullet = `${DONE_PREFIX} — PR [${prNumberLabel(opts.prUrl)}](${opts.prUrl}) submitted, ${opts.prStatus}.`;
  // If the previously-existing sub-bullets already contain a Done line, treat as idempotent.
  const existingSubBullets = lines.slice(block.start + 1, block.end);
  const hasDoneAlready = existingSubBullets.some((l) => l.trim().startsWith('- **Done**'));
  if (!hasDoneAlready) {
    lines.splice(block.end, 0, doneSubBullet);
  }

  // 3. If every issue under this repo heading is now struck, strike the heading too.
  const section = findRepoSection(lines, block.start);
  let repoHeadingStruck = false;
  let remaining = 0;
  if (section) {
    // Recompute end since we may have inserted a sub-bullet.
    const refreshed = findRepoSection(lines, block.start);
    if (refreshed) {
      remaining = countOpenIssues(lines, refreshed);
      const headingLine = lines[refreshed.headingIndex];
      const headingBody = headingLine.replace(/^#{3}\s+/, '');
      const headingAlreadyStruck = headingBody.startsWith(STRIKE) && headingBody.endsWith(STRIKE);
      if (remaining === 0 && !headingAlreadyStruck) {
        const result = strikeLine(headingLine);
        lines[refreshed.headingIndex] = result.line;
        repoHeadingStruck = !result.alreadyStruck;
      }
    }
  }

  let next = lines.join('\n');
  if (hadTrailingNewline) next += '\n';

  return {
    content: next,
    marked: true,
    repoHeadingStruck,
    remainingUnderRepo: remaining,
  };
}

/** Read → transform → write atomically (tmp + rename) so a crash mid-write can't corrupt the file. */
export async function runMarkIssueListItemDone(options: MarkDoneOptions): Promise<MarkDoneOutput> {
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

  const result = markIssueAsDone(content, {
    issueUrl: options.issueUrl,
    prUrl: options.prUrl,
    prStatus: options.prStatus,
  });

  if (result.marked) {
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, result.content, 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
      throw new Error(`Failed to write file: ${errorMessage(error)}`, { cause: error });
    }
  }

  return {
    marked: result.marked,
    filePath,
    url: options.issueUrl,
    repoHeadingStruck: result.repoHeadingStruck,
    remainingUnderRepo: result.remainingUnderRepo,
    reason: result.reason,
  };
}
