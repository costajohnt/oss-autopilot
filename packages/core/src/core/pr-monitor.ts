/**
 * PR Monitor - Fetches and checks PR status from GitHub.
 * v2: fetchUserOpenPRs() is stateless (no local PR tracking),
 * Score methods still write to state.
 *
 * Decomposed into focused modules (#263):
 * - ci-analysis.ts: CI status fetching, check classification and analysis
 * - review-analysis.ts: Review decision and comment detection
 * - checklist-analysis.ts: PR body checklist analysis
 * - maintainer-analysis.ts: Maintainer action hint extraction
 * - display-utils.ts: Display label computation
 * - github-stats.ts: Merged/closed PR counts and star-based filtering
 * - status-determination.ts: PR status classification logic
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { parseGitHubUrl, extractOwnerRepo, isOwnRepo } from './urls.js';
import { DEFAULT_CONCURRENCY, runWorkerPool } from './concurrency.js';
import { FetchedPR, DailyDigest, ClosedPR, MergedPR, StarFilter } from './types.js';
import {
  ConfigurationError,
  ValidationError,
  errorMessage,
  getHttpStatusCode,
  isInvalidUserSearchError,
  isRateLimitOrAuthError,
} from './errors.js';
import { paginateAllDetailed, type PaginateAllResult } from './pagination.js';
import { debug, warn, timed } from './logger.js';
import { getHttpCache, cachedRequest } from './http-cache.js';

import { getCIStatus } from './ci-analysis.js';
import { type ReviewComment } from './review-analysis.js';
import { assembleFetchedPR, type CommitInfo } from './pr-assembly.js';
import { batchFetchPRDetails, type PRRef, type NormalizedPRData, type BatchPRResult } from './pr-graphql.js';
import {
  type PRCountsResult,
  fetchUserMergedPRCounts as fetchUserMergedPRCountsImpl,
  fetchUserClosedPRCounts as fetchUserClosedPRCountsImpl,
  fetchRecentlyClosedPRs as fetchRecentlyClosedPRsImpl,
  fetchRecentlyMergedPRs as fetchRecentlyMergedPRsImpl,
} from './github-stats.js';
import { isPlaceholderUsername } from './placeholder-usernames.js';

// Re-export so existing consumers can still import from pr-monitor
export { computeDisplayLabel } from './display-utils.js';
export { categorizeCIStatus, classifyCICheck, classifyFailingChecks, getCIStatus } from './ci-analysis.js';
export { isConditionalChecklistItem } from './checklist-analysis.js';
export { determineStatus } from './status-determination.js';

/**
 * Check if a PR has a merge conflict based on GitHub's mergeable flag and mergeable_state.
 * Returns true when mergeable is explicitly false or the mergeable_state is 'dirty'.
 *
 * @param mergeable - GitHub's mergeable flag (null when not yet computed)
 * @param mergeableState - GitHub's mergeable_state string
 */
export function hasMergeConflict(mergeable: boolean | null, mergeableState: string | null): boolean {
  return mergeable === false || mergeableState === 'dirty';
}

const MODULE = 'pr-monitor';

const MAX_CONCURRENT_REQUESTS = DEFAULT_CONCURRENCY;

export interface PRCheckFailure {
  prUrl: string;
  error: string;
}

export interface FetchPRsResult {
  prs: FetchedPR[];
  failures: PRCheckFailure[];
  /**
   * Non-fatal warnings accumulated while fetching. Populated by:
   * - Placeholder auto-repair (stale/example `githubUsername` replaced with
   *   the authenticated viewer's login before the search runs).
   * - Post-fetch viewer-mismatch guardrail (configured username differs
   *   from the authenticated viewer when the search returned zero PRs).
   * - Search API 1000-result truncation (#1057 M25).
   * - Per-PR comment pagination truncation (#1456) — newest comments
   *   dropped, so unresponded-comment detection may be incomplete.
   * Callers (daily, dashboard) surface these so users see the signal.
   */
  warnings?: string[];
}

