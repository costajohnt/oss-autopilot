/**
 * Dismiss/Undismiss commands
 * Manages dismissing issue notifications without posting a comment.
 * Dismissed URLs resurface automatically when new responses arrive after the dismiss timestamp.
 *
 * PR URLs are accepted too: dismissing a merged PR's URL declines the
 * "merged PR with maintainer notes" nudge (#1861), and dismissing a PR the
 * user reviewed declines its review follow-up (#1857), for the activity
 * posted so far, with the same stamp-based resurfacing when newer activity
 * lands. A review follow-up dismissed with `--head <sha>` also records the
 * PR's head, so a push (new head) brings it back while bot, label and
 * bystander updates do not; see `daily-reviewed-prs.ts`.
 */

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import {
  ISSUE_OR_PR_URL_PATTERN,
  PR_URL_PATTERN,
  validateCommitSha,
  validateGitHubUrl,
  validateUrl,
} from './validation.js';

const MODULE = 'dismiss';

export interface DismissOutput {
  dismissed: boolean;
  url: string;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

export interface UndismissOutput {
  undismissed: boolean;
  url: string;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

/**
 * Dismiss an issue's reply notifications without posting a comment.
 * The dismissal auto-resurfaces when new responses arrive after the dismiss timestamp.
 *
 * A PR URL is always re-stamped: the merged-PR notes and review follow-up
 * phases compare the stamp with the newest activity, so a second "skip" after
 * newer activity has to move the stamp forward or it would be a no-op. Issue dismissals keep their first
 * stamp (the issue path auto-undismisses on new activity instead).
 *
 * @param options - Dismiss options
 * @param options.url - Full GitHub issue or PR URL
 * @param options.head - For a PR URL: the PR's full head SHA at dismiss time
 *   (the review follow-up entry's `headSha`). Recorded so the follow-up stays
 *   hidden until the head moves or someone comments after the dismiss.
 *   Without it, only the stamp decides, and any update to the PR can resurface it.
 * @returns Whether the issue was newly dismissed (false if already dismissed);
 *   always true for a PR URL
 * @throws {ValidationError} If the URL is not a valid GitHub issue or PR URL,
 *   if `head` is not a full 40-hex SHA, or if `head` is given with an issue URL
 */
export async function runDismiss(options: { url: string; head?: string }): Promise<DismissOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_OR_PR_URL_PATTERN, 'issue or PR');
  const isPR = PR_URL_PATTERN.test(options.url);
  if (!isPR && options.head !== undefined) {
    throw new ValidationError('--head applies to PR URLs only: a dismissed issue has no head commit');
  }

  const stateManager = getStateManager();
  const dismissedAt = new Date().toISOString();
  const dismissOptions = {
    refresh: isPR,
    ...(options.head !== undefined && { headSha: validateCommitSha(options.head) }),
  };
  const added = stateManager.dismissIssue(options.url, dismissedAt, dismissOptions);
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE, () =>
    stateManager.dismissIssue(options.url, dismissedAt, dismissOptions),
  );

  return { dismissed: added, url: options.url, ...(gistSyncWarning && { gistSyncWarning }) };
}

/**
 * Restore a dismissed issue to notifications.
 *
 * @param options - Undismiss options
 * @param options.url - Full GitHub issue or PR URL
 * @returns Whether the issue was undismissed (false if not currently dismissed)
 * @throws {ValidationError} If the URL is not a valid GitHub issue or PR URL
 */
export async function runUndismiss(options: { url: string }): Promise<UndismissOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_OR_PR_URL_PATTERN, 'issue or PR');

  const stateManager = getStateManager();
  const removed = stateManager.undismissIssue(options.url);
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE, () => stateManager.undismissIssue(options.url));

  return { undismissed: removed, url: options.url, ...(gistSyncWarning && { gistSyncWarning }) };
}
