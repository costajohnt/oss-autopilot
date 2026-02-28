/**
 * Read command
 * In v2, PR read/unread state is not tracked locally.
 * This command is a no-op preserved for backward compatibility.
 */

import { outputJson, outputJsonError } from '../formatters/json.js';
import { validateUrl } from './validation.js';

interface ReadOptions {
  prUrl?: string;
  all?: boolean;
  json?: boolean;
}

export async function runRead(options: ReadOptions): Promise<void> {
  if (!options.all && !options.prUrl) {
    if (options.json) {
      outputJsonError('PR URL or --all flag required');
    } else {
      console.error('Usage: oss-autopilot read <pr-url> or oss-autopilot read --all');
    }
    process.exit(1);
  }

  if (options.prUrl) {
    validateUrl(options.prUrl);
  }

  // In v2, unread state is not tracked locally — PRs are fetched fresh each run.
  if (options.json) {
    if (options.all) {
      outputJson({ markedAsRead: 0, all: true, message: 'In v2, PR read state is not tracked locally.' });
    } else {
      outputJson({ marked: false, url: options.prUrl, message: 'In v2, PR read state is not tracked locally.' });
    }
  } else {
    console.log('Note: In v2, PR read state is not tracked locally. PRs are fetched fresh on each daily run.');
  }
}
