/**
 * Read command
 * In v2, PR read/unread state is not tracked locally.
 * This command is a no-op preserved for backward compatibility.
 */

import { ValidationError } from '../core/errors.js';
import { validateUrl } from './validation.js';

export type ReadOutput =
  | { markedAsRead: number; all: true; message: string }
  | { marked: boolean; url: string | undefined; message: string };

export async function runRead(options: { prUrl?: string; all?: boolean }): Promise<ReadOutput> {
  if (!options.all && !options.prUrl) {
    throw new ValidationError('PR URL or --all flag required');
  }

  if (options.prUrl) {
    validateUrl(options.prUrl);
  }

  // In v2, unread state is not tracked locally — PRs are fetched fresh each run.
  if (options.all) {
    return { markedAsRead: 0, all: true, message: 'In v2, PR read state is not tracked locally.' };
  }
  return { marked: false, url: options.prUrl, message: 'In v2, PR read state is not tracked locally.' };
}
