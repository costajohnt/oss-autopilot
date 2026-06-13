/**
 * Close the merge loop (#1463).
 *
 * When the daily check detects recently merged PRs, nothing previously
 * connected the merge back to the curated issue list — `list-mark-done` is
 * only offered interactively at PR-creation time (draft-first-workflow
 * Step 10), so a skipped prompt left the entry open forever.
 *
 * The join: neither the merged-PR search result (url/repo/number/title/
 * mergedAt) nor `state.activeIssues` (TrackedIssue — issue URL only, no PR
 * URL) carries a deterministic PR→issue link. The only deterministic
 * linkage lives in the curated list itself: workflows record the PR URL in
 * an entry's sub-bullets (`**Done**` at Step 10, or in-progress markers
 * like `**In Progress** — PR [#N](url)`). So the reconciliation traverses
 * the list file's entry blocks for the merged PR URL, recovers the entry's
 * own URL from its entry line, and marks it done via the exact transform
 * `list-mark-done` uses. Repo-level guessing (matching a merged PR to "some
 * claimed issue in the same repo") is deliberately avoided — it could
 * strike the wrong entry when a repo has several listed issues.
 *
 * Auto vs offer: marking a list entry done for a PR that GitHub reports as
 * MERGED is safe and idempotent (already-marked entries are quiet no-ops),
 * so it runs automatically. The extract-learnings nudge stays an offer —
 * it costs API calls and an LLM pass — surfaced via the action menu's
 * `extract_learnings` item (see computeActionMenu in core/daily-logic.ts).
 *
 * Failures never crash the daily run: they land in `warnings[]` under the
 * `merge-loop` phase.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorMessage } from '../core/errors.js';
import { warn } from '../core/logger.js';
import type { DailyWarning, MergedPRListUpdate } from '../formatters/json.js';
import { ENTRY_LINE_RE, lineMentionsUrl } from './curated-list.js';
import { markIssueAsDone } from './list-mark-done.js';
import { detectIssueListPath } from './locate-issue-list.js';

const MODULE = 'merge-loop';

/** First GitHub issue-or-PR URL on a line, without trailing punctuation. */
const GITHUB_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+/;

/**
 * Find the curated-list entry whose block (entry line plus indented
 * sub-bullets) mentions `prUrl`, and return the entry line's own GitHub
 * URL — the URL `markIssueAsDone` needs to locate the block again.
 *
 * Returns undefined when no entry block mentions the PR URL, or when the
 * mentioning block's entry line carries no GitHub URL (nothing for the
 * mark-done transform to anchor on).
 */
export function findListEntryUrlByPrUrl(content: string, prUrl: string): string | undefined {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (!ENTRY_LINE_RE.test(lines[i])) {
      i++;
      continue;
    }
    // Block = entry line + following indented sub-bullets (same shape as
    // list-mark-done's findIssueBlock).
    let end = i + 1;
    while (end < lines.length && /^\s{2,}/.test(lines[end])) end++;
    if (lines.slice(i, end).some((line) => lineMentionsUrl(line, prUrl))) {
      const match = GITHUB_URL_RE.exec(lines[i]);
      if (match) return match[0];
      // Entry line has no URL to anchor a mark-done on — keep scanning in
      // case a later block also mentions the PR (e.g. duplicate sections).
    }
    i = end;
  }
  return undefined;
}

export interface ReconcileMergedPRsInput {
  /** Recently merged PRs from the daily fetch (Phase 1). */
  mergedPRs: Array<{ url: string; mergedAt?: string }>;
  /** Shared daily warnings collector — failures land here, never throw. */
  warnings: DailyWarning[];
}

/**
 * Auto-mark curated-list entries done for recently merged PRs.
 *
 * Silent no-op cases (by design — these are normal, not failures):
 *   - no merged PRs this run
 *   - no curated list configured/detected
 *   - no list entry mentions a merged PR's URL
 *   - the matching entry is already marked done (idempotent re-run)
 *
 * Returns the entries actually struck this run, or undefined when nothing
 * changed — callers omit the field from output rather than emitting `[]`.
 */
export function reconcileMergedPRsWithList(input: ReconcileMergedPRsInput): MergedPRListUpdate[] | undefined {
  const { mergedPRs, warnings } = input;
  if (mergedPRs.length === 0) return undefined;

  const located = detectIssueListPath();
  if (!located) return undefined;
  const listPath = path.resolve(located.path);

  let content: string;
  try {
    content = fs.readFileSync(listPath, 'utf8');
  } catch (error) {
    const message = `read issue list at ${listPath}: ${errorMessage(error)}`;
    warnings.push({ phase: 'merge-loop', operation: 'auto-mark merged list entries', message });
    warn(MODULE, message);
    return undefined;
  }

  const updates: MergedPRListUpdate[] = [];
  for (const pr of mergedPRs) {
    const entryUrl = findListEntryUrlByPrUrl(content, pr.url);
    if (!entryUrl) continue;

    const prStatus = pr.mergedAt ? `merged ${pr.mergedAt.slice(0, 10)}` : 'merged';
    const result = markIssueAsDone(content, { issueUrl: entryUrl, prUrl: pr.url, prStatus });
    if (!result.marked) continue; // already-marked (or not-found race) — quiet no-op
    content = result.content;
    updates.push({
      prUrl: pr.url,
      issueUrl: entryUrl,
      repoHeadingStruck: result.repoHeadingStruck,
      listPath,
    });
  }

  if (updates.length === 0) return undefined;

  // Atomic write (tmp + rename), mirroring runMarkIssueListItemDone.
  const tmp = `${listPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, listPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    const message = `write issue list at ${listPath}: ${errorMessage(error)}`;
    warnings.push({ phase: 'merge-loop', operation: 'auto-mark merged list entries', message });
    warn(MODULE, message);
    // Nothing persisted — do not report updates that are not on disk.
    return undefined;
  }

  return updates;
}
