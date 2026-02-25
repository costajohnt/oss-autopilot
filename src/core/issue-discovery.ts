/**
 * Issue Discovery - Finds and vets potential issues to work on
 * Checks for existing PRs, claims, project health, and contribution guidelines
 */

import * as fs from 'fs';
import * as path from 'path';
import { Octokit } from '@octokit/rest';
import { getOctokit, checkRateLimit } from './github.js';
import { getStateManager } from './state.js';
import { paginateAll } from './pagination.js';
import { parseGitHubUrl, daysBetween, getDataDir } from './utils.js';
import { TrackedIssue, IssueVettingResult, ContributionGuidelines, ProjectHealth, DEFAULT_CONFIG } from './types.js';
import { ValidationError } from './errors.js';

// Concurrency limit for parallel API calls
const MAX_CONCURRENT_REQUESTS = 5;

/** Minimal shape of a GitHub search result item (from octokit.search.issuesAndPullRequests) */
interface GitHubSearchItem {
  html_url: string;
  repository_url: string;
  updated_at: string;
  title?: string;
  labels?: Array<{ name?: string } | string>;
  [key: string]: unknown;
}

export type SearchPriority = 'merged_pr' | 'starred' | 'normal';

/** Result of a vetting check that may be inconclusive due to API errors. */
interface CheckResult {
  passed: boolean;
  inconclusive?: boolean;
  reason?: string;
}

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
    const entries = Array.from(guidelinesCache.entries()).sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);

    const toRemove = entries.slice(0, guidelinesCache.size - CACHE_MAX_SIZE);
    for (const [key] of toRemove) {
      guidelinesCache.delete(key);
    }
  }
}

/** Labels that indicate documentation-only issues (#105). */
export const DOC_ONLY_LABELS = new Set(['documentation', 'docs', 'typo', 'spelling']);

/**
 * Check if an issue's labels are ALL documentation-related (#105).
 * Issues with mixed labels (e.g., "good first issue" + "documentation") pass through.
 * Issues with no labels are not considered doc-only.
 */
export function isDocOnlyIssue(item: GitHubSearchItem): boolean {
  if (!item.labels || !Array.isArray(item.labels) || item.labels.length === 0) return false;
  const labelNames = item.labels.map((l) => (typeof l === 'string' ? l : l.name || '').toLowerCase());
  // Filter out empty label names before checking
  const nonEmptyLabels = labelNames.filter((n) => n.length > 0);
  if (nonEmptyLabels.length === 0) return false;
  return nonEmptyLabels.every((n) => DOC_ONLY_LABELS.has(n));
}

/**
 * Apply per-repo cap to candidates (#105).
 * Keeps at most `maxPerRepo` issues from any single repo.
 * Maintains the existing sort order — first N from each repo are kept,
 * excess issues from over-represented repos are dropped.
 */
export function applyPerRepoCap(candidates: IssueCandidate[], maxPerRepo: number): IssueCandidate[] {
  const repoCounts = new Map<string, number>();
  const kept: IssueCandidate[] = [];

  for (const c of candidates) {
    const count = repoCounts.get(c.issue.repo) || 0;
    if (count < maxPerRepo) {
      kept.push(c);
      repoCounts.set(c.issue.repo, count + 1);
    }
  }

  return kept;
}

/** Known beginner-type label names used to detect label-farming repos (#97). */
export const BEGINNER_LABELS = new Set([
  'good first issue',
  'hacktoberfest',
  'easy',
  'up-for-grabs',
  'first-timers-only',
  'beginner-friendly',
  'beginner',
  'starter',
  'newbie',
  'low-hanging-fruit',
  'community',
]);

/** Check if a single issue has an excessive number of beginner labels (>= 5). */
export function isLabelFarming(item: GitHubSearchItem): boolean {
  if (!item.labels || !Array.isArray(item.labels)) return false;
  const labelNames = item.labels.map((l) => (typeof l === 'string' ? l : l.name || '').toLowerCase());
  const beginnerCount = labelNames.filter((n) => BEGINNER_LABELS.has(n)).length;
  return beginnerCount >= 5;
}

/** Detect mass-created issue titles like "Add Trivia Question 61" or "Create Entry #5". */
export function hasTemplatedTitle(title: string): boolean {
  if (!title) return false;
  // Matches "<anything> <category-noun> <number>" where category nouns are typical
  // of mass-created templated issues. This avoids false positives on legitimate titles
  // like "Add support for Python 3" or "Implement RFC 7231" which lack category nouns.
  return /^.+\s+(question|fact|point|item|task|entry|post|challenge|exercise|example|problem|tip|recipe|snippet)\s+#?\d+$/i.test(
    title,
  );
}

