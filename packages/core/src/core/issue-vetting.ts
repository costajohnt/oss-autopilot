/**
 * Issue Vetting — checks individual issues for claimability, existing PRs,
 * project health, contribution guidelines, and requirement clarity.
 *
 * Extracted from issue-discovery.ts (#356) to isolate vetting logic.
 */

import { Octokit } from '@octokit/rest';
import { paginateAll } from './pagination.js';
import { parseGitHubUrl, daysBetween, DEFAULT_CONCURRENCY } from './utils.js';
import {
  TrackedIssue,
  IssueVettingResult,
  ContributionGuidelines,
  ProjectHealth,
  type SearchPriority,
  type IssueCandidate,
} from './types.js';
import { ValidationError, errorMessage, isRateLimitError } from './errors.js';
import { warn } from './logger.js';
import { getHttpCache, cachedRequest, cachedTimeBased } from './http-cache.js';
import { getStateManager } from './state.js';
import { calculateRepoQualityBonus, calculateViabilityScore } from './issue-scoring.js';

const MODULE = 'issue-vetting';

const MAX_CONCURRENT_REQUESTS = DEFAULT_CONCURRENCY;

/** Result of a vetting check that may be inconclusive due to API errors. */
export interface CheckResult {
  passed: boolean;
  inconclusive?: boolean;
  reason?: string;
}

// Cache for contribution guidelines (expires after 1 hour, max 100 entries)
const guidelinesCache = new Map<string, { guidelines: ContributionGuidelines | undefined; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
/** TTL for cached project health results (4 hours). Health data (stars, commits, CI) changes slowly. */
const HEALTH_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const CACHE_MAX_SIZE = 100;

function pruneCache(): void {
  const now = Date.now();

  // First, remove expired entries (older than CACHE_TTL_MS)
  for (const [key, value] of guidelinesCache.entries()) {
    if (now - value.fetchedAt > CACHE_TTL_MS) {
      guidelinesCache.delete(key);
    }
  }

  // Then, if still over size limit, remove oldest entries
  if (guidelinesCache.size > CACHE_MAX_SIZE) {
    const entries = Array.from(guidelinesCache.entries()).sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);

    const toRemove = entries.slice(0, guidelinesCache.size - CACHE_MAX_SIZE);
    for (const [key] of toRemove) {
      guidelinesCache.delete(key);
    }
  }
}

export class IssueVetter {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;

  constructor(octokit: Octokit, stateManager: ReturnType<typeof getStateManager>) {
    this.octokit = octokit;
    this.stateManager = stateManager;
  }

