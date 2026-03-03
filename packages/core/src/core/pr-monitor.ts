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
 * - github-stats.ts: Merged/closed PR counts and star fetching
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { daysBetween, parseGitHubUrl, extractOwnerRepo } from './utils.js';
import {
  FetchedPR,
  FetchedPRStatus,
  CIStatusResult,
  DailyDigest,
  ClosedPR,
  MergedPR,
  DetermineStatusInput,
} from './types.js';
import { runWorkerPool } from './concurrency.js';
import { ConfigurationError, ValidationError, errorMessage, getHttpStatusCode } from './errors.js';
import { paginateAll } from './pagination.js';
import { debug, warn, timed } from './logger.js';
import { getHttpCache, cachedRequest } from './http-cache.js';

// Extracted modules
import { classifyFailingChecks, analyzeCheckRuns, analyzeCombinedStatus, mergeStatuses } from './ci-analysis.js';
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
export { classifyCICheck, classifyFailingChecks } from './ci-analysis.js';
export { isConditionalChecklistItem } from './checklist-analysis.js';

const MODULE = 'pr-monitor';

// Concurrency limit for parallel API calls
const MAX_CONCURRENT_REQUESTS = 5;

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

    const shelvedUrls = new Set(config.shelvedPRUrls || []);

    const filteredItems = allItems.filter((item) => {
      if (!item.pull_request) return false;
      // Skip PRs to repos owned by the user (not OSS contributions)
      const parsed = extractOwnerRepo(item.html_url);
      if (!parsed) {
        warn('pr-monitor', `Skipping PR with unparseable URL: ${item.html_url}`);
        return false;
      }
      const ownerLower = parsed.owner.toLowerCase();
      if (ownerLower === config.githubUsername.toLowerCase()) return false;
      const repoFullName = `${parsed.owner}/${parsed.repo}`;
      // Keep shelved PRs even from excluded repos/orgs — excludeRepos is meant
      // to stop finding *new* issues there, not hide open PRs already being tracked (#175)
      const isShelved = shelvedUrls.has(item.html_url);
      if (config.excludeRepos.includes(repoFullName) && !isShelved) return false;
      if (config.excludeOrgs?.some((org) => ownerLower === org.toLowerCase()) && !isShelved) return false;
      return true;
    });

    debug(
      'pr-monitor',
      `Filtered to ${filteredItems.length} PRs after excluding own repos, shelved, and excluded orgs/repos`,
    );

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

    // Sort by days since activity (most urgent first)
    prs.sort((a, b) => {
      // Priority: needs_response > failing_ci > merge_conflict > approaching_dormant > dormant > waiting > healthy
      const statusPriority: Record<FetchedPRStatus, number> = {
        needs_response: 0,
        needs_changes: 1,
        failing_ci: 2,
        ci_blocked: 3,
        ci_not_running: 4,
        merge_conflict: 5,
        needs_rebase: 6,
        missing_required_files: 7,
        incomplete_checklist: 8,
        changes_addressed: 9,
        approaching_dormant: 10,
        dormant: 11,
        waiting: 12,
        waiting_on_maintainer: 13,
        healthy: 14,
      };
      return statusPriority[a.status] - statusPriority[b.status];
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
    const hasMergeConflict = this.hasMergeConflict(ghPR.mergeable, ghPR.mergeable_state);

    // Check if there's an unresponded maintainer comment (delegated to review-analysis module)
    const { hasUnrespondedComment, lastMaintainerComment } = checkUnrespondedComments(
      comments,
      reviews,
      reviewComments,
      config.githubUsername,
    );

    // Fetch CI status and (conditionally) latest commit date in parallel
    // We need the commit date when hasUnrespondedComment is true (to distinguish
    // "needs_response" from "changes_addressed") OR when reviewDecision is "changes_requested"
    // (to detect needs_changes: review requested changes but no new commits pushed)
    const ciPromise = this.getCIStatus(owner, repo, ghPR.head.sha);
    const needCommitDate = hasUnrespondedComment || reviewDecision === 'changes_requested';
    const commitDatePromise = needCommitDate
      ? this.octokit.repos
          .getCommit({ owner, repo, ref: ghPR.head.sha })
          .then((res) => res.data.commit.author?.date)
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

    const [{ status: ciStatus, failingCheckNames, failingCheckConclusions }, latestCommitDate] = await Promise.all([
      ciPromise,
      commitDatePromise,
    ]);

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
    const hasActionableCIFailure =
      ciStatus === 'failing' && classifiedChecks.some((c) => c.category === 'actionable');
    const status = this.determineStatus({
      ciStatus,
      hasMergeConflict,
      hasUnrespondedComment,
      hasIncompleteChecklist,
      reviewDecision,
      daysSinceActivity,
      dormantThreshold: config.dormantThresholdDays,
      approachingThreshold: config.approachingDormantDays,
      latestCommitDate,
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
      createdAt: ghPR.created_at,
      updatedAt: ghPR.updated_at,
      daysSinceActivity,
      ciStatus,
      failingCheckNames,
      classifiedChecks,
      hasMergeConflict,
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
   * Determine the overall status of a PR
   */
  private determineStatus(input: DetermineStatusInput): FetchedPRStatus {
    const {
      ciStatus,
      hasMergeConflict,
      hasUnrespondedComment,
      hasIncompleteChecklist,
      reviewDecision,
      daysSinceActivity,
      dormantThreshold,
      approachingThreshold,
      latestCommitDate,
      lastMaintainerCommentDate,
      latestChangesRequestedDate,
      hasActionableCIFailure = true,
    } = input;

    // Priority order: needs_response/needs_changes/changes_addressed > failing_ci > merge_conflict > incomplete_checklist > dormant > approaching_dormant > waiting_on_maintainer > waiting/healthy

    if (hasUnrespondedComment) {
      // If the contributor pushed a commit after the maintainer's comment,
      // the changes have been addressed — waiting for maintainer re-review
      if (latestCommitDate && lastMaintainerCommentDate && latestCommitDate > lastMaintainerCommentDate) {
        // Safety net (#431): if a CHANGES_REQUESTED review was submitted after
        // the commit, the maintainer still expects changes — don't mask it
        if (latestChangesRequestedDate && latestCommitDate < latestChangesRequestedDate) {
          return 'needs_response';
        }
        if (ciStatus === 'failing' && hasActionableCIFailure) return 'failing_ci';
        // Non-actionable CI failures (infrastructure, fork, auth) don't block changes_addressed —
        // the contributor can't fix them, so the relevant status is "waiting for re-review" (#502)
        return 'changes_addressed';
      }
      return 'needs_response';
    }

    // Review requested changes but no unresponded comment.
    // If the latest commit is before the review, the contributor hasn't addressed it yet.
    if (reviewDecision === 'changes_requested' && latestChangesRequestedDate) {
      if (!latestCommitDate || latestCommitDate < latestChangesRequestedDate) {
        return 'needs_changes';
      }
      // Commit is after review — changes have been addressed
      if (ciStatus === 'failing' && hasActionableCIFailure) return 'failing_ci';
      // Non-actionable CI failures don't block changes_addressed (#502)
      return 'changes_addressed';
    }

    if (ciStatus === 'failing') {
      return hasActionableCIFailure ? 'failing_ci' : 'ci_blocked';
    }

    if (hasMergeConflict) {
      return 'merge_conflict';
    }

    if (hasIncompleteChecklist) {
      return 'incomplete_checklist';
    }

    if (daysSinceActivity >= dormantThreshold) {
      return 'dormant';
    }

    if (daysSinceActivity >= approachingThreshold) {
      return 'approaching_dormant';
    }

    // Approved and CI passing/unknown = waiting on maintainer to merge
    if (reviewDecision === 'approved' && (ciStatus === 'passing' || ciStatus === 'unknown')) {
      return 'waiting_on_maintainer';
    }

    // CI pending means we're waiting
    if (ciStatus === 'pending') {
      return 'waiting';
    }

    return 'healthy';
  }

  /**
   * Check if PR has merge conflict
   */
  private hasMergeConflict(mergeable: boolean | null, mergeableState: string | null): boolean {
    return mergeable === false || mergeableState === 'dirty';
  }

  /**
   * Get CI status from combined status API and check runs.
   * Returns status and names of failing checks for diagnostics.
   * Delegates analysis to ci-analysis module.
   */
  private async getCIStatus(owner: string, repo: string, sha: string): Promise<CIStatusResult> {
    if (!sha) return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };

    try {
      // Fetch both combined status and check runs in parallel
      const [statusResponse, checksResponse] = await Promise.all([
        this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha }),
        // 404 is expected for repos without check runs configured; log other errors for debugging
        this.octokit.checks.listForRef({ owner, repo, ref: sha }).catch((err: unknown) => {
          const status = getHttpStatusCode(err);
          // Rate limit errors must propagate — matches listReviewComments pattern (#481)
          if (status === 429) throw err;
          if (status === 403) {
            const msg = errorMessage(err).toLowerCase();
            if (msg.includes('rate limit') || msg.includes('abuse detection')) throw err;
          }
          if (status === 404) {
            debug('pr-monitor', `Check runs 404 for ${owner}/${repo}@${sha.slice(0, 7)} (no checks configured)`);
          } else {
            warn(
              'pr-monitor',
              `Non-404 error fetching check runs for ${owner}/${repo}@${sha.slice(0, 7)}: ${status ?? err}`,
            );
          }
          return null;
        }),
      ]);

      const combinedStatus = statusResponse.data;
      const allCheckRuns = checksResponse?.data?.check_runs || [];

      // Deduplicate check runs by name, keeping only the most recent run per unique name.
      // GitHub returns all historical runs (including re-runs), so without deduplication
      // a superseded failure will incorrectly flag the PR as failing even after a re-run passes.
      const latestCheckRunsByName = new Map<string, (typeof allCheckRuns)[0]>();
      for (const check of allCheckRuns) {
        const existing = latestCheckRunsByName.get(check.name);
        if (!existing || new Date(check.started_at ?? 0) > new Date(existing.started_at ?? 0)) {
          latestCheckRunsByName.set(check.name, check);
        }
      }
      const checkRuns = [...latestCheckRunsByName.values()];

      // Delegate analysis to ci-analysis module
      const checkRunAnalysis = analyzeCheckRuns(checkRuns);
      const combinedAnalysis = analyzeCombinedStatus(combinedStatus);

      return mergeStatuses(checkRunAnalysis, combinedAnalysis, checkRuns.length);
    } catch (error) {
      const statusCode = getHttpStatusCode(error);

      if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
        throw error;
      } else if (statusCode === 404) {
        // Repo might not have CI configured, this is normal
        debug('pr-monitor', `CI check 404 for ${owner}/${repo} (no CI configured)`);
        return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };
      } else {
        warn('pr-monitor', `Failed to check CI for ${owner}/${repo}@${sha.slice(0, 7)}: ${errorMessage(error)}`);
      }
      return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };
    }
  }

  /**
   * Fetch merged PR counts and latest merge dates per repository for the configured user.
   * Delegates to github-stats module.
   */
  async fetchUserMergedPRCounts(): Promise<PRCountsResult<{ count: number; lastMergedAt: string }>> {
    const config = this.stateManager.getState().config;
    return fetchUserMergedPRCountsImpl(this.octokit, config.githubUsername);
  }

  /**
   * Fetch closed-without-merge PR counts per repository for the configured user.
   * Delegates to github-stats module.
   */
  async fetchUserClosedPRCounts(): Promise<PRCountsResult<number>> {
    const config = this.stateManager.getState().config;
    return fetchUserClosedPRCountsImpl(this.octokit, config.githubUsername);
  }

  /**
   * Fetch GitHub star counts for a list of repositories.
   * Delegates to github-stats module.
   */
  async fetchRepoStarCounts(repos: string[]): Promise<Map<string, number>> {
    if (repos.length === 0) return new Map();

    debug(MODULE, `Fetching star counts for ${repos.length} repos...`);
    const results = new Map<string, number>();
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
              }) as Promise<{ data: { stargazers_count: number }; headers: Record<string, string> }>,
          );
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
          warn(MODULE, `Failed to fetch stars for ${chunk[j]}: ${errorMessage(result.reason)}`);
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
    const prsNeedingResponse = prs.filter((pr) => pr.status === 'needs_response');
    const ciFailingPRs = prs.filter((pr) => pr.status === 'failing_ci');
    const mergeConflictPRs = prs.filter((pr) => pr.status === 'merge_conflict');
    const approachingDormant = prs.filter((pr) => pr.status === 'approaching_dormant');
    const dormantPRs = prs.filter((pr) => pr.status === 'dormant');
    const healthyPRs = prs.filter((pr) => pr.status === 'healthy' || pr.status === 'waiting');

    // Get stats from state manager (historical data from repo scores)
    const stats = this.stateManager.getStats();

    const ciBlockedPRs = prs.filter((pr) => pr.status === 'ci_blocked');
    const ciNotRunningPRs = prs.filter((pr) => pr.status === 'ci_not_running');
    const needsRebasePRs = prs.filter((pr) => pr.status === 'needs_rebase');
    const missingRequiredFilesPRs = prs.filter((pr) => pr.status === 'missing_required_files');
    const incompleteChecklistPRs = prs.filter((pr) => pr.status === 'incomplete_checklist');
    const needsChangesPRs = prs.filter((pr) => pr.status === 'needs_changes');
    const changesAddressedPRs = prs.filter((pr) => pr.status === 'changes_addressed');
    const waitingOnMaintainerPRs = prs.filter((pr) => pr.status === 'waiting_on_maintainer');

    return {
      generatedAt: now,
      openPRs: prs,
      prsNeedingResponse,
      ciFailingPRs,
      ciBlockedPRs,
      ciNotRunningPRs,
      mergeConflictPRs,
      needsRebasePRs,
      missingRequiredFilesPRs,
      incompleteChecklistPRs,
      needsChangesPRs,
      changesAddressedPRs,
      waitingOnMaintainerPRs,
      approachingDormant,
      dormantPRs,
      healthyPRs,
      recentlyClosedPRs,
      recentlyMergedPRs,
      shelvedPRs: [],
      autoUnshelvedPRs: [],
      summary: {
        totalActivePRs: prs.length,
        totalNeedingAttention:
          prsNeedingResponse.length +
          needsChangesPRs.length +
          ciFailingPRs.length +
          mergeConflictPRs.length +
          needsRebasePRs.length +
          missingRequiredFilesPRs.length +
          incompleteChecklistPRs.length,
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
