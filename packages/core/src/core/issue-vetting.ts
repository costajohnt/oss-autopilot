/**
 * Issue Vetting — orchestrates individual issue checks and computes
 * recommendation + viability score.
 *
 * Delegates to focused modules (#621):
 * - issue-eligibility.ts — PR existence, claim detection, requirements analysis
 * - repo-health.ts       — project health, contribution guidelines
 */

import { Octokit } from '@octokit/rest';
import { parseGitHubUrl } from './utils.js';
import { TrackedIssue, IssueVettingResult, type SearchPriority, type IssueCandidate } from './types.js';
import { ValidationError, errorMessage, isRateLimitError } from './errors.js';
import { debug, warn } from './logger.js';
import { getStateManager } from './state.js';
import { calculateRepoQualityBonus, calculateViabilityScore } from './issue-scoring.js';
import { repoBelongsToCategory } from './category-mapping.js';
import {
  checkNoExistingPR,
  checkNotClaimed,
  checkUserMergedPRsInRepo,
  analyzeRequirements,
} from './issue-eligibility.js';
import { checkProjectHealth, fetchContributionGuidelines } from './repo-health.js';
import { getHttpCache } from './http-cache.js';

const MODULE = 'issue-vetting';

/** Vetting concurrency: kept low to reduce burst pressure on GitHub's secondary rate limit. */
const MAX_CONCURRENT_VETTING = 3;

/** TTL for cached vetting results (15 minutes). Kept short so config changes take effect quickly. */
const VETTING_CACHE_TTL_MS = 15 * 60 * 1000;

export class IssueVetter {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;

  constructor(octokit: Octokit, stateManager: ReturnType<typeof getStateManager>) {
    this.octokit = octokit;
    this.stateManager = stateManager;
  }

  /**
   * Vet a specific issue — runs all checks and computes recommendation + viability score.
   * Results are cached for 15 minutes to avoid redundant API calls on repeated searches.
   */
  async vetIssue(issueUrl: string): Promise<IssueCandidate> {
    // Check vetting cache first — avoids ~6+ API calls per issue
    const cache = getHttpCache();
    const cacheKey = `vet:${issueUrl}`;
    const cached = cache.getIfFresh(cacheKey, VETTING_CACHE_TTL_MS);
    if (cached && typeof cached === 'object' && 'issue' in cached && 'viabilityScore' in cached) {
      debug(MODULE, `Vetting cache hit for ${issueUrl}`);
      return cached as IssueCandidate;
    }

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

    // Run all vetting checks in parallel — delegates to standalone functions
    const [existingPRCheck, claimCheck, projectHealth, contributionGuidelines, userMergedPRCount] = await Promise.all([
      checkNoExistingPR(this.octokit, owner, repo, number),
      checkNotClaimed(this.octokit, owner, repo, number, ghIssue.comments),
      checkProjectHealth(this.octokit, owner, repo),
      fetchContributionGuidelines(this.octokit, owner, repo),
      checkUserMergedPRsInRepo(this.octokit, owner, repo),
    ]);

    const noExistingPR = existingPRCheck.passed;
    const notClaimed = claimCheck.passed;

    // Analyze issue quality
    const clearRequirements = analyzeRequirements(ghIssue.body || '');

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

    // Check for category preference match
    const projectCategories = config.projectCategories ?? [];
    const matchesCategory = repoBelongsToCategory(repoFullName, projectCategories);
    if (matchesCategory) {
      reasonsToApprove.push('Matches preferred project category');
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
      matchesPreferredCategory: matchesCategory,
    });

    const starredRepos = this.stateManager.getStarredRepos();
    const preferredOrgs = config.preferredOrgs ?? [];
    let searchPriority: SearchPriority = 'normal';
    if (effectiveMergedCount > 0) {
      searchPriority = 'merged_pr';
    } else if (preferredOrgs.some((o) => o.toLowerCase() === orgName?.toLowerCase())) {
      searchPriority = 'preferred_org';
    } else if (starredRepos.includes(repoFullName)) {
      searchPriority = 'starred';
    }

    const result: IssueCandidate = {
      issue: trackedIssue,
      vettingResult,
      projectHealth,
      recommendation,
      reasonsToSkip,
      reasonsToApprove,
      viabilityScore,
      searchPriority,
    };

    // Persist repo metadata (stars, language) so the dashboard can display it (#839)
    if (!projectHealth.checkFailed) {
      try {
        this.stateManager.updateRepoScore(repoFullName, {
          stargazersCount: projectHealth.stargazersCount,
          language: projectHealth.language,
        });
      } catch {
        // Non-fatal — don't block vetting if metadata save fails
      }
    }

    // Cache the vetting result to avoid redundant API calls on repeated searches
    cache.set(cacheKey, '', result);

    return result;
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
      if (pending.size >= MAX_CONCURRENT_VETTING) {
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

  /**
   * Get the repo score from state, or return null if not evaluated
   */
  private getRepoScore(repoFullName: string): number | null {
    const state = this.stateManager.getState();
    const repoScore = state.repoScores?.[repoFullName];
    return repoScore?.score ?? null;
  }
}
