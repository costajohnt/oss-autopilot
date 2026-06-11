/**
 * Shelve/Unshelve commands
 * Manages shelving PRs to exclude them from capacity and actionable issues.
 * Shelved PRs are auto-unshelved when a maintainer engages.
 *
 * Note: The CLI and MCP shelve/unshelve commands delegate to runMove(),
 * which also clears status overrides. These functions match that behavior
 * to keep the library API consistent.
 */

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

const MODULE = 'shelve';

export interface ShelveOutput {
  shelved: boolean;
  url: string;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

export interface UnshelveOutput {
  unshelved: boolean;
  url: string;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

// Re-export for backward compatibility with tests
export { PR_URL_PATTERN };

/**
 * Shelve a PR, hiding it from daily digest and capacity calculations.
 *
 * @param options - Shelve options
 * @param options.prUrl - Full GitHub PR URL
 * @returns Whether the PR was newly shelved (false if already shelved)
 * @throws {ValidationError} If the URL is not a valid GitHub PR URL
 */
export async function runShelve(options: { prUrl: string }): Promise<ShelveOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const stateManager = getStateManager();
  let added = false;
  stateManager.batch(() => {
    added = stateManager.shelvePR(options.prUrl);
    stateManager.clearStatusOverride(options.prUrl);
  });
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);

  return { shelved: added, url: options.prUrl, ...(gistSyncWarning ? { gistSyncWarning } : {}) };
}

/**
 * Unshelve a PR, restoring it to the daily digest.
 *
 * @param options - Unshelve options
 * @param options.prUrl - Full GitHub PR URL
 * @returns Whether the PR was removed from the shelf (false if not shelved)
 * @throws {ValidationError} If the URL is not a valid GitHub PR URL
 */
export async function runUnshelve(options: { prUrl: string }): Promise<UnshelveOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const stateManager = getStateManager();
  let removed = false;
  stateManager.batch(() => {
    removed = stateManager.unshelvePR(options.prUrl);
    stateManager.clearStatusOverride(options.prUrl);
  });
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);

  return { unshelved: removed, url: options.prUrl, ...(gistSyncWarning ? { gistSyncWarning } : {}) };
}
