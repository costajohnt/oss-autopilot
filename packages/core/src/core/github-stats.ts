/**
 * GitHub Stats - Fetching merged/closed PR counts and repository star counts.
 * Extracted from PRMonitor to isolate statistics-gathering API calls (#263).
 */

import { Octokit } from '@octokit/rest';
import { extractOwnerRepo, parseGitHubUrl, isOwnRepo } from './utils.js';
import { ClosedPR, MergedPR } from './types.js';
import { debug, warn } from './logger.js';
import { getHttpCache } from './http-cache.js';

const MODULE = 'github-stats';

/** TTL for cached PR count results (24 hours — these stats change slowly). */
export const PR_COUNTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum number of pages to fetch during paginated PR count searches.
 * GitHub's Search API becomes unreliable (500s, ECONNRESET) at deep pages (4-5+).
 * 3 pages × 100 per_page = 300 results, which covers the vast majority of users.
 */
const MAX_PAGINATION_PAGES = 3;

/** Shape of a search result item from octokit.search.issuesAndPullRequests. */
type SearchItem = {
  html_url: string;
  created_at?: string;
  closed_at: string | null;
  pull_request?: { merged_at?: string | null };
};

/** Return type shared by both merged and closed PR count functions. */
export interface PRCountsResult<R> {
  repos: Map<string, R>;
  monthlyCounts: Record<string, number>;
  monthlyOpenedCounts: Record<string, number>;
  dailyActivityCounts: Record<string, number>;
}

/** Returns an empty PRCountsResult. Used as the fallback when stats fetches fail or username is empty. */
export function emptyPRCountsResult<R>(): PRCountsResult<R> {
  return { repos: new Map(), monthlyCounts: {}, monthlyOpenedCounts: {}, dailyActivityCounts: {} };
}

/** Serialized shape of a cached PRCountsResult (Map stored as entries array). */
interface CachedPRCounts {
  reposEntries: [string, unknown][];
  monthlyCounts: Record<string, number>;
  monthlyOpenedCounts: Record<string, number>;
  dailyActivityCounts: Record<string, number>;
}

/** Type guard for deserialized cache data — prevents crashes on corrupt/stale cache. */
function isCachedPRCounts(v: unknown): v is CachedPRCounts {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    Array.isArray(obj.reposEntries) &&
    typeof obj.monthlyCounts === 'object' &&
    obj.monthlyCounts !== null &&
    typeof obj.monthlyOpenedCounts === 'object' &&
    obj.monthlyOpenedCounts !== null &&
    typeof obj.dailyActivityCounts === 'object' &&
    obj.dailyActivityCounts !== null
  );
}

/**
 * Shared paginated search for user PR counts with histogram tracking.
 *
 * Handles: pagination, owner extraction, skip-own-repos, monthly/daily histograms.
 * The `accumulateRepo` callback handles per-repo data and returns the primary date
 * string (e.g. mergedAt or closedAt) used for monthly counts and daily activity.
 * Return an empty string to skip histogram tracking for that item.
 */
