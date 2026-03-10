import type { IncomingMessage, ServerResponse } from 'http';
import { Octokit } from '@octokit/rest';

/** Minimal Vercel request/response types (avoids heavy @vercel/node devDependency). */
interface VercelRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
}
interface VercelResponse extends ServerResponse {
  status(code: number): VercelResponse;
  json(body: unknown): VercelResponse;
}

/** GitHub username: alphanumeric or hyphens (not leading/trailing/consecutive), 1-39 chars. */
const GITHUB_USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

const DEFAULT_MIN_STARS = 50;

/** 2s buffer before Vercel Hobby's 10s function timeout. */
const FUNCTION_TIMEOUT_MS = 8000;

interface BadgeResponse {
  schemaVersion: number;
  label: string;
  message: string;
  color: string;
}

function errorBadge(message: string): BadgeResponse {
  return { schemaVersion: 1, label: 'OSS Contributions', message, color: 'lightgrey' };
}

function pickColor(mergeRate: number): string {
  if (mergeRate >= 0.8) return 'brightgreen';
  if (mergeRate >= 0.6) return 'green';
  if (mergeRate >= 0.4) return 'yellow';
  return 'orange';
}

/** In-memory cache for repo star counts (survives across warm invocations). */
const starCache = new Map<string, { stars: number; ts: number }>();
const STAR_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/** In-memory cache for full badge results. */
const badgeCache = new Map<string, { badge: BadgeResponse; ts: number }>();
const BADGE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const STALE_BADGE_TTL = 24 * 60 * 60 * 1000; // 24 hours — fallback during timeouts/errors

async function getRepoStars(octokit: Octokit, owner: string, repo: string): Promise<number> {
  const key = `${owner}/${repo}`;
  const cached = starCache.get(key);
  if (cached && Date.now() - cached.ts < STAR_CACHE_TTL) return cached.stars;

  const { data } = await octokit.repos.get({ owner, repo });
  starCache.set(key, { stars: data.stargazers_count, ts: Date.now() });
  return data.stargazers_count;
}

interface PRItem {
  repository_url: string;
}

/** Fetch all PR items for a search query (up to 1000, GitHub's limit). */
async function fetchAllPRs(octokit: Octokit, query: string): Promise<PRItem[]> {
  const items: PRItem[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.search.issuesAndPullRequests({
      q: query,
      per_page: 100,
      page,
    });
    items.push(...data.items);
    if (items.length >= data.total_count || items.length >= 1000 || data.items.length === 0) break;
    page++;
  }
  return items;
}

