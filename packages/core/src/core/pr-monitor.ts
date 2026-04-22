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
import { daysBetween, parseGitHubUrl, extractOwnerRepo, isOwnRepo, DEFAULT_CONCURRENCY } from './utils.js';
import { FetchedPR, DailyDigest, ClosedPR, MergedPR, StarFilter } from './types.js';
import { determineStatus } from './status-determination.js';
import { runWorkerPool } from './concurrency.js';
import {
  ConfigurationError,
  ValidationError,
  errorMessage,
  getHttpStatusCode,
  isRateLimitOrAuthError,
} from './errors.js';
import { paginateAll } from './pagination.js';
import { debug, warn, timed } from './logger.js';
import { getHttpCache, cachedRequest } from './http-cache.js';

import { classifyFailingChecks, getCIStatus } from './ci-analysis.js';
import {
  type ReviewComment,
  determineReviewDecision,
  getLatestChangesRequestedDate,
  checkUnrespondedComments,
} from './review-analysis.js';
import { analyzeChecklist } from './checklist-analysis.js';
import { extractMaintainerActionHints } from './maintainer-analysis.js';
import { computeDisplayLabel } from './display-utils.js';
import {
  type PRCountsResult,
  fetchUserMergedPRCounts as fetchUserMergedPRCountsImpl,
  fetchUserClosedPRCounts as fetchUserClosedPRCountsImpl,
  fetchRecentlyClosedPRs as fetchRecentlyClosedPRsImpl,
  fetchRecentlyMergedPRs as fetchRecentlyMergedPRsImpl,
} from './github-stats.js';

// Re-export so existing consumers can still import from pr-monitor
export { computeDisplayLabel } from './display-utils.js';
export { classifyCICheck, classifyFailingChecks, getCIStatus } from './ci-analysis.js';
export { isConditionalChecklistItem } from './checklist-analysis.js';
export { determineStatus } from './status-determination.js';

/**
 * Known placeholder values that can end up in `config.githubUsername` from
 * doc snippets, example configs, or aborted setup flows. When the configured
 * username matches one of these, the PR fetch silently returns zero results
 * and the dashboard looks like a fresh install. Detecting these lets us
 * auto-repair the config from the authenticated viewer before fetching.
 *
 * Entries must be lowercase — `Lowercase<string>` on the source tuple makes
 * a non-lowercase entry a compile error, keeping the case-insensitive lookup
 * contract type-checked instead of comment-documented.
 */
const PLACEHOLDER_USERNAMES: readonly Lowercase<string>[] = [
  'example-user',
  'your-username',
  'your-github-username',
] as const;
const KNOWN_PLACEHOLDER_USERNAMES: ReadonlySet<string> = new Set(PLACEHOLDER_USERNAMES);

function isPlaceholderUsername(username: string): boolean {
  return KNOWN_PLACEHOLDER_USERNAMES.has(username.toLowerCase());
}

