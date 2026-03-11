/**
 * Init command
 * Initialize with GitHub username. In v2, PRs are fetched fresh on each daily run.
 */

import { getStateManager } from '../core/index.js';
import { validateGitHubUsername } from './validation.js';

export interface InitOutput {
  username: string;
  message: string;
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

  return {
    username: options.username,
    message: 'Username saved. Run `daily` to fetch your open PRs from GitHub.',
  };
}
