/**
 * Snooze/Unsnooze commands
 * Manages snoozing CI failure notifications for PRs with known upstream/infrastructure issues.
 * Snoozed PRs are excluded from the actionable CI failure list until the snooze expires.
 */

import { getStateManager } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';
import { PR_URL_PATTERN, validateGitHubUrl, validateUrl, validateMessage } from './validation.js';

const DEFAULT_SNOOZE_DAYS = 7;

interface SnoozeCommandOptions {
  prUrl: string;
  reason: string;
  days?: number;
  json?: boolean;
}

interface UnsnoozeCommandOptions {
  prUrl: string;
  json?: boolean;
}

export async function runSnooze(options: SnoozeCommandOptions): Promise<void> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR', options.json);
  validateMessage(options.reason);

  const days = options.days ?? DEFAULT_SNOOZE_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    if (options.json) {
      outputJsonError('Snooze duration must be a positive number of days.');
    } else {
      console.error('Error: Snooze duration must be a positive number of days.');
    }
    process.exit(1);
  }

  try {
    const stateManager = getStateManager();
    const added = stateManager.snoozePR(options.prUrl, options.reason, days);

    if (added) {
      stateManager.save();
    }

    const snoozeInfo = stateManager.getSnoozeInfo(options.prUrl);

    if (options.json) {
      outputJson({ snoozed: added, url: options.prUrl, days, reason: options.reason, expiresAt: snoozeInfo?.expiresAt });
    } else if (added) {
      console.log(`Snoozed: ${options.prUrl}`);
      console.log(`Reason: ${options.reason}`);
      console.log(`Duration: ${days} day${days === 1 ? '' : 's'}`);
      console.log(`Expires: ${snoozeInfo?.expiresAt ? new Date(snoozeInfo.expiresAt).toLocaleString() : 'unknown'}`);
      console.log('CI failure notifications are now muted for this PR.');
    } else {
      console.log('PR is already snoozed.');
      if (snoozeInfo) {
        console.log(`Expires: ${new Date(snoozeInfo.expiresAt).toLocaleString()}`);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (options.json) {
      outputJsonError(`Snooze failed: ${msg}`);
    } else {
      console.error(`Error: Snooze failed: ${msg}`);
    }
    process.exit(1);
  }
}

export async function runUnsnooze(options: UnsnoozeCommandOptions): Promise<void> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR', options.json);

  const stateManager = getStateManager();
  const removed = stateManager.unsnoozePR(options.prUrl);

  if (removed) {
    stateManager.save();
  }

  if (options.json) {
    outputJson({ unsnoozed: removed, url: options.prUrl });
  } else if (removed) {
    console.log(`Unsnoozed: ${options.prUrl}`);
    console.log('CI failure notifications are active again for this PR.');
  } else {
    console.log('PR was not snoozed.');
  }
}
