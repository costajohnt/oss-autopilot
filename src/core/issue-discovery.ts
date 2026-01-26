/**
 * Issue Discovery - Finds and vets potential issues to work on
 * Checks for existing PRs, claims, project health, and contribution guidelines
 */

import * as fs from 'fs';
import * as path from 'path';
import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { parseGitHubUrl, daysBetween, getDataDir } from './utils.js';
import {
  TrackedIssue,
  IssueVettingResult,
  ContributionGuidelines,
  ProjectHealth,
  RepoScore,
} from './types.js';

// Concurrency limit for parallel API calls
const MAX_CONCURRENT_REQUESTS = 5;

type SearchPriority = 'starred' | 'high_score' | 'normal';

export interface IssueCandidate {
  issue: TrackedIssue;
  vettingResult: IssueVettingResult;
  projectHealth: ProjectHealth;
  recommendation: 'approve' | 'skip' | 'needs_review';
  reasonsToSkip: string[];
  reasonsToApprove: string[];
  viabilityScore: number; // 0-100 scale
  searchPriority: SearchPriority; // Priority level for sorting
}

// Cache for contribution guidelines (expires after 1 hour, max 100 entries)
const guidelinesCache = new Map<string, { guidelines: ContributionGuidelines | undefined; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
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
    const entries = Array.from(guidelinesCache.entries())
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);

    const toRemove = entries.slice(0, guidelinesCache.size - CACHE_MAX_SIZE);
    for (const [key] of toRemove) {
      guidelinesCache.delete(key);
    }
  }
}

export class IssueDiscovery {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;

  constructor(githubToken: string) {
    this.octokit = getOctokit(githubToken);
    this.stateManager = getStateManager();
  }

  /**
   * Fetch the authenticated user's starred repositories from GitHub.
   * Updates the state manager with the list and timestamp.
   */
  async fetchStarredRepos(): Promise<string[]> {
    console.log('Fetching starred repositories...');
    const starredRepos: string[] = [];

    try {
      // Paginate through all starred repos (up to 500 to avoid excessive API calls)
      const iterator = this.octokit.paginate.iterator(
        this.octokit.activity.listReposStarredByAuthenticatedUser,
        {
          per_page: 100,
        }
      );

      let pageCount = 0;
      for await (const { data: repos } of iterator) {
        for (const repo of repos) {
          // Handle both Repository and StarredRepository response types
          // Repository has full_name directly, StarredRepository has { repo: Repository }
          let fullName: string | undefined;
          if ('full_name' in repo && typeof repo.full_name === 'string') {
            // Repository type - full_name is directly on the object
            fullName = repo.full_name;
          } else if ('repo' in repo && repo.repo && typeof repo.repo === 'object' && 'full_name' in repo.repo) {
            // StarredRepository type - full_name is nested in repo property
            fullName = (repo.repo as { full_name: string }).full_name;
          }
          if (fullName) {
            starredRepos.push(fullName);
          }
        }
        pageCount++;
        // Limit to 5 pages (500 repos) to avoid excessive API usage
        if (pageCount >= 5) {
          console.log('Reached pagination limit for starred repos (500)');
          break;
        }
      }

      console.log(`Fetched ${starredRepos.length} starred repositories`);
      this.stateManager.setStarredRepos(starredRepos);
      return starredRepos;
    } catch (error) {
      const cachedRepos = this.stateManager.getStarredRepos();
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error fetching starred repos:', errorMessage);

      if (cachedRepos.length === 0) {
        console.warn(
          `[STARRED_REPOS_FETCH_FAILED] Failed to fetch starred repositories from GitHub API. ` +
          `No cached repos available. Error: ${errorMessage}\n` +
          `Tip: Ensure your GITHUB_TOKEN has the 'read:user' scope and try again.`
        );
      } else {
        console.warn(
          `[STARRED_REPOS_FETCH_FAILED] Failed to fetch starred repositories from GitHub API. ` +
          `Using ${cachedRepos.length} cached repos instead. Error: ${errorMessage}`
        );
      }
      return cachedRepos;
    }
  }

  /**
   * Get starred repos, fetching from GitHub if cache is stale
   */
  async getStarredReposWithRefresh(): Promise<string[]> {
    if (this.stateManager.isStarredReposStale()) {
      return this.fetchStarredRepos();
    }
    return this.stateManager.getStarredRepos();
  }

