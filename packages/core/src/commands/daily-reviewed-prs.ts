/**
 * Daily Phase 3.8: review follow-ups on PRs the user reviewed (#1857).
 *
 * Kept out of daily.ts (file-size ceiling). Pure selection lives in
 * core/reviewed-prs.ts; this module owns the search, the per-PR fetch, the
 * compare call that turns `reviewedSha` into a range or a rebase flag, the
 * dismiss check, the warnings, and the agent-facing fencing of excerpts.
 *
 * API cost per run: two searches (up to three pages each), then for every
 * reviewed PR not already dismissed at or after its last update, up to
 * {@link REVIEWED_PR_MAX_PER_RUN} of them, five calls (PR, comments,
 * reviews, inline comments, commits) and, when the PR turns out actionable
 * and the head moved, one compare.
 */

import {
  getStateManager,
  scanReviewedPR,
  type CompareStatus,
  type PRMonitor,
  type ReviewedPRFollowUp,
  type ReviewedPRRef,
} from '../core/index.js';
import { isRateLimitOrAuthError } from '../core/errors.js';
import { DEFAULT_CONCURRENCY, runWorkerPool } from '../core/concurrency.js';
import { debug, warn } from '../core/logger.js';
import { wrapUntrustedContent } from '../core/untrusted-content.js';
import type { DailyWarning } from '../formatters/json.js';
import { describeError, httpStatusLabel, isGoneError, recordWarning } from './daily-warnings.js';

const MODULE = 'daily';
const OPERATION = 'review follow-ups';

/**
 * Reviewed PRs enriched per run, most recently updated first (#1857). Five
 * calls each, so this bounds the phase at roughly 250 calls plus compares;
 * a reviewer with more open reviewed PRs than this sees one warning naming
 * how many were left unchecked. The search orders by `updated_at`, so the
 * PRs left out are the ones nothing has happened on for longest.
 */
export const REVIEWED_PR_MAX_PER_RUN = 50;

/** The three PRMonitor calls this phase makes; a structural type so tests can pass a stub. */
export type ReviewedPRSource = Pick<
  PRMonitor,
  'fetchReviewedOpenPRs' | 'fetchReviewedPRActivity' | 'fetchCompareStatus'
>;

type ReviewedPRActivityResult = Awaited<ReturnType<PRMonitor['fetchReviewedPRActivity']>>;

/**
 * Whether the user declined this PR: its URL was dismissed at or after
 * `activityAt` (the search's `updated_at` before the fetch, the newest
 * qualifying commit or comment after the scan). Newer activity resurfaces
 * the PR, same as merged-PR notes. An unreadable stamp fails open (the PR is
 * listed) with a log line, matching the issue path's dismiss filter.
 */
function isDismissed(prUrl: string, activityAt: string, dismissedAt: string | undefined): boolean {
  if (dismissedAt === undefined) return false;
  const dismissedMs = Date.parse(dismissedAt);
  const activityMs = Date.parse(activityAt);
  if (Number.isNaN(dismissedMs) || Number.isNaN(activityMs)) {
    warn(
      MODULE,
      `reviewed-prs: ${prUrl} has an unreadable dismiss (${JSON.stringify(dismissedAt)}) or activity (${JSON.stringify(activityAt)}) timestamp; listing`,
    );
    return false;
  }
  if (dismissedMs >= activityMs) {
    debug(MODULE, `reviewed-prs: ${prUrl} dismissed at ${dismissedAt}, after latest activity ${activityAt}; skipping`);
    return true;
  }
  return false;
}

/**
 * Fetch one PR's activity, turning a failure into a warning that names the
 * PR and its HTTP status. Returns undefined when the PR is dropped for this
 * run: on a fetch error, or when any list hit the pagination cap (the cap
 * cuts the newest items, which is where the author's reply and the user's
 * own re-review would be). Rate-limit/auth errors propagate.
 */
