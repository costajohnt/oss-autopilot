/**
 * PR Monitor - Fetches and checks PR status fresh from GitHub
 * v2: No local state tracking - fetches everything on each run
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { splitRepo, daysBetween } from './utils.js';
import { FetchedPR, FetchedPRStatus, CIStatus, ReviewDecision, DailyDigest } from './types.js';

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
      throw new Error('No GitHub username configured. Run setup first.');
    }

    console.error(`Fetching open PRs for @${config.githubUsername}...`);

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
    console.error(`Found ${totalCount} open PRs`);

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

    // Fetch detailed info for each PR in parallel with concurrency limit
    const prs: FetchedPR[] = [];
    const failures: PRCheckFailure[] = [];
    const pending: Promise<void>[] = [];

    for (const item of allItems) {
      if (!item.pull_request) continue;

      const task = this.fetchPRDetails(item.html_url)
        .then(pr => {
          if (pr) prs.push(pr);
        })
        .catch(error => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Error fetching ${item.html_url}: ${errorMessage}`);
          failures.push({ prUrl: item.html_url, error: errorMessage });
        });

      pending.push(task);

      // Limit concurrency
      if (pending.length >= MAX_CONCURRENT_REQUESTS) {
        const completed = await Promise.race(
          pending.map((p, i) => p.then(() => i))
        );
        pending.splice(completed, 1);
      }
    }

    // Wait for remaining
    await Promise.allSettled(pending);

    // Sort by days since activity (most urgent first)
    prs.sort((a, b) => {
      // Priority: needs_response > failing_ci > merge_conflict > approaching_dormant > dormant > waiting > healthy
      const statusPriority: Record<FetchedPRStatus, number> = {
        'needs_response': 0,
        'failing_ci': 1,
        'ci_blocked': 2,
        'ci_not_running': 3,
        'merge_conflict': 4,
        'needs_rebase': 5,
        'missing_required_files': 6,
        'approaching_dormant': 7,
        'dormant': 8,
        'waiting': 9,
        'healthy': 10,
      };
      return statusPriority[a.status] - statusPriority[b.status];
    });

    return { prs, failures };
  }

  /**
   * Fetch detailed information for a single PR
   */
  private async fetchPRDetails(prUrl: string): Promise<FetchedPR | null> {
    // Parse URL to get owner/repo/number
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) {
      throw new Error(`Invalid PR URL format: ${prUrl}`);
    }

    const [, owner, repo, numberStr] = match;
    const number = parseInt(numberStr, 10);
    const config = this.stateManager.getState().config;

    // Fetch PR data, comments, and reviews in parallel
    const [prResponse, commentsResponse, reviewsResponse] = await Promise.all([
      this.octokit.pulls.get({ owner, repo, pull_number: number }),
      this.octokit.issues.listComments({ owner, repo, issue_number: number, per_page: 100 }),
      this.octokit.pulls.listReviews({ owner, repo, pull_number: number }),
    ]);

    const ghPR = prResponse.data;
    const comments = commentsResponse.data;
    const reviews = reviewsResponse.data;

    // Get CI status with the actual SHA (must be done after fetching PR data)
    const ciStatus = await this.getCIStatus(owner, repo, ghPR.head.sha);

    // Determine review decision
    const reviewDecision = this.determineReviewDecision(reviews);

    // Check for merge conflict
    const hasMergeConflict = this.hasMergeConflict(ghPR.mergeable, ghPR.mergeable_state);

    // Check if there's an unresponded maintainer comment
    const { hasUnrespondedComment, lastMaintainerComment } = this.checkUnrespondedComments(
      comments,
      reviews,
      config.githubUsername
    );

    // Calculate days since activity
    const daysSinceActivity = daysBetween(new Date(ghPR.updated_at), new Date());

    // Determine status
    const status = this.determineStatus(
      ciStatus,
      hasMergeConflict,
      hasUnrespondedComment,
      daysSinceActivity,
      config.dormantThresholdDays,
      config.approachingDormantDays
    );

    return {
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
      hasMergeConflict,
      reviewDecision,
      hasUnrespondedComment,
      lastMaintainerComment,
    };
  }

  /**
   * Check if there are unresponded comments from maintainers
   */
  private checkUnrespondedComments(
    comments: Array<{ user?: { login?: string } | null; body?: string | null; created_at: string }>,
    reviews: Array<{ user?: { login?: string } | null; body?: string | null; submitted_at?: string | null }>,
    username: string
  ): { hasUnrespondedComment: boolean; lastMaintainerComment?: FetchedPR['lastMaintainerComment'] } {
    // Combine comments and reviews into a timeline
    const timeline: Array<{ author: string; body: string; createdAt: string; isUser: boolean }> = [];

    for (const comment of comments) {
      const author = comment.user?.login || 'unknown';
      timeline.push({
        author,
        body: comment.body || '',
        createdAt: comment.created_at,
        isUser: author.toLowerCase() === username.toLowerCase(),
      });
    }

    for (const review of reviews) {
      if (!review.submitted_at) continue;
      const author = review.user?.login || 'unknown';
      timeline.push({
        author,
        body: review.body || '',
        createdAt: review.submitted_at,
        isUser: author.toLowerCase() === username.toLowerCase(),
      });
    }

    // Sort by date
    timeline.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Find the last user comment
    let lastUserCommentTime: Date | null = null;
    for (const item of timeline) {
      if (item.isUser) {
        lastUserCommentTime = new Date(item.createdAt);
      }
    }

    // Find maintainer comments after the user's last comment
    let lastMaintainerComment: FetchedPR['lastMaintainerComment'] | undefined;

    for (const item of timeline) {
      if (item.isUser) continue; // Skip user's own comments
      if (item.author.includes('[bot]')) continue; // Skip bots

      const itemTime = new Date(item.createdAt);
      if (!lastUserCommentTime || itemTime > lastUserCommentTime) {
        lastMaintainerComment = {
          author: item.author,
          body: item.body.slice(0, 200) + (item.body.length > 200 ? '...' : ''),
          createdAt: item.createdAt,
        };
      }
    }

    return {
      hasUnrespondedComment: !!lastMaintainerComment,
      lastMaintainerComment,
    };
  }

  /**
   * Determine the overall status of a PR
   */
  private determineStatus(
    ciStatus: CIStatus,
    hasMergeConflict: boolean,
    hasUnrespondedComment: boolean,
    daysSinceActivity: number,
    dormantThreshold: number,
    approachingThreshold: number
  ): FetchedPRStatus {
    // Priority order: needs_response > failing_ci > merge_conflict > dormant > approaching_dormant > waiting/healthy

    if (hasUnrespondedComment) {
      return 'needs_response';
    }

    if (ciStatus === 'failing') {
      return 'failing_ci';
    }

    if (hasMergeConflict) {
      return 'merge_conflict';
    }

    if (daysSinceActivity >= dormantThreshold) {
      return 'dormant';
    }

    if (daysSinceActivity >= approachingThreshold) {
      return 'approaching_dormant';
    }

    // CI pending means we're waiting
    if (ciStatus === 'pending') {
      return 'waiting';
    }

    return 'healthy';
  }

  /**
   * Get CI status from combined status API and check runs
   */
  private async getCIStatus(owner: string, repo: string, sha: string): Promise<CIStatus> {
    if (!sha) return 'unknown';

    try {
      // Fetch both combined status and check runs in parallel
      const [statusResponse, checksResponse] = await Promise.all([
        this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha }),
        this.octokit.checks.listForRef({ owner, repo, ref: sha }).catch(() => null),
      ]);

      const combinedStatus = statusResponse.data;
      const checkRuns = checksResponse?.data?.check_runs || [];

      // Analyze check runs (GitHub Actions, etc.)
      let hasFailingChecks = false;
      let hasPendingChecks = false;
      let hasSuccessfulChecks = false;

      for (const check of checkRuns) {
        if (check.conclusion === 'failure' || check.conclusion === 'cancelled' || check.conclusion === 'timed_out') {
          hasFailingChecks = true;
        } else if (check.conclusion === 'action_required') {
          hasPendingChecks = true; // Maintainer approval gate, not a real failure
        } else if (check.status === 'in_progress' || check.status === 'queued') {
          hasPendingChecks = true;
        } else if (check.conclusion === 'success') {
          hasSuccessfulChecks = true;
        }
      }

      // Analyze combined status (Travis, CircleCI, etc.)
      // Filter out authorization-gate statuses (e.g., Vercel "Authorization required to deploy")
      // These are permission gates, not real CI failures
      const realStatuses = combinedStatus.statuses.filter(s => {
        const desc = (s.description || '').toLowerCase();
        return !(s.state === 'failure' && (
          desc.includes('authorization required') ||
          desc.includes('authorize')
        ));
      });

      const hasRealFailure = realStatuses.some(s => s.state === 'failure' || s.state === 'error');
      const hasRealPending = realStatuses.some(s => s.state === 'pending');
      const hasRealSuccess = realStatuses.some(s => s.state === 'success');
      const effectiveCombinedState = hasRealFailure ? 'failure'
        : hasRealPending ? 'pending'
        : hasRealSuccess ? 'success'
        : realStatuses.length === 0 ? 'success' // All statuses were auth gates; don't inherit original failure
        : combinedStatus.state;
      const hasStatuses = combinedStatus.statuses.length > 0;

      // Priority: failing > pending > passing > unknown
      // Safety net: If we have ANY failing checks, report as failing
      if (hasFailingChecks || effectiveCombinedState === 'failure' || effectiveCombinedState === 'error') {
        return 'failing';
      }

      if (hasPendingChecks || effectiveCombinedState === 'pending') {
        return 'pending';
      }

      if (hasSuccessfulChecks || effectiveCombinedState === 'success') {
        return 'passing';
      }

      // No checks found at all - this is common for repos without CI
      if (!hasStatuses && checkRuns.length === 0) {
        return 'unknown';
      }

      return 'unknown';
    } catch (error) {
      const statusCode = (error as { status?: number }).status;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (statusCode === 401) {
        console.error(`[AUTH ERROR] CI check failed for ${owner}/${repo}: Invalid token`);
      } else if (statusCode === 403) {
        console.error(`[RATE LIMIT] CI check failed for ${owner}/${repo}: Rate limit exceeded`);
      } else if (statusCode === 404) {
        // Repo might not have CI configured, this is normal
        return 'unknown';
      } else {
        console.error(`[CI ERROR] Failed to check CI for ${owner}/${repo}@${sha.slice(0, 7)}: ${errorMessage}`);
      }
      return 'unknown';
    }
  }

  /**
   * Determine review decision from reviews list
   */
  private determineReviewDecision(reviews: Array<{ state?: string | null; user?: { login?: string } | null }>): ReviewDecision {
    if (reviews.length === 0) {
      return 'review_required';
    }

    // Group reviews by user, keeping only the latest from each user
    const latestByUser = new Map<string, string>();
    for (const review of reviews) {
      const login = review.user?.login;
      const state = review.state;
      if (login && state) {
        latestByUser.set(login, state);
      }
    }

    const states = Array.from(latestByUser.values());

    if (states.includes('CHANGES_REQUESTED')) {
      return 'changes_requested';
    }

    if (states.includes('APPROVED')) {
      return 'approved';
    }

    return 'review_required';
  }

  /**
   * Check if PR has merge conflict
   */
  private hasMergeConflict(mergeable: boolean | null, mergeableState: string | null): boolean {
    if (mergeable === false) return true;
    if (mergeableState === 'dirty') return true;
    return false;
  }

  /**
   * Fetch merged PR counts per repository for the configured user.
   * Used to populate repoScores for accurate dashboard statistics.
   */
  async fetchUserMergedPRCounts(): Promise<Map<string, number>> {
    const config = this.stateManager.getState().config;

    if (!config.githubUsername) {
      return new Map();
    }

    console.error(`Fetching merged PR counts for @${config.githubUsername}...`);

    const counts = new Map<string, number>();
    let page = 1;
    let fetched = 0;

    while (true) {
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: `is:pr is:merged author:${config.githubUsername}`,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
        page,
      });

      for (const item of data.items) {
        const repoMatch = item.html_url.match(/github\.com\/([^/]+\/[^/]+)\//);
        if (!repoMatch) continue;

        const repo = repoMatch[1];
        const owner = repo.split('/')[0];

        // Skip own repos (PRs to your own repos aren't OSS contributions)
        if (owner.toLowerCase() === config.githubUsername.toLowerCase()) continue;

        // Skip excluded repos and orgs
        if (config.excludeRepos.includes(repo)) continue;
        if (config.excludeOrgs?.some(org => owner.toLowerCase() === org.toLowerCase())) continue;

        counts.set(repo, (counts.get(repo) || 0) + 1);
      }

      fetched += data.items.length;

      // Stop if we've fetched all results or hit the API limit (1000)
      if (fetched >= data.total_count || fetched >= 1000 || data.items.length === 0) {
        break;
      }

      page++;
    }

    console.error(`Found ${fetched} merged PRs across ${counts.size} repos`);
    return counts;
  }

  /**
   * Generate a daily digest from fetched PRs
   */
  generateDigest(prs: FetchedPR[]): DailyDigest {
    const now = new Date().toISOString();

    // Categorize PRs
    const prsNeedingResponse = prs.filter(pr => pr.status === 'needs_response');
    const ciFailingPRs = prs.filter(pr => pr.status === 'failing_ci');
    const mergeConflictPRs = prs.filter(pr => pr.status === 'merge_conflict');
    const approachingDormant = prs.filter(pr => pr.status === 'approaching_dormant');
    const dormantPRs = prs.filter(pr => pr.status === 'dormant');
    const healthyPRs = prs.filter(pr => pr.status === 'healthy' || pr.status === 'waiting');

    // Get stats from state manager (historical data from repo scores)
    const stats = this.stateManager.getStats();

    const ciBlockedPRs = prs.filter(pr => pr.status === 'ci_blocked');
    const ciNotRunningPRs = prs.filter(pr => pr.status === 'ci_not_running');
    const needsRebasePRs = prs.filter(pr => pr.status === 'needs_rebase');
    const missingRequiredFilesPRs = prs.filter(pr => pr.status === 'missing_required_files');

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
      approachingDormant,
      dormantPRs,
      healthyPRs,
      summary: {
        totalActivePRs: prs.length,
        totalNeedingAttention: prsNeedingResponse.length + ciFailingPRs.length + mergeConflictPRs.length + needsRebasePRs.length + missingRequiredFilesPRs.length,
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

  // ============================================
  // Legacy methods for backward compatibility
  // ============================================

  /**
   * @deprecated Use fetchUserOpenPRs() instead
   * Track a PR by adding it to local state
   */
  async trackPR(prUrl: string): Promise<import('./types.js').TrackedPR> {
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) {
      throw new Error(`Invalid PR URL: ${prUrl}`);
    }

    const [, owner, repo, numberStr] = match;
    const number = parseInt(numberStr, 10);

    const { data: ghPR } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: number,
    });

    const now = new Date();
    const ciStatus = await this.getCIStatus(owner, repo, ghPR.head.sha);
    const hasMergeConflict = this.hasMergeConflict(ghPR.mergeable, ghPR.mergeable_state);

    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: number,
    });
    const reviewDecision = this.determineReviewDecision(reviews);

    const pr: import('./types.js').TrackedPR = {
      id: ghPR.id,
      url: prUrl,
      repo: `${owner}/${repo}`,
      number,
      title: ghPR.title,
      status: ghPR.draft ? 'draft' : 'open',
      activityStatus: 'active',
      createdAt: ghPR.created_at,
      updatedAt: ghPR.updated_at,
      lastChecked: now.toISOString(),
      lastActivityAt: ghPR.updated_at,
      daysSinceActivity: daysBetween(new Date(ghPR.updated_at), now),
      hasUnreadComments: false,
      reviewCommentCount: ghPR.review_comments,
      commitCount: ghPR.commits,
      ciStatus,
      hasMergeConflict,
      reviewDecision,
    };

    this.stateManager.addActivePR(pr);
    return pr;
  }

  /**
   * @deprecated Use fetchUserOpenPRs() instead
   * Sync PRs from GitHub to local state
   */
  async syncPRs(): Promise<{ added: number; removed: number; total: number }> {
    const config = this.stateManager.getState().config;

    if (!config.githubUsername) {
      console.error('No GitHub username configured. Run setup first.');
      return { added: 0, removed: 0, total: 0 };
    }

    console.error(`Syncing PRs for @${config.githubUsername}...`);

    const { data } = await this.octokit.search.issuesAndPullRequests({
      q: `is:pr is:open author:${config.githubUsername}`,
      sort: 'updated',
      order: 'desc',
      per_page: 100,
    });

    const githubPRUrls = new Set<string>();
    let added = 0;

    for (const item of data.items) {
      if (item.pull_request) {
        githubPRUrls.add(item.html_url);

        const existingPR = this.stateManager.findPR(item.html_url);
        if (!existingPR) {
          try {
            await this.trackPR(item.html_url);
            added++;
          } catch (error) {
            console.error(`Error adding ${item.html_url}:`, error instanceof Error ? error.message : error);
          }
        }
      }
    }

    return { added, removed: 0, total: data.total_count };
  }

  /**
   * @deprecated Use fetchUserOpenPRs() instead
   * Check all tracked PRs and return updates
   */
  async checkAllPRs(): Promise<{ updates: PRUpdate[]; failures: PRCheckFailure[] }> {
    const state = this.stateManager.getState();
    const config = state.config;
    const now = new Date();

    console.error(`Checking ${state.activePRs.length} active PRs...`);

    const updates: PRUpdate[] = [];
    const failures: PRCheckFailure[] = [];

    for (const pr of state.activePRs) {
      try {
        const { owner, repo } = splitRepo(pr.repo);

        const { data: ghPR } = await this.octokit.pulls.get({
          owner,
          repo,
          pull_number: pr.number,
        });

        // Check for merge
        if (ghPR.merged) {
          this.stateManager.movePRToMerged(pr.url);
          updates.push({ pr, type: 'merged', message: `PR merged: ${pr.repo}#${pr.number}` });
          continue;
        }

        // Check for close
        if (ghPR.state === 'closed') {
          this.stateManager.movePRToClosed(pr.url);
          updates.push({ pr, type: 'closed', message: `PR closed: ${pr.repo}#${pr.number}` });
          continue;
        }

        // Update PR with current state
        const ciStatus = await this.getCIStatus(owner, repo, ghPR.head.sha);
        const hasMergeConflict = this.hasMergeConflict(ghPR.mergeable, ghPR.mergeable_state);
        const daysSinceActivity = daysBetween(new Date(ghPR.updated_at), now);

        this.stateManager.updatePR(pr.url, {
          lastChecked: now.toISOString(),
          lastActivityAt: ghPR.updated_at,
          daysSinceActivity,
          ciStatus,
          hasMergeConflict,
        });

        // Check dormancy
        if (daysSinceActivity >= config.dormantThresholdDays) {
          this.stateManager.movePRToDormant(pr.url);
          updates.push({ pr, type: 'dormant', message: `PR dormant: ${pr.repo}#${pr.number}` });
        } else if (daysSinceActivity >= config.approachingDormantDays) {
          updates.push({ pr, type: 'approaching_dormant', message: `PR approaching dormant: ${pr.repo}#${pr.number}` });
        }

        // Check CI
        if (ciStatus === 'failing' && pr.ciStatus !== 'failing') {
          updates.push({ pr, type: 'ci_failing', message: `CI failing: ${pr.repo}#${pr.number}` });
        }

        // Check conflict
        if (hasMergeConflict && !pr.hasMergeConflict) {
          updates.push({ pr, type: 'merge_conflict', message: `Merge conflict: ${pr.repo}#${pr.number}` });
        }
      } catch (error) {
        failures.push({
          prUrl: pr.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { updates, failures };
  }
}

// Legacy types for backward compatibility
export interface PRUpdate {
  pr: import('./types.js').TrackedPR;
  type: 'merged' | 'closed' | 'new_comment' | 'review' | 'dormant' | 'approaching_dormant' | 'updated' | 'ci_failing' | 'merge_conflict' | 'changes_requested';
  message: string;
  details?: string;
}

export interface CheckAllPRsResult {
  updates: PRUpdate[];
  failures: PRCheckFailure[];
}