/**
 * Fetches and enriches open PRs from GitHub for the configured user.
 *
 * In v2, all PR data is fetched fresh on each run — no local PR tracking.
 * CI status, reviews, merge conflicts, and maintainer comments are enriched
 * for each PR to compute a {@link FetchedPRStatus}.
 */
export class PRMonitor {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;

  /**
   * @param githubToken - GitHub personal access token or token from `gh auth token`
   */
  constructor(githubToken: string) {
    this.octokit = getOctokit(githubToken);
    this.stateManager = getStateManager();
  }

  /**
   * Fetch all open PRs for the configured user fresh from GitHub.
   * This is the main entry point for the v2 architecture.
   *
   * @returns All open PRs enriched with status, plus any failures
   * @throws {ConfigurationError} If no GitHub username is configured
   *
   * @example
   * ```typescript
   * import { PRMonitor, requireGitHubToken } from '@oss-autopilot/core';
   *
   * const monitor = new PRMonitor(requireGitHubToken());
   * const { prs, failures } = await monitor.fetchUserOpenPRs();
   * console.log(`Found ${prs.length} open PRs, ${failures.length} failures`);
   * ```
   */
  async fetchUserOpenPRs(): Promise<FetchPRsResult> {
    const initialConfig = this.stateManager.getState().config;

    if (!initialConfig.githubUsername) {
      throw new ConfigurationError('No GitHub username configured. Run setup first.');
    }

    // Non-fatal warnings threaded into the result (#1057 M25). When the
    // Search API's hard 1000-result ceiling truncates the user's PR list we
    // previously silently dropped the overflow; now the caller can surface
    // it so the daily digest doesn't quietly report a partial view.
    const warnings: string[] = [];

    // Username used for the search — mutated below if the pre-fetch placeholder
    // repair fires. Writing to config is separate from rebinding this local.
    let searchUsername = initialConfig.githubUsername;

    // Proactive placeholder repair: if the configured username is a known
    // placeholder (e.g. "example-user" carried over from docs or an aborted
    // setup), cross-check against the authenticated viewer and persist the
    // corrected name before fetching. Without this, the search silently
    // returns zero results and the dashboard looks like a fresh install.
    // Errors here are non-fatal; rate-limit/auth failures still abort so we
    // don't mask a revoked token by downgrading to a no-op.
    let didRepair = false;
    if (isPlaceholderUsername(searchUsername)) {
      try {
        const { data: viewer } = await this.octokit.users.getAuthenticated();
        const newLogin = viewer.login?.trim();
        // Guard against an empty/whitespace viewer login (enterprise proxies,
        // stubbed Octokit clients) and against the pathological case where the
        // authenticated viewer's login is itself one of our placeholder strings
        // — persisting either would swap one broken config for another.
        if (!newLogin || isPlaceholderUsername(newLogin)) {
          const message =
            `Placeholder username "${searchUsername}" detected but authenticated viewer ` +
            `returned an unusable login (${JSON.stringify(viewer.login)}); skipping auto-repair.`;
          warnings.push(message);
          warn(MODULE, message);
        } else {
          this.stateManager.updateConfig({ githubUsername: newLogin });
          searchUsername = newLogin;
          didRepair = true;
          const message =
            `Configured GitHub username "${initialConfig.githubUsername}" looks like a placeholder. ` +
            `Auto-repaired to "${newLogin}" using the authenticated viewer.`;
          warnings.push(message);
          warn(MODULE, message);
        }
      } catch (err) {
        if (isRateLimitOrAuthError(err)) throw err;
        // Non-fatal viewer-lookup failures (5xx, network, unexpected shape):
        // surface as a warning (not debug) so the daily digest shows that
        // auto-repair was attempted and couldn't complete. Falls through to
        // the normal fetch with the placeholder, which will then return zero
        // results — the post-fetch guardrail skips its own getAuthenticated
        // attempt since this one already failed the same way.
        const message = `Could not auto-repair placeholder username "${searchUsername}": ${errorMessage(err)}`;
        warnings.push(message);
        warn(MODULE, message);
      }
    }

    debug('pr-monitor', `Fetching open PRs for @${searchUsername}...`);

    // Search for all open PRs authored by the user with pagination
    let page = 1;
    const perPage = 100;

    let firstPage: Awaited<ReturnType<typeof this.octokit.search.issuesAndPullRequests>>;
    try {
      firstPage = await this.octokit.search.issuesAndPullRequests({
        q: `is:pr is:open is:public author:${searchUsername}`,
        sort: 'updated',
        order: 'desc',
        per_page: perPage,
        page: 1,
      });
    } catch (err) {
      // Rewrite the Search API's "users do not exist" 422 into an actionable
      // ConfigurationError naming the configured username (#1323). The raw
      // Octokit message ("Validation Failed: ...") gives the user no signal
      // that the cause is local config rather than a transient GitHub issue.
      if (isInvalidUserSearchError(err)) {
        throw new ConfigurationError(
          `Configured GitHub username "${searchUsername}" was not found on GitHub. ` +
            `Run \`/setup-oss\` to reconfigure, or edit \`config.githubUsername\` in ` +
            `\`~/.oss-autopilot/state.json\` directly.`,
        );
      }
      throw err;
    }

    const allItems: typeof firstPage.data.items = [];
    allItems.push(...firstPage.data.items);
    const totalCount = firstPage.data.total_count;
    debug(MODULE, `Found ${totalCount} open PRs`);

    // Fetch remaining pages if needed (GitHub search API returns max 1000 results)
    const SEARCH_API_RESULT_CAP = 1000;
    const MAX_PAGES = Math.ceil(SEARCH_API_RESULT_CAP / perPage); // 10 pages at per_page=100
    const totalPages = Math.min(Math.ceil(totalCount / perPage), MAX_PAGES);

    // Guardrail: if the Search API returned zero PRs, cross-check the
    // configured username against the authenticated viewer. This catches
    // stale usernames (e.g. a renamed GitHub account) that are not in the
    // known-placeholder set. Skipped when the pre-fetch repair already
    // reconciled the two — no need to spend a second getAuthenticated call
    // just to confirm a match we already established.
    if (totalCount === 0 && !didRepair) {
      try {
        const { data: viewer } = await this.octokit.users.getAuthenticated();
        if (viewer.login.toLowerCase() !== searchUsername.toLowerCase()) {
          const message =
            `Configured GitHub username @${searchUsername} does not match ` +
            `authenticated user @${viewer.login}. Did you mean to run ` +
            `\`oss-autopilot config username ${viewer.login}\`? Zero PRs returned.`;
          warnings.push(message);
          warn(MODULE, message);
        }
      } catch (err) {
        // Rate-limit/401/403 errors must abort the run just like every sibling
        // fetch in this pipeline — swallowing them here would mask the exact
        // class of failure the guardrail is meant to surface (e.g. revoked
        // token returning 401 while the unauthenticated Search above still
        // succeeds with zero results).
        if (isRateLimitOrAuthError(err)) throw err;
        debug(MODULE, `Could not cross-check viewer login: ${errorMessage(err)}`);
      }
    }

    if (totalCount > SEARCH_API_RESULT_CAP) {
      warnings.push(
        `GitHub Search API returned ${totalCount} PRs for @${searchUsername}, ` +
          `but results are capped at ${SEARCH_API_RESULT_CAP}. ` +
          `Showing the ${SEARCH_API_RESULT_CAP} most recently updated PRs.`,
      );
      warn(MODULE, warnings[warnings.length - 1]);
    }

    while (page < totalPages) {
      page++;
      const nextPage = await this.octokit.search.issuesAndPullRequests({
        q: `is:pr is:open is:public author:${searchUsername}`,
        sort: 'updated',
        order: 'desc',
        per_page: perPage,
        page,
      });
      allItems.push(...nextPage.data.items);
    }

    // Filter items to only PRs worth fetching
    const prs: FetchedPR[] = [];
    const failures: PRCheckFailure[] = [];

    const filteredItems = allItems.filter((item) => {
      if (!item.pull_request) return false;
      // Skip PRs to repos owned by the user (not OSS contributions)
      const parsed = extractOwnerRepo(item.html_url);
      if (!parsed) {
        warn('pr-monitor', `Skipping PR with unparseable URL: ${item.html_url}`);
        return false;
      }
      if (isOwnRepo(parsed.owner, searchUsername)) return false;
      return true;
    });

    debug('pr-monitor', `Filtered to ${filteredItems.length} PRs after excluding own repos`);

    // Build PR references for the batched GraphQL enrichment. `parseGitHubUrl`
    // is the authoritative parser (the filter above used `extractOwnerRepo`);
    // anything it can't parse as a PR is skipped with a warning.
    const refs: PRRef[] = [];
    const refByUrl = new Map<string, PRRef>();
    for (const item of filteredItems) {
      const parsed = parseGitHubUrl(item.html_url);
      if (!parsed || parsed.type !== 'pull') {
        warn(MODULE, `Skipping PR with unparseable URL: ${item.html_url}`);
        continue;
      }
      const ref: PRRef = { owner: parsed.owner, repo: parsed.repo, number: parsed.number, url: item.html_url };
      refs.push(ref);
      refByUrl.set(item.html_url, ref);
    }

    // Enrich PRs. The batched GraphQL path (separate 5000-point/hr bucket) handles
    // the common case in a handful of ~1-point queries; anything it can't resolve
    // (connection cap overflow, missing node, GraphQL outage) falls back to the
    // per-PR REST path via the worker pool.
    await timed('pr-monitor', `Fetch details for ${refs.length} PRs`, async () => {
      let batch: BatchPRResult;
      try {
        batch = await batchFetchPRDetails(this.octokit, refs);
      } catch (error) {
        // A fatal batch-level GraphQL error (rate limit / auth). Don't crash the
        // run — route every PR to the REST path, which surfaces per-PR failures
        // exactly as the pre-GraphQL implementation did.
        warn(MODULE, `GraphQL batch enrichment failed (${errorMessage(error)}); falling back to REST for all PRs`);
        batch = { resolved: new Map(), restFallbackUrls: refs.map((r) => r.url) };
      }

      // Assemble GraphQL-resolved PRs (no additional network calls).
      for (const [url, data] of batch.resolved) {
        const ref = refByUrl.get(url);
        if (!ref) continue;
        try {
          prs.push(await this.assembleFromNormalized(ref, data));
        } catch (error) {
          const errMsg = errorMessage(error);
          warn('pr-monitor', `Error assembling ${url}: ${errMsg}`);
          failures.push({ prUrl: url, error: errMsg });
        }
      }

      // REST fallback for the remainder, using a worker pool for bounded concurrency.
      await runWorkerPool(
        batch.restFallbackUrls,
        async (url) => {
          try {
            debug('pr-monitor', `Fetching details for ${url} (REST fallback)`);
            const pr = await this.fetchPRDetails(url, warnings);
            if (pr) prs.push(pr);
          } catch (error) {
            const errMsg = errorMessage(error);
            warn('pr-monitor', `Error fetching ${url}: ${errMsg}`);
            failures.push({ prUrl: url, error: errMsg });
          }
        },
        MAX_CONCURRENT_REQUESTS,
      );
    });

    // Sort by status (needs_addressing first, then waiting_on_maintainer)
    prs.sort((a, b) => {
      if (a.status === b.status) return 0;
      return a.status === 'needs_addressing' ? -1 : 1;
    });

    return warnings.length > 0 ? { prs, failures, warnings } : { prs, failures };
  }

