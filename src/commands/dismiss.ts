/**
 * Dismiss/Undismiss commands
 * Manages dismissing issue reply notifications without posting a comment.
 * Dismissed issues resurface automatically when new responses arrive after the dismiss timestamp.
 */

import { getStateManager } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl } from './validation.js';

interface DismissCommandOptions {
  issueUrl: string;
  json?: boolean;
}

// Re-export for backward compatibility with tests
export { ISSUE_URL_PATTERN };

export async function runDismiss(options: DismissCommandOptions): Promise<void> {
  validateGitHubUrl(options.issueUrl, ISSUE_URL_PATTERN, 'issue', options.json);

  const stateManager = getStateManager();
  const added = stateManager.dismissIssue(options.issueUrl, new Date().toISOString());

  if (added) {
    stateManager.save();
  }

  if (options.json) {
    outputJson({ dismissed: added, url: options.issueUrl });
  } else if (added) {
    console.log(`Dismissed: ${options.issueUrl}`);
    console.log('Issue reply notifications are now muted.');
    console.log('New responses after this point will resurface automatically.');
  } else {
    console.log('Issue is already dismissed.');
  }
}

export async function runUndismiss(options: DismissCommandOptions): Promise<void> {
  validateGitHubUrl(options.issueUrl, ISSUE_URL_PATTERN, 'issue', options.json);

  const stateManager = getStateManager();
  const removed = stateManager.undismissIssue(options.issueUrl);

  if (removed) {
    stateManager.save();
  }

  if (options.json) {
    outputJson({ undismissed: removed, url: options.issueUrl });
  } else if (removed) {
    console.log(`Undismissed: ${options.issueUrl}`);
    console.log('Issue reply notifications are active again.');
  } else {
    console.log('Issue was not dismissed.');
  }
}