  /**
   * Search for issues matching our criteria.
   * Searches in priority order: starred repos first, then high-scoring repos, then general.
   * Filters out issues from low-scoring repos.
   */
  async searchIssues(options: {
    languages?: string[];
    labels?: string[];
    maxResults?: number;
  } = {}): Promise<IssueCandidate[]> {
    const config = this.stateManager.getState().config;
    const languages = options.languages || config.languages;
    const labels = options.labels || config.labels;
    const maxResults = options.maxResults || 10;

    const allCandidates: IssueCandidate[] = [];

    // Get starred repos (with refresh if stale)
    const starredRepos = await this.getStarredReposWithRefresh();
    const starredRepoSet = new Set(starredRepos);

    // Get high-scoring and low-scoring repos from state
    const highScoringRepos = this.stateManager.getHighScoringRepos();
    const highScoringRepoSet = new Set(highScoringRepos);
    const lowScoringRepos = new Set(this.stateManager.getLowScoringRepos(3)); // Score <= 3 is low

    // Common filters
    const trackedUrls = new Set(this.stateManager.getState().activeIssues.map(i => i.url));
    const excludedRepos = new Set(config.excludeRepos);
    const maxAgeDays = config.maxIssueAgeDays || 90;
    const now = new Date();

    // Build base query parts
    const labelQuery = labels.map(l => `label:"${l}"`).join(' ');
    const langQuery = languages.map(l => `language:${l}`).join(' ');
    const baseQuery = `is:issue is:open ${labelQuery} ${langQuery} no:assignee`;

    // Helper to filter issues
    const filterIssues = (items: any[]) => {
      return items.filter(item => {
        if (trackedUrls.has(item.html_url)) return false;
        const repoFullName = item.repository_url.split('/').slice(-2).join('/');
        if (excludedRepos.has(repoFullName)) return false;
        // Filter OUT low-scoring repos
        if (lowScoringRepos.has(repoFullName)) return false;
        // Filter by issue age based on updated_at
        const updatedAt = new Date(item.updated_at);
        const ageDays = daysBetween(updatedAt, now);
        if (ageDays > maxAgeDays) return false;
        return true;
      });
    };

    // Phase 1: Search starred repos first
    if (starredRepos.length > 0) {
      console.log(`Phase 1: Searching issues in ${starredRepos.length} starred repos...`);
      const remainingNeeded = maxResults - allCandidates.length;
      if (remainingNeeded > 0) {
        const starredCandidates = await this.searchInRepos(
          starredRepos.slice(0, 10), // Limit to first 10 starred repos
          baseQuery,
          remainingNeeded,
          'starred',
          filterIssues
        );
        allCandidates.push(...starredCandidates);
        console.log(`Found ${starredCandidates.length} candidates from starred repos`);
      }
    }

    // Phase 2: Search high-scoring repos
    if (allCandidates.length < maxResults && highScoringRepos.length > 0) {
      console.log(`Phase 2: Searching issues in ${highScoringRepos.length} high-scoring repos...`);
      // Filter out repos already searched (starred)
      const reposToSearch = highScoringRepos.filter(r => !starredRepoSet.has(r));
      const remainingNeeded = maxResults - allCandidates.length;
      if (remainingNeeded > 0 && reposToSearch.length > 0) {
        const highScoreCandidates = await this.searchInRepos(
          reposToSearch.slice(0, 10), // Limit to first 10 high-scoring repos
          baseQuery,
          remainingNeeded,
          'high_score',
          filterIssues
        );
        allCandidates.push(...highScoreCandidates);
        console.log(`Found ${highScoreCandidates.length} candidates from high-scoring repos`);
      }
    }

    // Phase 3: General search (if still need more)
    if (allCandidates.length < maxResults) {
      console.log('Phase 3: General issue search...');
      const remainingNeeded = maxResults - allCandidates.length;
      try {
        const { data } = await this.octokit.search.issuesAndPullRequests({
          q: baseQuery,
          sort: 'created',
          order: 'desc',
          per_page: remainingNeeded * 3, // Fetch extra since some will be filtered
        });

        console.log(`Found ${data.total_count} issues in general search, processing top ${data.items.length}...`);

        // Filter and exclude already-found repos
        const seenRepos = new Set(allCandidates.map(c => c.issue.repo));
        const itemsToVet = filterIssues(data.items)
          .filter(item => {
            const repoFullName = item.repository_url.split('/').slice(-2).join('/');
            // Skip if already searched in starred or high-score phases
            return !starredRepoSet.has(repoFullName) && !highScoringRepoSet.has(repoFullName) && !seenRepos.has(repoFullName);
          })
          .slice(0, remainingNeeded * 2);

        const results = await this.vetIssuesParallel(
          itemsToVet.map(i => i.html_url),
          remainingNeeded,
          'normal'
        );
        allCandidates.push(...results);
        console.log(`Found ${results.length} candidates from general search`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[SEARCH_PHASE_3_FAILED] Error in general issue search: ${errorMessage}`);
      }
    }

    if (allCandidates.length === 0) {
      throw new Error(
        'No issue candidates found across all search phases. ' +
        'Try adjusting your search criteria (languages, labels) or check your network connection.'
      );
    }

    // Sort by priority first, then by recommendation
    allCandidates.sort((a, b) => {
      // Priority order: starred > high_score > normal
      const priorityOrder: Record<SearchPriority, number> = { starred: 0, high_score: 1, normal: 2 };
      const priorityDiff = priorityOrder[a.searchPriority] - priorityOrder[b.searchPriority];
      if (priorityDiff !== 0) return priorityDiff;

      // Then by recommendation
      const recommendationOrder = { approve: 0, needs_review: 1, skip: 2 };
      return recommendationOrder[a.recommendation] - recommendationOrder[b.recommendation];
    });

    return allCandidates.slice(0, maxResults);
  }

  /**
   * Search for issues within specific repos using batched queries.
   *
   * To avoid GitHub's secondary rate limit (30 requests/minute), we batch
   * multiple repos into a single search query using OR syntax:
   *   repo:owner1/repo1 OR repo:owner2/repo2 OR repo:owner3/repo3
   *
   * This reduces API calls from N (one per repo) to ceil(N/BATCH_SIZE).
   */
  private async searchInRepos(
    repos: string[],
    baseQuery: string,
    maxResults: number,
    priority: SearchPriority,
    filterFn: (items: any[]) => any[]
  ): Promise<IssueCandidate[]> {
    const candidates: IssueCandidate[] = [];

    // Batch repos to reduce API calls.
    // GitHub search query has a max length (~256 chars for query part).
    // Each "repo:owner/repo" is ~20-40 chars, plus " OR " (4 chars).
    // Using 5 repos per batch stays well under the limit.
    const BATCH_SIZE = 5;
    const batches = this.batchRepos(repos, BATCH_SIZE);

    for (const batch of batches) {
      if (candidates.length >= maxResults) break;

      try {
        // Build repo filter: (repo:a OR repo:b OR repo:c)
        const repoFilter = batch.map(r => `repo:${r}`).join(' OR ');
        const batchQuery = `${baseQuery} (${repoFilter})`;

        const { data } = await this.octokit.search.issuesAndPullRequests({
          q: batchQuery,
          sort: 'created',
          order: 'desc',
          per_page: Math.min(30, (maxResults - candidates.length) * 3),
        });

        if (data.items.length > 0) {
          const filtered = filterFn(data.items);
          const remainingNeeded = maxResults - candidates.length;
          const results = await this.vetIssuesParallel(
            filtered.slice(0, remainingNeeded * 2).map(i => i.html_url),
            remainingNeeded,
            priority
          );
          candidates.push(...results);
        }
      } catch (error) {
        // Log but continue with other batches
        const batchRepos = batch.join(', ');
        console.error(`Error searching issues in batch [${batchRepos}]:`, error instanceof Error ? error.message : error);
      }
    }

    return candidates;
  }

  /**
   * Split repos into batches of the specified size.
   */
  private batchRepos(repos: string[], batchSize: number): string[][] {
    const batches: string[][] = [];
    for (let i = 0; i < repos.length; i += batchSize) {
      batches.push(repos.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Vet multiple issues in parallel with concurrency limit
   * @param urls - Issue URLs to vet
   * @param maxResults - Maximum number of results to return
   * @param priority - Optional priority to override the auto-detected priority
   */
  private async vetIssuesParallel(
    urls: string[],
    maxResults: number,
    priority?: SearchPriority
  ): Promise<IssueCandidate[]> {
    const candidates: IssueCandidate[] = [];
    const pending: Promise<void>[] = [];

    for (const url of urls) {
      if (candidates.length >= maxResults) break;

      const task = this.vetIssue(url)
        .then(candidate => {
          if (candidates.length < maxResults) {
            // Override the priority if provided
            if (priority) {
              candidate.searchPriority = priority;
            }
            candidates.push(candidate);
          }
        })
        .catch(error => {
          console.error(`Error vetting issue ${url}:`, error instanceof Error ? error.message : error);
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

    // Wait for remaining
    await Promise.allSettled(pending);
    return candidates.slice(0, maxResults);
  }

  /**
   * Vet a specific issue
   */
  async vetIssue(issueUrl: string): Promise<IssueCandidate> {
    // Parse URL
    const parsed = parseGitHubUrl(issueUrl);
    if (!parsed || parsed.type !== 'issues') {
      throw new Error(`Invalid issue URL: ${issueUrl}`);
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
    const [noExistingPR, notClaimed, projectHealth, contributionGuidelines] = await Promise.all([
      this.checkNoExistingPR(owner, repo, number),
      this.checkNotClaimed(owner, repo, number, ghIssue.comments),
      this.checkProjectHealth(owner, repo),
      this.fetchContributionGuidelines(owner, repo),
    ]);

    // Analyze issue quality
    const clearRequirements = this.analyzeRequirements(ghIssue.body || '');

    const vettingResult: IssueVettingResult = {
      passedAllChecks: noExistingPR && notClaimed && projectHealth.isActive && clearRequirements,
      checks: {
        noExistingPR,
        notClaimed,
        projectActive: projectHealth.isActive,
        clearRequirements,
        contributionGuidelinesFound: !!contributionGuidelines,
      },
      contributionGuidelines,
      notes: [],
    };

    // Build notes
    if (!noExistingPR) vettingResult.notes.push('Existing PR found for this issue');
    if (!notClaimed) vettingResult.notes.push('Issue appears to be claimed by someone');
    if (!projectHealth.isActive) vettingResult.notes.push('Project may be inactive');
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
      labels: ghIssue.labels.map(l => (typeof l === 'string' ? l : l.name || '')),
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
    if (!projectHealth.isActive) reasonsToSkip.push('Inactive project');
    if (!clearRequirements) reasonsToSkip.push('Unclear requirements');

    if (noExistingPR) reasonsToApprove.push('No existing PR');
    if (notClaimed) reasonsToApprove.push('Not claimed');
    if (projectHealth.isActive) reasonsToApprove.push('Active project');
    if (clearRequirements) reasonsToApprove.push('Clear requirements');
    if (contributionGuidelines) reasonsToApprove.push('Has contribution guidelines');

    // Check if it's a trusted project
    const config = this.stateManager.getState().config;
    if (config.trustedProjects.includes(repoFullName)) {
      reasonsToApprove.push('Trusted project (previous PR merged)');
    }

    let recommendation: 'approve' | 'skip' | 'needs_review';
    if (vettingResult.passedAllChecks) {
      recommendation = 'approve';
    } else if (reasonsToSkip.length > 2) {
      recommendation = 'skip';
    } else {
      recommendation = 'needs_review';
    }

    // Calculate viability score
    const viabilityScore = this.calculateViabilityScore({
      repoScore: this.getRepoScore(repoFullName),
      hasExistingPR: !noExistingPR,
      isClaimed: !notClaimed,
      clearRequirements,
      hasContributionGuidelines: !!contributionGuidelines,
      issueUpdatedAt: ghIssue.updated_at,
    });

    // Determine search priority
    const starredRepos = this.stateManager.getStarredRepos();
    const repoScore = this.getRepoScore(repoFullName);
    let searchPriority: SearchPriority = 'normal';
    if (starredRepos.includes(repoFullName)) {
      searchPriority = 'starred';
    } else if (repoScore !== null && repoScore >= 7) {
      searchPriority = 'high_score';
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

  private async checkNoExistingPR(owner: string, repo: string, issueNumber: number): Promise<boolean> {
    try {
      // Search for PRs that mention this issue
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:pr ${issueNumber}`,
        per_page: 5,
      });

      // Also check timeline for linked PRs
      const { data: timeline } = await this.octokit.issues.listEventsForTimeline({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      });

      const linkedPRs = timeline.filter(
        (event: any) => event.event === 'cross-referenced' && event.source?.issue?.pull_request
      );

      return data.total_count === 0 && linkedPRs.length === 0;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[CHECK_NO_EXISTING_PR] Failed to check for existing PRs on ${owner}/${repo}#${issueNumber}: ${errorMessage}. Assuming no existing PR.`);
      return true;
    }
  }

