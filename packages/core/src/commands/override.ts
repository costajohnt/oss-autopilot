/**
 * Override command
 * Manually override a PR's status (needs_addressing ↔ waiting_on_maintainer).
 * Overrides auto-clear when the PR has new activity.
 */

import { getStateManager } from '../core/index.js';
import type { FetchedPRStatus } from '../core/types.js';
import { PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export interface OverrideOutput {
  url: string;
  status: FetchedPRStatus;
}

export interface ClearOverrideOutput {
  url: string;
  cleared: boolean;
}

const VALID_STATUSES: FetchedPRStatus[] = ['needs_addressing', 'waiting_on_maintainer'];

export async function runOverride(options: { prUrl: string; status: string }): Promise<OverrideOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  if (!VALID_STATUSES.includes(options.status as FetchedPRStatus)) {
    throw new Error(`Invalid status "${options.status}". Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const status = options.status as FetchedPRStatus;
  const stateManager = getStateManager();

  // Use current time as lastActivityAt — the CLI doesn't have cached PR data.
  // This means the override will auto-clear on the next daily run if the PR's
  // updatedAt is after this timestamp (which is the desired behavior: the override
  // will persist until new activity occurs on the PR).
  const lastActivityAt = new Date().toISOString();
  stateManager.setStatusOverride(options.prUrl, status, lastActivityAt);
  stateManager.save();

  return { url: options.prUrl, status };
}

export async function runClearOverride(options: { prUrl: string }): Promise<ClearOverrideOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const stateManager = getStateManager();
  const cleared = stateManager.clearStatusOverride(options.prUrl);

  if (cleared) {
    stateManager.save();
  }

  return { url: options.prUrl, cleared };
}