  /**
   * Vet a specific issue — runs all checks and computes recommendation + viability score.
   */
  async vetIssue(issueUrl: string): Promise<IssueCandidate> {
    // Parse URL
    const parsed = parseGitHubUrl(issueUrl);
    if (!parsed || parsed.type !== 'issues') {
      throw new ValidationError(`Invalid issue URL: ${issueUrl}`);
    }

    const { owner, repo, number } = parsed;
    const repoFullName = `${owner}/${repo}`;

    // Fetch issue data
    const { data: ghIssue } = await this.octokit.issues.get({
      owner,
      repo,
      issue_number: number,
    });

    // Run all vetting checks in parallel
    const [existingPRCheck, claimCheck, projectHealth, contributionGuidelines, userMergedPRCount] = await Promise.all([
      this.checkNoExistingPR(owner, repo, number),
      this.checkNotClaimed(owner, repo, number, ghIssue.comments),
      this.checkProjectHealth(owner, repo),
      this.fetchContributionGuidelines(owner, repo),
      this.checkUserMergedPRsInRepo(owner, repo),
    ]);

    const noExistingPR = existingPRCheck.passed;
    const notClaimed = claimCheck.passed;

    // Analyze issue quality
    const clearRequirements = this.analyzeRequirements(ghIssue.body || '');

    // When the health check itself failed (API error), use a neutral default:
    // don't penalize the repo as inactive, but don't credit it as active either.
    const projectActive = projectHealth.checkFailed ? true : projectHealth.isActive;

    const vettingResult: IssueVettingResult = {
      passedAllChecks: noExistingPR && notClaimed && projectActive && clearRequirements,
      checks: {
        noExistingPR,
        notClaimed,
        projectActive,
        clearRequirements,
        contributionGuidelinesFound: !!contributionGuidelines,
      },
      contributionGuidelines,
      notes: [],
    };

    // Build notes
    if (!noExistingPR) vettingResult.notes.push('Existing PR found for this issue');
    if (!notClaimed) vettingResult.notes.push('Issue appears to be claimed by someone');
    if (existingPRCheck.inconclusive) {
      vettingResult.notes.push(`Could not verify absence of existing PRs: ${existingPRCheck.reason || 'API error'}`);
    }
    if (claimCheck.inconclusive) {
      vettingResult.notes.push(`Could not verify claim status: ${claimCheck.reason || 'API error'}`);
    }
    if (projectHealth.checkFailed) {
      vettingResult.notes.push(`Could not verify project activity: ${projectHealth.failureReason || 'API error'}`);
    } else if (!projectHealth.isActive) {
      vettingResult.notes.push('Project may be inactive');
    }
    if (!clearRequirements) vettingResult.notes.push('Issue requirements are unclear');
    if (!contributionGuidelines) vettingResult.notes.push('No CONTRIBUTING.md found');

    // Create tracked issue
    const trackedIssue: TrackedIssue = {
      id: ghIssue.id,
      url: issueUrl,
      repo: repoFullName,
      number,
      title: ghIssue.title,
      status: 'candidate',
      labels: ghIssue.labels.map((l) => (typeof l === 'string' ? l : l.name || '')),
      createdAt: ghIssue.created_at,
      updatedAt: ghIssue.updated_at,
      vetted: true,
      vettingResult,
    };

    // Determine recommendation
    const reasonsToSkip: string[] = [];
    const reasonsToApprove: string[] = [];

    if (!noExistingPR) reasonsToSkip.push('Has existing PR');
    if (!notClaimed) reasonsToSkip.push('Already claimed');
    if (!projectHealth.isActive && !projectHealth.checkFailed) reasonsToSkip.push('Inactive project');
    if (!clearRequirements) reasonsToSkip.push('Unclear requirements');

    if (noExistingPR) reasonsToApprove.push('No existing PR');
    if (notClaimed) reasonsToApprove.push('Not claimed');
    if (projectHealth.isActive && !projectHealth.checkFailed) reasonsToApprove.push('Active project');
    if (clearRequirements) reasonsToApprove.push('Clear requirements');
    if (contributionGuidelines) reasonsToApprove.push('Has contribution guidelines');

    // Determine effective merged PR count: prefer local state (authoritative if present),
    // fall back to live GitHub API count to detect contributions made before using oss-autopilot (#373)
    const config = this.stateManager.getState().config;
    const repoScoreRecord = this.stateManager.getRepoScore(repoFullName);
    const effectiveMergedCount =
      repoScoreRecord && repoScoreRecord.mergedPRCount > 0 ? repoScoreRecord.mergedPRCount : userMergedPRCount;
    if (effectiveMergedCount > 0) {
      reasonsToApprove.push(
        `Trusted project (${effectiveMergedCount} PR${effectiveMergedCount > 1 ? 's' : ''} merged)`,
      );
    } else if (config.trustedProjects.includes(repoFullName)) {
      reasonsToApprove.push('Trusted project (previous PR merged)');
    }

    // Check for closed/rejected PR history in this repo
    // Use effectiveMergedCount to avoid contradictory signals when API data
    // shows merges that local state doesn't know about (#373)
    if (repoScoreRecord) {
      if (repoScoreRecord.closedWithoutMergeCount > 0 && effectiveMergedCount === 0) {
        reasonsToSkip.push('User has rejected PR(s) in this repo with no successful merges');
      } else if (repoScoreRecord.closedWithoutMergeCount > 0 && effectiveMergedCount > 0) {
        vettingResult.notes.push(
          `Mixed history: ${effectiveMergedCount} merged, ${repoScoreRecord.closedWithoutMergeCount} closed without merge`,
        );
      }
    }

    // Check for org-level affinity (user has merged PRs in another repo under same org)
    const orgName = repoFullName.split('/')[0];
    let orgHasMergedPRs = false;
    if (orgName && repoFullName.includes('/')) {
      orgHasMergedPRs = Object.values(this.stateManager.getState().repoScores).some(
        (rs) => rs.repo && rs.mergedPRCount > 0 && rs.repo.startsWith(orgName + '/') && rs.repo !== repoFullName,
      );
    }
    if (orgHasMergedPRs) {
      reasonsToApprove.push(`Org affinity (merged PRs in other ${orgName} repos)`);
    }

    let recommendation: 'approve' | 'skip' | 'needs_review';
    if (vettingResult.passedAllChecks) {
      recommendation = 'approve';
    } else if (reasonsToSkip.length > 2) {
      recommendation = 'skip';
    } else {
      recommendation = 'needs_review';
    }

    // Downgrade to needs_review if any check was inconclusive —
    // "approve" should only be given when all checks actually passed, not when they were skipped.
    const hasInconclusiveChecks = projectHealth.checkFailed || existingPRCheck.inconclusive || claimCheck.inconclusive;
    if (recommendation === 'approve' && hasInconclusiveChecks) {
      recommendation = 'needs_review';
      vettingResult.notes.push('Recommendation downgraded: one or more checks were inconclusive');
    }

    // Calculate repo quality bonus from star/fork counts (#98)
    const repoQualityBonus = calculateRepoQualityBonus(
      projectHealth.stargazersCount ?? 0,
      projectHealth.forksCount ?? 0,
    );
    if (projectHealth.checkFailed && repoQualityBonus === 0) {
      vettingResult.notes.push('Repo quality bonus unavailable: could not fetch star/fork counts due to API error');
    }

    const repoScore = this.getRepoScore(repoFullName);
    const viabilityScore = calculateViabilityScore({
      repoScore,
      hasExistingPR: !noExistingPR,
      isClaimed: !notClaimed,
      clearRequirements,
      hasContributionGuidelines: !!contributionGuidelines,
      issueUpdatedAt: ghIssue.updated_at,
      closedWithoutMergeCount: repoScoreRecord?.closedWithoutMergeCount ?? 0,
      mergedPRCount: effectiveMergedCount,
      orgHasMergedPRs,
      repoQualityBonus,
    });

    const starredRepos = this.stateManager.getStarredRepos();
    let searchPriority: SearchPriority = 'normal';
    if (effectiveMergedCount > 0) {
      searchPriority = 'merged_pr';
    } else if (starredRepos.includes(repoFullName)) {
      searchPriority = 'starred';
    }

    return {
      issue: trackedIssue,
      vettingResult,
      projectHealth,
      recommendation,
      reasonsToSkip,
      reasonsToApprove,
      viabilityScore,
      searchPriority,
    };
  }

