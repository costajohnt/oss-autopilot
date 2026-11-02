/**
 * Dismiss/Undismiss commands
 * Manages dismissing issue notifications without posting a comment.
 * Dismissed URLs resurface automatically when new responses arrive after the dismiss timestamp.
 *
 * PR URLs are accepted too (#1861): dismissing a merged PR's URL declines the
 * "merged PR with maintainer notes" nudge for the notes posted so far, with
 * the same stamp-based resurfacing when newer notes land.
 */

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { ISSUE_OR_PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

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
 * @param options - Dismiss options
 * @param options.url - Full GitHub issue or PR URL
 * @returns Whether the issue was newly dismissed (false if already dismissed)
 * @throws {ValidationError} If the URL is not a valid GitHub issue or PR URL
 */
export async function runDismiss(options: { url: string }): Promise<DismissOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_OR_PR_URL_PATTERN, 'issue or PR');

  const stateManager = getStateManager();
  const dismissedAt = new Date().toISOString();
  const added = stateManager.dismissIssue(options.url, dismissedAt);
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE, () =>
    stateManager.dismissIssue(options.url, dismissedAt),
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