async function fetchActivity(
  source: ReviewedPRSource,
  pr: ReviewedPRRef,
  warnings: DailyWarning[],
): Promise<ReviewedPRActivityResult | undefined> {
  const operation = `fetch activity on ${pr.url}`;
  let activity: ReviewedPRActivityResult;
  try {
    activity = await source.fetchReviewedPRActivity(pr.url);
  } catch (error) {
    if (isRateLimitOrAuthError(error)) throw error;
    const detail = isGoneError(error)
      ? `PR no longer reachable (${httpStatusLabel(error)}); dropped`
      : `${describeError(error)}; dropped`;
    recordWarning(warnings, 'reviewed-prs', operation, error, detail);
    return undefined;
  }
  if (activity.truncatedLists.length > 0) {
    recordWarning(
      warnings,
      'reviewed-prs',
      operation,
      null,
      `pagination cap reached on ${activity.truncatedLists.join(', ')}; the newest activity (including any re-review of yours) may be missing; dropped`,
    );
    return undefined;
  }
  return activity;
}

/**
 * Fill in `compareRange` / `compareUrl` or `rebased` from GitHub's compare
 * status. No call when the head is where the review left it (comments
 * only) or when the reviewed commit could not be named. On an error other
 * than 404 (which `fetchCompareStatus` maps to `missing`) the entry keeps
 * neither range nor flag, with a warning: an unverified range could be
 * wrong, and the commit list is still there. Rate-limit/auth errors
 * propagate.
 */
async function resolveCompare(
  source: ReviewedPRSource,
  entry: ReviewedPRFollowUp,
  warnings: DailyWarning[],
): Promise<void> {
  if (entry.reviewedSha === undefined || entry.reviewedSha === entry.headSha) return;
  let status: CompareStatus;
  try {
    status = await source.fetchCompareStatus(entry.prUrl, entry.reviewedSha, entry.headSha);
  } catch (error) {
    if (isRateLimitOrAuthError(error)) throw error;
    recordWarning(
      warnings,
      'reviewed-prs',
      `compare ${entry.reviewedSha.slice(0, 7)}...${entry.headSha.slice(0, 7)} on ${entry.prUrl}`,
      error,
      `${describeError(error)}; cannot tell whether the branch was rebased, showing the commit list only`,
    );
    return;
  }
  if (status === 'ahead' || status === 'identical') {
    entry.compareRange = `${entry.reviewedSha}...${entry.headSha}`;
    entry.compareUrl = `${entry.prUrl.replace(/\/pull\/\d+$/, '')}/compare/${entry.compareRange}`;
    return;
  }
  debug(MODULE, `reviewed-prs: ${entry.prUrl} compare status ${status}; flagging as rebased`);
  entry.rebased = true;
}

/**
 * Search for the open PRs the user reviewed or commented on but did not
 * author, fetch each one's thread, and keep the PRs where the author has
 * moved things since the user's last review or comment (`scanReviewedPR`):
 * commits pushed, a reply from the author, or a comment addressed to the
 * user. For each kept PR, ask GitHub whether the reviewed commit is still
 * an ancestor of the head: if so the entry carries the compare range, if
 * not it is flagged `rebased` and carries the commit list instead.
 *
 * "Only once": nothing is written to state. An entry disappears when the
 * user comments or reviews again (their last word moves past the activity),
 * when they dismiss the PR URL at or after the newest activity (the
 * workflow's "skip" runs the existing `dismiss`, which accepts PR URLs and
 * re-stamps on repeat), and when the PR closes or merges. A PR dismissed at
 * or after its search `updated_at` is skipped before any per-PR call.
 *
 * Never counted toward capacity or `needsAddressingPRs`: these are other
 * people's PRs.
 *
 * Non-fatal: a per-PR failure (fetch error, pagination cap, an error while
 * reading the thread, or a failed compare) drops or degrades that PR with a
 * `reviewed-prs` warning naming it; rate-limit/auth errors propagate like
 * every other phase's.
 */
