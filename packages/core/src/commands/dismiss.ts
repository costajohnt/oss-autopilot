/**
 * Dismiss/Undismiss commands
 * Manages dismissing issue notifications without posting a comment.
 * Dismissed URLs resurface automatically when new responses arrive after the dismiss timestamp.
 *
 * PR URLs are accepted too: dismissing a merged PR's URL declines the
 * "merged PR with maintainer notes" nudge (#1861), and dismissing a PR the
 * user reviewed declines its review follow-up (#1857), for the activity
 * posted so far, with the same stamp-based resurfacing when newer activity
 * lands.
 */

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { ISSUE_OR_PR_URL_PATTERN, PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

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
 * @returns Whether the issue was newly dismissed (false if already dismissed);
 *   always true for a PR URL
 * @throws {ValidationError} If the URL is not a valid GitHub issue or PR URL
 */
export async function runDismiss(options: { url: string }): Promise<DismissOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_OR_PR_URL_PATTERN, 'issue or PR');

  const stateManager = getStateManager();
  const dismissedAt = new Date().toISOString();
  const dismissOptions = { refresh: PR_URL_PATTERN.test(options.url) };
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