  /**
   * Vet multiple issues in parallel with concurrency limit
   */
  async vetIssuesParallel(
    urls: string[],
    maxResults: number,
    priority?: SearchPriority,
  ): Promise<{ candidates: IssueCandidate[]; allFailed: boolean; rateLimitHit: boolean }> {
    const candidates: IssueCandidate[] = [];
    const pending = new Map<string, Promise<void>>();
    let failedVettingCount = 0;
    let rateLimitFailures = 0;
    let attemptedCount = 0;

    for (const url of urls) {
      if (candidates.length >= maxResults) break;
      attemptedCount++;

      const task = this.vetIssue(url)
        .then((candidate) => {
          if (candidates.length < maxResults) {
            // Override the priority if provided
            if (priority) {
              candidate.searchPriority = priority;
            }
            candidates.push(candidate);
          }
        })
        .catch((error) => {
          failedVettingCount++;
          if (isRateLimitError(error)) {
            rateLimitFailures++;
          }
          warn(MODULE, `Error vetting issue ${url}:`, errorMessage(error));
        })
        .finally(() => pending.delete(url));

      pending.set(url, task);

      // Limit concurrency — wait for at least one to complete before launching more
      if (pending.size >= MAX_CONCURRENT_REQUESTS) {
        await Promise.race(pending.values());
      }
    }

    // Wait for remaining
    await Promise.allSettled(pending.values());

    const allFailed = failedVettingCount === attemptedCount && attemptedCount > 0;
    if (allFailed) {
      warn(
        MODULE,
        `All ${attemptedCount} issue(s) failed vetting. ` +
          `This may indicate a systemic issue (rate limit, auth, network).`,
      );
    }

    return { candidates: candidates.slice(0, maxResults), allFailed, rateLimitHit: rateLimitFailures > 0 };
  }

