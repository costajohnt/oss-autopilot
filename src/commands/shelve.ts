/**
 * Shelve/Unshelve commands
 * Manages shelving PRs to exclude them from capacity and actionable issues.
 * Shelved PRs are auto-unshelved when a maintainer engages.
 */

import { getStateManager } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import { PR_URL_PATTERN, validateGitHubUrl } from './validation.js';

interface ShelveCommandOptions {
  prUrl: string;
  json?: boolean;
}

// Re-export for backward compatibility with tests
export { PR_URL_PATTERN };

export async function runShelve(options: ShelveCommandOptions): Promise<void> {
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR', options.json);

  const stateManager = getStateManager();
  const added = stateManager.shelvePR(options.prUrl);

  if (added) {
    stateManager.save();
  }

  if (options.json) {
    outputJson({ shelved: added, url: options.prUrl });
  } else if (added) {
    console.log(`Shelved: ${options.prUrl}`);
    console.log('This PR is now excluded from capacity and actionable issues.');
    console.log('It will auto-unshelve if a maintainer engages.');
  } else {
    console.log('PR is already shelved.');
  }
}

export async function runUnshelve(options: ShelveCommandOptions): Promise<void> {
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR', options.json);

  const stateManager = getStateManager();
  const removed = stateManager.unshelvePR(options.prUrl);

  if (removed) {
    stateManager.save();
  }

  if (options.json) {
    outputJson({ unshelved: removed, url: options.prUrl });
  } else if (removed) {
    console.log(`Unshelved: ${options.prUrl}`);
    console.log('This PR is now active again.');
  } else {
    console.log('PR was not shelved.');
  }
}
