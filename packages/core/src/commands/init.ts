/**
 * Init command
 * Initialize with GitHub username. In v2, PRs are fetched fresh on each daily run.
 */

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { validateGitHubUsername } from './validation.js';

const MODULE = 'init';

export interface InitOutput {
  username: string;
  message: string;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1440). */
  gistSyncWarning?: string;
}

/**
 * Initialize with a GitHub username.
 *
 * @param options - Init options
 * @param options.username - GitHub username to configure
 * @returns Confirmation with username and next-step instructions
 * @throws {ValidationError} If the username is invalid
 */
export async function runInit(options: { username: string }): Promise<InitOutput> {
  validateGitHubUsername(options.username);
  const stateManager = getStateManager();

  // Set username in config
  stateManager.updateConfig({ githubUsername: options.username });

  // Push the config mutation to the Gist in gist mode (no-op locally).
  // Without this the change only hits the local cache and the next
  // bootstrap reverts it from the Gist (#1440).
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);
  return {
    username: options.username,
    message: 'Username saved. Run `daily` to fetch your open PRs from GitHub.',
    ...(gistSyncWarning ? { gistSyncWarning } : {}),
  };
}