/**
 * Batch-analyze search items to detect label-farming repositories (#97).
 * Returns a Set of repo full names (owner/repo) that appear to be spam.
 *
 * A repo is flagged if:
 * - ANY single issue has >= 5 beginner labels (strong individual signal), OR
 * - It has >= 3 issues with templated titles (batch signal)
 */
export function detectLabelFarmingRepos(items: GitHubSearchItem[]): Set<string> {
  const spamRepos = new Set<string>();
  const repoSpamCounts = new Map<string, number>();

  for (const item of items) {
    const repoFullName = item.repository_url.split('/').slice(-2).join('/');

    // Strong signal: single issue with 5+ beginner labels
    if (isLabelFarming(item)) {
      spamRepos.add(repoFullName);
      continue;
    }

    // Weaker signal: templated title
    if (item.title && hasTemplatedTitle(item.title)) {
      repoSpamCounts.set(repoFullName, (repoSpamCounts.get(repoFullName) || 0) + 1);
    }
  }

  // Flag repos with 3+ templated-title issues
  for (const [repo, count] of repoSpamCounts) {
    if (count >= 3) {
      spamRepos.add(repo);
    }
  }

  return spamRepos;
}

/**
 * Calculate a quality bonus based on repo star and fork counts (#98).
 * Stars: <50 → 0, 50-499 → +3, 500-4999 → +5, 5000+ → +8
 * Forks: 50+ → +2, 500+ → +4
 * Natural max is 12 (8 stars + 4 forks).
 */
export function calculateRepoQualityBonus(stargazersCount: number, forksCount: number): number {
  let bonus = 0;

  // Star tiers
  if (stargazersCount >= 5000) bonus += 8;
  else if (stargazersCount >= 500) bonus += 5;
  else if (stargazersCount >= 50) bonus += 3;

  // Fork tiers
  if (forksCount >= 500) bonus += 4;
  else if (forksCount >= 50) bonus += 2;

  return bonus;
}

export class IssueDiscovery {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;
  private githubToken: string;

  /** Set after searchIssues() runs if rate limits affected the search (low pre-flight quota or mid-search rate limit hits). */
  rateLimitWarning: string | null = null;

