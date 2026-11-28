/**
 * GitHub Stats - Fetching merged/closed PR counts with star-based filtering.
 * Extracted from PRMonitor to isolate statistics-gathering API calls (#263).
 */

import { Octokit } from '@octokit/rest';
import { extractOwnerRepo, parseGitHubUrl, isOwnRepo, isUntrackedOrg } from './urls.js';
import { ClosedPR, MergedPR, StoredMergedPR, StoredClosedPR, isBelowMinStars, type StarFilter } from './types.js';
import { debug, warn } from './logger.js';
import { describeError } from './errors.js';
import { getHttpCache } from './http-cache.js';
import { searchAllPages, type SearchPagesResult } from './pagination.js';

const MODULE = 'github-stats';

/** TTL for cached PR count results (24 hours — these stats change slowly). */
export const PR_COUNTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum number of pages to fetch during paginated PR count searches.
 * GitHub's Search API becomes unreliable (500s, ECONNRESET) at deep pages (4-5+).
 * 3 pages × 100 per_page = 300 results, which covers the vast majority of users.
 */
const MAX_PAGINATION_PAGES = 3;

const CLOSING_KEYWORD_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|([\w.-]+\/[\w.-]+)?#(\d+))\b/i;

/** HTML comments and code: where PR templates keep example `Fixes #123` lines. */
const NON_PROSE_RE = /<!--[\s\S]*?-->|```[\s\S]*?```|(`+)[^`]*\1/g;

/** GitHub's PR body limit; also bounds NON_PROSE_RE's scan on an unclosed `<!--`. */
const MAX_BODY_CHARS = 65_536;

/**
 * Issue URL a PR closes, from the first GitHub closing keyword in its body
 * (#1824): `Fixes #12`, `closes owner/repo#12`, or `resolves <issue url>`.
 * Joins the outcome ledger to vet-time predictions at zero API cost.
 *
 * ponytail: first keyword wins; a PR closing several issues links only the
 * first. Switch to GraphQL `closingIssuesReferences` if that ever matters.
 */
export function closingIssueUrl(body: string | null | undefined, prUrl: string): string | undefined {
  const m = body?.slice(0, MAX_BODY_CHARS).replace(NON_PROSE_RE, ' ').match(CLOSING_KEYWORD_RE);
  if (!m) return undefined;
  const own = extractOwnerRepo(prUrl);
  // A bare `#12` refers to the PR's own repo.
  const target = m[1] ?? m[3] ?? (own && `${own.owner}/${own.repo}`);
  return target ? `https://github.com/${target}/issues/${m[2] ?? m[4]}` : undefined;
}

/**
 * A github.com issue or pull URL, rewritten to ` owner/repo#N ` before the
 * mention scan so one simple pattern covers both spellings. The padding
 * spaces keep the rewritten form clear of the word boundary rule below.
 */
