/**
 * Starred-repo cache refresh.
 *
 * Scout's discovery runs a starred-repo search phase (Phase 1), but it only
 * fires when `config.starredRepos` is non-empty. The autopilot never populated
 * that cache — `init` imports PR history only — so the starred phase was a
 * silent no-op for every user and discovery kept recycling the merged-PR repos.
 * This module fetches the user's stars from GitHub and fills the cache so the
 * phase has input.
 */

import { getOctokit } from './github.js';
import { requireGitHubToken } from './auth.js';
import { debug, warn } from './logger.js';

const MODULE = 'starred-repos';

/** Page size for the starred-repos listing (GitHub max is 100). */
const PER_PAGE = 100;

/** Cap pages so an account that starred thousands of repos can't stall discovery. */
const MAX_PAGES = 5;

/** Minimal state surface this refresh needs — keeps it unit-testable. */
export interface StarredReposState {
  isStarredReposStale(): boolean;
  getStarredRepos(): string[];
  setStarredRepos(repos: string[]): void;
}

/** Page through the authenticated user's stars, collecting `owner/repo` names. */
async function collectStarredRepoNames(octokit: ReturnType<typeof getOctokit>): Promise<string[]> {
  const repos: string[] = [];
  let page = 0;
  for await (const response of octokit.paginate.iterator(octokit.activity.listReposStarredByAuthenticatedUser, {
    per_page: PER_PAGE,
    // Default media type returns the repo object directly (with full_name);
    // the star+timestamp media type would wrap it in { repo, starred_at }.
    headers: { accept: 'application/vnd.github.v3+json' },
  })) {
    for (const repo of response.data as Array<{ full_name?: string }>) {
      if (repo.full_name) repos.push(repo.full_name);
    }
    page += 1;
    if (page >= MAX_PAGES) break;
  }
  return repos;
}

/**
 * Refresh the cached starred-repo list from GitHub when the cache is stale
 * (>24h) or empty, so scout's starred-repo search phase has repos to query.
 *
 * Fails soft: a fetch error logs a warning and leaves the existing cache
 * untouched, so a transient GitHub failure never blocks a search. Returns the
 * number of repos cached after the call (freshly fetched, or the existing list
 * when fresh / on error).
 */
export async function refreshStarredReposIfStale(state: StarredReposState): Promise<number> {
  if (!state.isStarredReposStale()) {
    return state.getStarredRepos().length;
  }

  // A missing token is a configuration error, not a transient fetch failure —
  // let it propagate so the caller surfaces the actionable auth message rather
  // than silently degrading to an empty starred phase.
  const token = requireGitHubToken();

  // Only the network fetch is fail-soft: a transient GitHub error must not block
  // the search. Token resolution (above) and the state write (below) stay
  // outside the catch so genuine config/persistence faults aren't masked.
  let repos: string[];
  try {
    repos = await collectStarredRepoNames(getOctokit(token));
  } catch (err) {
    warn(
      MODULE,
      `Failed to refresh starred repos; continuing with cached list (${state.getStarredRepos().length}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return state.getStarredRepos().length;
  }

  // A successful-but-empty response (transient/partial API result) must not wipe
  // a populated cache and then stamp it fresh for 24h — that would silently
  // re-disable the very phase this refresh exists to feed. Keep the old list.
  if (repos.length === 0) {
    debug(MODULE, 'Starred-repo fetch returned 0; keeping existing cache');
    return state.getStarredRepos().length;
  }

  state.setStarredRepos(repos);
  debug(MODULE, `Refreshed starred repos from GitHub: ${repos.length} cached`);
  return repos.length;
}
