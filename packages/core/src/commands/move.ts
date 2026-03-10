/**
 * Move command — transition a PR between states:
 * attention, waiting, shelved, or auto (reset to computed status).
 */

import { getStateManager } from '../core/index.js';
import { PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export const VALID_TARGETS = ['attention', 'waiting', 'shelved', 'auto'] as const;

export type MoveTarget = (typeof VALID_TARGETS)[number];

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
    case 'attention':
    case 'waiting': {
      const status = target === 'attention' ? 'needs_addressing' : 'waiting_on_maintainer';
      const label = target === 'attention' ? 'Need Attention' : 'Waiting on Maintainer';
      // Use current time — the CLI doesn't have cached PR data. The override
      // will auto-clear on the next daily run if the PR has new activity after this.
      const lastActivityAt = new Date().toISOString();
      stateManager.batch(() => {
        stateManager.setStatusOverride(options.prUrl, status, lastActivityAt);
        stateManager.unshelvePR(options.prUrl);
      });
      return { url: options.prUrl, target, description: `Moved to ${label}` };
    }
    case 'shelved': {
      stateManager.batch(() => {
        stateManager.shelvePR(options.prUrl);
        stateManager.clearStatusOverride(options.prUrl);
      });
      return {
        url: options.prUrl,
        target,
        description: 'Shelved — excluded from capacity and actionable items',
      };
    }
    case 'auto': {
      stateManager.batch(() => {
        stateManager.clearStatusOverride(options.prUrl);
        stateManager.unshelvePR(options.prUrl);
      });
      return {
        url: options.prUrl,
        target,
        description: 'Reset to computed status',
      };
    }
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unhandled move target: ${_exhaustive}`);
    }
  }
}