  async checkNoExistingPR(owner: string, repo: string, issueNumber: number): Promise<CheckResult> {
    try {
      // Search for PRs that mention this issue
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:pr ${issueNumber}`,
        per_page: 5,
      });

      // Also check timeline for linked PRs
      const timeline = await paginateAll((page) =>
        this.octokit.issues.listEventsForTimeline({
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
          page,
        }),
      );

      const linkedPRs = timeline.filter((event) => {
        const e = event as { event?: string; source?: { issue?: { pull_request?: unknown } } };
        return e.event === 'cross-referenced' && e.source?.issue?.pull_request;
      });

      return { passed: data.total_count === 0 && linkedPRs.length === 0 };
    } catch (error) {
      const errMsg = errorMessage(error);
      warn(
        MODULE,
        `Failed to check for existing PRs on ${owner}/${repo}#${issueNumber}: ${errMsg}. Assuming no existing PR.`,
      );
      return { passed: true, inconclusive: true, reason: errMsg };
    }
  }

  /**
   * Check how many merged PRs the authenticated user has in a repo.
   * Uses GitHub Search API. Returns 0 on error (non-fatal).
   */
  async checkUserMergedPRsInRepo(owner: string, repo: string): Promise<number> {
    try {
      // Use @me to search as the authenticated user
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:pr is:merged author:@me`,
        per_page: 1, // We only need total_count
      });
      return data.total_count;
    } catch (error) {
      const errMsg = errorMessage(error);
      warn(MODULE, `Could not check merged PRs in ${owner}/${repo}: ${errMsg}. Defaulting to 0.`);
      return 0;
    }
  }

  async checkNotClaimed(owner: string, repo: string, issueNumber: number, commentCount: number): Promise<CheckResult> {
    if (commentCount === 0) return { passed: true };

    try {
      // Paginate through all comments (up to 100)
      const comments = await this.octokit.paginate(
        this.octokit.issues.listComments,
        {
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
        },
        (response) => response.data,
      );

      // Limit to last 100 comments to avoid excessive processing
      const recentComments = comments.slice(-100);

      // Look for claiming phrases
      const claimPhrases = [
        "i'm working on this",
        'i am working on this',
        "i'll take this",
        'i will take this',
        'working on it',
        "i'd like to work on",
        'i would like to work on',
        'can i work on',
        'may i work on',
        'assigned to me',
        "i'm on it",
        "i'll submit a pr",
        'i will submit a pr',
        'working on a fix',
        'working on a pr',
      ];

      for (const comment of recentComments) {
        const body = (comment.body || '').toLowerCase();
        if (claimPhrases.some((phrase) => body.includes(phrase))) {
          return { passed: false };
        }
      }

      return { passed: true };
    } catch (error) {
      const errMsg = errorMessage(error);
      warn(MODULE, `Failed to check claim status on ${owner}/${repo}#${issueNumber}: ${errMsg}. Assuming not claimed.`);
      return { passed: true, inconclusive: true, reason: errMsg };
    }
  }

  async checkProjectHealth(owner: string, repo: string): Promise<ProjectHealth> {
    const cache = getHttpCache();
    const healthCacheKey = `health:${owner}/${repo}`;

    try {
      return await cachedTimeBased(cache, healthCacheKey, HEALTH_CACHE_TTL_MS, async () => {
        // Get repo info (with ETag caching — repo metadata changes infrequently)
        const url = `/repos/${owner}/${repo}`;
        const repoData = await cachedRequest(
          cache,
          url,
          (headers) =>
            this.octokit.repos.get({ owner, repo, headers }) as Promise<{
              data: { open_issues_count: number; pushed_at: string; stargazers_count: number; forks_count: number };
              headers: Record<string, string>;
            }>,
        );

        // Get recent commits
        const { data: commits } = await this.octokit.repos.listCommits({
          owner,
          repo,
          per_page: 1,
        });

        const lastCommit = commits[0];
        const lastCommitAt = lastCommit?.commit?.author?.date || repoData.pushed_at;
        const daysSinceLastCommit = daysBetween(new Date(lastCommitAt));

        // Check CI status (simplified - just check if workflows exist)
        let ciStatus: 'passing' | 'failing' | 'unknown' = 'unknown';
        try {
          const { data: workflows } = await this.octokit.actions.listRepoWorkflows({
            owner,
            repo,
            per_page: 1,
          });
          if (workflows.total_count > 0) {
            ciStatus = 'passing'; // Assume passing if workflows exist
          }
        } catch (error) {
          const errMsg = errorMessage(error);
          warn(MODULE, `Failed to check CI status for ${owner}/${repo}: ${errMsg}. Defaulting to unknown.`);
        }

        return {
          repo: `${owner}/${repo}`,
          lastCommitAt,
          daysSinceLastCommit,
          openIssuesCount: repoData.open_issues_count,
          avgIssueResponseDays: 0, // Would need more API calls to calculate
          ciStatus,
          isActive: daysSinceLastCommit < 30,
          stargazersCount: repoData.stargazers_count,
          forksCount: repoData.forks_count,
        };
      });
    } catch (error) {
      const errMsg = errorMessage(error);
      warn(MODULE, `Error checking project health for ${owner}/${repo}: ${errMsg}`);
      return {
        repo: `${owner}/${repo}`,
        lastCommitAt: '',
        daysSinceLastCommit: 999,
        openIssuesCount: 0,
        avgIssueResponseDays: 0,
        ciStatus: 'unknown',
        isActive: false,
        checkFailed: true,
        failureReason: errMsg,
      };
    }
  }

  async fetchContributionGuidelines(owner: string, repo: string): Promise<ContributionGuidelines | undefined> {
    const cacheKey = `${owner}/${repo}`;

    // Check cache first
    const cached = guidelinesCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.guidelines;
    }

    const filesToCheck = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', 'contributing.md'];

    // Probe all paths in parallel — take the first success in priority order
    const results = await Promise.allSettled(
      filesToCheck.map((file) =>
        this.octokit.repos.getContent({ owner, repo, path: file }).then(({ data }) => {
          if ('content' in data) {
            return Buffer.from(data.content, 'base64').toString('utf-8');
          }
          return null;
        }),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        const guidelines = this.parseContributionGuidelines(result.value);
        guidelinesCache.set(cacheKey, { guidelines, fetchedAt: Date.now() });
        pruneCache();
        return guidelines;
      }
      if (result.status === 'rejected') {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        if (!msg.includes('404') && !msg.includes('Not Found')) {
          warn(MODULE, `Unexpected error fetching ${filesToCheck[i]} from ${owner}/${repo}: ${msg}`);
        }
      }
    }

    // Cache the negative result too and prune if needed
    guidelinesCache.set(cacheKey, { guidelines: undefined, fetchedAt: Date.now() });
    pruneCache();
    return undefined;
  }

  parseContributionGuidelines(content: string): ContributionGuidelines {
    const guidelines: ContributionGuidelines = {
      rawContent: content,
    };

    const lowerContent = content.toLowerCase();

    // Detect branch naming conventions
    if (lowerContent.includes('branch')) {
      const branchMatch = content.match(/branch[^\n]*(?:named?|format|convention)[^\n]*[`"]([^`"]+)[`"]/i);
      if (branchMatch) {
        guidelines.branchNamingConvention = branchMatch[1];
      }
    }

    // Detect commit message format
    if (lowerContent.includes('conventional commit')) {
      guidelines.commitMessageFormat = 'conventional commits';
    } else if (lowerContent.includes('commit message')) {
      const commitMatch = content.match(/commit message[^\n]*[`"]([^`"]+)[`"]/i);
      if (commitMatch) {
        guidelines.commitMessageFormat = commitMatch[1];
      }
    }

    // Detect test framework
    if (lowerContent.includes('jest')) guidelines.testFramework = 'Jest';
    else if (lowerContent.includes('rspec')) guidelines.testFramework = 'RSpec';
    else if (lowerContent.includes('pytest')) guidelines.testFramework = 'pytest';
    else if (lowerContent.includes('mocha')) guidelines.testFramework = 'Mocha';

    // Detect linter
    if (lowerContent.includes('eslint')) guidelines.linter = 'ESLint';
    else if (lowerContent.includes('rubocop')) guidelines.linter = 'RuboCop';
    else if (lowerContent.includes('prettier')) guidelines.formatter = 'Prettier';

    // Detect CLA requirement
    if (lowerContent.includes('cla') || lowerContent.includes('contributor license agreement')) {
      guidelines.claRequired = true;
    }

    return guidelines;
  }

  analyzeRequirements(body: string): boolean {
    if (!body || body.length < 50) return false;

    // Check for clear structure
    const hasSteps = /\d+\.|[-*]\s/.test(body);
    const hasCodeBlock = /```/.test(body);
    const hasExpectedBehavior = /expect|should|must|want/i.test(body);

    // Must have at least two indicators of clarity
    const indicators = [hasSteps, hasCodeBlock, hasExpectedBehavior, body.length > 200];
    return indicators.filter(Boolean).length >= 2;
  }

  /**
   * Get the repo score from state, or return null if not evaluated
   */
  private getRepoScore(repoFullName: string): number | null {
    const state = this.stateManager.getState();
    const repoScore = state.repoScores?.[repoFullName];
    return repoScore?.score ?? null;
  }
}
