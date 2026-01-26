/**
 * Read command
 * Mark PR comments as read
 */

import { getStateManager } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

interface ReadOptions {
  prUrl?: string;
  all?: boolean;
  json?: boolean;
}

export async function runRead(options: ReadOptions): Promise<void> {
  const stateManager = getStateManager();

  if (options.all) {
    if (!options.json) {
      console.log('\n✓ Marking all PRs as read...\n');
    }

    const count = stateManager.markAllPRsAsRead();
    stateManager.save();

    if (options.json) {
      outputJson({ markedAsRead: count, all: true });
    } else {
      console.log(`Marked ${count} PRs as read.`);
    }
    return;
  }

  if (!options.prUrl) {
    if (options.json) {
      outputJsonError('PR URL or --all flag required');
    } else {
      console.error('Usage: oss-autopilot read <pr-url> or oss-autopilot read --all');
    }
    process.exit(1);
  }

  if (!options.json) {
    console.log(`\n✓ Marking PR as read: ${options.prUrl}\n`);
  }

  const marked = stateManager.markPRAsRead(options.prUrl);
  if (marked) {
    stateManager.save();
  }

  if (options.json) {
    outputJson({ marked, url: options.prUrl });
  } else {
    if (marked) {
      console.log('PR marked as read.');
    } else {
      console.log('PR not found or already read.');
    }
  }
}