// Module-private on purpose: callers should only use the predicate so the
// `.toLowerCase()` contract can't be bypassed by reading the set directly.
export { isPlaceholderUsername };

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
    const allItems: typeof firstPage.data.items = [];
    let page = 1;
    const perPage = 100;

    const firstPage = await this.octokit.search.issuesAndPullRequests({
      q: `is:pr is:open is:public author:${searchUsername}`,
      sort: 'updated',
      order: 'desc',
      per_page: perPage,
      page: 1,
    });

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

    // Fetch detailed info using a worker pool for bounded concurrency.
    await timed('pr-monitor', `Fetch details for ${filteredItems.length} PRs`, async () => {
      await runWorkerPool(
        filteredItems,
        async (item) => {
          try {
            debug('pr-monitor', `Fetching details for ${item.html_url}`);
            const pr = await this.fetchPRDetails(item.html_url);
            if (pr) prs.push(pr);
          } catch (error) {
            const errMsg = errorMessage(error);
            warn('pr-monitor', `Error fetching ${item.html_url}: ${errMsg}`);
            failures.push({ prUrl: item.html_url, error: errMsg });
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
   * Fetch detailed information for a single PR
   */
  private async fetchPRDetails(prUrl: string): Promise<FetchedPR | null> {
    const parsed = parseGitHubUrl(prUrl);
    if (!parsed || parsed.type !== 'pull') {
      throw new ValidationError(`Invalid PR URL format: ${prUrl}`);
    }

    const { owner, repo, number } = parsed;
    const config = this.stateManager.getState().config;

    // Fetch PR data, comments, reviews, and inline review comments in parallel.
    // listReviewComments is non-critical (used for self-reply detection), so degrade
    // gracefully on failure rather than dropping the entire PR (#199).
    const [prResponse, comments, reviewsResponse, reviewComments] = await Promise.all([
      this.octokit.pulls.get({ owner, repo, pull_number: number }),
      paginateAll((page) =>
        this.octokit.issues.listComments({ owner, repo, issue_number: number, per_page: 100, page }),
      ),
      this.octokit.pulls.listReviews({ owner, repo, pull_number: number }),
      paginateAll((page) =>
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
          return [] as ReviewComment[];
        }
        if (status === 404) {
          debug('pr-monitor', `Review comments 404 for ${owner}/${repo}#${number} (likely no inline comments)`);
        } else {
          warn(
            'pr-monitor',
            `Failed to fetch review comments for ${owner}/${repo}#${number} (status ${status ?? 'unknown'}): self-reply detection will be skipped`,
          );
        }
        return [] as ReviewComment[];
      }),
    ]);

    const ghPR = prResponse.data;
    const reviews = reviewsResponse.data;

    // Determine review decision (delegated to review-analysis module)
    const reviewDecision = determineReviewDecision(reviews);

    // Check for merge conflict
    const mergeConflict = hasMergeConflict(ghPR.mergeable, ghPR.mergeable_state);

    // Check if there's an unresponded maintainer comment (delegated to review-analysis module)
    const { hasUnrespondedComment, lastMaintainerComment } = checkUnrespondedComments(
      comments,
      reviews,
      reviewComments,
      config.githubUsername,
    );

    // Fetch CI status and (conditionally) latest commit date in parallel
    // We need the commit date when hasUnrespondedComment is true (to distinguish
    // "needs_response" from "waiting_on_maintainer") OR when reviewDecision is "changes_requested"
    // (to detect needs_changes: review requested changes but no new commits pushed)
    const ciPromise = getCIStatus(this.octokit, owner, repo, ghPR.head.sha);
    const needCommitDate = hasUnrespondedComment || reviewDecision === 'changes_requested';
    const commitInfoPromise = needCommitDate
      ? this.octokit.repos
          .getCommit({ owner, repo, ref: ghPR.head.sha })
          .then((res) => ({
            date: res.data.commit.author?.date,
            // GitHub user login of the commit author (may differ from git author)
            author: res.data.author?.login,
          }))
          .catch((err: unknown) => {
            // Rate limit errors must propagate — silently swallowing them produces
            // misleading status (e.g. needs_changes when changes were addressed) (#469).
            const status = getHttpStatusCode(err);
            if (status === 429) throw err;
            if (status === 403) {
              const msg = errorMessage(err).toLowerCase();
              if (msg.includes('rate limit') || msg.includes('abuse detection')) throw err;
              // Non-rate-limit 403 (DMCA, private repo, SSO) — degrade gracefully
              warn(
                'pr-monitor',
                `403 fetching commit date for ${owner}/${repo}@${ghPR.head.sha.slice(0, 7)}: ${errorMessage(err)}`,
              );
              return undefined;
            }
            warn(
              'pr-monitor',
              `Failed to fetch commit date for ${owner}/${repo}@${ghPR.head.sha.slice(0, 7)}: ${errorMessage(err)}`,
            );
            return undefined;
          })
      : Promise.resolve(undefined);

    const [{ status: ciStatus, failingCheckNames, failingCheckConclusions }, commitInfo] = await Promise.all([
      ciPromise,
      commitInfoPromise,
    ]);
    const latestCommitDate = commitInfo?.date;
    const latestCommitAuthor = commitInfo?.author;

    // Analyze PR body for incomplete checklists (delegated to checklist-analysis module)
    const { hasIncompleteChecklist, checklistStats } = analyzeChecklist(ghPR.body || '');

    // Extract maintainer action hints from comments (delegated to maintainer-analysis module)
    const maintainerActionHints = extractMaintainerActionHints(lastMaintainerComment?.body, reviewDecision);

    // Calculate days since activity
    const daysSinceActivity = daysBetween(new Date(ghPR.updated_at), new Date());

    // Find the date of the latest changes_requested review (delegated to review-analysis module)
    const latestChangesRequestedDate = getLatestChangesRequestedDate(reviews);

    // Classify failing checks (delegated to ci-analysis module)
    const classifiedChecks = classifyFailingChecks(failingCheckNames, failingCheckConclusions);

    // Determine status
    const hasActionableCIFailure = ciStatus === 'failing' && classifiedChecks.some((c) => c.category === 'actionable');
    const { status, actionReason, waitReason, stalenessTier, actionReasons } = determineStatus({
      ciStatus,
      hasMergeConflict: mergeConflict,
      hasUnrespondedComment,
      hasIncompleteChecklist,
      reviewDecision,
      daysSinceActivity,
      dormantThreshold: config.dormantThresholdDays,
      approachingThreshold: config.approachingDormantDays,
      latestCommitDate,
      latestCommitAuthor,
      contributorUsername: config.githubUsername,
      lastMaintainerCommentDate: lastMaintainerComment?.createdAt,
      latestChangesRequestedDate,
      hasActionableCIFailure,
    });

    return this.buildFetchedPR({
      id: ghPR.id,
      url: prUrl,
      repo: `${owner}/${repo}`,
      number,
      title: ghPR.title,
      status,
      actionReason,
      waitReason,
      stalenessTier,
      actionReasons,
      createdAt: ghPR.created_at,
      updatedAt: ghPR.updated_at,
      daysSinceActivity,
      ciStatus,
      failingCheckNames,
      classifiedChecks,
      hasMergeConflict: mergeConflict,
      reviewDecision,
      hasUnrespondedComment,
      lastMaintainerComment,
      latestCommitDate,
      hasIncompleteChecklist,
      checklistStats,
      maintainerActionHints,
    });
  }

  /**
   * Build a FetchedPR object from computed fields and attach display labels.
   * Centralizes PR construction and display label computation (#79).
   */
  private buildFetchedPR(fields: Omit<FetchedPR, 'displayLabel' | 'displayDescription'>): FetchedPR {
    const pr: FetchedPR = {
      ...fields,
      displayLabel: '', // computed below
      displayDescription: '', // computed below
    };

    // Compute display labels (#79) — delegated to display-utils module
    const { displayLabel, displayDescription } = computeDisplayLabel(pr);
    pr.displayLabel = displayLabel;
    pr.displayDescription = displayDescription;

    return pr;
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
