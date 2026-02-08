/**
 * PR Monitor - Fetches and checks PR status fresh from GitHub
 * v2: No local state tracking - fetches everything on each run
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { splitRepo, daysBetween } from './utils.js';
import { FetchedPR, FetchedPRStatus, CIStatus, ReviewDecision, DailyDigest, MaintainerActionHint } from './types.js';

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

      // Skip PRs to repos owned by the user (not OSS contributions)
      const repoMatch = item.html_url.match(/github\.com\/([^/]+)\/([^/]+)\//);
      if (repoMatch) {
        const repoOwner = repoMatch[1];
        if (repoOwner.toLowerCase() === config.githubUsername.toLowerCase()) continue;
        const repoFullName = `${repoMatch[1]}/${repoMatch[2]}`;
        if (config.excludeRepos.includes(repoFullName)) continue;
        if (config.excludeOrgs?.some(org => repoOwner.toLowerCase() === org.toLowerCase())) continue;
      }

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
        'incomplete_checklist': 7,
        'approaching_dormant': 8,
        'dormant': 9,
        'waiting': 10,
        'waiting_on_maintainer': 11,
        'healthy': 12,
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
    const { status: ciStatus, failingCheckNames } = await this.getCIStatus(owner, repo, ghPR.head.sha);

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

    // Analyze PR body for incomplete checklists
    const { hasIncompleteChecklist, checklistStats } = this.analyzeChecklist(ghPR.body || '');

    // Extract maintainer action hints from comments
    const maintainerActionHints = this.extractMaintainerActionHints(
      lastMaintainerComment?.body,
      reviewDecision
    );

    // Calculate days since activity
    const daysSinceActivity = daysBetween(new Date(ghPR.updated_at), new Date());

    // Determine status
    const status = this.determineStatus(
      ciStatus,
      hasMergeConflict,
      hasUnrespondedComment,
      hasIncompleteChecklist,
      reviewDecision,
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
      failingCheckNames,
      hasMergeConflict,
      reviewDecision,
      hasUnrespondedComment,
      lastMaintainerComment,
      hasIncompleteChecklist,
      checklistStats,
      maintainerActionHints,
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
      // Skip reviews with empty bodies - these are state changes (approve/request changes)
      // without actual comment text, and don't need a response
      const body = (review.body || '').trim();
      if (!body) continue;
      const author = review.user?.login || 'unknown';
      timeline.push({
        author,
        body,
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
    hasIncompleteChecklist: boolean,
    reviewDecision: ReviewDecision,
    daysSinceActivity: number,
    dormantThreshold: number,
    approachingThreshold: number
  ): FetchedPRStatus {
    // Priority order: needs_response > failing_ci > merge_conflict > incomplete_checklist > dormant > approaching_dormant > waiting_on_maintainer > waiting/healthy

    if (hasUnrespondedComment) {
      return 'needs_response';
    }

    if (ciStatus === 'failing') {
      return 'failing_ci';
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
   * Analyze PR body for incomplete checklists (unchecked markdown checkboxes).
   * Looks for patterns like "- [ ]" (unchecked) vs "- [x]" (checked).
   * Only flags if there ARE checkboxes and some are unchecked.
   */
  private analyzeChecklist(body: string): { hasIncompleteChecklist: boolean; checklistStats?: FetchedPR['checklistStats'] } {
    if (!body) return { hasIncompleteChecklist: false };

    const checkedPattern = /- \[x\]/gi;
    const uncheckedPattern = /- \[ \]/g;

    const checkedMatches = body.match(checkedPattern) || [];
    const uncheckedMatches = body.match(uncheckedPattern) || [];

    const checked = checkedMatches.length;
    const total = checked + uncheckedMatches.length;

    // No checkboxes at all - not a checklist PR
    if (total === 0) return { hasIncompleteChecklist: false };

    // All checked - checklist complete
    if (uncheckedMatches.length === 0) return {
      hasIncompleteChecklist: false,
      checklistStats: { checked, total },
    };

    return {
      hasIncompleteChecklist: true,
      checklistStats: { checked, total },
    };
  }

  /**
   * Extract action hints from maintainer comments using keyword matching.
   * Returns an array of hints about what the maintainer is asking for.
   */
  private extractMaintainerActionHints(
    commentBody: string | undefined,
    reviewDecision: ReviewDecision
  ): MaintainerActionHint[] {
    const hints: MaintainerActionHint[] = [];

    if (reviewDecision === 'changes_requested') {
      hints.push('changes_requested');
    }

    if (!commentBody) return hints;

    const lower = commentBody.toLowerCase();

    // Demo/screenshot requests
    const demoKeywords = ['screenshot', 'demo', 'recording', 'screen recording', 'before/after', 'before and after', 'gif', 'video', 'screencast', 'show me', 'can you show'];
    if (demoKeywords.some(kw => lower.includes(kw))) {
      hints.push('demo_requested');
    }

    // Test requests
    const testKeywords = ['add test', 'test coverage', 'unit test', 'missing test', 'add a test', 'write test', 'needs test', 'need test'];
    if (testKeywords.some(kw => lower.includes(kw))) {
      hints.push('tests_requested');
    }

    // Documentation requests
    const docKeywords = ['documentation', 'readme', 'jsdoc', 'docstring', 'add docs', 'update docs', 'document this'];
    if (docKeywords.some(kw => lower.includes(kw))) {
      hints.push('docs_requested');
    }

    // Rebase requests
    const rebaseKeywords = ['rebase', 'merge conflict', 'out of date', 'behind main', 'behind master'];
    if (rebaseKeywords.some(kw => lower.includes(kw))) {
      hints.push('rebase_requested');
    }

    return hints;
  }

  /**
   * Get CI status from combined status API and check runs.
   * Returns status and names of failing checks for diagnostics.
   */
  private async getCIStatus(owner: string, repo: string, sha: string): Promise<{ status: CIStatus; failingCheckNames: string[] }> {
    if (!sha) return { status: 'unknown', failingCheckNames: [] };

    try {
      // Fetch both combined status and check runs in parallel
      const [statusResponse, checksResponse] = await Promise.all([
        this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha }),
        this.octokit.checks.listForRef({ owner, repo, ref: sha }).catch(() => null),
      ]);

      const combinedStatus = statusResponse.data;
      const allCheckRuns = checksResponse?.data?.check_runs || [];

      // Deduplicate check runs by name, keeping only the most recent run per unique name.
      // GitHub returns all historical runs (including re-runs), so without deduplication
      // a superseded failure will incorrectly flag the PR as failing even after a re-run passes.
      const latestCheckRunsByName = new Map<string, typeof allCheckRuns[0]>();
      for (const check of allCheckRuns) {
        const existing = latestCheckRunsByName.get(check.name);
        if (!existing || new Date(check.started_at ?? 0) > new Date(existing.started_at ?? 0)) {
          latestCheckRunsByName.set(check.name, check);
        }
      }
      const checkRuns = [...latestCheckRunsByName.values()];

      // Analyze check runs (GitHub Actions, etc.)
      let hasFailingChecks = false;
      let hasPendingChecks = false;
      let hasSuccessfulChecks = false;
      const failingCheckNames: string[] = [];

      for (const check of checkRuns) {
        if (check.conclusion === 'failure' || check.conclusion === 'cancelled' || check.conclusion === 'timed_out') {
          hasFailingChecks = true;
          failingCheckNames.push(check.name);
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

      // Collect failing status names from combined status API
      for (const s of realStatuses) {
        if (s.state === 'failure' || s.state === 'error') {
          failingCheckNames.push(s.context);
        }
      }

      // Priority: failing > pending > passing > unknown
      // Safety net: If we have ANY failing checks, report as failing
      if (hasFailingChecks || effectiveCombinedState === 'failure' || effectiveCombinedState === 'error') {
        return { status: 'failing', failingCheckNames };
      }

      if (hasPendingChecks || effectiveCombinedState === 'pending') {
        return { status: 'pending', failingCheckNames: [] };
      }

      if (hasSuccessfulChecks || effectiveCombinedState === 'success') {
        return { status: 'passing', failingCheckNames: [] };
      }

      // No checks found at all - this is common for repos without CI
      if (!hasStatuses && checkRuns.length === 0) {
        return { status: 'unknown', failingCheckNames: [] };
      }

      return { status: 'unknown', failingCheckNames: [] };
    } catch (error) {
      const statusCode = (error as { status?: number }).status;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (statusCode === 401) {
        console.error(`[AUTH ERROR] CI check failed for ${owner}/${repo}: Invalid token`);
      } else if (statusCode === 403) {
        console.error(`[RATE LIMIT] CI check failed for ${owner}/${repo}: Rate limit exceeded`);
      } else if (statusCode === 404) {
        // Repo might not have CI configured, this is normal
        return { status: 'unknown', failingCheckNames: [] };
      } else {
        console.error(`[CI ERROR] Failed to check CI for ${owner}/${repo}@${sha.slice(0, 7)}: ${errorMessage}`);
      }
      return { status: 'unknown', failingCheckNames: [] };
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
   * Fetch merged PR counts and latest merge dates per repository for the configured user.
   * Also builds a monthly histogram of all merges for the contribution timeline.
   */
  async fetchUserMergedPRCounts(): Promise<{
    repos: Map<string, { count: number; lastMergedAt: string }>;
    monthlyCounts: Record<string, number>;
  }> {
    const config = this.stateManager.getState().config;

    if (!config.githubUsername) {
      return { repos: new Map(), monthlyCounts: {} };
    }

    console.error(`Fetching merged PR counts for @${config.githubUsername}...`);

    const repos = new Map<string, { count: number; lastMergedAt: string }>();
    const monthlyCounts: Record<string, number> = {};
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

        const mergedAt = item.pull_request?.merged_at || item.closed_at || '';

        // Per-repo tracking
        const existing = repos.get(repo);
        if (existing) {
          existing.count += 1;
          if (mergedAt && mergedAt > existing.lastMergedAt) {
            existing.lastMergedAt = mergedAt;
          }
        } else {
          repos.set(repo, { count: 1, lastMergedAt: mergedAt });
        }

        // Monthly histogram (every PR counted individually)
        if (mergedAt) {
          const month = mergedAt.slice(0, 7); // "YYYY-MM"
          monthlyCounts[month] = (monthlyCounts[month] || 0) + 1;
        }
      }

      fetched += data.items.length;

      // Stop if we've fetched all results or hit the API limit (1000)
      if (fetched >= data.total_count || fetched >= 1000 || data.items.length === 0) {
        break;
      }

      page++;
    }

    console.error(`Found ${fetched} merged PRs across ${repos.size} repos`);
    return { repos, monthlyCounts };
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
    const incompleteChecklistPRs = prs.filter(pr => pr.status === 'incomplete_checklist');
    const waitingOnMaintainerPRs = prs.filter(pr => pr.status === 'waiting_on_maintainer');

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
      waitingOnMaintainerPRs,
      approachingDormant,
      dormantPRs,
      healthyPRs,
      summary: {
        totalActivePRs: prs.length,
        totalNeedingAttention: prsNeedingResponse.length + ciFailingPRs.length + mergeConflictPRs.length + needsRebasePRs.length + missingRequiredFilesPRs.length + incompleteChecklistPRs.length,
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
    const { status: ciStatus } = await this.getCIStatus(owner, repo, ghPR.head.sha);
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
        const { status: ciStatus } = await this.getCIStatus(owner, repo, ghPR.head.sha);
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
