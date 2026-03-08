/**
 * Shelve/Unshelve commands
 * Manages shelving PRs to exclude them from capacity and actionable issues.
 * Shelved PRs are auto-unshelved when a maintainer engages.
 *
 * Note: The CLI and MCP shelve/unshelve commands delegate to runMove(),
 * which also clears status overrides. These functions match that behavior
 * to keep the library API consistent.
 */

import { getStateManager } from '../core/index.js';
import { PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export interface ShelveOutput {
  shelved: boolean;
  url: string;
}

export interface UnshelveOutput {
  unshelved: boolean;
  url: string;
}

// Re-export for backward compatibility with tests
export { PR_URL_PATTERN };

export async function runShelve(options: { prUrl: string }): Promise<ShelveOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const stateManager = getStateManager();
  const added = stateManager.shelvePR(options.prUrl);
  const clearedOverride = stateManager.clearStatusOverride(options.prUrl);

  if (added || clearedOverride) {
    stateManager.save();
  }

  return { shelved: added, url: options.prUrl };
}

export async function runUnshelve(options: { prUrl: string }): Promise<UnshelveOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const stateManager = getStateManager();
  const removed = stateManager.unshelvePR(options.prUrl);
  const clearedOverride = stateManager.clearStatusOverride(options.prUrl);

  if (removed || clearedOverride) {
    stateManager.save();
  }

  return { unshelved: removed, url: options.prUrl };
}