  constructor(githubToken: string) {
    this.githubToken = githubToken;
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
      const iterator = this.octokit.paginate.iterator(this.octokit.activity.listReposStarredByAuthenticatedUser, {
        per_page: 100,
      });

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
            `Tip: Ensure your GITHUB_TOKEN has the 'read:user' scope and try again.`,
        );
      } else {
        console.warn(
          `[STARRED_REPOS_FETCH_FAILED] Failed to fetch starred repositories from GitHub API. ` +
            `Using ${cachedRepos.length} cached repos instead. Error: ${errorMessage}`,
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
   * Searches in priority order: merged-PR repos first (no label filter), then starred repos, then general.
   * Filters out issues from low-scoring and excluded repos.
   */
  async searchIssues(
    options: {
      languages?: string[];
      labels?: string[];
      maxResults?: number;
    } = {},
  ): Promise<IssueCandidate[]> {
    const config = this.stateManager.getState().config;
    const languages = options.languages || config.languages;
    const labels = options.labels || config.labels;
    const maxResults = options.maxResults || 10;

    const allCandidates: IssueCandidate[] = [];
    let phase0Error: string | null = null;
    let phase1Error: string | null = null;
    let rateLimitHitDuringSearch = false;

    // Pre-flight rate limit check (#100)
    this.rateLimitWarning = null;
    try {
      const rateLimit = await checkRateLimit(this.githubToken);
      if (rateLimit.remaining < 5) {
        const resetTime = new Date(rateLimit.resetAt).toLocaleTimeString('en-US', { hour12: false });
        this.rateLimitWarning = `GitHub search API quota low (${rateLimit.remaining}/${rateLimit.limit} remaining, resets at ${resetTime}). Search may be slow.`;
        console.warn(this.rateLimitWarning);
      }
    } catch (error) {
      // Fail fast on auth errors — no point searching with a bad token
      if ((error as { status?: number })?.status === 401) {
        throw error;
      }
      // Non-fatal: proceed with search for transient/network errors
      console.warn('[RATE_LIMIT_CHECK] Could not check rate limit:', error instanceof Error ? error.message : error);
    }

    // Get merged-PR repos (highest merge probability)
    const mergedPRRepos = this.stateManager.getReposWithMergedPRs();
    const mergedPRRepoSet = new Set(mergedPRRepos);

    // Get open-PR repos (repos with score data but no merges yet)
    const openPRRepos = this.stateManager.getReposWithOpenPRs();

    // Get starred repos (with refresh if stale)
    const starredRepos = await this.getStarredReposWithRefresh();
    const starredRepoSet = new Set(starredRepos);

    // Get low-scoring repos from state
    const lowScoringRepos = new Set(this.stateManager.getLowScoringRepos(3)); // Score <= 3 is low

    // Common filters
    const trackedUrls = new Set(this.stateManager.getState().activeIssues.map((i) => i.url));
    const excludedRepos = new Set(config.excludeRepos);
    const maxAgeDays = config.maxIssueAgeDays || 90;
    const now = new Date();

    // Build query parts
    const labelQuery = labels.map((l) => `label:"${l}"`).join(' ');
    const langQuery = languages.map((l) => `language:${l}`).join(' ');
    // Phase 0 uses a broader query — established contributors don't need beginner labels
    const establishedQuery = `is:issue is:open ${langQuery} no:assignee`;
    // Phases 1+ use label-filtered query for discovery in unfamiliar repos
    const baseQuery = `is:issue is:open ${labelQuery} ${langQuery} no:assignee`;

    // Helper to filter issues
    const includeDocIssues = config.includeDocIssues ?? true;
    const aiBlocklisted = new Set(config.aiPolicyBlocklist ?? DEFAULT_CONFIG.aiPolicyBlocklist ?? []);
    if (aiBlocklisted.size > 0) {
      console.log(
        `[AI_POLICY_FILTER] Filtering issues from ${aiBlocklisted.size} blocklisted repo(s): ${[...aiBlocklisted].join(', ')}`,
      );
    }
    const filterIssues = (items: GitHubSearchItem[]) => {
      return items.filter((item) => {
        if (trackedUrls.has(item.html_url)) return false;
        const repoFullName = item.repository_url.split('/').slice(-2).join('/');
        if (excludedRepos.has(repoFullName)) return false;
        // Filter repos with known anti-AI contribution policies (#108)
        if (aiBlocklisted.has(repoFullName)) return false;
        // Filter OUT low-scoring repos
        if (lowScoringRepos.has(repoFullName)) return false;
        // Filter by issue age based on updated_at
        const updatedAt = new Date(item.updated_at);
        const ageDays = daysBetween(updatedAt, now);
        if (ageDays > maxAgeDays) return false;
        // Filter out doc-only issues unless opted in (#105)
        if (!includeDocIssues && isDocOnlyIssue(item)) return false;
        return true;
      });
    };

    // Phase 0: Search repos where user has merged PRs + open-PR repos (highest merge probability)
    // Uses broader query — established contributors don't need "good first issue" labels
    // Merged-PR repos come first, then open-PR repos fill remaining slots (capped at 10 total)
    const phase0Repos = [...mergedPRRepos, ...openPRRepos.filter((r) => !mergedPRRepoSet.has(r))].slice(0, 10);
    const phase0RepoSet = new Set(phase0Repos);

    if (phase0Repos.length > 0) {
      const mergedInPhase0 = Math.min(mergedPRRepos.length, phase0Repos.length);
      const openInPhase0 = phase0Repos.length - mergedInPhase0;
      console.log(
        `Phase 0: Searching issues in ${phase0Repos.length} repos (${mergedInPhase0} merged-PR, ${openInPhase0} open-PR, no label filter)...`,
      );

      // Phase 0a: merged-PR repos (priority: merged_pr)
      const mergedPhase0Repos = phase0Repos.slice(0, mergedInPhase0);
      if (mergedPhase0Repos.length > 0) {
        const remainingNeeded = maxResults - allCandidates.length;
        if (remainingNeeded > 0) {
          const {
            candidates: mergedCandidates,
            allBatchesFailed,
            rateLimitHit,
          } = await this.searchInRepos(mergedPhase0Repos, establishedQuery, remainingNeeded, 'merged_pr', filterIssues);
          allCandidates.push(...mergedCandidates);
          if (allBatchesFailed) {
            phase0Error = 'All merged-PR repo batches failed';
          }
          if (rateLimitHit) {
            rateLimitHitDuringSearch = true;
          }
          console.log(`Found ${mergedCandidates.length} candidates from merged-PR repos`);
        }
      }

      // Phase 0b: open-PR repos (priority: starred — intermediate tier)
      const openPhase0Repos = phase0Repos.slice(mergedInPhase0);
      if (openPhase0Repos.length > 0 && allCandidates.length < maxResults) {
        const remainingNeeded = maxResults - allCandidates.length;
        if (remainingNeeded > 0) {
          const {
            candidates: openCandidates,
            allBatchesFailed,
            rateLimitHit,
          } = await this.searchInRepos(openPhase0Repos, establishedQuery, remainingNeeded, 'starred', filterIssues);
          allCandidates.push(...openCandidates);
          if (allBatchesFailed) {
            const msg = 'All open-PR repo batches failed';
            phase0Error = phase0Error ? `${phase0Error}; ${msg}` : msg;
          }
          if (rateLimitHit) {
            rateLimitHitDuringSearch = true;
          }
          console.log(`Found ${openCandidates.length} candidates from open-PR repos`);
        }
      }
    }

    // Phase 1: Search starred repos (filter out already-searched Phase 0 repos)
    if (allCandidates.length < maxResults && starredRepos.length > 0) {
      const reposToSearch = starredRepos.filter((r) => !phase0RepoSet.has(r));
      if (reposToSearch.length > 0) {
        console.log(`Phase 1: Searching issues in ${reposToSearch.length} starred repos...`);
        const remainingNeeded = maxResults - allCandidates.length;
        if (remainingNeeded > 0) {
          const {
            candidates: starredCandidates,
            allBatchesFailed,
            rateLimitHit,
          } = await this.searchInRepos(reposToSearch.slice(0, 10), baseQuery, remainingNeeded, 'starred', filterIssues);
          allCandidates.push(...starredCandidates);
          if (allBatchesFailed) {
            phase1Error = 'All starred repo batches failed';
          }
          if (rateLimitHit) {
            rateLimitHitDuringSearch = true;
          }
          console.log(`Found ${starredCandidates.length} candidates from starred repos`);
        }
      }
    }

    // Phase 2: General search (if still need more)
    let phase2Error: string | null = null;
    if (allCandidates.length < maxResults) {
      console.log('Phase 2: General issue search...');
      const remainingNeeded = maxResults - allCandidates.length;
      try {
        const { data } = await this.octokit.search.issuesAndPullRequests({
          q: baseQuery,
          sort: 'created',
          order: 'desc',
          per_page: remainingNeeded * 3, // Fetch extra since some will be filtered
        });

        console.log(`Found ${data.total_count} issues in general search, processing top ${data.items.length}...`);

        // Detect and filter label-farming repos (#97)
        const spamRepos = detectLabelFarmingRepos(data.items);
        if (spamRepos.size > 0) {
          const spamCount = data.items.filter((i) =>
            spamRepos.has(i.repository_url.split('/').slice(-2).join('/')),
          ).length;
          console.log(
            `[SPAM_FILTER] Filtered ${spamCount} issues from ${spamRepos.size} label-farming repos: ${[...spamRepos].join(', ')}`,
          );
        }

        // Filter and exclude already-found repos
        const seenRepos = new Set(allCandidates.map((c) => c.issue.repo));
        const itemsToVet = filterIssues(data.items)
          .filter((item) => {
            const repoFullName = item.repository_url.split('/').slice(-2).join('/');
            return !spamRepos.has(repoFullName);
          })
          .filter((item) => {
            const repoFullName = item.repository_url.split('/').slice(-2).join('/');
            // Skip if already searched in earlier phases
            return (
              !phase0RepoSet.has(repoFullName) && !starredRepoSet.has(repoFullName) && !seenRepos.has(repoFullName)
            );
          })
          .slice(0, remainingNeeded * 2);

        const {
          candidates: results,
          allFailed: allVetFailed,
          rateLimitHit: vetRateLimitHit,
        } = await this.vetIssuesParallel(
          itemsToVet.map((i) => i.html_url),
          remainingNeeded,
          'normal',
        );

        // Apply minStars filter to Phase 2 results (#105)
        // Phase 0/1 are exempt — if you've already contributed to or starred a repo, star count is irrelevant.
        const minStars = config.minStars ?? 50;
        const starFiltered = results.filter((c) => {
          if (c.projectHealth.checkFailed) return true; // Don't penalize repos we couldn't check
          const stars = c.projectHealth.stargazersCount ?? 0;
          return stars >= minStars;
        });
        const starFilteredCount = results.length - starFiltered.length;
        if (starFilteredCount > 0) {
          console.log(`[STAR_FILTER] Filtered ${starFilteredCount} candidates below ${minStars} stars`);
        }

        allCandidates.push(...starFiltered);
        if (allVetFailed) {
          phase2Error = (phase2Error ? phase2Error + '; ' : '') + 'all vetting failed';
        }
        if (vetRateLimitHit) {
          rateLimitHitDuringSearch = true;
        }
        console.log(`Found ${starFiltered.length} candidates from general search`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        phase2Error = errorMessage;
        if (IssueDiscovery.isRateLimitError(error)) {
          rateLimitHitDuringSearch = true;
        }
        console.error(`[SEARCH_PHASE_2_FAILED] Error in general issue search: ${errorMessage}`);
      }
    }

    if (allCandidates.length === 0) {
      const phaseErrors = [
        phase0Error ? `Phase 0 (merged-PR repos): ${phase0Error}` : null,
        phase1Error ? `Phase 1 (starred repos): ${phase1Error}` : null,
        phase2Error ? `Phase 2 (general): ${phase2Error}` : null,
      ].filter(Boolean);
      const details = phaseErrors.length > 0 ? ` ${phaseErrors.join('. ')}.` : '';
      const rateLimitContext = rateLimitHitDuringSearch
        ? ' GitHub API rate limits may have affected results — try again after the rate limit resets.'
        : '';
      throw new ValidationError(
        `No issue candidates found across all search phases.${details}${rateLimitContext} ` +
          'Try adjusting your search criteria (languages, labels) or check your network connection.',
      );
    }

    // Surface rate limit warning even with partial results (#100)
    // This overwrites the pre-flight "quota low" warning (speculative) with a more
    // informative "results incomplete" warning (factual) when rate limits actually hit.
    if (rateLimitHitDuringSearch) {
      this.rateLimitWarning =
        `Search results may be incomplete: GitHub API rate limits were hit during search. ` +
        `Found ${allCandidates.length} candidate${allCandidates.length === 1 ? '' : 's'} but some search phases failed. ` +
        `Try again after the rate limit resets for complete results.`;
    }

    // Sort by priority first, then by recommendation, then by viability score
    allCandidates.sort((a, b) => {
      // Priority order: merged_pr > starred > normal
      const priorityOrder: Record<SearchPriority, number> = { merged_pr: 0, starred: 1, normal: 2 };
      const priorityDiff = priorityOrder[a.searchPriority] - priorityOrder[b.searchPriority];
      if (priorityDiff !== 0) return priorityDiff;

      // Then by recommendation
      const recommendationOrder = { approve: 0, needs_review: 1, skip: 2 };
      const recDiff = recommendationOrder[a.recommendation] - recommendationOrder[b.recommendation];
      if (recDiff !== 0) return recDiff;

      // Then by viability score (highest first)
      return b.viabilityScore - a.viabilityScore;
    });

    // Apply per-repo cap: max 2 issues from any single repo (#105)
    const capped = applyPerRepoCap(allCandidates, 2);

    return capped.slice(0, maxResults);
  }

  /** Check if an error is a GitHub rate limit error (429 or rate-limit 403). */
  private static isRateLimitError(error: unknown): boolean {
    const status = (error as { status?: number })?.status;
    if (status === 429) return true;
    if (status === 403) {
      const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      return msg.includes('rate limit');
    }
    return false;
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
    filterFn: (items: GitHubSearchItem[]) => GitHubSearchItem[],
  ): Promise<{ candidates: IssueCandidate[]; allBatchesFailed: boolean; rateLimitHit: boolean }> {
    const candidates: IssueCandidate[] = [];

    // Batch repos to reduce API calls.
    // GitHub search query has a max length (~256 chars for query part).
    // Each "repo:owner/repo" is ~20-40 chars, plus " OR " (4 chars).
    // Using 5 repos per batch stays well under the limit.
    const BATCH_SIZE = 5;
    const batches = this.batchRepos(repos, BATCH_SIZE);
    let failedBatches = 0;
    let rateLimitFailures = 0;

    for (const batch of batches) {
      if (candidates.length >= maxResults) break;

      try {
        // Build repo filter: (repo:a OR repo:b OR repo:c)
        const repoFilter = batch.map((r) => `repo:${r}`).join(' OR ');
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
          const { candidates: vetted } = await this.vetIssuesParallel(
            filtered.slice(0, remainingNeeded * 2).map((i) => i.html_url),
            remainingNeeded,
            priority,
          );
          candidates.push(...vetted);
        }
      } catch (error) {
        failedBatches++;
        if (IssueDiscovery.isRateLimitError(error)) {
          rateLimitFailures++;
        }
        const batchRepos = batch.join(', ');
        console.error(
          `Error searching issues in batch [${batchRepos}]:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    const allBatchesFailed = failedBatches === batches.length && batches.length > 0;
    const rateLimitHit = rateLimitFailures > 0;
    if (allBatchesFailed) {
      console.error(
        `[SEARCH_PHASE_ALL_BATCHES_FAILED] All ${batches.length} batch(es) failed for ${priority} phase. ` +
          `This may indicate a systemic issue (rate limit, auth, network).`,
      );
    }

    return { candidates, allBatchesFailed, rateLimitHit };
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
    priority?: SearchPriority,
  ): Promise<{ candidates: IssueCandidate[]; allFailed: boolean; rateLimitHit: boolean }> {
    const candidates: IssueCandidate[] = [];
    const pending: Promise<void>[] = [];
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
          if (IssueDiscovery.isRateLimitError(error)) {
            rateLimitFailures++;
          }
          console.error(`Error vetting issue ${url}:`, error instanceof Error ? error.message : error);
        });

      pending.push(task);

      // Limit concurrency
      if (pending.length >= MAX_CONCURRENT_REQUESTS) {
        // Wait for at least one to complete, then remove it
        const completed = await Promise.race(pending.map((p, i) => p.then(() => i)));
        pending.splice(completed, 1);
      }
    }

    // Wait for remaining
    await Promise.allSettled(pending);

    const allFailed = failedVettingCount === attemptedCount && attemptedCount > 0;
    if (allFailed) {
      console.error(
        `[VET_ISSUES_ALL_FAILED] All ${attemptedCount} issue(s) failed vetting. ` +
          `This may indicate a systemic issue (rate limit, auth, network).`,
      );
    }

    return { candidates: candidates.slice(0, maxResults), allFailed, rateLimitHit: rateLimitFailures > 0 };
  }

  /**
   * Vet a specific issue
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
    const [existingPRCheck, claimCheck, projectHealth, contributionGuidelines] = await Promise.all([
      this.checkNoExistingPR(owner, repo, number),
      this.checkNotClaimed(owner, repo, number, ghIssue.comments),
      this.checkProjectHealth(owner, repo),
      this.fetchContributionGuidelines(owner, repo),
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

    // Check if it's a trusted project (via repoScores or legacy trustedProjects list)
    const config = this.stateManager.getState().config;
    const repoScoreRecord = this.stateManager.getRepoScore(repoFullName);
    if (repoScoreRecord && repoScoreRecord.mergedPRCount > 0) {
      reasonsToApprove.push(
        `Trusted project (${repoScoreRecord.mergedPRCount} PR${repoScoreRecord.mergedPRCount > 1 ? 's' : ''} merged)`,
      );
    } else if (config.trustedProjects.includes(repoFullName)) {
      reasonsToApprove.push('Trusted project (previous PR merged)');
    }

    // Check for closed/rejected PR history in this repo
    if (repoScoreRecord) {
      if (repoScoreRecord.closedWithoutMergeCount > 0 && repoScoreRecord.mergedPRCount === 0) {
        reasonsToSkip.push('User has rejected PR(s) in this repo with no successful merges');
      } else if (repoScoreRecord.closedWithoutMergeCount > 0 && repoScoreRecord.mergedPRCount > 0) {
        vettingResult.notes.push(
          `Mixed history: ${repoScoreRecord.mergedPRCount} merged, ${repoScoreRecord.closedWithoutMergeCount} closed without merge`,
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

    // Calculate viability score
    const viabilityScore = this.calculateViabilityScore({
      repoScore: this.getRepoScore(repoFullName),
      hasExistingPR: !noExistingPR,
      isClaimed: !notClaimed,
      clearRequirements,
      hasContributionGuidelines: !!contributionGuidelines,
      issueUpdatedAt: ghIssue.updated_at,
      closedWithoutMergeCount: repoScoreRecord?.closedWithoutMergeCount ?? 0,
      mergedPRCount: repoScoreRecord?.mergedPRCount ?? 0,
      orgHasMergedPRs,
      repoQualityBonus,
    });

    // Determine search priority
    const starredRepos = this.stateManager.getStarredRepos();
    let searchPriority: SearchPriority = 'normal';
    if (repoScoreRecord && repoScoreRecord.mergedPRCount > 0) {
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

  private async checkNoExistingPR(owner: string, repo: string, issueNumber: number): Promise<CheckResult> {
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(
        `[CHECK_NO_EXISTING_PR] Failed to check for existing PRs on ${owner}/${repo}#${issueNumber}: ${errorMessage}. Assuming no existing PR.`,
      );
      return { passed: true, inconclusive: true, reason: errorMessage };
    }
  }

  private async checkNotClaimed(
    owner: string,
    repo: string,
    issueNumber: number,
    commentCount: number,
  ): Promise<CheckResult> {
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(
        `[CHECK_NOT_CLAIMED] Failed to check claim status on ${owner}/${repo}#${issueNumber}: ${errorMessage}. Assuming not claimed.`,
      );
      return { passed: true, inconclusive: true, reason: errorMessage };
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
        console.warn(
          `[CHECK_CI_STATUS] Failed to check CI status for ${owner}/${repo}: ${errorMessage}. Defaulting to unknown.`,
        );
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

  private async fetchContributionGuidelines(owner: string, repo: string): Promise<ContributionGuidelines | undefined> {
    const cacheKey = `${owner}/${repo}`;

    // Check cache first
    const cached = guidelinesCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.guidelines;
    }

    const filesToCheck = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', 'contributing.md'];

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
   * - +repoQualityBonus (up to +12 for established repos, from star/fork counts) (#98)
   * - +15 for merged PR in this repo (direct proven relationship) (#99)
   * - +15 for clear requirements (clarity)
   * - +15 for freshness (recently updated)
   * - +10 for contribution guidelines
   * - +5 for org affinity (merged PRs in same org)
   * - -30 if existing PR
   * - -20 if claimed
   * - -15 if closed-without-merge history with no merges
   */
  calculateViabilityScore(params: {
    repoScore: number | null;
    hasExistingPR: boolean;
    isClaimed: boolean;
    clearRequirements: boolean;
    hasContributionGuidelines: boolean;
    issueUpdatedAt: string;
    closedWithoutMergeCount: number;
    mergedPRCount: number;
    orgHasMergedPRs: boolean;
    repoQualityBonus?: number;
  }): number {
    let score = 50; // Base score

    // Add repo score contribution (up to +20)
    if (params.repoScore !== null) {
      score += params.repoScore * 2;
    }

    // Repo quality bonus from star/fork counts (#98, up to +12)
    score += params.repoQualityBonus ?? 0;

    // Merged PR bonus (+15) — direct proven relationship with this repo (#99)
    if (params.mergedPRCount > 0) {
      score += 15;
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

    // Org affinity bonus (+5) — user has merged PRs in another repo under same org
    if (params.orgHasMergedPRs) {
      score += 5;
    }

    // Penalty for existing PR (-30)
    if (params.hasExistingPR) {
      score -= 30;
    }

    // Penalty for claimed issue (-20)
    if (params.isClaimed) {
      score -= 20;
    }

    // Penalty for closed-without-merge history with no successful merges (-15)
    if (params.closedWithoutMergeCount > 0 && params.mergedPRCount === 0) {
      score -= 15;
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
- Last commit: ${projectHealth.checkFailed ? 'unknown (API error)' : `${projectHealth.daysSinceLastCommit} days ago`}
- Open issues: ${projectHealth.openIssuesCount}
- CI status: ${projectHealth.ciStatus}

### Recommendation: **${recommendation.toUpperCase()}**
${reasonsToApprove.length > 0 ? `\n**Reasons to approve:**\n${reasonsToApprove.map((r) => `- ${r}`).join('\n')}` : ''}
${reasonsToSkip.length > 0 ? `\n**Reasons to skip:**\n${reasonsToSkip.map((r) => `- ${r}`).join('\n')}` : ''}
${vettingResult.notes.length > 0 ? `\n**Notes:**\n${vettingResult.notes.map((n) => `- ${n}`).join('\n')}` : ''}
`;
  }
}
