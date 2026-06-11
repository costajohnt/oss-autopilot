/**
 * Dismiss/Undismiss commands
 * Manages dismissing issue notifications without posting a comment.
 * Dismissed URLs resurface automatically when new responses arrive after the dismiss timestamp.
 */

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

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
 * @param options.url - Full GitHub issue URL
 * @returns Whether the issue was newly dismissed (false if already dismissed)
 * @throws {ValidationError} If the URL is not a valid GitHub issue URL
 */
export async function runDismiss(options: { url: string }): Promise<DismissOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_URL_PATTERN, 'issue');

  const stateManager = getStateManager();
  const added = stateManager.dismissIssue(options.url, new Date().toISOString());
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);

  return { dismissed: added, url: options.url, ...(gistSyncWarning ? { gistSyncWarning } : {}) };
}

/**
 * Restore a dismissed issue to notifications.
 *
 * @param options - Undismiss options
 * @param options.url - Full GitHub issue URL
 * @returns Whether the issue was undismissed (false if not currently dismissed)
 * @throws {ValidationError} If the URL is not a valid GitHub issue URL
 */
export async function runUndismiss(options: { url: string }): Promise<UndismissOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_URL_PATTERN, 'issue');

  const stateManager = getStateManager();
  const removed = stateManager.undismissIssue(options.url);
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);

  return { undismissed: removed, url: options.url, ...(gistSyncWarning ? { gistSyncWarning } : {}) };
}