  private async checkNotClaimed(
    owner: string,
    repo: string,
    issueNumber: number,
    commentCount: number
  ): Promise<boolean> {
    if (commentCount === 0) return true;

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
        (response) => response.data
      );

      // Limit to last 100 comments to avoid excessive processing
      const recentComments = comments.slice(-100);

      // Look for claiming phrases
      const claimPhrases = [
        'i\'m working on this',
        'i am working on this',
        'i\'ll take this',
        'i will take this',
        'working on it',
        'i\'d like to work on',
        'i would like to work on',
        'can i work on',
        'may i work on',
        'assigned to me',
        'i\'m on it',
        'i\'ll submit a pr',
        'i will submit a pr',
        'working on a fix',
        'working on a pr',
      ];

      for (const comment of recentComments) {
        const body = (comment.body || '').toLowerCase();
        if (claimPhrases.some(phrase => body.includes(phrase))) {
          return false;
        }
      }

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[CHECK_NOT_CLAIMED] Failed to check claim status on ${owner}/${repo}#${issueNumber}: ${errorMessage}. Assuming not claimed.`);
      return true;
    }
  }

  private async checkProjectHealth(owner: string, repo: string): Promise<ProjectHealth> {
    try {
      // Get repo info
      const { data: repoData } = await this.octokit.repos.get({ owner, repo });

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
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`[CHECK_CI_STATUS] Failed to check CI status for ${owner}/${repo}: ${errorMessage}. Defaulting to unknown.`);
      }

      return {
        repo: `${owner}/${repo}`,
        lastCommitAt,
        daysSinceLastCommit,
        openIssuesCount: repoData.open_issues_count,
        avgIssueResponseDays: 0, // Would need more API calls to calculate
        ciStatus,
        isActive: daysSinceLastCommit < 30,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CHECK_PROJECT_HEALTH] Error checking project health for ${owner}/${repo}: ${errorMessage}`);
      return {
        repo: `${owner}/${repo}`,
        lastCommitAt: '',
        daysSinceLastCommit: 999,
        openIssuesCount: 0,
        avgIssueResponseDays: 0,
        ciStatus: 'unknown',
        isActive: false,
        checkFailed: true,
        failureReason: errorMessage,
      };
    }
  }

  private async fetchContributionGuidelines(
    owner: string,
    repo: string
  ): Promise<ContributionGuidelines | undefined> {
    const cacheKey = `${owner}/${repo}`;

    // Check cache first
    const cached = guidelinesCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      return cached.guidelines;
    }

    const filesToCheck = [
      'CONTRIBUTING.md',
      '.github/CONTRIBUTING.md',
      'docs/CONTRIBUTING.md',
      'contributing.md',
    ];

    for (const file of filesToCheck) {
      try {
        const { data } = await this.octokit.repos.getContent({
          owner,
          repo,
          path: file,
        });

        if ('content' in data) {
          const content = Buffer.from(data.content, 'base64').toString('utf-8');
          const guidelines = this.parseContributionGuidelines(content);

          // Cache the result and prune if needed
          guidelinesCache.set(cacheKey, { guidelines, fetchedAt: Date.now() });
          pruneCache();
          return guidelines;
        }
      } catch (error) {
        // File not found is expected; only log unexpected errors
        if (error instanceof Error && !error.message.includes('404') && !error.message.includes('Not Found')) {
          console.warn(`[FETCH_GUIDELINES] Unexpected error fetching ${file} from ${owner}/${repo}: ${error.message}`);
        }
      }
    }

    // Cache the negative result too and prune if needed
    guidelinesCache.set(cacheKey, { guidelines: undefined, fetchedAt: Date.now() });
    pruneCache();
    return undefined;
  }

  private parseContributionGuidelines(content: string): ContributionGuidelines {
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

  private analyzeRequirements(body: string): boolean {
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

  /**
   * Calculate viability score for an issue (0-100 scale)
   * Scoring:
   * - Base: 50 points
   * - +repoScore*2 (up to +20 for score of 10)
   * - +15 for clear requirements (clarity)
   * - +15 for freshness (recently updated)
   * - +10 for contribution guidelines
   * - -30 if existing PR
   * - -20 if claimed
   */
  calculateViabilityScore(params: {
    repoScore: number | null;
    hasExistingPR: boolean;
    isClaimed: boolean;
    clearRequirements: boolean;
    hasContributionGuidelines: boolean;
    issueUpdatedAt: string;
  }): number {
    let score = 50; // Base score

    // Add repo score contribution (up to +20)
    if (params.repoScore !== null) {
      score += params.repoScore * 2;
    }

    // Clarity bonus (+15)
    if (params.clearRequirements) {
      score += 15;
    }

    // Freshness bonus (+15 for issues updated within last 14 days)
    const updatedAt = new Date(params.issueUpdatedAt);
    const daysSinceUpdate = daysBetween(updatedAt);
    if (daysSinceUpdate <= 14) {
      score += 15;
    } else if (daysSinceUpdate <= 30) {
      // Partial bonus for 15-30 days
      score += Math.round(15 * (1 - (daysSinceUpdate - 14) / 16));
    }

    // Contribution guidelines bonus (+10)
    if (params.hasContributionGuidelines) {
      score += 10;
    }

    // Penalty for existing PR (-30)
    if (params.hasExistingPR) {
      score -= 30;
    }

    // Penalty for claimed issue (-20)
    if (params.isClaimed) {
      score -= 20;
    }

    // Clamp to 0-100
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Save search results to ~/.oss-autopilot/found-issues.md
   * Results are sorted by viability score (highest first)
   */
  saveSearchResults(candidates: IssueCandidate[]): string {
    // Sort by viability score descending
    const sorted = [...candidates].sort((a, b) => b.viabilityScore - a.viabilityScore);

    const outputDir = getDataDir();
    const outputFile = path.join(outputDir, 'found-issues.md');

    // Directory is created by getDataDir() if needed

    // Generate markdown content
    const timestamp = new Date().toISOString();
    let content = `# Found Issues\n\n`;
    content += `> Generated at: ${timestamp}\n\n`;
    content += `| Score | Repo | Issue | Title | Labels | Updated | Recommendation |\n`;
    content += `|-------|------|-------|-------|--------|---------|----------------|\n`;

    for (const candidate of sorted) {
      const { issue, viabilityScore, recommendation } = candidate;
      const labels = issue.labels.slice(0, 3).join(', ');
      const truncatedLabels = labels.length > 30 ? labels.substring(0, 27) + '...' : labels;
      const truncatedTitle = issue.title.length > 50 ? issue.title.substring(0, 47) + '...' : issue.title;
      const updatedDate = new Date(issue.updatedAt).toLocaleDateString();
      const recIcon = recommendation === 'approve' ? 'Y' : recommendation === 'skip' ? 'N' : '?';

      content += `| ${viabilityScore} | ${issue.repo} | [#${issue.number}](${issue.url}) | ${truncatedTitle} | ${truncatedLabels} | ${updatedDate} | ${recIcon} |\n`;
    }

    content += `\n## Legend\n\n`;
    content += `- **Score**: Viability score (0-100)\n`;
    content += `- **Recommendation**: Y = approve, N = skip, ? = needs_review\n`;

    fs.writeFileSync(outputFile, content, 'utf-8');
    console.log(`Saved ${sorted.length} issues to ${outputFile}`);

    return outputFile;
  }

  /**
   * Format issue candidate for display
   */
  formatCandidate(candidate: IssueCandidate): string {
    const { issue, vettingResult, projectHealth, recommendation, reasonsToApprove, reasonsToSkip } = candidate;

    const statusIcon = recommendation === 'approve' ? '✅' : recommendation === 'skip' ? '❌' : '⚠️';

    return `
## ${statusIcon} Issue Candidate: ${issue.repo}#${issue.number}

**Title:** ${issue.title}
**Labels:** ${issue.labels.join(', ')}
**Created:** ${new Date(issue.createdAt).toLocaleDateString()}
**URL:** ${issue.url}

### Vetting Results
${Object.entries(vettingResult.checks)
  .map(([key, passed]) => `- ${passed ? '✓' : '✗'} ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}`)
  .join('\n')}

### Project Health
- Last commit: ${projectHealth.daysSinceLastCommit} days ago
- Open issues: ${projectHealth.openIssuesCount}
- CI status: ${projectHealth.ciStatus}

### Recommendation: **${recommendation.toUpperCase()}**
${reasonsToApprove.length > 0 ? `\n**Reasons to approve:**\n${reasonsToApprove.map(r => `- ${r}`).join('\n')}` : ''}
${reasonsToSkip.length > 0 ? `\n**Reasons to skip:**\n${reasonsToSkip.map(r => `- ${r}`).join('\n')}` : ''}
${vettingResult.notes.length > 0 ? `\n**Notes:**\n${vettingResult.notes.map(n => `- ${n}`).join('\n')}` : ''}
`;
  }
}
