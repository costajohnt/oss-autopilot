/**
 * GitHub fetches behind the review follow-ups phase (#1857): the two
 * reviewed-PR searches, the per-PR activity fetch and the compare call.
 * Extracted from `PRMonitor` like github-stats.ts, so pr-monitor.ts stays
 * readable; `PRMonitor` exposes thin wrappers that supply the Octokit
 * instance and the config.
 */

import type { Octokit } from '@octokit/rest';
import { rethrowRejections } from './concurrency.js';
import { ConfigurationError, ValidationError, getHttpStatusCode } from './errors.js';
import { debug, warn } from './logger.js';
import { paginateAllDetailed } from './pagination.js';
import type { ReviewedPRActivity, ReviewedPRActivityList, ReviewedPRRef } from './reviewed-prs.js';
import { isOwnRepo, isUntrackedOrg, parseGitHubUrl } from './urls.js';

const MODULE = 'reviewed-prs';

/**
 * Search pages read per reviewed-PR query. Same ceiling as the PR count
 * searches: the Search API gets unreliable (500s, ECONNRESET) past page 3,
 * and 300 reviewed PRs per query is far more than a run should enrich.
 */
export const REVIEWED_PR_SEARCH_MAX_PAGES = 3;

const SEARCH_PER_PAGE = 100;

/** Result of `PRMonitor.fetchReviewedOpenPRs`. */
export interface ReviewedPRSearchResult {
  /** Deduplicated across both searches, most recently updated first. */
  prs: ReviewedPRRef[];
  /** One entry per search whose results were cut by the page or 1000-result cap. */
  warnings: string[];
}

/** Outcome of `PRMonitor.fetchCompareStatus`. */
export type CompareStatus = 'ahead' | 'behind' | 'diverged' | 'identical' | 'missing';

/** The config fields the search reads. */
export interface ReviewedPRSearchConfig {
  githubUsername: string;
  untrackedOrgs?: string[];
  excludeRepos?: string[];
  excludeOrgs?: string[];
}

/** The two searches behind the reviewed-PR list, with the label used in cap warnings. */
const REVIEWED_PR_SEARCHES: ReadonlyArray<{ qualifier: string; label: string }> = [
  { qualifier: 'reviewed-by', label: 'reviewed' },
  { qualifier: 'commenter', label: 'commented on' },
];

/** Shape of a search result item from octokit.search.issuesAndPullRequests. */
type SearchItem = {
  html_url: string;
  title: string;
  updated_at: string;
  user?: { login?: string } | null;
  pull_request?: unknown;
};

/** Value of a settled promise known to have fulfilled (the caller already rethrew any rejection). */
function fulfilledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

function parsePRUrl(prUrl: string): { owner: string; repo: string; number: number } {
  const parsed = parseGitHubUrl(prUrl);
  if (!parsed || parsed.type !== 'pull') {
    throw new ValidationError(`Invalid PR URL format: ${prUrl}`);
  }
  return parsed;
}

/** The repo-level exclusions, resolved once per search run. */
class ReviewedPRFilter {
  private readonly usernameLower: string;
  private readonly excludedRepos: Set<string>;
  private readonly excludedOrgs: Set<string>;

  constructor(private readonly config: ReviewedPRSearchConfig) {
    this.usernameLower = config.githubUsername.toLowerCase();
    this.excludedRepos = new Set((config.excludeRepos ?? []).map((repo) => repo.toLowerCase()));
    this.excludedOrgs = new Set((config.excludeOrgs ?? []).map((org) => org.toLowerCase()));
  }

  private isRepoExcluded(owner: string, repo: string): boolean {
    const ownerLower = owner.toLowerCase();
    if (isOwnRepo(owner, this.config.githubUsername) || isUntrackedOrg(owner, this.config.untrackedOrgs)) return true;
    return this.excludedRepos.has(repo.toLowerCase()) || this.excludedOrgs.has(ownerLower);
  }

  /**
   * The ref for a search item, or undefined when it is dropped: not a pull
   * request, an unparseable URL (warned), authored by the user after all,
   * or in an own, untracked or excluded repo or org.
   */
  toRef(item: SearchItem): ReviewedPRRef | undefined {
    if (!item.pull_request) return undefined;
    const parsed = parseGitHubUrl(item.html_url);
    if (!parsed || parsed.type !== 'pull') {
      warn(MODULE, `Skipping reviewed PR with unparseable URL: ${item.html_url}`);
      return undefined;
    }
    const author = item.user?.login ?? '';
    const repo = `${parsed.owner}/${parsed.repo}`;
    if (author.toLowerCase() === this.usernameLower || this.isRepoExcluded(parsed.owner, repo)) return undefined;
    return { repo, author, url: item.html_url, number: parsed.number, title: item.title, updatedAt: item.updated_at };
  }
}

/** One search's items across its pages, plus how many results it reported in total. */
async function searchPages(
  octokit: Octokit,
  q: string,
): Promise<{ items: SearchItem[]; fetched: number; totalCount: number }> {
  const items: SearchItem[] = [];
  let totalCount = 0;
  for (let page = 1; page <= REVIEWED_PR_SEARCH_MAX_PAGES; page++) {
    const { data } = await octokit.search.issuesAndPullRequests({
      q,
      page,
      sort: 'updated',
      order: 'desc',
      per_page: SEARCH_PER_PAGE,
    });
    totalCount = data.total_count;
    items.push(...data.items);
    if (data.items.length < SEARCH_PER_PAGE || items.length >= totalCount) break;
  }
  return { items, totalCount, fetched: items.length };
}