async function prepareReviewedPRs(source: ReviewedPRSource, warnings: DailyWarning[]): Promise<ReviewedPRFollowUp[]> {
  const stateManager = getStateManager();
  const username = stateManager.getState().config.githubUsername;
  if (!username) {
    recordWarning(warnings, 'reviewed-prs', OPERATION, null, 'skipped: no GitHub username configured');
    return [];
  }

  const search = await source.fetchReviewedOpenPRs();
  for (const message of search.warnings) {
    recordWarning(warnings, 'reviewed-prs', 'search reviewed PRs (truncated)', null, message);
  }
  const notDismissed = search.prs.filter(
    (pr) => !isDismissed(pr.url, pr.updatedAt, stateManager.getIssueDismissedAt(pr.url)),
  );
  const candidates = notDismissed.slice(0, REVIEWED_PR_MAX_PER_RUN);
  if (notDismissed.length > candidates.length) {
    recordWarning(
      warnings,
      'reviewed-prs',
      OPERATION,
      null,
      `${notDismissed.length - candidates.length} reviewed PR(s) beyond the per-run cap of ${REVIEWED_PR_MAX_PER_RUN} were not checked (the least recently updated); dismiss or re-review stale ones to make room`,
    );
  }
  if (candidates.length === 0) return [];

  // Keyed by PR so the output keeps the search order however the workers finish.
  const pending = new Map<ReviewedPRRef, ReviewedPRFollowUp>();
  await runWorkerPool(
    candidates,
    async (pr) => {
      const activity = await fetchActivity(source, pr, warnings);
      if (!activity) return;
      let entry: ReviewedPRFollowUp | null;
      try {
        entry = scanReviewedPR(pr, activity, username);
      } catch (error) {
        if (isRateLimitOrAuthError(error)) throw error;
        recordWarning(
          warnings,
          'reviewed-prs',
          `read activity on ${pr.url}`,
          error,
          `${describeError(error)}; dropped`,
        );
        return;
      }
      if (!entry || isDismissed(pr.url, entry.latestActivityAt, stateManager.getIssueDismissedAt(pr.url))) return;
      await resolveCompare(source, entry, warnings);
      pending.set(pr, entry);
    },
    DEFAULT_CONCURRENCY,
  );

  const ordered: ReviewedPRFollowUp[] = [];
  for (const pr of candidates) {
    const entry = pending.get(pr);
    if (entry) ordered.push(entry);
  }
  return ordered;
}

/**
 * Phase 3.8 entry point: runs {@link prepareReviewedPRs} and turns any
 * non-fatal failure (including a failed search) into a `reviewed-prs`
 * warning plus an empty list. Rate-limit/auth errors end the run like every
 * other phase's.
 */
export async function runReviewedPRsPhase(
  source: ReviewedPRSource,
  warnings: DailyWarning[],
): Promise<ReviewedPRFollowUp[]> {
  try {
    return await prepareReviewedPRs(source, warnings);
  } catch (error) {
    if (isRateLimitOrAuthError(error)) throw error;
    recordWarning(warnings, 'reviewed-prs', `prepare ${OPERATION}`, error);
    return [];
  }
}

/**
 * Fence the GitHub-sourced text for agent-facing JSON (#1372), at the same
 * boundary as daily.ts's `fenceCommentedIssue`: question excerpts and commit
 * subjects. The internal result keeps raw text for the text renderer and
 * tests.
 */
export function fenceReviewedPR(entry: ReviewedPRFollowUp): ReviewedPRFollowUp {
  const label = `${entry.repo}#${entry.number}`;
  return {
    ...entry,
    questions: entry.questions.map((question) => ({
      ...question,
      excerpt: wrapUntrustedContent(question.excerpt, label, { author: question.author, source: 'pr-comment' }),
    })),
    commits: entry.commits.map((commit) => ({
      ...commit,
      subject: wrapUntrustedContent(commit.subject, label, { author: commit.author, source: 'pr-commit' }),
    })),
  };
}
