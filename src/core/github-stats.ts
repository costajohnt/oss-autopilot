/**
 * GitHub Stats - Fetching merged/closed PR counts and repository star counts.
 * Extracted from PRMonitor to isolate statistics-gathering API calls (#263).
 */

import { Octokit } from '@octokit/rest';
import { extractOwnerRepo, parseGitHubUrl } from './utils.js';
import { ClosedPR, MergedPR } from './types.js';
import { ValidationError } from './errors.js';
import { debug, warn } from './logger.js';

const MODULE = 'github-stats';

/**
 * Fetch merged PR counts and latest merge dates per repository for the configured user.
 * Also builds a monthly histogram of all merges for the contribution timeline.
 */
export async function fetchUserMergedPRCounts(
  octokit: Octokit,
  githubUsername: string,
): Promise<{
  repos: Map<string, { count: number; lastMergedAt: string }>;
  monthlyCounts: Record<string, number>;
  monthlyOpenedCounts: Record<string, number>;
  dailyActivityCounts: Record<string, number>;
}> {
  if (!githubUsername) {
    return { repos: new Map(), monthlyCounts: {}, monthlyOpenedCounts: {}, dailyActivityCounts: {} };
  }

  debug(MODULE, `Fetching merged PR counts for @${githubUsername}...`);

  const repos = new Map<string, { count: number; lastMergedAt: string }>();
  const monthlyCounts: Record<string, number> = {};
  const monthlyOpenedCounts: Record<string, number> = {};
  const dailyActivityCounts: Record<string, number> = {};
  let page = 1;
  let fetched = 0;

  while (true) {
    const { data } = await octokit.search.issuesAndPullRequests({
      q: `is:pr is:merged author:${githubUsername}`,
      sort: 'updated',
      order: 'desc',
      per_page: 100,
      page,
    });

    for (const item of data.items) {
      const parsed = extractOwnerRepo(item.html_url);
      if (!parsed) {
        warn(MODULE, `Skipping merged PR with unparseable URL: ${item.html_url}`);
        continue;
      }

      const { owner } = parsed;
      const repo = `${owner}/${parsed.repo}`;

      // Skip own repos (PRs to your own repos aren't OSS contributions)
      if (owner.toLowerCase() === githubUsername.toLowerCase()) continue;

      // Note: excludeRepos/excludeOrgs are intentionally NOT filtered here.
      // Those filters control issue discovery/search, not historical statistics.
      // A merged PR is a merged PR regardless of current tracking preferences.

      const mergedAt = item.pull_request?.merged_at || item.closed_at || '';

      // Per-repo tracking
      const existing = repos.get(repo);
      if (existing) {
        existing.count += 1;
        if (mergedAt && mergedAt > existing.lastMergedAt) {
          existing.lastMergedAt = mergedAt;
        }
      } else {
        repos.set(repo, { count: 1, lastMergedAt: mergedAt });
      }

      // Monthly histogram (every PR counted individually)
      if (mergedAt) {
        const month = mergedAt.slice(0, 7); // "YYYY-MM"
        monthlyCounts[month] = (monthlyCounts[month] || 0) + 1;
      }

      // Track when this PR was opened (for monthly opened histogram)
      if (item.created_at) {
        const openedMonth = item.created_at.slice(0, 7); // "YYYY-MM"
        monthlyOpenedCounts[openedMonth] = (monthlyOpenedCounts[openedMonth] || 0) + 1;
        // Daily activity: PR opened
        const openedDay = item.created_at.slice(0, 10);
        if (openedDay.length === 10) dailyActivityCounts[openedDay] = (dailyActivityCounts[openedDay] || 0) + 1;
      }

      // Daily activity: PR merged
      if (mergedAt) {
        const mergedDay = mergedAt.slice(0, 10);
        if (mergedDay.length === 10) dailyActivityCounts[mergedDay] = (dailyActivityCounts[mergedDay] || 0) + 1;
      }
    }

    fetched += data.items.length;

    // Stop if we've fetched all results or hit the API limit (1000)
    if (fetched >= data.total_count || fetched >= 1000 || data.items.length === 0) {
      break;
    }

    page++;
  }

  debug(MODULE, `Found ${fetched} merged PRs across ${repos.size} repos`);
  return { repos, monthlyCounts, monthlyOpenedCounts, dailyActivityCounts };
}

/**
 * Fetch closed-without-merge PR counts per repository for the configured user.
 * Used to populate closedWithoutMergeCount in repo scores for accurate merge rate.
 */