/**
 * Open PRs the configured user reviewed or commented on but did not author:
 * `is:pr is:open reviewed-by:<user> -author:<user>` plus the same with
 * `commenter:` (a review left as a plain comment), merged and deduplicated
 * by URL. Each search reads up to {@link REVIEWED_PR_SEARCH_MAX_PAGES}
 * pages, most recently updated first, and records one warning when more
 * results exist (the page cap or the Search API's 1000-result cap). Dropped
 * without a warning, like every other PR list: PRs in the user's own repos,
 * in `untrackedOrgs`, in `excludeRepos` or `excludeOrgs`, and anything the
 * search returned that is not a pull request or that the user authored
 * after all.
 *
 * @throws {ConfigurationError} If no GitHub username is configured
 * @throws Octokit errors (rate limit, auth, 5xx) unchanged
 */
export async function fetchReviewedOpenPRs(
  octokit: Octokit,
  config: ReviewedPRSearchConfig,
): Promise<ReviewedPRSearchResult> {
  const username = config.githubUsername;
  if (!username) {
    throw new ConfigurationError('No GitHub username configured. Run setup first.');
  }
  const filter = new ReviewedPRFilter(config);
  const prs: ReviewedPRRef[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];

  for (const { qualifier, label } of REVIEWED_PR_SEARCHES) {
    const q = `is:pr is:open is:public ${qualifier}:${username} -author:${username}`;
    const { items, fetched, totalCount } = await searchPages(octokit, q);
    for (const item of items) {
      if (seen.has(item.html_url)) continue;
      seen.add(item.html_url);
      const ref = filter.toRef(item);
      if (ref) prs.push(ref);
    }
    if (fetched < totalCount) {
      const message =
        `GitHub Search API reports ${totalCount} open PRs you ${label} (not authored), but only the ${fetched} ` +
        `most recently updated were read (${REVIEWED_PR_SEARCH_MAX_PAGES} pages of ${SEARCH_PER_PAGE}; ` +
        `the API caps results at 1000). Older reviewed PRs are not checked this run.`;
      warnings.push(message);
      warn(MODULE, message);
    }
  }
  debug(MODULE, `Found ${prs.length} open PRs reviewed by @${username}`);
  return { prs, warnings };
}

/**
 * Everything the review follow-up scan reads for one PR: the PR itself
 * (head SHA, state, author), issue comments, reviews, inline review
 * comments and commits, the lists paginated. Five calls per PR (more past
 * 100 items). `truncatedLists` names the lists that hit the pagination cap;
 * they arrive oldest-first, so the newest activity would be missing.
 *
 * The five calls run together; when more than one fails, a rate-limit or
 * auth error is rethrown ahead of the others.
 *
 * @throws {ValidationError} If `prUrl` is not a GitHub PR URL
 * @throws Octokit errors (404 when the PR is gone, rate limit, auth) unchanged
 */
export async function fetchReviewedPRActivity(
  octokit: Octokit,
  prUrl: string,
): Promise<ReviewedPRActivity & { truncatedLists: ReviewedPRActivityList[] }> {
  const { owner, repo, number } = parsePRUrl(prUrl);
  const settled = await Promise.allSettled([
    octokit.pulls.get({ owner, repo, pull_number: number }),
    paginateAllDetailed((page) =>
      octokit.issues.listComments({ owner, repo, page, issue_number: number, per_page: 100 }),
    ),
    paginateAllDetailed((page) => octokit.pulls.listReviews({ owner, repo, page, pull_number: number, per_page: 100 })),
    paginateAllDetailed((page) =>
      octokit.pulls.listReviewComments({ owner, repo, page, pull_number: number, per_page: 100 }),
    ),
    paginateAllDetailed((page) => octokit.pulls.listCommits({ owner, repo, page, pull_number: number, per_page: 100 })),
  ]);
  rethrowRejections(settled);
  const pr = fulfilledValue(settled[0]).data;
  const comments = fulfilledValue(settled[1]);
  const reviews = fulfilledValue(settled[2]);
  const reviewComments = fulfilledValue(settled[3]);
  const commits = fulfilledValue(settled[4]);
  const truncatedLists: ReviewedPRActivityList[] = [];
  if (comments.truncated) truncatedLists.push('comments');
  if (reviews.truncated) truncatedLists.push('reviews');
  if (reviewComments.truncated) truncatedLists.push('review comments');
  if (commits.truncated) truncatedLists.push('commits');
  return {
    truncatedLists,
    pr: { headSha: pr.head.sha, state: pr.state, author: pr.user?.login, title: pr.title },
    comments: comments.items,
    reviews: reviews.items,
    reviewComments: reviewComments.items,
    commits: commits.items,
  };
}

/**
 * How `head` relates to `base` in the PR's repository: `ahead` or
 * `identical` means `base` is an ancestor of `head` and `<base>...<head>`
 * shows exactly what changed since; `behind` or `diverged` means the branch
 * was rebased or force-pushed. A 404 (GitHub no longer has `base`, as after
 * a force-push once the old commits are collected) is reported as
 * `missing`. One call; the commit list is not requested.
 *
 * @throws {ValidationError} If `prUrl` is not a GitHub PR URL
 * @throws Octokit errors other than 404 (rate limit, auth, 5xx) unchanged
 */
export async function fetchCompareStatus(
  octokit: Octokit,
  prUrl: string,
  base: string,
  head: string,
): Promise<CompareStatus> {
  const { owner, repo } = parsePRUrl(prUrl);
  try {
    const { data } = await octokit.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
      per_page: 1,
    });
    return data.status;
  } catch (error) {
    if (getHttpStatusCode(error) === 404) return 'missing';
    throw error;
  }
}
