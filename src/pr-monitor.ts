/**
 * PR Monitor - Checks status of all tracked PRs
 * Detects merges, new comments, and dormant PRs
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { parseGitHubUrl, daysBetween, splitRepo } from './utils.js';
import { TrackedPR } from './types.js';

// Concurrency limit for parallel API calls
const MAX_CONCURRENT_REQUESTS = 5;

export interface PRUpdate {
  pr: TrackedPR;
  type: 'merged' | 'closed' | 'new_comment' | 'review' | 'dormant' | 'approaching_dormant' | 'updated';
  message: string;
  details?: string;
}

export class PRMonitor {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;

  constructor(githubToken: string) {
    this.octokit = getOctokit(githubToken);
    this.stateManager = getStateManager();
  }

  /**
   * Check all tracked PRs and return updates
   */
  async checkAllPRs(): Promise<PRUpdate[]> {
    const state = this.stateManager.getState();
    const now = new Date();

    console.log(`Checking ${state.activePRs.length} active PRs...`);

    // Check active and dormant PRs in parallel with concurrency limit
    const allPRs = [
      ...state.activePRs.map(pr => ({ pr, isDormant: false })),
      ...state.dormantPRs.map(pr => ({ pr, isDormant: true })),
    ];

    const updates: PRUpdate[] = [];
    const pending: Promise<void>[] = [];

    for (const { pr, isDormant } of allPRs) {
      const task = (isDormant ? this.checkDormantPR(pr, now) : this.checkPR(pr, now))
        .then(prUpdates => {
          updates.push(...prUpdates);
        })
        .catch(error => {
          console.error(`Error checking ${isDormant ? 'dormant ' : ''}PR ${pr.url}:`, error instanceof Error ? error.message : error);
        });

      pending.push(task);

      // Limit concurrency
      if (pending.length >= MAX_CONCURRENT_REQUESTS) {
        await Promise.race(pending);
        // Clean up completed promises
        pending.splice(0, pending.length, ...pending.filter(() => false));
      }
    }

    // Wait for all remaining
    await Promise.allSettled(pending);

    return updates;
  }

  private async checkPR(pr: TrackedPR, now: Date): Promise<PRUpdate[]> {
    const updates: PRUpdate[] = [];
    const { owner, repo } = splitRepo(pr.repo);

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
      if (!this.stateManager.getState().config.trustedProjects.includes(pr.repo)) {
        this.stateManager.addTrustedProject(pr.repo);
      }

      updates.push({
        pr,
        type: 'merged',
        message: `🎉 PR merged: ${pr.repo}#${pr.number}`,
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
        message: `❌ PR closed: ${pr.repo}#${pr.number}`,
        details: pr.title,
      });
      return updates;
    }

    // Check for new comments
    const lastChecked = new Date(pr.lastChecked);
    const { data: comments } = await this.octokit.issues.listComments({
      owner,
      repo,
      issue_number: pr.number,
      since: lastChecked.toISOString(),
    });

    // Filter out our own comments
    const config = this.stateManager.getState().config;
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
        message: `💬 New comment on ${pr.repo}#${pr.number}`,
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
        message: `📝 New review on ${pr.repo}#${pr.number}: ${latestReview.state}`,
        details: latestReview.body || undefined,
      });
    }

    // Check for dormancy
    const daysSinceActivity = daysBetween(new Date(ghPR.updated_at), now);
    const dormantThreshold = config.dormantThresholdDays;
    const approachingThreshold = config.approachingDormantDays;

    this.stateManager.updatePR(pr.url, {
      lastChecked: now.toISOString(),
      lastActivityAt: ghPR.updated_at,
      daysSinceActivity,
    });

    if (daysSinceActivity >= dormantThreshold) {
      this.stateManager.movePRToDormant(pr.url);
      updates.push({
        pr,
        type: 'dormant',
        message: `⏰ PR dormant: ${pr.repo}#${pr.number}`,
        details: `No activity for ${daysSinceActivity} days`,
      });
    } else if (daysSinceActivity >= approachingThreshold) {
      updates.push({
        pr,
        type: 'approaching_dormant',
        message: `⚠️ PR approaching dormant: ${pr.repo}#${pr.number}`,
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
        message: `🎉 Dormant PR merged: ${pr.repo}#${pr.number}`,
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
        message: `❌ Dormant PR closed: ${pr.repo}#${pr.number}`,
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
        message: `🔄 Dormant PR reactivated: ${pr.repo}#${pr.number}`,
        details: 'New activity detected',
      });
    }

    return updates;
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
    };

    this.stateManager.addActivePR(pr);
    return pr;
  }
}