  /**
   * Fetch detailed information for a single PR via the REST enrichment path.
   *
   * This is the fallback path in the GraphQL-batched architecture (#1539
   * lineage): PRs that the batched GraphQL query couldn't resolve (a connection
   * cap, a missing/inaccessible node, or a GraphQL outage) are enriched here.
   * Both paths funnel through the shared {@link assembleFetchedPR} pipeline, so
   * the computed status is identical regardless of transport.
   */
  private async fetchPRDetails(prUrl: string, warnings?: string[]): Promise<FetchedPR | null> {
    const parsed = parseGitHubUrl(prUrl);
    if (!parsed || parsed.type !== 'pull') {
      throw new ValidationError(`Invalid PR URL format: ${prUrl}`);
    }

    const { owner, repo, number } = parsed;
    const config = this.stateManager.getState().config;

    // Fetch PR data, comments, reviews, and inline review comments in parallel.
    // listReviewComments is non-critical (used for self-reply detection), so degrade
    // gracefully on failure rather than dropping the entire PR (#199).
    const [prResponse, commentsResult, reviewsResponse, reviewCommentsResult] = await Promise.all([
      this.octokit.pulls.get({ owner, repo, pull_number: number }),
      paginateAllDetailed((page) =>
        this.octokit.issues.listComments({ owner, repo, issue_number: number, per_page: 100, page }),
      ),
      this.octokit.pulls.listReviews({ owner, repo, pull_number: number }),
      paginateAllDetailed((page) =>
        this.octokit.pulls.listReviewComments({ owner, repo, pull_number: number, per_page: 100, page }),
      ).catch((err: unknown) => {
        const status = getHttpStatusCode(err);
        // Rate limit errors must propagate — silently swallowing them hides
        // a systemic problem and produces misleading results (#229).
        if (status === 429) {
          throw err;
        }
        if (status === 403) {
          const msg = errorMessage(err).toLowerCase();
          if (msg.includes('rate limit') || msg.includes('abuse detection')) {
            throw err;
          }
          // Non-rate-limit 403 (DMCA, private repo, SSO) — degrade gracefully
          warn('pr-monitor', `403 fetching review comments for ${owner}/${repo}#${number}: ${msg}`);
          return { items: [], truncated: false } as PaginateAllResult<ReviewComment>;
        }
        if (status === 404) {
          debug('pr-monitor', `Review comments 404 for ${owner}/${repo}#${number} (likely no inline comments)`);
        } else {
          warn(
            'pr-monitor',
            `Failed to fetch review comments for ${owner}/${repo}#${number} (status ${status ?? 'unknown'}): self-reply detection will be skipped`,
          );
        }
        return { items: [], truncated: false } as PaginateAllResult<ReviewComment>;
      }),
    ]);
    const { items: comments } = commentsResult;
    const { items: reviewComments } = reviewCommentsResult;

    // Surface pagination truncation through the caller's warnings channel
    // (#1456): comments arrive oldest-first, so hitting the cap drops the
    // NEWEST maintainer feedback — status determination (unresponded-comment
    // detection) may be wrong for this PR.
    if (commentsResult.truncated || reviewCommentsResult.truncated) {
      const message =
        `Comment pagination cap reached for ${owner}/${repo}#${number}; the newest comments were not ` +
        `fetched and unresponded-comment detection may be incomplete.`;
      warnings?.push(message);
      warn(MODULE, message);
    }

    const ghPR = prResponse.data;
    const reviews = reviewsResponse.data;

    const ciStatus = await getCIStatus(this.octokit, owner, repo, ghPR.head.sha);

    // The commit date is only consulted (and only fetched) when the PR has an
    // unresponded maintainer comment or a changes-requested review — the shared
    // pipeline decides via `needCommitDate` and invokes this thunk lazily.
    return assembleFetchedPR(
      {
        prUrl,
        owner,
        repo,
        number,
        id: ghPR.id,
        title: ghPR.title,
        body: ghPR.body || '',
        createdAt: ghPR.created_at,
        updatedAt: ghPR.updated_at,
        hasMergeConflict: hasMergeConflict(ghPR.mergeable, ghPR.mergeable_state),
        comments,
        reviews,
        reviewComments,
        ciStatus,
      },
      config,
      () => this.fetchCommitInfo(owner, repo, ghPR.head.sha),
    );
  }

