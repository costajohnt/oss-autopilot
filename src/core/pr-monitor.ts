/**
 * PR Monitor - Checks status of all tracked PRs
 * Detects merges, new comments, dormant PRs, CI failures, and merge conflicts
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { parseGitHubUrl, daysBetween, splitRepo } from './utils.js';
import { TrackedPR, CIStatus, ReviewDecision } from './types.js';

// Concurrency limit for parallel API calls
const MAX_CONCURRENT_REQUESTS = 5;

export interface PRUpdate {
  pr: TrackedPR;
  type:
    | 'merged'
    | 'closed'
    | 'new_comment'
    | 'review'
    | 'dormant'
    | 'approaching_dormant'
    | 'updated'
    | 'ci_failing'
    | 'merge_conflict'
    | 'changes_requested';
  message: string;
  details?: string;
}

export interface PRCheckFailure {
  prUrl: string;
  error: string;
  isDormant: boolean;
}

export interface CheckAllPRsResult {
  updates: PRUpdate[];
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
   * Check all tracked PRs and return updates along with any failures
   */
  async checkAllPRs(): Promise<CheckAllPRsResult> {
    const state = this.stateManager.getState();
    const now = new Date();

    console.error(`Checking ${state.activePRs.length} active PRs...`);

    // Check active and dormant PRs in parallel with concurrency limit
    const allPRs = [
      ...state.activePRs.map(pr => ({ pr, isDormant: false })),
      ...state.dormantPRs.map(pr => ({ pr, isDormant: true })),
    ];

    const updates: PRUpdate[] = [];
    const failures: PRCheckFailure[] = [];
    const pending: Promise<void>[] = [];

    for (const { pr, isDormant } of allPRs) {
      const task = (isDormant ? this.checkDormantPR(pr, now) : this.checkPR(pr, now))
        .then(prUpdates => {
          updates.push(...prUpdates);
        })
        .catch(error => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const dormantLabel = isDormant ? 'dormant ' : '';
          console.error(`Error checking ${dormantLabel}PR ${pr.url}: ${errorMessage}`);
          failures.push({
            prUrl: pr.url,
            error: errorMessage,
            isDormant,
          });
        });

      pending.push(task);

      // Limit concurrency
      if (pending.length >= MAX_CONCURRENT_REQUESTS) {
        // Wait for at least one to complete, then remove it
        const completed = await Promise.race(
          pending.map((p, i) => p.then(() => i))
        );
        pending.splice(completed, 1);
      }
    }

    // Wait for all remaining
    await Promise.allSettled(pending);

    // If ALL checks failed, throw an error to surface the problem
    if (allPRs.length > 0 && failures.length === allPRs.length) {
      const sampleErrors = failures.slice(0, 3).map(f => f.error).join('; ');
      throw new Error(`All ${failures.length} PR checks failed. Sample errors: ${sampleErrors}`);
    }

    return { updates, failures };
  }

  /**
   * Get CI status from combined status API
   */
  private async getCIStatus(owner: string, repo: string, sha: string): Promise<CIStatus> {
    try {
      const { data: status } = await this.octokit.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref: sha,
      });

      switch (status.state) {
        case 'success':
          return 'passing';
        case 'failure':
        case 'error':
          return 'failing';
        case 'pending':
          return 'pending';
        default:
          return 'unknown';
      }
    } catch (error) {
      // Log specific warnings for auth and rate limit errors
      const statusCode = (error as { status?: number }).status;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (statusCode === 401) {
        console.error(`[AUTH ERROR] CI status check failed for ${owner}/${repo}@${sha}: Invalid or expired GitHub token. Please refresh your GITHUB_TOKEN.`);
      } else if (statusCode === 403) {
        console.error(`[RATE LIMIT] CI status check failed for ${owner}/${repo}@${sha}: GitHub API rate limit exceeded. Try again later.`);
      } else {
        console.error(`Error fetching CI status for ${owner}/${repo}@${sha}: ${errorMessage}`);
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

    // Check the states
    const states = Array.from(latestByUser.values());

    // If any reviewer requested changes, return changes_requested
    if (states.includes('CHANGES_REQUESTED')) {
      return 'changes_requested';
    }

    // If any reviewer approved, return approved
    if (states.includes('APPROVED')) {
      return 'approved';
    }

    // Otherwise, review is still required
    return 'review_required';
  }

  /**
   * Check if PR has merge conflict based on GitHub's mergeable status
   */
  private hasMergeConflict(mergeable: boolean | null, mergeableState: string | null): boolean {
    // If mergeable is explicitly false, there's a conflict
    if (mergeable === false) {
      return true;
    }

    // Check mergeable_state for 'dirty' which indicates conflicts
    if (mergeableState === 'dirty') {
      return true;
    }

    return false;
  }

  private async checkPR(pr: TrackedPR, now: Date): Promise<PRUpdate[]> {
    const updates: PRUpdate[] = [];
    const { owner, repo } = splitRepo(pr.repo);
    const config = this.stateManager.getState().config;

    // Fetch PR data from GitHub
    const { data: ghPR } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: pr.number,
    });

    // Check for merge
    if (ghPR.merged) {
      this.stateManager.movePRToMerged(pr.url);

      // Add project to trusted list on first merge
      if (!config.trustedProjects.includes(pr.repo)) {
        this.stateManager.addTrustedProject(pr.repo);
      }

      updates.push({
        pr,
        type: 'merged',
        message: `PR merged: ${pr.repo}#${pr.number}`,
        details: pr.title,
      });
      return updates;
    }

    // Check for close without merge
    if (ghPR.state === 'closed') {
      this.stateManager.movePRToClosed(pr.url);
      updates.push({
        pr,
        type: 'closed',
        message: `PR closed: ${pr.repo}#${pr.number}`,
        details: pr.title,
      });
      return updates;
    }

    // Check CI status
    const ciStatus = await this.getCIStatus(owner, repo, ghPR.head.sha);
    const previousCIStatus = pr.ciStatus;

    // Check merge conflict status
    const hasMergeConflict = this.hasMergeConflict(ghPR.mergeable, ghPR.mergeable_state);
    const previousHadConflict = pr.hasMergeConflict;

    // Check for new comments
    const lastChecked = new Date(pr.lastChecked);
    const { data: comments } = await this.octokit.issues.listComments({
      owner,
      repo,
      issue_number: pr.number,
      since: lastChecked.toISOString(),
    });

    // Filter out our own comments
    const newComments = comments.filter(c => c.user?.login !== config.githubUsername);

    if (newComments.length > 0) {
      // Get the most recent comment (API returns oldest first)
      const mostRecentComment = newComments[newComments.length - 1];
      this.stateManager.updatePR(pr.url, {
        hasUnreadComments: true,
        activityStatus: 'needs_response',
        lastActivityAt: mostRecentComment.created_at,
      });

      updates.push({
        pr,
        type: 'new_comment',
        message: `New comment on ${pr.repo}#${pr.number}`,
        details: newComments.map(c => `@${c.user?.login}: ${c.body?.slice(0, 100)}...`).join('\n'),
      });
    }

    // Check for new reviews
    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: pr.number,
    });

    const newReviews = reviews.filter(r => new Date(r.submitted_at || '') > lastChecked);

    // Determine overall review decision
    const reviewDecision = this.determineReviewDecision(reviews);
    const previousReviewDecision = pr.reviewDecision;

    if (newReviews.length > 0) {
      // Get the most recent review (API returns oldest first)
      const latestReview = newReviews[newReviews.length - 1];
      this.stateManager.updatePR(pr.url, {
        hasUnreadComments: true,
        activityStatus: 'needs_response',
        lastActivityAt: latestReview.submitted_at || now.toISOString(),
      });

      updates.push({
        pr,
        type: 'review',
        message: `New review on ${pr.repo}#${pr.number}: ${latestReview.state}`,
        details: latestReview.body || undefined,
      });
    }

    // Generate updates for CI failures (only when status transitions to failing)
    if (ciStatus === 'failing' && previousCIStatus !== 'failing') {
      updates.push({
        pr,
        type: 'ci_failing',
        message: `CI failing on ${pr.repo}#${pr.number}`,
        details: 'Status checks are failing',
      });
    }

    // Generate updates for merge conflicts (only when conflict is newly detected)
    if (hasMergeConflict && !previousHadConflict) {
      updates.push({
        pr,
        type: 'merge_conflict',
        message: `Merge conflict detected on ${pr.repo}#${pr.number}`,
        details: 'Branch has conflicts with base branch',
      });
    }

    // Generate updates for changes requested (only when review decision transitions)
    if (reviewDecision === 'changes_requested' && previousReviewDecision !== 'changes_requested') {
      updates.push({
        pr,
        type: 'changes_requested',
        message: `Changes requested on ${pr.repo}#${pr.number}`,
        details: 'Reviewer has requested changes',
      });
    }

    // Check for dormancy
    const daysSinceActivity = daysBetween(new Date(ghPR.updated_at), now);
    const dormantThreshold = config.dormantThresholdDays;
    const approachingThreshold = config.approachingDormantDays;

    // Update PR state with all new fields
    this.stateManager.updatePR(pr.url, {
      lastChecked: now.toISOString(),
      lastActivityAt: ghPR.updated_at,
      daysSinceActivity,
      ciStatus,
      hasMergeConflict,
      reviewDecision,
    });

    if (daysSinceActivity >= dormantThreshold) {
      this.stateManager.movePRToDormant(pr.url);
      updates.push({
        pr,
        type: 'dormant',
        message: `PR dormant: ${pr.repo}#${pr.number}`,
        details: `No activity for ${daysSinceActivity} days`,
      });
    } else if (daysSinceActivity >= approachingThreshold) {
      updates.push({
        pr,
        type: 'approaching_dormant',
        message: `PR approaching dormant: ${pr.repo}#${pr.number}`,
        details: `No activity for ${daysSinceActivity} days`,
      });
    }

    return updates;
  }

  private async checkDormantPR(pr: TrackedPR, now: Date): Promise<PRUpdate[]> {
    const updates: PRUpdate[] = [];
    const { owner, repo } = splitRepo(pr.repo);

    const { data: ghPR } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: pr.number,
    });

    // Check for merge (might have been merged while dormant)
    if (ghPR.merged) {
      // Move directly from dormant to merged
      this.stateManager.moveDormantPRToMerged(pr.url);

      // Add project to trusted list on first merge
      if (!this.stateManager.getState().config.trustedProjects.includes(pr.repo)) {
        this.stateManager.addTrustedProject(pr.repo);
      }

      updates.push({
        pr,
        type: 'merged',
        message: `Dormant PR merged: ${pr.repo}#${pr.number}`,
        details: pr.title,
      });
      return updates;
    }

    // Check for close without merge
    if (ghPR.state === 'closed') {
      this.stateManager.moveDormantPRToClosed(pr.url);
      updates.push({
        pr,
        type: 'closed',
        message: `Dormant PR closed: ${pr.repo}#${pr.number}`,
        details: pr.title,
      });
      return updates;
    }

    // Check for new activity that would reactivate
    const daysSinceActivity = daysBetween(new Date(ghPR.updated_at), now);
    const config = this.stateManager.getState().config;

    if (daysSinceActivity < config.approachingDormantDays) {
      this.stateManager.reactivatePR(pr.url);
      updates.push({
        pr,
        type: 'updated',
        message: `Dormant PR reactivated: ${pr.repo}#${pr.number}`,
        details: 'New activity detected',
      });
    }

    return updates;
  }

  /**
   * Sync PRs from GitHub - fetch all open PRs and update state
   * Returns count of new PRs added and PRs removed
   */
  async syncPRs(): Promise<{ added: number; removed: number; total: number }> {
    const config = this.stateManager.getState().config;

    if (!config.githubUsername) {
      console.error('No GitHub username configured. Run setup first.');
      return { added: 0, removed: 0, total: 0 };
    }

    console.error(`Syncing PRs for @${config.githubUsername}...`);

    // Fetch all open PRs from GitHub
    const { data } = await this.octokit.search.issuesAndPullRequests({
      q: `is:pr is:open author:${config.githubUsername}`,
      sort: 'updated',
      order: 'desc',
      per_page: 100,
    });

    const githubPRUrls = new Set<string>();
    let added = 0;

    // Add new PRs that aren't already tracked
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

    // Remove PRs that are no longer open on GitHub
    const state = this.stateManager.getState();
    let removed = 0;

    for (const pr of [...state.activePRs]) {
      if (!githubPRUrls.has(pr.url)) {
        // PR is no longer open - it was merged or closed
        // We'll let the check step handle moving it to the right place
        removed++;
      }
    }

    return { added, removed, total: data.total_count };
  }

  /**
   * Add a new PR to track (from a URL)
   */
  async trackPR(prUrl: string): Promise<TrackedPR> {
    const parsed = parseGitHubUrl(prUrl);
    if (!parsed || parsed.type !== 'pull') {
      throw new Error(`Invalid PR URL: ${prUrl}`);
    }

    const { owner, repo, number } = parsed;

    const { data: ghPR } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: number,
    });

    const now = new Date();
    const daysSinceActivity = daysBetween(new Date(ghPR.updated_at), now);

    // Fetch initial CI status
    const ciStatus = await this.getCIStatus(owner, repo, ghPR.head.sha);

    // Check initial merge conflict status
    const hasMergeConflict = this.hasMergeConflict(ghPR.mergeable, ghPR.mergeable_state);

    // Fetch reviews for initial review decision
    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: number,
    });
    const reviewDecision = this.determineReviewDecision(reviews);

    const pr: TrackedPR = {
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
      daysSinceActivity,
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
}
