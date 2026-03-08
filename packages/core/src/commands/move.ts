/**
 * Move command — transition a PR between states:
 * attention, waiting, shelved, or auto (reset to computed status).
 */

import { getStateManager } from '../core/index.js';
import { PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export type MoveTarget = 'attention' | 'waiting' | 'shelved' | 'auto';

export const VALID_TARGETS: readonly MoveTarget[] = ['attention', 'waiting', 'shelved', 'auto'] as const;

export interface MoveOutput {
  url: string;
  target: MoveTarget;
  /** Human-readable description of what happened. */
  description: string;
}

export async function runMove(options: { prUrl: string; target: string }): Promise<MoveOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const target = options.target as MoveTarget;
  if (!VALID_TARGETS.includes(target)) {
    throw new Error(`Invalid target "${options.target}". Must be one of: ${VALID_TARGETS.join(', ')}`);
  }

  const stateManager = getStateManager();

  switch (target) {
    case 'attention': {
      const lastActivityAt = new Date().toISOString();
      stateManager.setStatusOverride(options.prUrl, 'needs_addressing', lastActivityAt);
      stateManager.unshelvePR(options.prUrl);
      stateManager.save();
      return { url: options.prUrl, target, description: 'Moved to Need Attention' };
    }
    case 'waiting': {
      const lastActivityAt = new Date().toISOString();
      stateManager.setStatusOverride(options.prUrl, 'waiting_on_maintainer', lastActivityAt);
      stateManager.unshelvePR(options.prUrl);
      stateManager.save();
      return { url: options.prUrl, target, description: 'Moved to Waiting on Maintainer' };
    }
    case 'shelved': {
      stateManager.shelvePR(options.prUrl);
      stateManager.clearStatusOverride(options.prUrl);
      stateManager.save();
      return {
        url: options.prUrl,
        target,
        description: 'Shelved — excluded from capacity and actionable items',
      };
    }
    case 'auto': {
      const clearedOverride = stateManager.clearStatusOverride(options.prUrl);
      const unshelved = stateManager.unshelvePR(options.prUrl);
      if (clearedOverride || unshelved) {
        stateManager.save();
      }
      return {
        url: options.prUrl,
        target,
        description: 'Reset to computed status',
      };
    }
  }
}