async function fetchUserPRCounts<R>(
  octokit: Octokit,
  githubUsername: string,
  query: string,
  label: string,
  accumulateRepo: (repos: Map<string, R>, repo: string, item: SearchItem) => string,
): Promise<PRCountsResult<R>> {
  if (!githubUsername) {
    return emptyPRCountsResult<R>();
  }

  // Check for a fresh cached result (avoids 10-20 paginated API calls)
  const cache = getHttpCache();
  const cacheKey = `pr-counts:${label}:${githubUsername}`;
  const cached = cache.getIfFresh(cacheKey, PR_COUNTS_CACHE_TTL_MS);
  if (cached && isCachedPRCounts(cached)) {
    debug(MODULE, `Using cached ${label} PR counts for @${githubUsername}`);
    return {
      repos: new Map(cached.reposEntries as [string, R][]),
      monthlyCounts: cached.monthlyCounts,
      monthlyOpenedCounts: cached.monthlyOpenedCounts,
      dailyActivityCounts: cached.dailyActivityCounts,
    };
  }

  debug(MODULE, `Fetching ${label} PR counts for @${githubUsername}...`);

  const repos = new Map<string, R>();
  const monthlyCounts: Record<string, number> = {};
  const monthlyOpenedCounts: Record<string, number> = {};
  const dailyActivityCounts: Record<string, number> = {};
  let page = 1;
  let fetched = 0;
  let lastTotalCount = 0;

  while (true) {
    const { data } = await octokit.search.issuesAndPullRequests({
      q: `is:pr ${query} author:${githubUsername}`,
      sort: 'updated',
      order: 'desc',
      per_page: 100,
      page,
    });

    lastTotalCount = data.total_count;

    for (const item of data.items) {
      const parsed = extractOwnerRepo(item.html_url);
      if (!parsed) {
        warn(MODULE, `Skipping ${label} PR with unparseable URL: ${item.html_url}`);
        continue;
      }

      const { owner } = parsed;
      const repo = `${owner}/${parsed.repo}`;

      // Skip own repos (PRs to your own repos aren't OSS contributions)
      if (isOwnRepo(owner, githubUsername)) continue;

      // Note: excludeRepos/excludeOrgs are intentionally NOT filtered here.
      // Those filters control issue discovery/search, not historical statistics.

      // Per-repo accumulation + get primary date for histograms
      const primaryDate = accumulateRepo(repos, repo, item);

      // Monthly histogram for primary date (merged/closed)
      if (primaryDate) {
        const month = primaryDate.slice(0, 7); // "YYYY-MM"
        monthlyCounts[month] = (monthlyCounts[month] || 0) + 1;
        // Daily activity for primary date
        const day = primaryDate.slice(0, 10);
        if (day.length === 10) dailyActivityCounts[day] = (dailyActivityCounts[day] || 0) + 1;
      }

      // Track when this PR was opened (for monthly opened histogram + daily activity)
      if (item.created_at) {
        const openedMonth = item.created_at.slice(0, 7); // "YYYY-MM"
        monthlyOpenedCounts[openedMonth] = (monthlyOpenedCounts[openedMonth] || 0) + 1;
        const openedDay = item.created_at.slice(0, 10);
        if (openedDay.length === 10) dailyActivityCounts[openedDay] = (dailyActivityCounts[openedDay] || 0) + 1;
      }
    }

    fetched += data.items.length;

    // Stop if we've fetched all results, hit the API limit (1000), or reached max pages
    // GitHub Search API returns 500/ECONNRESET on deep pagination (page 4-5+),
    // so we cap at MAX_PAGINATION_PAGES to avoid taking down the entire startup flow.
    if (fetched >= data.total_count || fetched >= 1000 || data.items.length === 0 || page >= MAX_PAGINATION_PAGES) {
      break;
    }

    page++;
  }

  if (fetched < lastTotalCount && page >= MAX_PAGINATION_PAGES) {
    warn(
      MODULE,
      `Pagination capped at ${MAX_PAGINATION_PAGES} pages: fetched ${fetched} of ${lastTotalCount} ${label} PRs. Stats may be incomplete for prolific contributors.`,
    );
  }

  debug(MODULE, `Found ${fetched} ${label} PRs across ${repos.size} repos`);

  // Cache the aggregated result (Map → entries array for JSON serialization).
  // Note: truncated results (from pagination cap) are cached with the same TTL. This is an
  // accepted tradeoff — prolific contributors (300+ PRs) may see slightly incomplete stats
  // for up to 24 hours, but these are cosmetic and self-heal on the next cache expiry.
  cache.set(cacheKey, '', {
    reposEntries: Array.from(repos.entries()),
    monthlyCounts,
    monthlyOpenedCounts,
    dailyActivityCounts,
  });

  return { repos, monthlyCounts, monthlyOpenedCounts, dailyActivityCounts };
}

/**
 * Fetch merged PR counts and latest merge dates per repository for the configured user.
 * Also builds a monthly histogram of all merges for the contribution timeline.
 */
export function fetchUserMergedPRCounts(
  octokit: Octokit,
  githubUsername: string,
): Promise<PRCountsResult<{ count: number; lastMergedAt: string }>> {
  return fetchUserPRCounts(octokit, githubUsername, 'is:merged', 'merged', (repos, repo, item) => {
    if (!item.pull_request?.merged_at) {
      warn(
        MODULE,
        `merged_at missing for merged PR ${item.html_url}${item.closed_at ? ', falling back to closed_at' : ', no date available'}`,
      );
    }
    const mergedAt = item.pull_request?.merged_at || item.closed_at || '';

    const existing = repos.get(repo);
    if (existing) {
      existing.count += 1;
      if (mergedAt && mergedAt > existing.lastMergedAt) {
        existing.lastMergedAt = mergedAt;
      }
    } else {
      repos.set(repo, { count: 1, lastMergedAt: mergedAt });
    }

    return mergedAt;
  });
}

