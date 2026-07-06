/**
 * Shared GitHub API client with rate limiting and throttling
 */

import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';
import { warn } from './logger.js';

const MODULE = 'github';

// Plugin order matches octokit.js's own composition (retry, then throttling):
// throttling must be the outermost layer so its Bottleneck-based queueing sees
// rate-limit errors first, before plugin-retry's own request-level retries.
const ThrottledOctokit = Octokit.plugin(retry, throttling);

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

/**
 * Throttle callbacks used by the Octokit client. Exported for testability.
 * @returns Rate limit and secondary rate limit handler callbacks
 */
export function getRateLimitCallbacks() {
  return {
    onRateLimit: (retryAfter: number, options: unknown, _octokit: unknown, retryCount: number): boolean => {
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
    onSecondaryRateLimit: (retryAfter: number, options: unknown, _octokit: unknown, retryCount: number): boolean => {
      const opts = options as { method: string; url: string };
      const resetAt = new Date(Date.now() + retryAfter * 1000);
      if (retryCount < 3) {
        warn(
          MODULE,
          `Secondary rate limit hit (retry ${retryCount + 1}/3, waiting ${retryAfter}s, resets at ${formatResetTime(resetAt)}) — ${opts.method} ${opts.url}`,
        );
        return true;
      }
      warn(
        MODULE,
        `Secondary rate limit exceeded, not retrying — ${opts.method} ${opts.url} (resets at ${formatResetTime(resetAt)})`,
      );
      return false;
    },
  };
}

/**
 * Get a shared, throttled Octokit instance for the given token.
 * Returns a cached instance if the token matches, otherwise creates a new one.
 *
 * The client retries on primary rate limits (up to 2 retries) and
 * secondary rate limits (up to 3 retries), and separately retries
 * transient 5xx/network errors (up to 3 retries) via `@octokit/plugin-retry`.
 *
 * @param token - GitHub personal access token
 * @returns Authenticated Octokit instance with rate limit throttling
 *
 * @example
 * ```typescript
 * import { getOctokit, requireGitHubToken } from '@oss-autopilot/core';
 *
 * const octokit = getOctokit(requireGitHubToken());
 * const { data } = await octokit.repos.get({ owner: 'facebook', repo: 'react' });
 * ```
 */
export function getOctokit(token: string): Octokit {
  // Return cached instance only if token matches
  if (_octokit && _currentToken === token) return _octokit;

  const callbacks = getRateLimitCallbacks();
  _octokit = new ThrottledOctokit({
    auth: token,
    throttle: callbacks,
    // Mirrors plugin-retry's own default doNotRetry list (keep in sync on
    // upgrade) plus 429, so primary rate limits stay owned by the throttling
    // callbacks above instead of being retried again here with a shorter backoff.
    retry: { doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451] },
  });

  _currentToken = token;
  return _octokit;
}

/**
 * Check the GitHub Search API rate limit quota.
 *
 * @param token - GitHub personal access token
 * @returns Remaining requests, total limit, and reset time for the search endpoint
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
