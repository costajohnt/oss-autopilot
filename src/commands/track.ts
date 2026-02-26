/**
 * Track/Untrack commands
 * Manages PR tracking
 */

import { getStateManager, PRMonitor, getGitHubToken } from '../core/index.js';
import { outputJson, type TrackOutput } from '../formatters/json.js';
import { validateUrl, PR_URL_PATTERN, validateGitHubUrl } from './validation.js';

interface TrackOptions {
  prUrl: string;
  json?: boolean;
}

interface UntrackOptions {
  prUrl: string;
  json?: boolean;
}

export async function runTrack(options: TrackOptions): Promise<void> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR', options.json);

  // Token is guaranteed by the preAction hook in cli.ts for non-LOCAL_ONLY_COMMANDS.
  const token = getGitHubToken()!;

  const stateManager = getStateManager();
  const prMonitor = new PRMonitor(token);

  if (!options.json) {
    console.log(`\n📌 Tracking PR: ${options.prUrl}\n`);
  }

  const pr = await prMonitor.trackPR(options.prUrl);
  stateManager.save();

  if (options.json) {
    outputJson<TrackOutput>({ pr });
  } else {
    console.log(`Added PR: ${pr.repo}#${pr.number} - ${pr.title}`);
  }
}

export async function runUntrack(options: UntrackOptions): Promise<void> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR', options.json);

  const stateManager = getStateManager();

  if (!options.json) {
    console.log(`\n🗑️ Untracking PR: ${options.prUrl}\n`);
  }

  const removed = stateManager.untrackPR(options.prUrl);

  if (removed) {
    stateManager.save();
  }

  if (options.json) {
    outputJson({ removed, url: options.prUrl });
  } else {
    if (removed) {
      console.log('PR removed from tracking.');
    } else {
      console.log('PR was not being tracked.');
    }
  }
}
