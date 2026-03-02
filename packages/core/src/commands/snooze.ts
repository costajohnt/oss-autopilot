/**
 * Snooze/Unsnooze commands
 * Manages snoozing CI failure notifications for PRs with known upstream/infrastructure issues.
 * Snoozed PRs are excluded from the actionable CI failure list until the snooze expires.
 */

import { getStateManager } from '../core/index.js';
import { PR_URL_PATTERN, validateGitHubUrl, validateUrl, validateMessage } from './validation.js';

const DEFAULT_SNOOZE_DAYS = 7;

export interface SnoozeOutput {
  snoozed: boolean;
  url: string;
  days: number;
  reason: string;
  expiresAt: string | undefined;
}

export interface UnsnoozeOutput {
  unsnoozed: boolean;
  url: string;
}

export async function runSnooze(options: { prUrl: string; reason: string; days?: number }): Promise<SnoozeOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');
  validateMessage(options.reason);

  const days = options.days ?? DEFAULT_SNOOZE_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('Snooze duration must be a positive number of days.');
  }

  const stateManager = getStateManager();
  const added = stateManager.snoozePR(options.prUrl, options.reason, days);

  if (added) {
    stateManager.save();
  }

  const snoozeInfo = stateManager.getSnoozeInfo(options.prUrl);

  return {
    snoozed: added,
    url: options.prUrl,
    days,
    reason: options.reason,
    expiresAt: snoozeInfo?.expiresAt,
  };
}

export async function runUnsnooze(options: { prUrl: string }): Promise<UnsnoozeOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const stateManager = getStateManager();
  const removed = stateManager.unsnoozePR(options.prUrl);

  if (removed) {
    stateManager.save();
  }

  return { unsnoozed: removed, url: options.prUrl };
}
