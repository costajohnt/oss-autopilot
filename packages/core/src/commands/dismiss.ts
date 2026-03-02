/**
 * Dismiss/Undismiss commands
 * Manages dismissing issue and PR notifications without posting a comment.
 * Dismissed URLs resurface automatically when new responses arrive after the dismiss timestamp.
 */

import { getStateManager } from '../core/index.js';
import { ISSUE_OR_PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export interface DismissOutput {
  dismissed: boolean;
  url: string;
}

export interface UndismissOutput {
  undismissed: boolean;
  url: string;
}


export async function runDismiss(options: { url: string }): Promise<DismissOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_OR_PR_URL_PATTERN, 'issue or PR');

  const stateManager = getStateManager();
  const added = stateManager.dismissIssue(options.url, new Date().toISOString());

  if (added) {
    stateManager.save();
  }

  return { dismissed: added, url: options.url };
}

export async function runUndismiss(options: { url: string }): Promise<UndismissOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_OR_PR_URL_PATTERN, 'issue or PR');

  const stateManager = getStateManager();
  const removed = stateManager.undismissIssue(options.url);

  if (removed) {
    stateManager.save();
  }

  return { undismissed: removed, url: options.url };
}
