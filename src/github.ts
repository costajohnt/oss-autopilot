/**
 * Shared GitHub API client with rate limiting and throttling
 */

import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';

const ThrottledOctokit = Octokit.plugin(throttling);

let _octokit: Octokit | null = null;
let _currentToken: string | null = null;

export function getOctokit(token: string): Octokit {
  // Return cached instance only if token matches
  if (_octokit && _currentToken === token) return _octokit;

  _octokit = new ThrottledOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        const opts = options as { method: string; url: string };
        console.warn(`Rate limit hit for ${opts.method} ${opts.url}`);
        if (retryCount < 2) {
          console.log(`Retrying after ${retryAfter} seconds...`);
          return true;
        }
        console.error('Rate limit exceeded, not retrying');
        return false;
      },
      onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
        const opts = options as { method: string; url: string };
        console.warn(`Secondary rate limit hit for ${opts.method} ${opts.url}`);
        if (retryCount < 1) {
          console.log(`Retrying after ${retryAfter} seconds...`);
          return true;
        }
        return false;
      },
    },
  });

  _currentToken = token;
  return _octokit;
}