/** Extract "owner/repo" from a repository_url like "https://api.github.com/repos/owner/repo". */
function repoFromUrl(url: string): string {
  const parts = url.split('/');
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** Compute badge data by fetching PR stats from GitHub API. */
async function computeBadge(username: string, minStars: number): Promise<BadgeResponse> {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('[badge] GITHUB_TOKEN not set — using unauthenticated GitHub API (60 req/hr limit)');
  }
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN || undefined,
  });

  // Fetch all three categories excluding user's own repos
  const baseQuery = `is:pr author:${username} -user:${username}`;

  const [mergedItems, closedItems, openItems] = await Promise.all([
    fetchAllPRs(octokit, `${baseQuery} is:merged`),
    fetchAllPRs(octokit, `${baseQuery} is:closed is:unmerged`),
    fetchAllPRs(octokit, `${baseQuery} is:open`),
  ]);

  // Collect unique repos across all PRs
  const allItems = [...mergedItems, ...closedItems, ...openItems];
  const uniqueRepos = new Set(allItems.map((item) => repoFromUrl(item.repository_url)));

  // Fetch star counts for all unique repos (parallelized, with caching)
  const repoStarsMap = new Map<string, number>();
  const repoEntries = [...uniqueRepos];
  const BATCH_SIZE = 10;
  for (let i = 0; i < repoEntries.length; i += BATCH_SIZE) {
    const batch = repoEntries.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (repo) => {
        const [owner, name] = repo.split('/');
        try {
          return { repo, stars: await getRepoStars(octokit, owner, name) };
        } catch {
          // Repo may be private/deleted — exclude it
          return { repo, stars: 0 };
        }
      }),
    );
    for (const { repo, stars } of results) {
      repoStarsMap.set(repo, stars);
    }
  }

  // Filter qualifying repos
  const qualifyingRepos = new Set(repoEntries.filter((repo) => (repoStarsMap.get(repo) ?? 0) >= minStars));

  // Count PRs only from qualifying repos
  const mergedCount = mergedItems.filter((item) => qualifyingRepos.has(repoFromUrl(item.repository_url))).length;
  const closedCount = closedItems.filter((item) => qualifyingRepos.has(repoFromUrl(item.repository_url))).length;
  const openCount = openItems.filter((item) => qualifyingRepos.has(repoFromUrl(item.repository_url))).length;

  const total = mergedCount + closedCount;
  const mergeRate = total > 0 ? mergedCount / total : 0;
  const mergeRatePct = `${(mergeRate * 100).toFixed(0)}%`;

  if (mergedCount === 0 && openCount === 0) {
    return { schemaVersion: 1, label: 'OSS Contributions', message: 'Getting Started', color: 'blue' };
  }

  return {
    schemaVersion: 1,
    label: 'OSS Contributions',
    message: `${mergeRatePct} merge rate | ${mergedCount} merged | ${openCount} open`,
    color: pickColor(mergeRate),
  };
}

/** Return stale cached badge if available (within STALE_BADGE_TTL), or an error badge. */
function staleFallback(cacheKey: string, reason: string): BadgeResponse {
  const stale = badgeCache.get(cacheKey);
  if (stale && Date.now() - stale.ts < STALE_BADGE_TTL) {
    console.warn(`[badge] Serving stale cache for ${cacheKey}: ${reason}`);
    return stale.badge;
  }
  return errorBadge('temporarily unavailable');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { username, minStars: minStarsParam } = req.query;

  if (typeof username !== 'string' || !GITHUB_USERNAME_RE.test(username)) {
    return res.status(200).json(errorBadge('invalid username'));
  }

  const minStars =
    typeof minStarsParam === 'string'
      ? Math.max(0, parseInt(minStarsParam, 10) || DEFAULT_MIN_STARS)
      : DEFAULT_MIN_STARS;

  const cacheKey = `${username}:${minStars}`;
  const cached = badgeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < BADGE_CACHE_TTL) {
    return res.status(200).json(cached.badge);
  }

  // Race the computation against a timeout to avoid Vercel's forced 10s kill.
  // Attach .catch() to prevent unhandled rejections if computeBadge throws after timeout.
  const computation = computeBadge(username, minStars);
  computation.catch((err) => {
    console.warn('[badge] Post-timeout error for', username, err instanceof Error ? err.message : String(err));
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      computation,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FUNCTION_TIMEOUT_MS);
      }),
    ]);

    if (timer) clearTimeout(timer);

    if (result === null) {
      console.warn('[badge] Computation timed out for', username);
      return res.status(200).json(staleFallback(cacheKey, 'timeout'));
    }

    badgeCache.set(cacheKey, { badge: result, ts: Date.now() });
    return res.status(200).json(result);
  } catch (error: unknown) {
    if (timer) clearTimeout(timer);
    const status = error instanceof Object && 'status' in error ? (error as { status: number }).status : undefined;
    if (status === 422) {
      return res.status(200).json(errorBadge('user not found'));
    }
    if (status === 403 || status === 429) {
      console.warn('[badge] GitHub API rate limited for', username);
      return res.status(200).json(staleFallback(cacheKey, 'rate limited'));
    }
    console.error('[badge]', error instanceof Error ? error.message : String(error));
    return res.status(200).json(staleFallback(cacheKey, 'error'));
  }
}
