/**
 * GitHub fetches behind the review follow-ups phase (#1857): the two
 * reviewed-PR searches, the per-PR activity fetch and the compare call.
 * Extracted from `PRMonitor` like github-stats.ts, so pr-monitor.ts stays
 * readable; `PRMonitor` exposes thin wrappers that supply the Octokit
 * instance and the config.
 */

import type { Octokit } from '@octokit/rest';
import { rethrowRejections } from './concurrency.js';
import {
  ConfigurationError,
  ValidationError,
  describeError,
  getHttpStatusCode,
  isRateLimitOrAuthError,
} from './errors.js';
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

/**
 * GitHub lists at most this many commits for a pull request, however many
 * pages are asked for; past it the last page comes back short, so
 * `paginateAllDetailed` cannot tell on its own. The commit list is cut when
 * it reaches this count or does not end at the PR's head.
 */
export const PR_COMMITS_LIST_MAX = 250;

/** Result of `PRMonitor.fetchReviewedOpenPRs`. */
export interface ReviewedPRSearchResult {
  /** Deduplicated across both searches and sorted most recently updated first. */
  prs: ReviewedPRRef[];
  /**
   * Per search: one entry when its results were cut by the page cap or a
   * failed page, plus one when GitHub flagged a page as incomplete.
   */
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

/** One search's items across the pages that were read. */
interface SearchPages {
  items: SearchItem[];
  /** `total_count` from the last page read; 0 when none was. */
  totalCount: number;
  /** Pages read successfully. */
  pagesRead: number;
  /** GitHub flagged a page `incomplete_results` (the search timed out server-side and returned what it had). */
  incomplete: boolean;
  /** The page whose request failed, with the error; the pages before it were kept. */
  failure?: { page: number; error: unknown };
}

/**
 * Read one search page by page, most recently updated first, up to
 * {@link REVIEWED_PR_SEARCH_MAX_PAGES}. A page that fails ends the search
 * with what was read so far and the failure recorded; a rate-limit or auth
 * error propagates instead.
 */
async function searchPages(octokit: Octokit, q: string): Promise<SearchPages> {
  const result: SearchPages = { items: [], totalCount: 0, pagesRead: 0, incomplete: false };
  for (let page = 1; page <= REVIEWED_PR_SEARCH_MAX_PAGES; page++) {
    let data: Awaited<ReturnType<Octokit['search']['issuesAndPullRequests']>>['data'];
    try {
      ({ data } = await octokit.search.issuesAndPullRequests({
        q,
        page,
        sort: 'updated',
        order: 'desc',
        per_page: SEARCH_PER_PAGE,
      }));
    } catch (error) {
      if (isRateLimitOrAuthError(error)) throw error;
      result.failure = { page, error };
      return result;
    }
    result.pagesRead = page;
    result.totalCount = data.total_count;
    if (data.incomplete_results) result.incomplete = true;
    result.items.push(...data.items);
    if (data.items.length < SEARCH_PER_PAGE || result.items.length >= result.totalCount) break;
  }
  return result;
}

/** Why a search did not cover every result: a failed page, else the page cap; undefined when it did. */
function coverageWarning(subject: string, pages: SearchPages): string | undefined {
  if (pages.failure) {
    return (
      `GitHub search for ${subject} failed on page ${pages.failure.page} (${describeError(pages.failure.error)}); ` +
      `only the ${pages.items.length} result(s) from the ${pages.pagesRead} page(s) before it were read this run.`
    );
  }
  if (pages.items.length < pages.totalCount) {
    return (
      `GitHub Search API reports ${pages.totalCount} ${subject}, but only the ${pages.items.length} most recently ` +
      `updated were read (${pages.pagesRead} page(s) of ${SEARCH_PER_PAGE}). Older reviewed PRs are not checked this run.`
    );
  }
  return undefined;
}

/** The warnings one search earned: incomplete coverage (failed page or page cap), and an incomplete page. */
function searchWarnings(label: string, pages: SearchPages): string[] {
  const subject = `open PRs you ${label} (not authored)`;
  const messages: string[] = [];
  const coverage = coverageWarning(subject, pages);
  if (coverage !== undefined) messages.push(coverage);
  if (pages.incomplete) {
    messages.push(
      `GitHub Search API returned incomplete results for ${subject} (the search timed out server-side); ` +
        `some reviewed PRs may be missing this run.`,
    );
  }
  return messages;
}

/** Most recently updated first; an unreadable `updatedAt` sorts last. */
function byUpdatedDesc(a: ReviewedPRRef, b: ReviewedPRRef): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

/**
 * Open PRs the configured user reviewed or commented on but did not author:
 * `is:pr is:open reviewed-by:<user> -author:<user>` plus the same with
 * `commenter:` (a review left as a plain comment), merged, deduplicated by
 * URL and sorted most recently updated first across both searches, so a
 * per-run cap downstream drops the quietest PRs whichever search found
 * them. Each search reads up to {@link REVIEWED_PR_SEARCH_MAX_PAGES} pages
 * and records one warning when more results exist beyond the pages read,
 * one when a page failed (the pages before it are kept and the other search
 * still runs), and one when GitHub flagged a page as incomplete. Dropped
 * without a warning, like every other PR list: PRs in the user's own repos,
 * in `untrackedOrgs`, in `excludeRepos` or `excludeOrgs`, and anything the
 * search returned that is not a pull request or that the user authored
 * after all.
 *
 * @throws {ConfigurationError} If no GitHub username is configured
 * @throws Octokit rate-limit and auth errors unchanged
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
    const pages = await searchPages(octokit, `is:pr is:open is:public ${qualifier}:${username} -author:${username}`);
    for (const item of pages.items) {
      if (seen.has(item.html_url)) continue;
      seen.add(item.html_url);
      const ref = filter.toRef(item);
      if (ref) prs.push(ref);
    }
    for (const message of searchWarnings(label, pages)) {
      warnings.push(message);
      warn(MODULE, message);
    }
  }
  prs.sort(byUpdatedDesc);
  debug(MODULE, `Found ${prs.length} open PRs reviewed by @${username}`);
  return { prs, warnings };
}

/**
 * Everything the review follow-up scan reads for one PR: the PR itself
 * (head SHA, state, author), issue comments, reviews, inline review
 * comments and commits, the lists paginated. Five calls per PR (more past
 * 100 items). `truncatedLists` names the lists that hit the pagination cap;
 * they arrive oldest-first, so the newest activity would be missing. The
 * commit list is also reported cut when it reaches GitHub's own
 * {@link PR_COMMITS_LIST_MAX} or its last entry is not the PR's head: past
 * 250 commits GitHub returns a short final page, which looks complete.
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
  const isCommitListCut = commits.items.length >= PR_COMMITS_LIST_MAX || commits.items.at(-1)?.sha !== pr.head.sha;
  if (isCommitListCut || commits.truncated) truncatedLists.push('commits');
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