const ISSUE_URL_RE = /https:\/\/github\.com\/([\w-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\b/g;

/**
 * `owner/repo#12` or a bare `#12`, closing keyword or not. Owners are GitHub
 * logins (word characters and hyphens, no dots), and the mention must not
 * sit inside a word or path (`C#5`, `example.com/page#5`), mirroring
 * GitHub's autolink rule.
 */
const ISSUE_MENTION_RE = /(?<![\w/.-])([\w-]+\/[\w.-]+)?#(\d+)\b/g;

/**
 * Every issue or PR a PR's title and body mention (#1863), as canonical issue
 * URLs (`https://github.com/owner/repo/issues/N`). Issues and PRs share one
 * number space per repo, so `/pull/N` folds into the same URL and a bare `#N`
 * resolves against the PR's own repo. Unlike {@link closingIssueUrl} no
 * closing keyword is needed: a follow-up PR that says "supersedes #8" or
 * "alternative approach for #12" links too. Deduplicated, in order of
 * appearance; HTML comments and code are ignored like in `closingIssueUrl`.
 */
export function mentionedIssueUrls(
  title: string | null | undefined,
  body: string | null | undefined,
  prUrl: string,
): string[] {
  const own = extractOwnerRepo(prUrl);
  const text = `${title ?? ''}\n${body?.slice(0, MAX_BODY_CHARS) ?? ''}`
    .replaceAll(NON_PROSE_RE, ' ')
    .replaceAll(ISSUE_URL_RE, ' $1#$2 ');
  const urls = new Set<string>();
  for (const m of text.matchAll(ISSUE_MENTION_RE)) {
    const target = m[1] ?? (own && `${own.owner}/${own.repo}`);
    if (target) urls.add(`https://github.com/${target}/issues/${m[2]}`);
  }
  return [...urls];
}

/** GitHub rejects a search whose text is longer than this. */
const MAX_SEARCH_QUERY_CHARS = 256;
/**
 * Room kept inside that limit for what callers add around the scope: the
 * state qualifiers (`is:pr is:closed is:unmerged`) and two date bounds.
 */
const SCOPE_QUERY_BUDGET = MAX_SEARCH_QUERY_CHARS - 96;
/** An organisation login that is safe to put in a search query. */
const ORG_LOGIN_RE = /^[\w.-]+$/;

/** The search scope every ledger and count query shares; see {@link externalPRScope}. */
export interface ExternalPRScope {
  /** Qualifiers to append to `is:pr <state>`. */
  query: string;
  /**
   * True when `query` excludes every untracked organisation, so the search's
   * `total_count` is the number of PRs the ledger may hold. False when the
   * list did not fit GitHub's limits: results must still be filtered with
   * `isUntrackedOrg`, and the total is an overcount.
   */
  isExact: boolean;
}

/**
 * Which of the user's PRs the ledgers and their counts cover: public
 * repositories only, not the user's own, and not organisations in
 * `config.untrackedOrgs` (the user's employer). One fragment, so the merged
 * and closed ledger fetches and the count searches cannot drift apart: a
 * count taken over a wider set than the ledger can hold would report a gap
 * no back-fill closes.
 */
export function externalPRScope(username: string, untrackedOrgs: readonly string[] = []): ExternalPRScope {
  const base = `is:public author:${username} -user:${username}`;
  const exclusions = untrackedOrgs.map((org) => ` -org:${org}`).join('');
  // No cap on the number of exclusions: a live search with ten `-org:` terms
  // was accepted and returned a count. GitHub's documented limit of five
  // operators is about the AND / OR / NOT keywords, not `-qualifier` terms.
  const isExact =
    untrackedOrgs.every((org) => ORG_LOGIN_RE.test(org)) && base.length + exclusions.length <= SCOPE_QUERY_BUDGET;
  if (!isExact) {
    debug(MODULE, 'untrackedOrgs do not fit in a search query; filtering results instead, totals are not comparable.');
  }
  return { query: isExact ? base + exclusions : base, isExact };
}

/** Shape of a search result item from octokit.search.issuesAndPullRequests. */
type SearchItem = {
  html_url: string;
  title?: string;
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
  /**
   * Every non-own PR the search returned (before the star filter), as
   * URL + title. Lets the daily run spot repos that were transferred or
   * renamed since a stored PR was recorded (see findRepoTransfers).
   */
  searchedPRs: Array<{ url: string; title: string }>;
  /**
   * True when the search had more results than it fetched (pagination cap),
   * so `repos` undercounts and a repo missing from it may still have PRs.
   */
  truncated: boolean;
  /**
   * GitHub's `total_count` for the search: every PR in {@link externalPRScope},
   * before the star filter and whatever the pagination cap. Absent when
   * unknown (failed fetch, a result cached before the field existed, or
   * untracked organisations that did not fit in the query), which is not the
   * same as zero.
   */
  totalCount?: number;
}

/** Returns an empty PRCountsResult. Used as the fallback when stats fetches fail or username is empty. */
export function emptyPRCountsResult<R>(): PRCountsResult<R> {
  return {
    repos: new Map(),
    monthlyCounts: {},
    monthlyOpenedCounts: {},
    dailyActivityCounts: {},
    searchedPRs: [],
    truncated: false,
  };
}

/** Serialized shape of a cached PRCountsResult (Map stored as entries array). */
interface CachedPRCounts {
  reposEntries: [string, unknown][];
  monthlyCounts: Record<string, number>;
  monthlyOpenedCounts: Record<string, number>;
  dailyActivityCounts: Record<string, number>;
  /** Absent on entries cached before searchedPRs existed. */
  searchedPRs?: Array<{ url: string; title: string }>;
  truncated?: boolean;
  totalCount?: number;
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
    obj.dailyActivityCounts !== null &&
    ['number', 'undefined'].includes(typeof obj.totalCount)
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
  starFilter: StarFilter | undefined,
  untrackedOrgs: readonly string[],
): Promise<PRCountsResult<R>> {
  if (!githubUsername) {
    return emptyPRCountsResult<R>();
  }

  // Check for a fresh cached result (avoids 10-20 paginated API calls)
  const cache = getHttpCache();
  const minStarsSuffix = starFilter ? `:stars${starFilter.minStars}` : '';
  // v4: public repositories only, untracked organisations excluded (#1924).
  // Sorted, so reordering the setting does not discard a fresh cache entry.
  const orgKey = untrackedOrgs.map((org) => org.toLowerCase()).sort((a, b) => a.localeCompare(b));
  const orgsSuffix = orgKey.length > 0 ? `:-${orgKey.join(',')}` : '';
  const cacheKey = `pr-counts:v4:${label}:${githubUsername}${minStarsSuffix}${orgsSuffix}`;
  const scope = externalPRScope(githubUsername, untrackedOrgs);
  const cached = cache.getIfFresh(cacheKey, PR_COUNTS_CACHE_TTL_MS);
  if (cached && isCachedPRCounts(cached)) {
    debug(MODULE, `Using cached ${label} PR counts for @${githubUsername}`);
    return {
      repos: new Map(cached.reposEntries as [string, R][]),
      monthlyCounts: cached.monthlyCounts,
      monthlyOpenedCounts: cached.monthlyOpenedCounts,
      dailyActivityCounts: cached.dailyActivityCounts,
      searchedPRs: Array.isArray(cached.searchedPRs) ? cached.searchedPRs : [],
      truncated: cached.truncated === true,
      totalCount: cached.totalCount,
    };
  }

  debug(MODULE, `Fetching ${label} PR counts for @${githubUsername}...`);

  const repos = new Map<string, R>();
  const monthlyCounts: Record<string, number> = {};
  const monthlyOpenedCounts: Record<string, number> = {};
  const dailyActivityCounts: Record<string, number> = {};
  const searchedPRs: Array<{ url: string; title: string }> = [];
  let page = 1;
  let fetched = 0;
  let totalCount!: number;

  while (true) {
    const { data } = await octokit.search.issuesAndPullRequests({
      q: `is:pr ${query} ${scope.query}`,
      sort: 'updated',
      order: 'desc',
      per_page: 100,
      page,
    });

    totalCount = data.total_count;

    for (const item of data.items) {
      const parsed = extractOwnerRepo(item.html_url);
      if (!parsed) {
        warn(MODULE, `Skipping ${label} PR with unparseable URL: ${item.html_url}`);
        continue;
      }

      const { owner } = parsed;
      const repo = `${owner}/${parsed.repo}`;

      // Skip own repos (PRs to your own repos aren't OSS contributions) and
      // untracked organisations (never counted, whether or not the query excluded them).
      if (isOwnRepo(owner, githubUsername) || isUntrackedOrg(owner, untrackedOrgs)) continue;

      searchedPRs.push({ url: item.html_url, title: item.title ?? '' });

      // Skip repos below the minimum star threshold (#576).
      // Repos with unknown star counts (not yet fetched) are also excluded (fail-closed).
      if (starFilter && isBelowMinStars(starFilter.knownStarCounts.get(repo), starFilter.minStars)) {
        continue;
      }

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

  const isTruncated = fetched < totalCount;
  if (isTruncated && page >= MAX_PAGINATION_PAGES) {
    warn(
      MODULE,
      `Pagination capped at ${MAX_PAGINATION_PAGES} pages: fetched ${fetched} of ${totalCount} ${label} PRs. Stats may be incomplete for prolific contributors.`,
    );
  }

  debug(MODULE, `Found ${fetched} ${label} PRs across ${repos.size} repos`);
  const comparableTotal = scope.isExact ? totalCount : undefined;

  // Cache the aggregated result (Map → entries array for JSON serialization).
  // Note: truncated results (from pagination cap) are cached with the same TTL. This is an
  // accepted tradeoff — prolific contributors (300+ PRs) may see slightly incomplete stats
  // for up to 24 hours, but these are cosmetic and self-heal on the next cache expiry.
  cache.set(cacheKey, '', {
    reposEntries: Array.from(repos.entries()),
    truncated: isTruncated,
    totalCount: comparableTotal,
    monthlyCounts,
    monthlyOpenedCounts,
    dailyActivityCounts,
    searchedPRs,
  });

  return {
    repos,
    monthlyCounts,
    monthlyOpenedCounts,
    dailyActivityCounts,
    searchedPRs,
    totalCount: comparableTotal,
    truncated: isTruncated,
  };
}

/**
 * Fetch merged PR counts and latest merge dates per repository for the configured user.
 * Also builds a monthly histogram of all merges for the contribution timeline.
 */
export function fetchUserMergedPRCounts(
  octokit: Octokit,
  githubUsername: string,
  starFilter?: StarFilter,
  untrackedOrgs: readonly string[] = [],
): Promise<PRCountsResult<{ count: number; lastMergedAt: string }>> {
  return fetchUserPRCounts(
    octokit,
    githubUsername,
    'is:merged',
    'merged',
    (repos, repo, item) => {
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
    },
    starFilter,
    untrackedOrgs,
  );
}

/**
 * Fetch closed-without-merge PR counts per repository for the configured user.
 * Used to populate closedWithoutMergeCount in repo scores for accurate merge rate.
 */
export function fetchUserClosedPRCounts(
  octokit: Octokit,
  githubUsername: string,
  starFilter?: StarFilter,
  untrackedOrgs: readonly string[] = [],
): Promise<PRCountsResult<number>> {
  return fetchUserPRCounts(
    octokit,
    githubUsername,
    'is:closed is:unmerged',
    'closed',
    (repos, repo, item) => {
      repos.set(repo, (repos.get(repo) || 0) + 1);
      return item.closed_at || '';
    },
    starFilter,
    untrackedOrgs,
  );
}

/**
 * A recently merged or recently closed PR list that is missing entries
 * (#1928): the recent-list truncation. Not the count-search truncation of
 * the all-time merged and closed counts (`PRCountsResult.truncated`).
 */
export interface RecentListTruncation {
  /** Short form for lists of degraded operations, e.g. `recently merged PR search truncated (300 of 450)`. */
  label: string;
  /** Full sentence for logs and the daily warnings. */
  message: string;
}

/** Word a partial recent-PR search: a failed later page, else the counts read. */
function describeRecentListTruncation(label: string, search: SearchPagesResult<unknown>): RecentListTruncation {
  const read = search.items.length;
  if (search.failure) {
    const cause = describeError(search.failure.error);
    return {
      label: `recently ${label} PR search failed on page ${search.failure.page} (${read} read)`,
      message: `Recently ${label} PR search failed on page ${search.failure.page} (${cause}); only the ${read} result(s) from the page(s) before it were read. Some recently ${label} PRs may be missing this run.`,
    };
  }
  return {
    label: `recently ${label} PR search truncated (${read} of ${search.totalCount})`,
    message: `Recently ${label} PR search is partial: read the ${read} most recently updated of ${search.totalCount} result(s). Some recently ${label} PRs may be missing this run.`,
  };
}

/**
 * Shared helper: search for recent PRs and filter out own repos.
 *
 * Callers pass an `updated:>={since}` query rather than `closed:`/`merged:`.
 * GitHub's search index populates the close/merge date facets separately from
 * the `closed_at`/`merged_at` payload fields, and a PR can be indexed for
 * `updated:` while its close-date facet is missing — such a PR silently
 * vanishes from any `closed:>=X` filter even though the API returns a correct
 * `closed_at`. `updated` is the sort key, so it is always indexed. We narrow to
 * the real window here with `dateOf`.
 *
 * Reads up to `SEARCH_MAX_PAGES` pages (`searchAllPages`). When the list is
 * still partial (more results than were read, a later page failed, or GitHub
 * flagged the search incomplete), what was read is returned and the
 * recent-list truncation is logged and pushed to `truncations`, so the caller
 * can report it and hold back anything that reads "not in this list" as a
 * fact (#1928).
 */
async function fetchRecentPRs<T>(
  octokit: Octokit,
  config: { githubUsername: string; untrackedOrgs?: string[] },
  query: string,
  label: string,
  days: number,
  mapItem: (
    item: {
      html_url: string;
      title: string;
      created_at?: string | null;
      closed_at: string | null;
      body?: string | null;
      pull_request?: { merged_at?: string | null };
    },
    parsed: { owner: string; repo: string; number: number },
  ) => T,
  dateOf: (item: {
    closed_at: string | null;
    pull_request?: { merged_at?: string | null };
  }) => string | null | undefined,
  truncations?: RecentListTruncation[],
): Promise<T[]> {
  if (!config.githubUsername) {
    warn(MODULE, `Skipping recently ${label} PRs fetch: no githubUsername configured. Run /setup-oss to configure.`);
    return [];
  }

  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  const since = sinceDate.toISOString().split('T', 1)[0]; // YYYY-MM-DD

  debug(MODULE, `Fetching recently ${label} PRs for @${config.githubUsername} (since ${since})...`);

  // The shared scope keeps untracked organisations out of the search itself,
  // so their PRs use no page slots; the owner filter below stays for a list
  // that does not fit in a query.
  const scope = externalPRScope(config.githubUsername, config.untrackedOrgs);
  const search = await searchAllPages((page) =>
    octokit.search.issuesAndPullRequests({
      page,
      q: query.replace('{scope}', scope.query).replace('{since}', since),
      sort: 'updated',
      order: 'desc',
      per_page: 100,
    }),
  );
  const { items } = search;
  if (search.truncated) {
    const truncation = describeRecentListTruncation(label, search);
    warn(MODULE, truncation.message);
    truncations?.push(truncation);
  }

  const results: T[] = [];

  for (const item of items) {
    const parsed = parseGitHubUrl(item.html_url);
    if (!parsed) {
      warn(MODULE, `Could not parse GitHub URL from API response: ${item.html_url}`);
      continue;
    }

    // Skip own repos
    if (isOwnRepo(parsed.owner, config.githubUsername)) continue;
    if (isUntrackedOrg(parsed.owner, config.untrackedOrgs)) continue;

    // The query bounds on `updated`, so an old PR that just got a comment can
    // come back. Narrow to the actual close/merge window here.
    const date = dateOf(item);
    if (!date || date < since) continue;

    const repo = `${parsed.owner}/${parsed.repo}`;
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
  config: { githubUsername: string; untrackedOrgs?: string[] },
  days: number = 7,
  truncations?: RecentListTruncation[],
): Promise<ClosedPR[]> {
  return fetchRecentPRs<ClosedPR>(
    octokit,
    config,
    'is:pr is:closed is:unmerged {scope} updated:>={since}',
    'closed',
    days,
    (item, { repo, number }) => ({
      url: item.html_url,
      repo,
      number,
      title: item.title,
      closedAt: item.closed_at || '',
      // Free on the search result — feeds the outcome ledger (#1461).
      openedAt: item.created_at || undefined,
      issueUrl: closingIssueUrl(item.body, item.html_url),
    }),
    (item) => item.closed_at,
    truncations,
  );
}

/**
 * Fetch PRs merged in the last N days.
 * Returns lightweight MergedPR objects for surfacing as wins in the dashboard.
 */
export async function fetchRecentlyMergedPRs(
  octokit: Octokit,
  config: { githubUsername: string; untrackedOrgs?: string[] },
  days: number = 7,
  truncations?: RecentListTruncation[],
): Promise<MergedPR[]> {
  return fetchRecentPRs<MergedPR>(
    octokit,
    config,
    'is:pr is:merged {scope} updated:>={since}',
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
        // Free on the search result — feeds the outcome ledger (#1461).
        openedAt: item.created_at || undefined,
        issueUrl: closingIssueUrl(item.body, item.html_url),
      };
    },
    (item) => item.pull_request?.merged_at || item.closed_at,
    truncations,
  );
}

/**
 * Shared adapter for the two `since`-incremental PR fetches (merged and
 * closed-without-merge). Both walk the Search API, skip own-org results, and
 * project each item into a stored-shape record. They differ only in the
 * search query, the date field on the result, and label strings (#958).
 */
interface PRFetchAdapter<T> {
  /** Label used in log / warn messages: "merged" or "closed". */
  kind: string;
  /** Noun used in "no {noun} date" skip warnings: "merge" or "close". */
  dateNoun: string;
  /** Build the Search API `q` query string from the shared scope (see externalPRScope). */
  buildQuery: (scope: string, since: string | undefined) => string;
  /** Extract the relevant timestamp from a search item. Return empty string if missing. */
  extractDate: (item: SearchItemForPRs) => string;
  /** Build the stored-shape record from an item and its extracted date. */
  buildRecord: (item: SearchItemForPRs, date: string) => T;
}

/** Minimal subset of the Search API item fields we consume. */
type SearchItemForPRs = {
  html_url: string;
  title: string;
  created_at?: string | null;
  closed_at?: string | null;
  body?: string | null;
  pull_request?: { merged_at?: string | null } | null;
};

/**
 * Most PRs a ledger gap fetch takes in one run (the Search API's own cap for
 * a single query). A search matching more returns nothing: the caller stores
 * no rows, so the ledger's newest entry stays where it was, the next run asks
 * for the same range, and `ledger-backfill` (no limit) is the way out.
 */
export const LEDGER_GAP_MAX_RESULTS = 1000;

/** What the daily run and the dashboard report when a merged-ledger gap fetch is truncated. */
export const MERGED_LEDGER_TRUNCATED_MESSAGE =
  `More than ${LEDGER_GAP_MAX_RESULTS} merged PRs changed since the merged-PR ledger was last filled, ` +
  'so none were stored. Run `ledger-backfill` to fetch the full history.';

/** What the daily run and the dashboard report when a closed-ledger gap fetch is truncated. */
export const CLOSED_LEDGER_TRUNCATED_MESSAGE =
  `More than ${LEDGER_GAP_MAX_RESULTS} closed PRs changed since the closed-PR ledger was last filled, ` +
  'so none were stored. Run `ledger-backfill` to fetch the full history.';

/**
 * A ledger with fewer rows than this that is short of GitHub's all-time count
 * is refetched from the start (#1504, #1925): a recent row stored ahead of the
 * history behind it would otherwise hide that history from every gap fetch.
 * Past it a short ledger keeps its watermark, so a contributor whose count
 * legitimately exceeds the ledger doesn't refetch everything on every run;
 * the count warning and `ledger-backfill` cover that case.
 */
export const LEDGER_BACKFILL_CEILING = 300;

/**
 * The watermark a ledger gap fetch starts from: undefined (all time) when the
 * ledger holds `stored` rows, fewer than `allTimeCount` and under
 * {@link LEDGER_BACKFILL_CEILING}, and the whole history fits in one gap fetch
 * ({@link LEDGER_GAP_MAX_RESULTS}); otherwise `watermark`. An unknown count
 * keeps the watermark.
 *
 * A history larger than one fetch would come back truncated with no rows, and
 * the caller then stores nothing, the recent list included, on every run. So
 * that ledger keeps growing from its watermark and the count warning points
 * at `ledger-backfill`, which fetches without a limit.
 */
export function gapFetchWatermark(
  watermark: string | undefined,
  stored: number,
  allTimeCount: number | undefined,
): string | undefined {
  const total = allTimeCount ?? 0;
  return stored < total && stored < LEDGER_BACKFILL_CEILING && total <= LEDGER_GAP_MAX_RESULTS ? undefined : watermark;
}

/** How far before the watermark a gap fetch starts: covers clock skew and search indexing lag. */
const LEDGER_GAP_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** Result of a since-watermark ledger fetch. */
export interface PRsSinceResult<T> {
  /** Every matching PR. Empty when `truncated`: a partial range is never returned. */
  prs: T[];
  /** The search matched more than the caller's limit, so the range was not fetched. */
  truncated: boolean;
}

/**
 * The search bound for a ledger watermark (its newest stored date): one
 * overlap earlier, at second precision. An absent or unparseable watermark
 * gives undefined, which means "all time".
 */
export function withLedgerOverlap(watermark: string = ''): string | undefined {
  const time = Date.parse(watermark);
  if (Number.isNaN(time)) return undefined;
  const bound = new Date(time - LEDGER_GAP_OVERLAP_MS);
  return `${bound.toISOString().slice(0, 19)}Z`;
}

interface SearchWindow {
  items: SearchItemForPRs[];
  /** GitHub's `total_count` for this window's query. */
  totalCount: number;
  /** The window reached the end of its results (as opposed to its page cap). */
  isExhausted: boolean;
}

/**
 * Up to MAX_PAGINATION_PAGES pages of `q`, oldest-created first. That order
 * never changes while paging (a PR's creation date is fixed), and it lets the
 * caller continue past the page cap with a `created:>=` bound instead of deep
 * pages. Stops after the first page when the total exceeds `maxResults`.
 */
async function fetchSearchWindow(octokit: Octokit, q: string, maxResults: number): Promise<SearchWindow> {
  const items: SearchItemForPRs[] = [];
  let totalCount = 0;
  let isExhausted = false;
  for (let page = 1; !isExhausted && page <= MAX_PAGINATION_PAGES && totalCount <= maxResults; page++) {
    const { data } = await octokit.search.issuesAndPullRequests({
      q,
      sort: 'created',
      order: 'asc',
      per_page: 100,
      page,
    });
    totalCount = data.total_count;
    items.push(...(data.items as SearchItemForPRs[]));
    isExhausted = items.length >= totalCount || data.items.length === 0;
  }
  return { items, totalCount, isExhausted };
}

/** What a ledger fetch reads from the user's config. */
export interface LedgerFetchConfig {
  githubUsername: string;
  /** Organisations whose PRs are never stored (the user's employer). */
  untrackedOrgs?: readonly string[];
}

/** The stored-shape record for a search item, or undefined when it is skipped. */
function toStoredRecord<T>(
  item: SearchItemForPRs,
  config: LedgerFetchConfig,
  adapter: PRFetchAdapter<T>,
): T | undefined {
  const parsed = parseGitHubUrl(item.html_url);
  if (!parsed) {
    warn(MODULE, `Skipping ${adapter.kind} PR with unparseable URL: ${item.html_url}`);
    return undefined;
  }
  if (isOwnRepo(parsed.owner, config.githubUsername)) return undefined;
  // Never stored, whether or not the query could exclude the organisation.
  if (isUntrackedOrg(parsed.owner, config.untrackedOrgs)) return undefined;
  const date = adapter.extractDate(item);
  if (!date) {
    warn(MODULE, `Skipping ${adapter.kind} PR with no ${adapter.dateNoun} date: ${item.html_url}`);
    return undefined;
  }
  return adapter.buildRecord(item, date);
}

/**
 * A window that ended on its page cap without a later creation date to
 * continue from (300 PRs created in one second, or no creation dates). The
 * walk would repeat it forever, so it counts as truncated.
 */
function isWalkStuck(page: SearchWindow, cursor: string | undefined, next: string | undefined): boolean {
  return !page.isExhausted && (!next || next === cursor);
}

/**
 * Every PR matching the adapter's query for `since`, or `truncated` when
 * there are more than `maxResults`. Walks the results in windows of
 * MAX_PAGINATION_PAGES pages, each starting at the creation date the last one
 * ended on, so no request goes to a deep page. A request failure rejects;
 * nothing partial is returned either way.
 */
async function fetchPRsSince<T extends { url: string }>(
  octokit: Octokit,
  config: LedgerFetchConfig,
  adapter: PRFetchAdapter<T>,
  since: string | undefined,
  maxResults: number,
): Promise<PRsSinceResult<T>> {
  if (!config.githubUsername) {
    warn(MODULE, `Skipping ${adapter.kind} PRs fetch: no githubUsername configured.`);
    return { prs: [], truncated: false };
  }

  const scope = externalPRScope(config.githubUsername, config.untrackedOrgs);
  const baseQuery = adapter.buildQuery(scope.query, since);
  debug(MODULE, `Fetching ${adapter.kind} PRs: ${baseQuery}`);

  const prs: T[] = [];
  const seen = new Set<string>();
  let query = baseQuery;
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchSearchWindow(octokit, query, maxResults);
    const next = page.items.at(-1)?.created_at ?? undefined;
    if (page.totalCount > maxResults || isWalkStuck(page, cursor, next)) {
      warn(
        MODULE,
        `Not storing ${adapter.kind} PRs: the search matched ${page.totalCount}, more than one run fetches.`,
      );
      return { prs: [], truncated: true };
    }
    for (const item of page.items) {
      const record = toStoredRecord(item, config, adapter);
      if (record && !seen.has(record.url)) prs.push(record);
      seen.add(item.html_url);
    }
    if (page.isExhausted) break;
    cursor = next;
    query = `${baseQuery} created:>=${cursor}`;
  }

  debug(MODULE, `Fetched ${prs.length} ${adapter.kind} PRs`);
  return { prs, truncated: false };
}

const MERGED_ADAPTER: PRFetchAdapter<StoredMergedPR> = {
  kind: 'merged',
  dateNoun: 'merge',
  // Bounded on `updated`, not `merged`: GitHub can index a PR for `updated:`
  // while its merge-date facet is missing (see fetchRecentPRs), and such a PR
  // would never match `merged:>`. Every PR merged after a date was also
  // updated after it, so this is a superset; re-seen rows dedupe on write.
  buildQuery: (scope, s) => `is:pr is:merged ${scope}` + (s ? ` updated:>${s}` : ''),
  extractDate: (item) => item.pull_request?.merged_at || item.closed_at || '',
  buildRecord: (item, date) => ({
    url: item.html_url,
    title: item.title,
    mergedAt: date,
    // Free on the search result — feeds the outcome ledger (#1461).
    openedAt: item.created_at || undefined,
    issueUrl: closingIssueUrl(item.body, item.html_url),
  }),
};

/**
 * The one fetch that fills the merged-PR ledger (#1924), shared by the daily
 * run, the dashboard and `ledger-backfill`: every merged PR updated since
 * `watermark` (the ledger's newest `mergedAt`) minus a one-day overlap, or
 * all of them when there is no watermark.
 *
 * `truncated` (more than `maxResults` matches) returns no rows. Callers must
 * then add nothing newer to the ledger, so its watermark does not move past
 * the range that was not fetched. `ledger-backfill` passes `Infinity`.
 */
export async function fetchMergedPRsSince(
  octokit: Octokit,
  config: LedgerFetchConfig,
  watermark?: string,
  maxResults: number = LEDGER_GAP_MAX_RESULTS,
): Promise<PRsSinceResult<StoredMergedPR>> {
  return fetchPRsSince(octokit, config, MERGED_ADAPTER, withLedgerOverlap(watermark), maxResults);
}

const CLOSED_ADAPTER: PRFetchAdapter<StoredClosedPR> = {
  kind: 'closed',
  dateNoun: 'close',
  // `is:unmerged` leaves out merged PRs, which GitHub also counts as closed.
  // Bounded on `updated` for the same reason as MERGED_ADAPTER: the close-date
  // facet can be missing from the index (see fetchRecentPRs).
  buildQuery: (scope, s) => `is:pr is:closed is:unmerged ${scope}` + (s ? ` updated:>${s}` : ''),
  extractDate: (item) => item.closed_at || '',
  buildRecord: (item, date) => ({
    url: item.html_url,
    title: item.title,
    closedAt: date,
    // Free on the search result — feeds the outcome ledger (#1461).
    openedAt: item.created_at || undefined,
    issueUrl: closingIssueUrl(item.body, item.html_url),
  }),
};

/**
 * The closed-without-merge mirror of {@link fetchMergedPRsSince} (#1925),
 * shared by the daily run, the dashboard and `ledger-backfill`: every closed
 * PR updated since `watermark` (the ledger's newest `closedAt`) minus a
 * one-day overlap, or all of them when there is no watermark. Same
 * `truncated` contract: no rows, so the watermark does not move.
 */
export async function fetchClosedPRsSince(
  octokit: Octokit,
  config: LedgerFetchConfig,
  watermark?: string,
  maxResults: number = LEDGER_GAP_MAX_RESULTS,
): Promise<PRsSinceResult<StoredClosedPR>> {
  return fetchPRsSince(octokit, config, CLOSED_ADAPTER, withLedgerOverlap(watermark), maxResults);
}
