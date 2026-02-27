/**
 * PR Monitor - Fetches and checks PR status from GitHub.
 * v2: fetchUserOpenPRs() is stateless (no local PR tracking),
 * Score methods still write to state.
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { daysBetween, parseGitHubUrl, extractOwnerRepo } from './utils.js';
import {
  FetchedPR,
  FetchedPRStatus,
  CIStatusResult,
  ReviewDecision,
  DailyDigest,
  MaintainerActionHint,
  ClosedPR,
  MergedPR,
  CIFailureCategory,
  ClassifiedCheck,
  DetermineStatusInput,
} from './types.js';
import { isBotAuthor, isAcknowledgmentComment } from './comment-utils.js';
import { runWorkerPool } from './concurrency.js';
import { ConfigurationError, ValidationError } from './errors.js';
import { paginateAll } from './pagination.js';
import { debug, warn, timed } from './logger.js';

// Re-export so existing consumers (tests, index.ts) can still import from pr-monitor
export { isBotAuthor };

// Concurrency limit for parallel API calls
const MAX_CONCURRENT_REQUESTS = 5;

/** Inline review comment shape used for self-reply detection and body extraction (#199). */
interface ReviewComment {
  id: number;
  user?: { login?: string } | null;
  body?: string | null;
  created_at: string;
  in_reply_to_id?: number;
  pull_request_review_id?: number | null;
}

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
            const errorMessage = error instanceof Error ? error.message : String(error);
            warn('pr-monitor', `Error fetching ${item.html_url}: ${errorMessage}`);
            failures.push({ prUrl: item.html_url, error: errorMessage });
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
        const status = (err as { status?: number })?.status;
        // Rate limit errors must propagate — silently swallowing them hides
        // a systemic problem and produces misleading results (#229).
        if (status === 429) {
          throw err;
        }
        if (status === 403) {
          const msg = ((err as { message?: string })?.message ?? '').toLowerCase();
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

    // Determine review decision
    const reviewDecision = this.determineReviewDecision(reviews);

    // Check for merge conflict
    const hasMergeConflict = this.hasMergeConflict(ghPR.mergeable, ghPR.mergeable_state);

    // Check if there's an unresponded maintainer comment (pure computation, no API call)
    const { hasUnrespondedComment, lastMaintainerComment } = this.checkUnrespondedComments(
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
          .catch(() => undefined)
      : Promise.resolve(undefined);

    const [{ status: ciStatus, failingCheckNames, failingCheckConclusions }, latestCommitDate] = await Promise.all([
      ciPromise,
      commitDatePromise,
    ]);

    // Analyze PR body for incomplete checklists
    const { hasIncompleteChecklist, checklistStats } = this.analyzeChecklist(ghPR.body || '');

    // Extract maintainer action hints from comments
    const maintainerActionHints = this.extractMaintainerActionHints(lastMaintainerComment?.body, reviewDecision);

    // Calculate days since activity
    const daysSinceActivity = daysBetween(new Date(ghPR.updated_at), new Date());

    // Find the date of the latest changes_requested review (for needs_changes detection)
    const latestChangesRequestedDate = this.getLatestChangesRequestedDate(reviews);

    // Determine status
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
    });

    // Classify failing checks (#81)
    const classifiedChecks = classifyFailingChecks(failingCheckNames, failingCheckConclusions);

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

    // Compute display labels (#79) — must happen after status + classifiedChecks are set
    const { displayLabel, displayDescription } = computeDisplayLabel(pr);
    pr.displayLabel = displayLabel;
    pr.displayDescription = displayDescription;

    return pr;
  }

  /**
   * Check if there are unresponded comments from maintainers
   */
  private checkUnrespondedComments(
    comments: Array<{ user?: { login?: string } | null; body?: string | null; created_at: string }>,
    reviews: Array<{
      user?: { login?: string } | null;
      body?: string | null;
      submitted_at?: string | null;
      state?: string | null;
      id?: number;
    }>,
    reviewComments: ReviewComment[],
    username: string,
  ): { hasUnrespondedComment: boolean; lastMaintainerComment?: FetchedPR['lastMaintainerComment'] } {
    // Combine comments and reviews into a timeline
    const timeline: Array<{ author: string; body: string; createdAt: string; isUser: boolean }> = [];
    const usernameLower = username.toLowerCase();

    for (const comment of comments) {
      const author = comment.user?.login || 'unknown';
      timeline.push({
        author,
        body: comment.body || '',
        createdAt: comment.created_at,
        isUser: author.toLowerCase() === usernameLower,
      });
    }

    for (const review of reviews) {
      if (!review.submitted_at) continue;
      const body = (review.body || '').trim();
      // Include COMMENTED reviews even without body text — they indicate
      // inline review comments were posted and may need a response (#151).
      // Skip other empty-body reviews (APPROVED, CHANGES_REQUESTED, DISMISSED)
      // as those are state changes without comment text.
      if (!body && review.state !== 'COMMENTED') continue;
      const author = review.user?.login || 'unknown';

      // For inline-only COMMENTED reviews, skip pure self-replies (#199)
      if (!body && review.state === 'COMMENTED' && review.id != null) {
        if (this.isAllSelfReplies(review.id, reviewComments)) {
          continue;
        }
      }

      // Resolve body: prefer actual text, then inline comment text, then synthetic placeholder
      const resolvedBody =
        body ||
        (review.id != null ? this.getInlineCommentBody(review.id, reviewComments) : undefined) ||
        '(posted inline review comments)';

      timeline.push({
        author,
        body: resolvedBody,
        createdAt: review.submitted_at,
        isUser: author.toLowerCase() === usernameLower,
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
      if (item.author === 'unknown') continue; // Skip deleted/null accounts
      if (isBotAuthor(item.author)) continue; // Skip bots

      const itemTime = new Date(item.createdAt);
      if (!lastUserCommentTime || itemTime > lastUserCommentTime) {
        lastMaintainerComment = {
          author: item.author,
          body: item.body.slice(0, 200) + (item.body.length > 200 ? '...' : ''),
          createdAt: item.createdAt,
        };
      }
    }

    // Filter out pure acknowledgment comments that don't require a response
    if (lastMaintainerComment && isAcknowledgmentComment(lastMaintainerComment.body)) {
      lastMaintainerComment = undefined;
    }

    return {
      hasUnrespondedComment: !!lastMaintainerComment,
      lastMaintainerComment,
    };
  }

  /**
   * Check if all inline comments in a COMMENTED review are self-replies.
   * A self-reply is when an author replies to their own earlier inline comment.
   * Used to filter out informational follow-ups that don't require contributor action (#199).
   */
  private isAllSelfReplies(reviewId: number, reviewComments: ReviewComment[]): boolean {
    const commentsForReview = reviewComments.filter((c) => c.pull_request_review_id === reviewId);

    if (commentsForReview.length === 0) return false;

    // Build map of ALL comment IDs → lowercase author for parent lookup
    const authorMap = new Map<number, string>();
    for (const c of reviewComments) {
      if (c.user?.login) {
        authorMap.set(c.id, c.user.login.toLowerCase());
      }
    }

    return commentsForReview.every((comment) => {
      if (!comment.in_reply_to_id) return false; // New thread, not a reply
      const parentAuthor = authorMap.get(comment.in_reply_to_id);
      const commentAuthor = comment.user?.login?.toLowerCase();
      return parentAuthor != null && commentAuthor != null && parentAuthor === commentAuthor;
    });
  }

  /**
   * Get the body text of inline review comments for a COMMENTED review.
   * Returns the first non-empty comment body, or undefined.
   * Enables the acknowledgment filter to evaluate real content instead of
   * synthetic placeholders (#199).
   */
  private getInlineCommentBody(reviewId: number, reviewComments: ReviewComment[]): string | undefined {
    return reviewComments.find((c) => c.pull_request_review_id === reviewId && c.body?.trim())?.body?.trim();
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
    } = input;

    // Priority order: needs_response/needs_changes/changes_addressed > failing_ci > merge_conflict > incomplete_checklist > dormant > approaching_dormant > waiting_on_maintainer > waiting/healthy

    if (hasUnrespondedComment) {
      // If the contributor pushed a commit after the maintainer's comment,
      // the changes have been addressed — waiting for maintainer re-review
      if (latestCommitDate && lastMaintainerCommentDate && latestCommitDate > lastMaintainerCommentDate) {
        if (ciStatus === 'failing') return 'failing_ci';
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
      if (ciStatus === 'failing') return 'failing_ci';
      return 'changes_addressed';
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
   * Conditional items (containing "if applicable", "(if ...)", etc.) are
   * excluded from the incomplete count (#152).
   */
  private analyzeChecklist(body: string): {
    hasIncompleteChecklist: boolean;
    checklistStats?: FetchedPR['checklistStats'];
  } {
    if (!body) return { hasIncompleteChecklist: false };

    const checkedPattern = /- \[x\]/gi;
    const uncheckedLinePattern = /^.*- \[ \].*$/gm;

    const checkedMatches = body.match(checkedPattern) || [];
    const uncheckedLines = body.match(uncheckedLinePattern) || [];

    const checked = checkedMatches.length;
    const total = checked + uncheckedLines.length;

    // No checkboxes at all - not a checklist PR
    if (total === 0) return { hasIncompleteChecklist: false };

    // Filter out conditional checklist items that are intentionally unchecked
    const nonConditionalUnchecked = uncheckedLines.filter((line) => !isConditionalChecklistItem(line));

    return {
      hasIncompleteChecklist: nonConditionalUnchecked.length > 0,
      checklistStats: { checked, total },
    };
  }

  /**
   * Extract action hints from maintainer comments using keyword matching.
   * Returns an array of hints about what the maintainer is asking for.
   */
  private extractMaintainerActionHints(
    commentBody: string | undefined,
    reviewDecision: ReviewDecision,
  ): MaintainerActionHint[] {
    const hints: MaintainerActionHint[] = [];

    if (reviewDecision === 'changes_requested') {
      hints.push('changes_requested');
    }

    if (!commentBody) return hints;

    const lower = commentBody.toLowerCase();

    // Demo/screenshot requests
    const demoKeywords = [
      'screenshot',
      'demo',
      'recording',
      'screen recording',
      'before/after',
      'before and after',
      'gif',
      'video',
      'screencast',
      'show me',
      'can you show',
    ];
    if (demoKeywords.some((kw) => lower.includes(kw))) {
      hints.push('demo_requested');
    }

    // Test requests
    const testKeywords = [
      'add test',
      'test coverage',
      'unit test',
      'missing test',
      'add a test',
      'write test',
      'needs test',
      'need test',
    ];
    if (testKeywords.some((kw) => lower.includes(kw))) {
      hints.push('tests_requested');
    }

    // Documentation requests
    const docKeywords = ['documentation', 'readme', 'jsdoc', 'docstring', 'add docs', 'update docs', 'document this'];
    if (docKeywords.some((kw) => lower.includes(kw))) {
      hints.push('docs_requested');
    }

    // Rebase requests
    const rebaseKeywords = ['rebase', 'merge conflict', 'out of date', 'behind main', 'behind master'];
    if (rebaseKeywords.some((kw) => lower.includes(kw))) {
      hints.push('rebase_requested');
    }

    return hints;
  }

  /**
   * Analyze check runs (GitHub Actions, etc.) and categorize them.
   * Returns flags for failing/pending/success and lists of failing check names + conclusions.
   */
  private analyzeCheckRuns(checkRuns: Array<{ name: string; conclusion: string | null; status: string }>): {
    hasFailingChecks: boolean;
    hasPendingChecks: boolean;
    hasSuccessfulChecks: boolean;
    failingCheckNames: string[];
    failingCheckConclusions: Map<string, string>;
  } {
    let hasFailingChecks = false;
    let hasPendingChecks = false;
    let hasSuccessfulChecks = false;
    const failingCheckNames: string[] = [];
    const failingCheckConclusions = new Map<string, string>();

    for (const check of checkRuns) {
      if (check.conclusion === 'failure' || check.conclusion === 'cancelled' || check.conclusion === 'timed_out') {
        hasFailingChecks = true;
        failingCheckNames.push(check.name);
        failingCheckConclusions.set(check.name, check.conclusion);
      } else if (check.conclusion === 'action_required') {
        hasPendingChecks = true; // Maintainer approval gate, not a real failure
      } else if (check.status === 'in_progress' || check.status === 'queued') {
        hasPendingChecks = true;
      } else if (check.conclusion === 'success') {
        hasSuccessfulChecks = true;
      }
    }

    return { hasFailingChecks, hasPendingChecks, hasSuccessfulChecks, failingCheckNames, failingCheckConclusions };
  }

  /**
   * Analyze combined status API results (Travis, CircleCI, etc.).
   * Filters out authorization-gate statuses and determines the effective combined state.
   * Appends failing status context names to the provided failingCheckNames array.
   */
  private analyzeCombinedStatus(
    combinedStatus: { state: string; statuses: Array<{ state: string; context: string; description: string | null }> },
    failingCheckNames: string[],
  ): { effectiveCombinedState: string; hasStatuses: boolean } {
    // Filter out authorization-gate statuses (e.g., Vercel "Authorization required to deploy")
    // These are permission gates, not real CI failures
    const realStatuses = combinedStatus.statuses.filter((s) => {
      const desc = (s.description || '').toLowerCase();
      return !(s.state === 'failure' && (desc.includes('authorization required') || desc.includes('authorize')));
    });

    const hasRealFailure = realStatuses.some((s) => s.state === 'failure' || s.state === 'error');
    const hasRealPending = realStatuses.some((s) => s.state === 'pending');
    const hasRealSuccess = realStatuses.some((s) => s.state === 'success');
    const effectiveCombinedState = hasRealFailure
      ? 'failure'
      : hasRealPending
        ? 'pending'
        : hasRealSuccess
          ? 'success'
          : realStatuses.length === 0
            ? 'success' // All statuses were auth gates; don't inherit original failure
            : combinedStatus.state;
    const hasStatuses = combinedStatus.statuses.length > 0;

    // Collect failing status names from combined status API
    // Note: Combined statuses don't have conclusion data (only check runs do),
    // so these rely on name-based classification in classifyFailingChecks.
    for (const s of realStatuses) {
      if (s.state === 'failure' || s.state === 'error') {
        failingCheckNames.push(s.context);
      }
    }

    return { effectiveCombinedState, hasStatuses };
  }

  /**
   * Merge check run analysis and combined status analysis into a final CIStatusResult.
   * Priority: failing > pending > passing > unknown.
   */
  private mergeStatuses(
    checkRunAnalysis: {
      hasFailingChecks: boolean;
      hasPendingChecks: boolean;
      hasSuccessfulChecks: boolean;
      failingCheckNames: string[];
      failingCheckConclusions: Map<string, string>;
    },
    combinedAnalysis: { effectiveCombinedState: string; hasStatuses: boolean },
    checkRunCount: number,
  ): CIStatusResult {
    const { hasFailingChecks, hasPendingChecks, hasSuccessfulChecks, failingCheckNames, failingCheckConclusions } =
      checkRunAnalysis;
    const { effectiveCombinedState, hasStatuses } = combinedAnalysis;

    // Safety net: If we have ANY failing checks, report as failing
    if (hasFailingChecks || effectiveCombinedState === 'failure' || effectiveCombinedState === 'error') {
      return { status: 'failing', failingCheckNames, failingCheckConclusions };
    }

    if (hasPendingChecks || effectiveCombinedState === 'pending') {
      return { status: 'pending', failingCheckNames: [], failingCheckConclusions: new Map() };
    }

    if (hasSuccessfulChecks || effectiveCombinedState === 'success') {
      return { status: 'passing', failingCheckNames: [], failingCheckConclusions: new Map() };
    }

    // No checks found at all - this is common for repos without CI
    if (!hasStatuses && checkRunCount === 0) {
      return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };
    }

    return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };
  }

  /**
   * Get CI status from combined status API and check runs.
   * Returns status and names of failing checks for diagnostics.
   */
  private async getCIStatus(owner: string, repo: string, sha: string): Promise<CIStatusResult> {
    if (!sha) return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };

    try {
      // Fetch both combined status and check runs in parallel
      const [statusResponse, checksResponse] = await Promise.all([
        this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha }),
        // 404 is expected for repos without check runs configured; log other errors for debugging
        this.octokit.checks.listForRef({ owner, repo, ref: sha }).catch((err: unknown) => {
          const status = (err as { status?: number })?.status;
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

      const checkRunAnalysis = this.analyzeCheckRuns(checkRuns);
      const combinedAnalysis = this.analyzeCombinedStatus(combinedStatus, checkRunAnalysis.failingCheckNames);

      return this.mergeStatuses(checkRunAnalysis, combinedAnalysis, checkRuns.length);
    } catch (error) {
      const statusCode = (error as { status?: number }).status;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (statusCode === 401) {
        warn('pr-monitor', `CI check failed for ${owner}/${repo}: Invalid token`);
      } else if (statusCode === 403) {
        warn('pr-monitor', `CI check failed for ${owner}/${repo}: Rate limit exceeded`);
      } else if (statusCode === 404) {
        // Repo might not have CI configured, this is normal
        debug('pr-monitor', `CI check 404 for ${owner}/${repo} (no CI configured)`);
        return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };
      } else {
        warn('pr-monitor', `Failed to check CI for ${owner}/${repo}@${sha.slice(0, 7)}: ${errorMessage}`);
      }
      return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };
    }
  }

  /**
   * Determine review decision from reviews list
   */
  private determineReviewDecision(
    reviews: Array<{ state?: string | null; user?: { login?: string } | null }>,
  ): ReviewDecision {
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
   * Get the date of the latest CHANGES_REQUESTED review (from any reviewer).
   * Used to detect needs_changes status when review feedback is in inline comments.
   */
  private getLatestChangesRequestedDate(
    reviews: Array<{ state?: string | null; submitted_at?: string | null }>,
  ): string | undefined {
    let latest: string | undefined;
    for (const review of reviews) {
      if (review.state === 'CHANGES_REQUESTED' && review.submitted_at) {
        if (!latest || review.submitted_at > latest) {
          latest = review.submitted_at;
        }
      }
    }
    return latest;
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
    monthlyOpenedCounts: Record<string, number>;
    dailyActivityCounts: Record<string, number>;
  }> {
    const config = this.stateManager.getState().config;

    if (!config.githubUsername) {
      return { repos: new Map(), monthlyCounts: {}, monthlyOpenedCounts: {}, dailyActivityCounts: {} };
    }

    console.error(`Fetching merged PR counts for @${config.githubUsername}...`);

    const repos = new Map<string, { count: number; lastMergedAt: string }>();
    const monthlyCounts: Record<string, number> = {};
    const monthlyOpenedCounts: Record<string, number> = {};
    const dailyActivityCounts: Record<string, number> = {};
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
        const parsed = extractOwnerRepo(item.html_url);
        if (!parsed) {
          console.error(`[PR_MONITOR] Skipping merged PR with unparseable URL: ${item.html_url}`);
          continue;
        }

        const { owner } = parsed;
        const repo = `${owner}/${parsed.repo}`;

        // Skip own repos (PRs to your own repos aren't OSS contributions)
        if (owner.toLowerCase() === config.githubUsername.toLowerCase()) continue;

        // Note: excludeRepos/excludeOrgs are intentionally NOT filtered here.
        // Those filters control issue discovery/search, not historical statistics.
        // A merged PR is a merged PR regardless of current tracking preferences.

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

        // Track when this PR was opened (for monthly opened histogram)
        if (item.created_at) {
          const openedMonth = item.created_at.slice(0, 7); // "YYYY-MM"
          monthlyOpenedCounts[openedMonth] = (monthlyOpenedCounts[openedMonth] || 0) + 1;
          // Daily activity: PR opened
          const openedDay = item.created_at.slice(0, 10);
          if (openedDay.length === 10) dailyActivityCounts[openedDay] = (dailyActivityCounts[openedDay] || 0) + 1;
        }

        // Daily activity: PR merged
        if (mergedAt) {
          const mergedDay = mergedAt.slice(0, 10);
          if (mergedDay.length === 10) dailyActivityCounts[mergedDay] = (dailyActivityCounts[mergedDay] || 0) + 1;
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
    return { repos, monthlyCounts, monthlyOpenedCounts, dailyActivityCounts };
  }

  /**
   * Fetch closed-without-merge PR counts per repository for the configured user.
   * Used to populate closedWithoutMergeCount in repo scores for accurate merge rate.
   */
  async fetchUserClosedPRCounts(): Promise<{
    repos: Map<string, number>;
    monthlyCounts: Record<string, number>;
    monthlyOpenedCounts: Record<string, number>;
    dailyActivityCounts: Record<string, number>;
  }> {
    const config = this.stateManager.getState().config;

    if (!config.githubUsername) {
      return { repos: new Map(), monthlyCounts: {}, monthlyOpenedCounts: {}, dailyActivityCounts: {} };
    }

    console.error(`Fetching closed PR counts for @${config.githubUsername}...`);

    const repos = new Map<string, number>();
    const monthlyCounts: Record<string, number> = {};
    const monthlyOpenedCounts: Record<string, number> = {};
    const dailyActivityCounts: Record<string, number> = {};
    let page = 1;
    let fetched = 0;

    while (true) {
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: `is:pr is:closed is:unmerged author:${config.githubUsername}`,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
        page,
      });

      for (const item of data.items) {
        const parsed = extractOwnerRepo(item.html_url);
        if (!parsed) {
          console.error(`[PR_MONITOR] Skipping closed PR with unparseable URL: ${item.html_url}`);
          continue;
        }

        const { owner } = parsed;
        const repo = `${owner}/${parsed.repo}`;

        // Skip own repos
        if (owner.toLowerCase() === config.githubUsername.toLowerCase()) continue;

        // Note: excludeRepos/excludeOrgs are intentionally NOT filtered here.
        // Those filters control issue discovery/search, not historical statistics.
        // A closed PR is a closed PR regardless of current tracking preferences.

        repos.set(repo, (repos.get(repo) || 0) + 1);

        // Track when this PR was closed (for monthly closed histogram)
        if (item.closed_at) {
          const closedMonth = item.closed_at.slice(0, 7); // "YYYY-MM"
          monthlyCounts[closedMonth] = (monthlyCounts[closedMonth] || 0) + 1;
          // Daily activity: PR closed
          const closedDay = item.closed_at.slice(0, 10);
          if (closedDay.length === 10) dailyActivityCounts[closedDay] = (dailyActivityCounts[closedDay] || 0) + 1;
        }

        // Track when this PR was opened (for monthly opened histogram)
        if (item.created_at) {
          const openedMonth = item.created_at.slice(0, 7); // "YYYY-MM"
          monthlyOpenedCounts[openedMonth] = (monthlyOpenedCounts[openedMonth] || 0) + 1;
          // Daily activity: PR opened
          const openedDay = item.created_at.slice(0, 10);
          if (openedDay.length === 10) dailyActivityCounts[openedDay] = (dailyActivityCounts[openedDay] || 0) + 1;
        }
      }

      fetched += data.items.length;

      if (fetched >= data.total_count || fetched >= 1000 || data.items.length === 0) {
        break;
      }

      page++;
    }

    console.error(`Found ${fetched} closed (unmerged) PRs across ${repos.size} repos`);
    return { repos, monthlyCounts, monthlyOpenedCounts, dailyActivityCounts };
  }

  /**
   * Fetch GitHub star counts for a list of repositories.
   * Used to populate stargazersCount in repo scores for dashboard filtering by minStars.
   * Fetches concurrently with per-repo error isolation (missing/private repos are skipped).
   */
  async fetchRepoStarCounts(repos: string[]): Promise<Map<string, number>> {
    if (repos.length === 0) return new Map();

    console.error(`Fetching star counts for ${repos.length} repos...`);
    const results = new Map<string, number>();

    // Fetch in parallel chunks to avoid overwhelming the API
    const chunkSize = 10;
    for (let i = 0; i < repos.length; i += chunkSize) {
      const chunk = repos.slice(i, i + chunkSize);
      const settled = await Promise.allSettled(
        chunk.map(async (repo) => {
          const parts = repo.split('/');
          if (parts.length !== 2 || !parts[0] || !parts[1]) {
            throw new ValidationError(`Malformed repo identifier: "${repo}"`);
          }
          const [owner, name] = parts;
          const { data } = await this.octokit.repos.get({ owner, repo: name });
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
          console.error(
            `[STAR_FETCH] Failed to fetch stars for ${chunk[j]}: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
          );
        }
      }
      // If entire chunk failed, likely a systemic issue (rate limit, auth, outage) — abort remaining
      if (chunkFailures === chunk.length && chunk.length > 0) {
        const remaining = repos.length - i - chunkSize;
        if (remaining > 0) {
          console.error(`[STAR_FETCH] Entire chunk failed, aborting remaining ${remaining} repos`);
        }
        break;
      }
    }

    console.error(`Fetched star counts for ${results.size}/${repos.length} repos`);
    return results;
  }

  /**
   * Shared helper: search for recent PRs and filter out own repos, excluded repos/orgs.
   * Returns parsed search results that pass all filters.
   */
  private async fetchRecentPRs<T>(
    query: string,
    label: string,
    days: number,
    mapItem: (
      item: { html_url: string; title: string; closed_at: string | null; pull_request?: { merged_at?: string | null } },
      parsed: { owner: string; repo: string; number: number },
    ) => T,
  ): Promise<T[]> {
    const config = this.stateManager.getState().config;

    if (!config.githubUsername) {
      console.error(`Skipping recently ${label} PRs fetch: no githubUsername configured. Run /setup-oss to configure.`);
      return [];
    }

    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);
    const since = sinceDate.toISOString().split('T')[0]; // YYYY-MM-DD

    console.error(`Fetching recently ${label} PRs for @${config.githubUsername} (since ${since})...`);

    const { data } = await this.octokit.search.issuesAndPullRequests({
      q: query.replace('{username}', config.githubUsername).replace('{since}', since),
      sort: 'updated',
      order: 'desc',
      per_page: 100,
    });

    const results: T[] = [];

    for (const item of data.items) {
      const parsed = parseGitHubUrl(item.html_url);
      if (!parsed) {
        console.error(`Warning: Could not parse GitHub URL from API response: ${item.html_url}`);
        continue;
      }

      const repo = `${parsed.owner}/${parsed.repo}`;

      // Skip own repos
      if (parsed.owner.toLowerCase() === config.githubUsername.toLowerCase()) continue;

      // Skip excluded repos and orgs
      if (config.excludeRepos.includes(repo)) continue;
      if (config.excludeOrgs?.some((org) => parsed.owner.toLowerCase() === org.toLowerCase())) continue;

      results.push(mapItem(item, { owner: parsed.owner, repo, number: parsed.number }));
    }

    console.error(`Found ${results.length} recently ${label} PRs`);
    return results;
  }

  /**
   * Fetch PRs closed without merge in the last N days.
   * Returns lightweight ClosedPR objects for surfacing in the daily digest.
   */
  async fetchRecentlyClosedPRs(days: number = 7): Promise<ClosedPR[]> {
    return this.fetchRecentPRs<ClosedPR>(
      'is:pr is:closed is:unmerged author:{username} closed:>={since}',
      'closed',
      days,
      (item, { repo, number }) => ({
        url: item.html_url,
        repo,
        number,
        title: item.title,
        closedAt: item.closed_at || '',
      }),
    );
  }

  /**
   * Fetch PRs merged in the last N days.
   * Returns lightweight MergedPR objects for surfacing as wins in the dashboard.
   */
  async fetchRecentlyMergedPRs(days: number = 7): Promise<MergedPR[]> {
    return this.fetchRecentPRs<MergedPR>(
      'is:pr is:merged author:{username} merged:>={since}',
      'merged',
      days,
      (item, { repo, number }) => {
        const mergedAt = item.pull_request?.merged_at;
        if (!mergedAt) {
          console.error(
            `Warning: merged_at missing for merged PR ${item.html_url}${item.closed_at ? ', falling back to closed_at' : ', no date available'}`,
          );
        }
        return {
          url: item.html_url,
          repo,
          number,
          title: item.title,
          mergedAt: mergedAt || item.closed_at || '',
        };
      },
    );
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

/**
 * Deterministic mapping from FetchedPRStatus → human-readable display label (#79).
 * Ensures consistent label text across sessions — agents no longer derive these.
 */
const STATUS_DISPLAY: Record<FetchedPRStatus, { label: string; description: (pr: FetchedPR) => string }> = {
  needs_response: {
    label: '[Needs Response]',
    description: (pr) =>
      pr.lastMaintainerComment ? `@${pr.lastMaintainerComment.author} commented` : 'Maintainer awaiting response',
  },
  needs_changes: {
    label: '[Needs Changes]',
    description: () => 'Review requested changes — push commits to address',
  },
  failing_ci: {
    label: '[CI Failing]',
    description: (pr) => {
      const checks = pr.classifiedChecks || [];
      const actionable = checks.filter((c) => c.category === 'actionable');
      if (actionable.length > 0)
        return `${actionable.length} check${actionable.length === 1 ? '' : 's'} failed: ${actionable.map((c) => c.name).join(', ')}`;
      const infrastructure = checks.filter((c) => c.category === 'infrastructure');
      if (infrastructure.length > 0)
        return `${infrastructure.length} check${infrastructure.length === 1 ? '' : 's'} cancelled/timed out (infrastructure)`;
      const failingNames = pr.failingCheckNames || [];
      if (failingNames.length > 0) return `${failingNames.length} check${failingNames.length === 1 ? '' : 's'} failed`;
      return 'One or more CI checks are failing';
    },
  },
  ci_blocked: {
    label: '[CI Blocked]',
    description: () => 'CI cannot run (first-time contributor approval needed)',
  },
  ci_not_running: {
    label: '[CI Not Running]',
    description: () => 'No CI checks have been triggered',
  },
  merge_conflict: {
    label: '[Merge Conflict]',
    description: () => 'PR has merge conflicts with the base branch',
  },
  needs_rebase: {
    label: '[Needs Rebase]',
    description: () => 'PR branch is significantly behind upstream',
  },
  missing_required_files: {
    label: '[Missing Files]',
    description: (pr) =>
      pr.missingRequiredFiles ? `Missing: ${pr.missingRequiredFiles.join(', ')}` : 'Required files are missing',
  },
  incomplete_checklist: {
    label: '[Incomplete Checklist]',
    description: (pr) =>
      pr.checklistStats
        ? `${pr.checklistStats.checked}/${pr.checklistStats.total} items checked`
        : 'PR body has unchecked required checkboxes',
  },
  changes_addressed: {
    label: '[Changes Addressed]',
    description: (pr) =>
      pr.lastMaintainerComment
        ? `Waiting for @${pr.lastMaintainerComment.author} to re-review`
        : 'Waiting for maintainer re-review',
  },
  waiting: {
    label: '[Waiting]',
    description: () => 'CI pending or awaiting review',
  },
  waiting_on_maintainer: {
    label: '[Waiting on Maintainer]',
    description: () => 'Approved and CI passes — waiting for merge',
  },
  healthy: {
    label: '[Healthy]',
    description: () => 'Everything looks good — normal review cycle',
  },
  approaching_dormant: {
    label: '[Approaching Dormant]',
    description: (pr) => `No activity for ${pr.daysSinceActivity} days`,
  },
  dormant: {
    label: '[Dormant]',
    description: (pr) => `No activity for ${pr.daysSinceActivity} days`,
  },
};

/** Compute display label and description for a FetchedPR (#79). */
export function computeDisplayLabel(pr: FetchedPR): { displayLabel: string; displayDescription: string } {
  const entry = STATUS_DISPLAY[pr.status];
  if (!entry) {
    console.warn(`[DISPLAY_LABEL] Unknown status "${pr.status}" for PR #${pr.number} (${pr.url})`);
    return { displayLabel: `[${pr.status}]`, displayDescription: 'Unknown status' };
  }
  return {
    displayLabel: entry.label,
    displayDescription: entry.description(pr),
  };
}

/**
 * Detect conditional checklist items that are intentionally left unchecked (#152).
 * Matches patterns like "(if the PR is ...)", "if applicable", "N/A", "optional", etc.
 * Conservative — only skips items with clear conditional language.
 */
const CONDITIONAL_CHECKLIST_PATTERN =
  /\(if\s|\bif applicable\b|\bif needed\b|\bif relevant\b|\bonly if\b|\bwhen applicable\b|\(optional\)|- \[ \]\s*optional\b|\bn\/a\b|\bnot applicable\b|\bif required\b|\bif necessary\b/;

export function isConditionalChecklistItem(line: string): boolean {
  return CONDITIONAL_CHECKLIST_PATTERN.test(line.toLowerCase());
}

/**
 * Known CI check name patterns that indicate fork limitations rather than real failures (#81).
 * These are deployment/preview services that require repo-level secrets unavailable in forks.
 */
const FORK_LIMITATION_PATTERNS: RegExp[] = [
  /vercel/i,
  /netlify/i,
  /\bpreview\s*deploy/i,
  /\bdeploy\s*preview/i,
  /storybook/i,
  /chromatic/i,
  /percy/i,
  /cloudflare pages/i,
];

/**
 * Known CI check name patterns that indicate authorization gates (#81).
 * These require maintainer approval and are not real failures.
 */
const AUTH_GATE_PATTERNS: RegExp[] = [/authoriz/i, /approval/i, /\bcla\b/i, /license\/cla/i];

/**
 * Known CI check name patterns that indicate infrastructure/transient failures (#145).
 * These are runner issues, dependency install problems, or service outages — not code failures.
 */
const INFRASTRUCTURE_PATTERNS: RegExp[] = [
  /\binstall\s*(os\s*)?dep(endenc|s\b)/i,
  /\bsetup\s+fail(ed|ure)?\b/i,
  /\bservice\s*unavailable/i,
  /\binfrastructure/i,
];

/**
 * Classify a failing CI check as actionable, fork_limitation, auth_gate, or infrastructure (#81, #145).
 * Default is 'actionable' — only known patterns get reclassified.
 * When conclusion is provided (cancelled, timed_out), the check is classified as infrastructure.
 */
export function classifyCICheck(name: string, description?: string, conclusion?: string): CIFailureCategory {
  // Infrastructure: cancelled or timed_out jobs are transient failures (#145)
  if (conclusion === 'cancelled' || conclusion === 'timed_out') return 'infrastructure';

  const nameLower = name.toLowerCase();

  // Check name first (more reliable than description)
  if (AUTH_GATE_PATTERNS.some((p) => p.test(nameLower))) return 'auth_gate';
  if (FORK_LIMITATION_PATTERNS.some((p) => p.test(nameLower))) return 'fork_limitation';
  if (INFRASTRUCTURE_PATTERNS.some((p) => p.test(nameLower))) return 'infrastructure';

  // Fall through to description only if name was not classified
  if (description) {
    const descLower = description.toLowerCase();
    if (AUTH_GATE_PATTERNS.some((p) => p.test(descLower))) return 'auth_gate';
    if (FORK_LIMITATION_PATTERNS.some((p) => p.test(descLower))) return 'fork_limitation';
    if (INFRASTRUCTURE_PATTERNS.some((p) => p.test(descLower))) return 'infrastructure';
  }

  return 'actionable';
}

/**
 * Classify all failing checks and return both the flat names array and classified array (#81, #145).
 * Accepts optional conclusion data to detect infrastructure failures.
 */
export function classifyFailingChecks(
  failingCheckNames: string[],
  conclusions?: Map<string, string>,
): ClassifiedCheck[] {
  return failingCheckNames.map((name) => {
    const conclusion = conclusions?.get(name);
    return {
      name,
      category: classifyCICheck(name, undefined, conclusion),
      conclusion,
    };
  });
}