export async function fetchUserClosedPRCounts(
  octokit: Octokit,
  githubUsername: string,
): Promise<{
  repos: Map<string, number>;
  monthlyCounts: Record<string, number>;
  monthlyOpenedCounts: Record<string, number>;
  dailyActivityCounts: Record<string, number>;
}> {
  if (!githubUsername) {
    return { repos: new Map(), monthlyCounts: {}, monthlyOpenedCounts: {}, dailyActivityCounts: {} };
  }

  debug(MODULE, `Fetching closed PR counts for @${githubUsername}...`);

  const repos = new Map<string, number>();
  const monthlyCounts: Record<string, number> = {};
  const monthlyOpenedCounts: Record<string, number> = {};
  const dailyActivityCounts: Record<string, number> = {};
  let page = 1;
  let fetched = 0;

  while (true) {
    const { data } = await octokit.search.issuesAndPullRequests({
      q: `is:pr is:closed is:unmerged author:${githubUsername}`,
      sort: 'updated',
      order: 'desc',
      per_page: 100,
      page,
    });

    for (const item of data.items) {
      const parsed = extractOwnerRepo(item.html_url);
      if (!parsed) {
        warn(MODULE, `Skipping closed PR with unparseable URL: ${item.html_url}`);
        continue;
      }

      const { owner } = parsed;
      const repo = `${owner}/${parsed.repo}`;

      // Skip own repos
      if (owner.toLowerCase() === githubUsername.toLowerCase()) continue;

      // Note: excludeRepos/excludeOrgs are intentionally NOT filtered here.
      // Those filters control issue discovery/search, not historical statistics.
      // A closed PR is a closed PR regardless of current tracking preferences.

      repos.set(repo, (repos.get(repo) || 0) + 1);

      // Track when this PR was closed (for monthly closed histogram)
      if (item.closed_at) {
        const closedMonth = item.closed_at.slice(0, 7); // "YYYY-MM"
        monthlyCounts[closedMonth] = (monthlyCounts[closedMonth] || 0) + 1;
        // Daily activity: PR closed
        const closedDay = item.closed_at.slice(0, 10);
        if (closedDay.length === 10) dailyActivityCounts[closedDay] = (dailyActivityCounts[closedDay] || 0) + 1;
      }

      // Track when this PR was opened (for monthly opened histogram)
      if (item.created_at) {
        const openedMonth = item.created_at.slice(0, 7); // "YYYY-MM"
        monthlyOpenedCounts[openedMonth] = (monthlyOpenedCounts[openedMonth] || 0) + 1;
        // Daily activity: PR opened
        const openedDay = item.created_at.slice(0, 10);
        if (openedDay.length === 10) dailyActivityCounts[openedDay] = (dailyActivityCounts[openedDay] || 0) + 1;
      }
    }

    fetched += data.items.length;

    if (fetched >= data.total_count || fetched >= 1000 || data.items.length === 0) {
      break;
    }

    page++;
  }

  debug(MODULE, `Found ${fetched} closed (unmerged) PRs across ${repos.size} repos`);
  return { repos, monthlyCounts, monthlyOpenedCounts, dailyActivityCounts };
}

/**
 * Fetch GitHub star counts for a list of repositories.
 * Used to populate stargazersCount in repo scores for dashboard filtering by minStars.
 * Fetches concurrently with per-repo error isolation (missing/private repos are skipped).
 */
export async function fetchRepoStarCounts(octokit: Octokit, repos: string[]): Promise<Map<string, number>> {
  if (repos.length === 0) return new Map();

  debug(MODULE, `Fetching star counts for ${repos.length} repos...`);
  const results = new Map<string, number>();

  // Fetch in parallel chunks to avoid overwhelming the API
  const chunkSize = 10;
  for (let i = 0; i < repos.length; i += chunkSize) {
    const chunk = repos.slice(i, i + chunkSize);
    const settled = await Promise.allSettled(
      chunk.map(async (repo) => {
        const parts = repo.split('/');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          throw new ValidationError(`Malformed repo identifier: "${repo}"`);
        }
        const [owner, name] = parts;
        const { data } = await octokit.repos.get({ owner, repo: name });
        return { repo, stars: data.stargazers_count };
      }),
    );
    let chunkFailures = 0;
    for (let j = 0; j < settled.length; j++) {
      const result = settled[j];
      if (result.status === 'fulfilled') {
        results.set(result.value.repo, result.value.stars);
      } else {
        chunkFailures++;
        warn(
          MODULE,
          `Failed to fetch stars for ${chunk[j]}: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
        );
      }
    }
    // If entire chunk failed, likely a systemic issue (rate limit, auth, outage) — abort remaining
    if (chunkFailures === chunk.length && chunk.length > 0) {
      const remaining = repos.length - i - chunkSize;
      if (remaining > 0) {
        warn(MODULE, `Entire chunk failed, aborting remaining ${remaining} repos`);
      }
      break;
    }
  }

  debug(MODULE, `Fetched star counts for ${results.size}/${repos.length} repos`);
  return results;
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
    if (parsed.owner.toLowerCase() === config.githubUsername.toLowerCase()) continue;

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
