/**
 * Dismiss/Undismiss commands
 * Manages dismissing issue reply notifications without posting a comment.
 * Dismissed issues resurface automatically when new responses arrive after the dismiss timestamp.
 */

import { getStateManager } from '../core/index.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export interface DismissOutput {
  dismissed: boolean;
  url: string;
}

export interface UndismissOutput {
  undismissed: boolean;
  url: string;
}

// Re-export for backward compatibility with tests
export { ISSUE_URL_PATTERN };

export async function runDismiss(options: { issueUrl: string }): Promise<DismissOutput> {
  validateUrl(options.issueUrl);
  validateGitHubUrl(options.issueUrl, ISSUE_URL_PATTERN, 'issue');

  const stateManager = getStateManager();
  const added = stateManager.dismissIssue(options.issueUrl, new Date().toISOString());

  if (added) {
    stateManager.save();
  }

  return { dismissed: added, url: options.issueUrl };
}

export async function runUndismiss(options: { issueUrl: string }): Promise<UndismissOutput> {
  validateUrl(options.issueUrl);
  validateGitHubUrl(options.issueUrl, ISSUE_URL_PATTERN, 'issue');

  const stateManager = getStateManager();
  const removed = stateManager.undismissIssue(options.issueUrl);

  if (removed) {
    stateManager.save();
  }

  return { undismissed: removed, url: options.issueUrl };
}
