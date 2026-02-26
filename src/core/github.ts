/**
 * Shared GitHub API client with rate limiting and throttling
 */

import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { warn } from './logger.js';

const ThrottledOctokit = Octokit.plugin(throttling);

const MODULE = 'github';

/** Rate limit info returned by {@link checkRateLimit}. */
export interface RateLimitInfo {
  /** Remaining search API requests in current window. */
  remaining: number;
  /** Total search API request limit per window. */
  limit: number;
  /** ISO timestamp when the rate limit window resets. */
  resetAt: string;
}

let _octokit: Octokit | null = null;
let _currentToken: string | null = null;

/** Format a Date as HH:MM:SS for log messages. */
function formatResetTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour12: false });
}

export function getOctokit(token: string): Octokit {
  // Return cached instance only if token matches
  if (_octokit && _currentToken === token) return _octokit;

  _octokit = new ThrottledOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        const opts = options as { method: string; url: string };
        const resetAt = new Date(Date.now() + retryAfter * 1000);
        if (retryCount < 2) {
          warn(
            MODULE,
            `Rate limit hit (retry ${retryCount + 1}/2, waiting ${retryAfter}s, resets at ${formatResetTime(resetAt)}) — ${opts.method} ${opts.url}`,
          );
          return true;
        }
        warn(
          MODULE,
          `Rate limit exceeded, not retrying — ${opts.method} ${opts.url} (resets at ${formatResetTime(resetAt)})`,
        );
        return false;
      },
      onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
        const opts = options as { method: string; url: string };
        const resetAt = new Date(Date.now() + retryAfter * 1000);
        if (retryCount < 1) {
          warn(
            MODULE,
            `Secondary rate limit hit (retry ${retryCount + 1}/1, waiting ${retryAfter}s, resets at ${formatResetTime(resetAt)}) — ${opts.method} ${opts.url}`,
          );
          return true;
        }
        warn(
          MODULE,
          `Secondary rate limit exceeded, not retrying — ${opts.method} ${opts.url} (resets at ${formatResetTime(resetAt)})`,
        );
        return false;
      },
    },
  });

  _currentToken = token;
  return _octokit;
}

/**
 * Check the GitHub Search API rate limit quota.
 * Returns the remaining requests, total limit, and reset time for the search endpoint.
 */
export async function checkRateLimit(token: string): Promise<RateLimitInfo> {
  const octokit = getOctokit(token);
  const { data } = await octokit.rateLimit.get();
  const search = data.resources.search;
  return {
    remaining: search.remaining,
    limit: search.limit,
    resetAt: new Date(search.reset * 1000).toISOString(),
  };
}
