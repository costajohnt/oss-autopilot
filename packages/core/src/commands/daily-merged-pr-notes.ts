/**
 * Daily Phase 3.7: maintainer notes on recently merged PRs (#1861).
 *
 * Kept out of daily.ts (file-size ceiling). Pure selection lives in
 * core/merged-pr-notes.ts; this module owns the per-PR fetch, the dismiss
 * check, the warnings, and the agent-facing fencing of note excerpts.
 */

import {
  getStateManager,
  groupThanksOnlyAcknowledgments,
  latestNoteAt,
  omitAcknowledgedViaCarrier,
  scanMergedPR,
  type CarrierReply,
  type PRMonitor,
  type MergedPR,
  type MergedPRNotes,
} from '../core/index.js';
import { isRateLimitOrAuthError } from '../core/errors.js';
import { DEFAULT_CONCURRENCY, runWorkerPool } from '../core/concurrency.js';
import { debug, warn } from '../core/logger.js';
import { wrapUntrustedContent } from '../core/untrusted-content.js';
import type { DailyWarning } from '../formatters/json.js';
import { describeError, httpStatusLabel, isGoneError, recordWarning } from './daily-warnings.js';

const MODULE = 'daily';
const OPERATION = 'merged-PR maintainer notes';

type MergedPRActivityResult = Awaited<ReturnType<PRMonitor['fetchMergedPRActivity']>>;

/** What Phase 1 learned about the recently merged list. */
export interface MergedPRNotesInput {
  recentlyMergedPRs: MergedPR[];
  /** The list is the [] fallback of a failed fetch; the phase is skipped with a warning. */
  recentlyMergedFetchFailed: boolean;
}

/**
 * Whether the user declined this PR's notes: its URL was dismissed at or
 * after the newest note. A note newer than the dismiss resurfaces the PR,
 * same as issue replies. An unreadable stamp fails open (the PR is listed)
 * with a log line, matching the issue path's dismiss filter.
 */
function isDismissed(prUrl: string, notes: MergedPRNotes, dismissedAt: string | undefined): boolean {
  if (dismissedAt === undefined) return false;
  const dismissedMs = Date.parse(dismissedAt);
  if (Number.isNaN(dismissedMs)) {
    warn(
      MODULE,
      `merged-pr-notes: ${prUrl} has an unreadable dismiss timestamp ${JSON.stringify(dismissedAt)}; listing`,
    );
    return false;
  }
  const newestNoteAt = latestNoteAt(notes);
  if (dismissedMs >= Date.parse(newestNoteAt)) {
    debug(MODULE, `merged-pr-notes: ${prUrl} dismissed at ${dismissedAt}, after newest note ${newestNoteAt}; skipping`);
    return true;
  }
  return false;
}

/**
 * Fetch one PR's activity, turning a failure into a warning that names the
 * PR and its HTTP status. Returns undefined when the PR is dropped for this
 * run: on a fetch error, or when any of the four lists hit the pagination
 * cap (the cap cuts the newest items, which is where the user's own reply
 * would be, so an incomplete thread would nag about an answered note).
 * Rate-limit/auth errors propagate.
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
  if (activity.truncatedLists.length > 0) {
    recordWarning(
      warnings,
      'merged-pr-notes',
      operation,
      null,
      `pagination cap reached on ${activity.truncatedLists.join(', ')}; the newest activity (including any reply of yours) may be missing; dropped`,
    );
    return undefined;
  }
  return activity;
}

/**
 * For each PR in this run's recently merged list (already limited to repos
 * the user does not own and outside `untrackedOrgs` by the search), fetch its
 * comments, reviews, inline review comments and commits and keep the notes
 * `scanMergedPR` says still wait for the user: maintainer comments after the
 * user's last word (comment or commit) and no earlier than an hour before
 * the merge, plus commits someone else pushed on top. Thanks-only entries in
 * one repo collapse onto the most recent PR (`ackCoveredBy`), and once the
 * user has commented on that carrier the covered entries stop coming back
 * (`omitAcknowledgedViaCarrier`).
 *
 * "Only once": nothing is written to state. An entry disappears when the
 * user comments on the PR (or on its group's carrier) after the notes, when
 * they dismiss the PR URL at or after the newest note (the workflow's "skip"
 * runs the existing `dismiss`, which accepts PR URLs and re-stamps on
 * repeat), and at the latest when the PR leaves the recently-merged window.
 *
 * Non-fatal: a per-PR failure (fetch error, pagination cap, or an error
 * while reading the thread) drops that PR with a `merged-pr-notes` warning
 * naming it; rate-limit/auth errors propagate like every other phase's.
 */
async function prepareMergedPRNotes(
  prMonitor: PRMonitor,
  { recentlyMergedPRs, recentlyMergedFetchFailed }: MergedPRNotesInput,
  warnings: DailyWarning[],
): Promise<MergedPRNotes[]> {
  if (recentlyMergedFetchFailed) {
    recordWarning(warnings, 'merged-pr-notes', OPERATION, null, 'skipped: recently-merged fetch failed');
    return [];
  }
  if (recentlyMergedPRs.length === 0) return [];

  const stateManager = getStateManager();
  const username = stateManager.getState().config.githubUsername;
  if (!username) {
    recordWarning(warnings, 'merged-pr-notes', OPERATION, null, 'skipped: no GitHub username configured');
    return [];
  }

  // Keyed by PR so the output keeps the fetched order however the workers finish.
  const pending = new Map<MergedPR, MergedPRNotes>();
  const carriers: CarrierReply[] = [];
  const recordScan = (pr: MergedPR, activity: MergedPRActivityResult): void => {
    const scan = scanMergedPR(pr, activity, username);
    if (scan.thanksOnlyThread) {
      carriers.push({ prUrl: pr.url, repo: pr.repo, mergedAt: pr.mergedAt, lastUserCommentMs: scan.lastUserCommentMs });
    }
    if (!scan.pending || isDismissed(pr.url, scan.pending, stateManager.getIssueDismissedAt(pr.url))) return;
    pending.set(pr, scan.pending);
  };
  await runWorkerPool(
    recentlyMergedPRs,
    async (pr) => {
      const activity = await fetchActivity(prMonitor, pr, warnings);
      if (!activity) return;
      try {
        recordScan(pr, activity);
      } catch (error) {
        if (isRateLimitOrAuthError(error)) throw error;
        recordWarning(
          warnings,
          'merged-pr-notes',
          `read activity on ${pr.url}`,
          error,
          `${describeError(error)}; dropped`,
        );
      }
    },
    DEFAULT_CONCURRENCY,
  );

  const ordered: MergedPRNotes[] = [];
  for (const pr of recentlyMergedPRs) {
    const notes = pending.get(pr);
    if (notes) ordered.push(notes);
  }
  return groupThanksOnlyAcknowledgments(omitAcknowledgedViaCarrier(ordered, carriers));
}

/**
 * Phase 3.7 entry point: runs {@link prepareMergedPRNotes} and turns any
 * non-fatal failure into a `merged-pr-notes` warning plus an empty list.
 * Rate-limit/auth errors end the run like every other phase's.
 */
export async function runMergedPRNotesPhase(
  prMonitor: PRMonitor,
  input: MergedPRNotesInput,
  warnings: DailyWarning[],
): Promise<MergedPRNotes[]> {
  try {
    return await prepareMergedPRNotes(prMonitor, input, warnings);
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
