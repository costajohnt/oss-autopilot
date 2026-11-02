/**
 * Daily Phase 3.7: maintainer notes on recently merged PRs (#1861).
 *
 * Kept out of daily.ts (file-size ceiling). Pure selection lives in
 * core/merged-pr-notes.ts; this module owns the per-PR fetch, the dismiss
 * check, the warnings, and the agent-facing fencing of note excerpts.
 */

import {
  getStateManager,
  collectMergedPRNotes,
  groupThanksOnlyAcknowledgments,
  latestNoteAt,
  type PRMonitor,
  type MergedPR,
  type MergedPRNotes,
} from '../core/index.js';
import { isRateLimitOrAuthError } from '../core/errors.js';
import { DEFAULT_CONCURRENCY, runWorkerPool } from '../core/concurrency.js';
import { debug } from '../core/logger.js';
import { wrapUntrustedContent } from '../core/untrusted-content.js';
import type { DailyWarning } from '../formatters/json.js';
import { describeError, httpStatusLabel, isGoneError, recordWarning } from './daily-warnings.js';

const MODULE = 'daily';
const OPERATION = 'merged-PR maintainer notes';

type MergedPRActivityResult = Awaited<ReturnType<PRMonitor['fetchMergedPRActivity']>>;

/**
 * Whether the user declined this PR's notes: its URL was dismissed at or
 * after the newest note (or with an unreadable stamp). A note newer than the
 * dismiss resurfaces the PR, same as issue replies.
 */
function isDismissed(prUrl: string, notes: MergedPRNotes, dismissedAt: string | undefined): boolean {
  if (dismissedAt === undefined) return false;
  const dismissedMs = Date.parse(dismissedAt);
  const newestNoteAt = latestNoteAt(notes);
  if (Number.isNaN(dismissedMs) || dismissedMs >= Date.parse(newestNoteAt)) {
    debug(MODULE, `merged-pr-notes: ${prUrl} dismissed at ${dismissedAt}, after newest note ${newestNoteAt}; skipping`);
    return true;
  }
  return false;
}

/**
 * Fetch one PR's activity, turning a failure into a warning that names the
 * PR and its HTTP status. Returns undefined when the PR is dropped for this
 * run. Rate-limit/auth errors propagate.
 */
async function fetchActivity(
  prMonitor: PRMonitor,
  pr: MergedPR,
  warnings: DailyWarning[],
): Promise<MergedPRActivityResult | undefined> {
  const operation = `fetch activity on ${pr.url}`;
  let activity: MergedPRActivityResult;
  try {
    activity = await prMonitor.fetchMergedPRActivity(pr.url);
  } catch (error) {
    if (isRateLimitOrAuthError(error)) throw error;
    const detail = isGoneError(error)
      ? `PR no longer reachable (${httpStatusLabel(error)}); dropped`
      : `${describeError(error)}; dropped`;
    recordWarning(warnings, 'merged-pr-notes', operation, error, detail);
    return undefined;
  }
  if (activity.truncated) {
    recordWarning(
      warnings,
      'merged-pr-notes',
      operation,
      null,
      'pagination cap reached; the newest notes may be missing',
    );
  }
  return activity;
}

/**
 * For each PR in this run's recently merged list (already limited to repos
 * the user does not own and outside `untrackedOrgs` by the search), fetch its
 * comments, reviews, inline review comments and commits and keep the notes
 * `collectMergedPRNotes` says still wait for the user: maintainer comments
 * after the user's last word and no earlier than an hour before the merge,
 * plus commits someone else pushed on top. Thanks-only entries in one repo
 * collapse onto the most recent PR (`ackCoveredBy`).
 *
 * "Only once": nothing is written to state. An entry disappears when the
 * user comments on the PR after the notes, when they dismiss the PR URL at
 * or after the newest note (the workflow's "skip" runs the existing
 * `dismiss`, which accepts PR URLs), and at the latest when the PR leaves
 * the recently-merged window. A merged fetch that fell back to [] simply
 * yields no entries (that fallback already carries its own fetch warning).
 *
 * Non-fatal: a per-PR failure drops that PR with a `merged-pr-notes`
 * warning naming it and the HTTP status (404/410 as "no longer reachable");
 * rate-limit/auth errors propagate like every other phase's.
 */
async function prepareMergedPRNotes(
  prMonitor: PRMonitor,
  recentlyMergedPRs: MergedPR[],
  warnings: DailyWarning[],
): Promise<MergedPRNotes[]> {
  if (recentlyMergedPRs.length === 0) return [];

  const stateManager = getStateManager();
  const username = stateManager.getState().config.githubUsername;
  if (!username) {
    recordWarning(warnings, 'merged-pr-notes', OPERATION, null, 'skipped: no GitHub username configured');
    return [];
  }

  // Keyed by PR so the output keeps the fetched order however the workers finish.
  const found = new Map<MergedPR, MergedPRNotes>();
  await runWorkerPool(
    recentlyMergedPRs,
    async (pr) => {
      const activity = await fetchActivity(prMonitor, pr, warnings);
      if (!activity) return;
      const notes = collectMergedPRNotes(pr, activity, username);
      if (!notes || isDismissed(pr.url, notes, stateManager.getIssueDismissedAt(pr.url))) return;
      found.set(pr, notes);
    },
    DEFAULT_CONCURRENCY,
  );

  const ordered: MergedPRNotes[] = [];
  for (const pr of recentlyMergedPRs) {
    const notes = found.get(pr);
    if (notes) ordered.push(notes);
  }
  return groupThanksOnlyAcknowledgments(ordered);
}

/**
 * Phase 3.7 entry point: runs {@link prepareMergedPRNotes} and turns any
 * non-fatal failure into a `merged-pr-notes` warning plus an empty list.
 * Rate-limit/auth errors end the run like every other phase's.
 */
export async function runMergedPRNotesPhase(
  prMonitor: PRMonitor,
  recentlyMergedPRs: MergedPR[],
  warnings: DailyWarning[],
): Promise<MergedPRNotes[]> {
  try {
    return await prepareMergedPRNotes(prMonitor, recentlyMergedPRs, warnings);
  } catch (error) {
    if (isRateLimitOrAuthError(error)) throw error;
    recordWarning(warnings, 'merged-pr-notes', 'prepare merged-PR maintainer notes', error);
    return [];
  }
}

/**
 * Fence the GitHub-sourced note excerpts for agent-facing JSON (#1372), at
 * the same boundary as daily.ts's `fenceCommentedIssue`: the internal result
 * keeps raw text for the text renderer and tests.
 */
export function fenceMergedPRNotes(entry: MergedPRNotes): MergedPRNotes {
  const label = `${entry.repo}#${entry.number}`;
  return {
    ...entry,
    notes: entry.notes.map((note) => ({
      ...note,
      excerpt: wrapUntrustedContent(note.excerpt, label, {
        author: note.author,
        source: note.kind === 'commit' ? 'pr-commit' : 'pr-comment',
      }),
    })),
  };
}