/**
 * Fetch closed-without-merge PR counts per repository for the configured user.
 * Used to populate closedWithoutMergeCount in repo scores for accurate merge rate.
 */
export function fetchUserClosedPRCounts(octokit: Octokit, githubUsername: string): Promise<PRCountsResult<number>> {
  return fetchUserPRCounts(octokit, githubUsername, 'is:closed is:unmerged', 'closed', (repos, repo, item) => {
    repos.set(repo, (repos.get(repo) || 0) + 1);
    return item.closed_at || '';
  });
}

/**
 * Shared helper: search for recent PRs and filter out own repos, excluded repos/orgs.
 * Returns parsed search results that pass all filters.
 */
export async function fetchRecentPRs<T>(
  octokit: Octokit,
  config: { githubUsername: string; excludeRepos: string[]; excludeOrgs?: string[] },
  query: string,
  label: string,
  days: number,
  mapItem: (
    item: { html_url: string; title: string; closed_at: string | null; pull_request?: { merged_at?: string | null } },
    parsed: { owner: string; repo: string; number: number },
  ) => T,
): Promise<T[]> {
  if (!config.githubUsername) {
    warn(MODULE, `Skipping recently ${label} PRs fetch: no githubUsername configured. Run /setup-oss to configure.`);
    return [];
  }

  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  const since = sinceDate.toISOString().split('T')[0]; // YYYY-MM-DD

  debug(MODULE, `Fetching recently ${label} PRs for @${config.githubUsername} (since ${since})...`);

  const { data } = await octokit.search.issuesAndPullRequests({
    q: query.replace('{username}', config.githubUsername).replace('{since}', since),
    sort: 'updated',
    order: 'desc',
    per_page: 100,
  });

  const results: T[] = [];

  for (const item of data.items) {
    const parsed = parseGitHubUrl(item.html_url);
    if (!parsed) {
      warn(MODULE, `Could not parse GitHub URL from API response: ${item.html_url}`);
      continue;
    }

    const repo = `${parsed.owner}/${parsed.repo}`;

    // Skip own repos
    if (isOwnRepo(parsed.owner, config.githubUsername)) continue;

    // Skip excluded repos and orgs
    if (config.excludeRepos.includes(repo)) continue;
    if (config.excludeOrgs?.some((org) => parsed.owner.toLowerCase() === org.toLowerCase())) continue;

    results.push(mapItem(item, { owner: parsed.owner, repo, number: parsed.number }));
  }

  debug(MODULE, `Found ${results.length} recently ${label} PRs`);
  return results;
}

/**
 * Fetch PRs closed without merge in the last N days.
 * Returns lightweight ClosedPR objects for surfacing in the daily digest.
 */
export async function fetchRecentlyClosedPRs(
  octokit: Octokit,
  config: { githubUsername: string; excludeRepos: string[]; excludeOrgs?: string[] },
  days: number = 7,
): Promise<ClosedPR[]> {
  return fetchRecentPRs<ClosedPR>(
    octokit,
    config,
    'is:pr is:closed is:unmerged author:{username} closed:>={since}',
    'closed',
    days,
    (item, { repo, number }) => ({
      url: item.html_url,
      repo,
      number,
      title: item.title,
      closedAt: item.closed_at || '',
    }),
  );
}

/**
 * Fetch PRs merged in the last N days.
 * Returns lightweight MergedPR objects for surfacing as wins in the dashboard.
 */
export async function fetchRecentlyMergedPRs(
  octokit: Octokit,
  config: { githubUsername: string; excludeRepos: string[]; excludeOrgs?: string[] },
  days: number = 7,
): Promise<MergedPR[]> {
  return fetchRecentPRs<MergedPR>(
    octokit,
    config,
    'is:pr is:merged author:{username} merged:>={since}',
    'merged',
    days,
    (item, { repo, number }) => {
      const mergedAt = item.pull_request?.merged_at;
      if (!mergedAt) {
        warn(
          MODULE,
          `merged_at missing for merged PR ${item.html_url}${item.closed_at ? ', falling back to closed_at' : ', no date available'}`,
        );
      }
      return {
        url: item.html_url,
        repo,
        number,
        title: item.title,
        mergedAt: mergedAt || item.closed_at || '',
      };
    },
  );
}
