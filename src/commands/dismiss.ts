/**
 * Dismiss/Undismiss commands
 * Manages dismissing issue reply notifications without posting a comment.
 * Dismissed issues resurface automatically when new responses arrive after the dismiss timestamp.
 */

import { getStateManager } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

interface DismissCommandOptions {
  issueUrl: string;
  json?: boolean;
}

/** @internal Exported for testing */
export const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;

function validateIssueUrl(issueUrl: string, json?: boolean): void {
  if (ISSUE_URL_PATTERN.test(issueUrl)) return;

  if (json) {
    outputJsonError(`Invalid issue URL: ${issueUrl}. Expected format: https://github.com/owner/repo/issues/123`);
  } else {
    console.error(`Error: Invalid issue URL: ${issueUrl}`);
    console.error('Expected format: https://github.com/owner/repo/issues/123');
  }
  process.exit(1);
}

export async function runDismiss(options: DismissCommandOptions): Promise<void> {
  validateIssueUrl(options.issueUrl, options.json);

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
  validateIssueUrl(options.issueUrl, options.json);

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
