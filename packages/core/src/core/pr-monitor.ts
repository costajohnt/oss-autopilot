/**
 * PR Monitor - Fetches and checks PR status from GitHub.
 * v2: fetchUserOpenPRs() is stateless (no local PR tracking),
 * Score methods still write to state.
 *
 * Decomposed into focused modules (#263):
 * - ci-analysis.ts: CI check classification and analysis
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
import { ConfigurationError, ValidationError, errorMessage, getHttpStatusCode } from './errors.js';
import { paginateAll } from './pagination.js';
import { debug, warn, timed } from './logger.js';
import { getHttpCache, cachedRequest } from './http-cache.js';

// Extracted modules
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
 * Check if PR has merge conflict.
 * Exported as a free function so tests can call it directly without PRMonitor instantiation.
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
}

export class PRMonitor {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;

  constructor(githubToken: string) {
    this.octokit = getOctokit(githubToken);
    this.stateManager = getStateManager();
  }

  /**
   * Fetch all open PRs for the configured user fresh from GitHub
   * This is the main entry point for the v2 architecture
   */
  async fetchUserOpenPRs(): Promise<FetchPRsResult> {
    const config = this.stateManager.getState().config;

    if (!config.githubUsername) {
      throw new ConfigurationError('No GitHub username configured. Run setup first.');
    }

    debug('pr-monitor', `Fetching open PRs for @${config.githubUsername}...`);

    // Search for all open PRs authored by the user with pagination
    const allItems: typeof firstPage.data.items = [];
    let page = 1;
    const perPage = 100;

    const firstPage = await this.octokit.search.issuesAndPullRequests({
      q: `is:pr is:open author:${config.githubUsername}`,
      sort: 'updated',
      order: 'desc',
      per_page: perPage,
      page: 1,
    });

    allItems.push(...firstPage.data.items);
    const totalCount = firstPage.data.total_count;
    debug('pr-monitor', `Found ${totalCount} open PRs`);

    // Fetch remaining pages if needed (GitHub search API returns max 1000 results)
    const totalPages = Math.min(Math.ceil(totalCount / perPage), 10); // Cap at 1000 results
    while (page < totalPages) {
      page++;
      const nextPage = await this.octokit.search.issuesAndPullRequests({
        q: `is:pr is:open author:${config.githubUsername}`,
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
      if (isOwnRepo(parsed.owner, config.githubUsername)) return false;
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

    return { prs, failures };
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
   * Delegates to github-stats module.
   */
  async fetchUserMergedPRCounts(
    starFilter?: StarFilter,
  ): Promise<PRCountsResult<{ count: number; lastMergedAt: string }>> {
    const config = this.stateManager.getState().config;
    return fetchUserMergedPRCountsImpl(this.octokit, config.githubUsername, starFilter);
  }

  /**
   * Fetch closed-without-merge PR counts per repository for the configured user.
   * Delegates to github-stats module.
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
   * Delegates to github-stats module.
   */
  async fetchRecentlyClosedPRs(days: number = 7): Promise<ClosedPR[]> {
    const config = this.stateManager.getState().config;
    return fetchRecentlyClosedPRsImpl(this.octokit, config, days);
  }

  /**
   * Fetch PRs merged in the last N days.
   * Delegates to github-stats module.
   */
  async fetchRecentlyMergedPRs(days: number = 7): Promise<MergedPR[]> {
    const config = this.stateManager.getState().config;
    return fetchRecentlyMergedPRsImpl(this.octokit, config, days);
  }

  /**
   * Generate a daily digest from fetched PRs
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
   * Update repository scores based on observed PR (called when we detect merged/closed PRs)
   */
  async updateRepoScoreFromObservedPR(repo: string, wasMerged: boolean): Promise<void> {
    if (wasMerged) {
      this.stateManager.incrementMergedCount(repo);
    } else {
      this.stateManager.incrementClosedCount(repo);
    }
  }
}
