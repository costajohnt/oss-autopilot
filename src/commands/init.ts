/**
 * Init command
 * Initialize with GitHub username. In v2, PRs are fetched fresh on each daily run.
 */

import { getStateManager } from '../core/index.js';
import { outputJson } from '../formatters/json.js';

interface InitOptions {
  username: string;
  json?: boolean;
}

export async function runInit(options: InitOptions): Promise<void> {
  const stateManager = getStateManager();

  if (!options.json) {
    console.log(`\n🚀 Initializing for @${options.username}...\n`);
  }

  // Set username in config
  stateManager.updateConfig({ githubUsername: options.username });
  stateManager.save();

  if (options.json) {
    outputJson({
      username: options.username,
      message: 'Username saved. Run `daily` to fetch your open PRs from GitHub.',
    });
  } else {
    console.log(`Username set to @${options.username}.`);
    console.log('Run `oss-autopilot daily` to fetch your open PRs from GitHub.');
  }
}
