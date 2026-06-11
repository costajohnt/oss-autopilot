/**
 * Move command — transition a PR between states:
 * attention, waiting, shelved, or auto (reset to computed status).
 */

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

const MODULE = 'move';

export const VALID_TARGETS = ['attention', 'waiting', 'shelved', 'auto'] as const;

export type MoveTarget = (typeof VALID_TARGETS)[number];

export interface MoveOutput {
  url: string;
  target: MoveTarget;
  /** Human-readable description of what happened. */
  description: string;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

/** Attach the checkpoint warning only when present, keeping the key off the wire on clean runs (#1370). */
function withGistSyncWarning(output: MoveOutput, gistSyncWarning: string | null): MoveOutput {
  return gistSyncWarning ? { ...output, gistSyncWarning } : output;
}

/**
 * Move a PR between states: attention, waiting, shelved, or auto (computed).
 *
 * @param options - Move options
 * @param options.prUrl - Full GitHub PR URL
 * @param options.target - Target state: 'attention' | 'waiting' | 'shelved' | 'auto'
 * @returns The move result with a human-readable description
 * @throws {ValidationError} If the URL is not a valid GitHub PR URL or the target is invalid
 */
export async function runMove(options: { prUrl: string; target: string }): Promise<MoveOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const target = options.target as MoveTarget;
  if (!VALID_TARGETS.includes(target)) {
    throw new ValidationError(`Invalid target "${options.target}". Must be one of: ${VALID_TARGETS.join(', ')}`);
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
      const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);
      return withGistSyncWarning({ url: options.prUrl, target, description: `Moved to ${label}` }, gistSyncWarning);
    }
    case 'shelved': {
      stateManager.batch(() => {
        stateManager.shelvePR(options.prUrl);
        stateManager.clearStatusOverride(options.prUrl);
      });
      const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);
      return withGistSyncWarning(
        {
          url: options.prUrl,
          target,
          description: 'Shelved — excluded from capacity and actionable items',
        },
        gistSyncWarning,
      );
    }
    case 'auto': {
      stateManager.batch(() => {
        stateManager.clearStatusOverride(options.prUrl);
        stateManager.unshelvePR(options.prUrl);
      });
      const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);
      return withGistSyncWarning(
        {
          url: options.prUrl,
          target,
          description: 'Reset to computed status',
        },
        gistSyncWarning,
      );
    }
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unhandled move target: ${_exhaustive}`);
    }
  }
}
