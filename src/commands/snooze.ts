/**
 * Snooze/Unsnooze commands
 * Manages snoozing CI failure notifications for PRs with known upstream/infrastructure issues.
 * Snoozed PRs are excluded from the actionable CI failure list until the snooze expires.
 */

import { getStateManager } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

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

/** @internal Exported for testing */
export const PR_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

function validatePRUrl(prUrl: string, json?: boolean): void {
  if (PR_URL_PATTERN.test(prUrl)) return;

  if (json) {
    outputJsonError(`Invalid PR URL: ${prUrl}. Expected format: https://github.com/owner/repo/pull/123`);
  } else {
    console.error(`Error: Invalid PR URL: ${prUrl}`);
    console.error('Expected format: https://github.com/owner/repo/pull/123');
  }
  process.exit(1);
}

export async function runSnooze(options: SnoozeCommandOptions): Promise<void> {
  validatePRUrl(options.prUrl, options.json);

  const days = options.days ?? DEFAULT_SNOOZE_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    if (options.json) {
      outputJsonError('Snooze duration must be a positive number of days.');
    } else {
      console.error('Error: Snooze duration must be a positive number of days.');
    }
    process.exit(1);
  }

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
}

export async function runUnsnooze(options: UnsnoozeCommandOptions): Promise<void> {
  validatePRUrl(options.prUrl, options.json);

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
