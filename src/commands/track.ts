/**
 * Track/Untrack commands
 * Manages PR tracking
 */

import { getStateManager, PRMonitor, getGitHubToken } from '../core/index.js';
import { outputJson, outputJsonError, type TrackOutput } from '../formatters/json.js';
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

  const token = getGitHubToken();
  if (!token) {
    if (options.json) {
      outputJsonError('GitHub authentication required. Run "gh auth login" or set GITHUB_TOKEN.');
    } else {
      console.error('Error: GitHub authentication required.');
      console.error('');
      console.error('Options:');
      console.error('  1. Use gh CLI: gh auth login');
      console.error('  2. Set GITHUB_TOKEN environment variable');
    }
    process.exit(1);
  }

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