  /**
   * Fetch the HEAD commit's author date and login via REST `repos.getCommit`.
   * Rate-limit errors propagate (silently swallowing them produces misleading
   * status, e.g. needs_changes when changes were addressed) (#469); other
   * failures degrade to `undefined` so the PR is still returned.
   */
  private async fetchCommitInfo(owner: string, repo: string, sha: string): Promise<CommitInfo | undefined> {
    try {
      const res = await this.octokit.repos.getCommit({ owner, repo, ref: sha });
      return {
        date: res.data.commit.author?.date,
        // GitHub user login of the commit author (may differ from git author)
        author: res.data.author?.login,
      };
    } catch (err) {
      const status = getHttpStatusCode(err);
      if (status === 429) throw err;
      if (status === 403) {
        const msg = errorMessage(err).toLowerCase();
        if (msg.includes('rate limit') || msg.includes('abuse detection')) throw err;
        // Non-rate-limit 403 (DMCA, private repo, SSO) — degrade gracefully
        warn('pr-monitor', `403 fetching commit date for ${owner}/${repo}@${sha.slice(0, 7)}: ${errorMessage(err)}`);
        return undefined;
      }
      warn('pr-monitor', `Failed to fetch commit date for ${owner}/${repo}@${sha.slice(0, 7)}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  /**
   * Assemble a {@link FetchedPR} from GraphQL-batched {@link NormalizedPRData}.
   * No network calls: the batch already carries the commit info, so the shared
   * pipeline's lazy commit thunk just returns it.
   */
  private assembleFromNormalized(ref: PRRef, data: NormalizedPRData): Promise<FetchedPR> {
    const config = this.stateManager.getState().config;
    return assembleFetchedPR(
      {
        prUrl: ref.url,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        id: data.id,
        title: data.title,
        body: data.body,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        hasMergeConflict: data.hasMergeConflict,
        comments: data.comments,
        reviews: data.reviews,
        reviewComments: data.reviewComments,
        ciStatus: data.ciStatus,
      },
      config,
      async () => data.commitInfo,
    );
  }

  /**
   * Fetch merged PR counts and latest merge dates per repository for the configured user.
   * @param starFilter - Optional filter to exclude low-star repos
   * @returns Per-repo merged counts with monthly breakdowns
   */
  async fetchUserMergedPRCounts(
    starFilter?: StarFilter,
  ): Promise<PRCountsResult<{ count: number; lastMergedAt: string }>> {
    const config = this.stateManager.getState().config;
    return fetchUserMergedPRCountsImpl(this.octokit, config.githubUsername, starFilter);
  }

  /**
   * Fetch closed-without-merge PR counts per repository for the configured user.
   * @param starFilter - Optional filter to exclude low-star repos
   * @returns Per-repo closed counts with monthly breakdowns
   */
  async fetchUserClosedPRCounts(starFilter?: StarFilter): Promise<PRCountsResult<number>> {
    const config = this.stateManager.getState().config;
    return fetchUserClosedPRCountsImpl(this.octokit, config.githubUsername, starFilter);
  }

  /**
   * Fetch metadata (star count and primary language) for a list of repositories.
   * Both fields come from the same `repos.get()` call — zero additional API cost.
   */
  async fetchRepoMetadata(repos: string[]): Promise<Map<string, { stars: number; language: string | null }>> {
    if (repos.length === 0) return new Map();

    debug(MODULE, `Fetching repo metadata for ${repos.length} repos...`);
    const results = new Map<string, { stars: number; language: string | null }>();
    const cache = getHttpCache();

    // Deduplicate repos to avoid fetching the same repo twice
    const uniqueRepos = [...new Set(repos)];

    // Fetch in parallel chunks to avoid overwhelming the API
    const chunkSize = 10;
    for (let i = 0; i < uniqueRepos.length; i += chunkSize) {
      const chunk = uniqueRepos.slice(i, i + chunkSize);
      const settled = await Promise.allSettled(
        chunk.map(async (repo) => {
          const parts = repo.split('/');
          if (parts.length !== 2 || !parts[0] || !parts[1]) {
            throw new ValidationError(`Malformed repo identifier: "${repo}"`);
          }
          const [owner, name] = parts;
          const url = `/repos/${owner}/${name}`;
          const data = await cachedRequest(
            cache,
            url,
            (headers) =>
              this.octokit.repos.get({
                owner,
                repo: name,
                headers,
              }) as Promise<{
                data: { stargazers_count: number; language: string | null };
                headers: Record<string, string>;
              }>,
          );
          const metadata = { stars: data.stargazers_count, language: data.language ?? null };
          return { repo, metadata };
        }),
      );
      let chunkFailures = 0;
      for (let j = 0; j < settled.length; j++) {
        const result = settled[j];
        if (result.status === 'fulfilled') {
          results.set(result.value.repo, result.value.metadata);
        } else {
          chunkFailures++;
          warn(MODULE, `Failed to fetch metadata for ${chunk[j]}: ${errorMessage(result.reason)}`);
        }
      }
      // If entire chunk failed, likely a systemic issue (rate limit, auth, outage) — abort remaining
      if (chunkFailures === chunk.length && chunk.length > 0) {
        const remaining = uniqueRepos.length - i - chunkSize;
        if (remaining > 0) {
          warn(MODULE, `Entire chunk failed, aborting remaining ${remaining} repos`);
        }
        break;
      }
    }

    debug(MODULE, `Fetched repo metadata for ${results.size}/${repos.length} repos`);
    return results;
  }

  /**
   * Fetch PRs closed without merge in the last N days.
   * @param days - Lookback window in days (default: 7)
   * @returns Recently closed PRs
   */
  async fetchRecentlyClosedPRs(days: number = 7): Promise<ClosedPR[]> {
    const config = this.stateManager.getState().config;
    return fetchRecentlyClosedPRsImpl(this.octokit, config, days);
  }

  /**
   * Fetch PRs merged in the last N days.
   * @param days - Lookback window in days (default: 7)
   * @returns Recently merged PRs
   */
  async fetchRecentlyMergedPRs(days: number = 7): Promise<MergedPR[]> {
    const config = this.stateManager.getState().config;
    return fetchRecentlyMergedPRsImpl(this.octokit, config, days);
  }

  /**
   * Generate a daily digest from fetched PRs.
   * @param prs - All open PRs (active + shelved)
   * @param recentlyClosedPRs - PRs closed without merge in the last 7 days
   * @param recentlyMergedPRs - PRs merged in the last 7 days
   * @returns Daily digest with categorized PRs and summary stats
   */
  generateDigest(
    prs: FetchedPR[],
    recentlyClosedPRs: ClosedPR[] = [],
    recentlyMergedPRs: MergedPR[] = [],
  ): DailyDigest {
    const now = new Date().toISOString();

    // Categorize PRs
    const needsAddressingPRs = prs.filter((pr) => pr.status === 'needs_addressing');
    const waitingOnMaintainerPRs = prs.filter((pr) => pr.status === 'waiting_on_maintainer');

    // Get stats from state manager (historical data from repo scores)
    const stats = this.stateManager.getStats();

    return {
      generatedAt: now,
      openPRs: prs,
      needsAddressingPRs,
      waitingOnMaintainerPRs,
      recentlyClosedPRs,
      recentlyMergedPRs,
      shelvedPRs: [],
      autoUnshelvedPRs: [],
      summary: {
        totalActivePRs: prs.length,
        totalNeedingAttention: needsAddressingPRs.length,
        totalMergedAllTime: stats.mergedPRs,
        mergeRate: parseFloat(stats.mergeRate),
      },
    };
  }

  /**
   * Update repository scores based on observed PR (called when we detect merged/closed PRs).
   * @param repo - Repository in "owner/repo" format
   * @param wasMerged - true if the PR was merged, false if closed without merge
   */
  async updateRepoScoreFromObservedPR(repo: string, wasMerged: boolean): Promise<void> {
    if (wasMerged) {
      this.stateManager.incrementMergedCount(repo);
    } else {
      this.stateManager.incrementClosedCount(repo);
    }
  }
}
