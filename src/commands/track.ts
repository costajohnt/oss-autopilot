/**
 * Track/Untrack commands
 * Manages PR tracking
 */

import { getStateManager, PRMonitor } from '../core/index.js';
import { outputJson, outputJsonError, type TrackOutput } from '../formatters/json.js';

interface TrackOptions {
  prUrl: string;
  json?: boolean;
}

interface UntrackOptions {
  prUrl: string;
  json?: boolean;
}

export async function runTrack(options: TrackOptions): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (options.json) {
      outputJsonError('GITHUB_TOKEN environment variable is required');
    } else {
      console.error('Error: GITHUB_TOKEN environment variable is required');
      console.error('Set it with: export GITHUB_TOKEN=$(gh auth token)');
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
