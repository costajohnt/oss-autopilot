/**
 * Issue Discovery — orchestrates multi-phase issue search across GitHub.
 *
 * Delegates filtering, scoring, and vetting to focused modules (#356):
 * - issue-filtering.ts — spam detection, doc-only filtering, per-repo caps
 * - issue-scoring.ts  — viability scores, repo quality bonuses
 * - issue-vetting.ts  — individual issue checks (PRs, claims, health, guidelines)
 */

import * as fs from 'fs';
import * as path from 'path';
import { Octokit } from '@octokit/rest';
import { getOctokit, checkRateLimit } from './github.js';
import { getStateManager } from './state.js';
import { daysBetween, getDataDir } from './utils.js';
import { DEFAULT_CONFIG, type SearchPriority, type IssueCandidate } from './types.js';
import { ValidationError, errorMessage, getHttpStatusCode, isRateLimitError } from './errors.js';
import { debug, info, warn } from './logger.js';
import { getHttpCache, cachedTimeBased } from './http-cache.js';
import { type GitHubSearchItem, isDocOnlyIssue, detectLabelFarmingRepos, applyPerRepoCap } from './issue-filtering.js';
import { IssueVetter } from './issue-vetting.js';
import { calculateViabilityScore as calcViabilityScore, type ViabilityScoreParams } from './issue-scoring.js';
import { getTopicsForCategories } from './category-mapping.js';

// Re-export everything from sub-modules for backward compatibility.
// Existing consumers (tests, CLI commands) import from './issue-discovery.js'.
export {
  isDocOnlyIssue,
  applyPerRepoCap,
  isLabelFarming,
  hasTemplatedTitle,
  detectLabelFarmingRepos,
  DOC_ONLY_LABELS,
  BEGINNER_LABELS,
  type GitHubSearchItem,
} from './issue-filtering.js';
export { calculateRepoQualityBonus, calculateViabilityScore, type ViabilityScoreParams } from './issue-scoring.js';
export { type CheckResult } from './issue-vetting.js';
// Re-export types that were previously defined here
export type { SearchPriority, IssueCandidate } from './types.js';

const MODULE = 'issue-discovery';

/** TTL for cached search API results (15 minutes). */
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;

export class IssueDiscovery {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;
  private githubToken: string;
  private vetter: IssueVetter;

  /** Set after searchIssues() runs if rate limits affected the search (low pre-flight quota or mid-search rate limit hits). */
  rateLimitWarning: string | null = null;

  constructor(githubToken: string) {
    this.githubToken = githubToken;
    this.octokit = getOctokit(githubToken);
    this.stateManager = getStateManager();
    this.vetter = new IssueVetter(this.octokit, this.stateManager);
  }

  /**
   * Wrap octokit.search.issuesAndPullRequests with time-based caching.
   * Repeated identical queries within SEARCH_CACHE_TTL_MS return cached results
   * without consuming GitHub API rate limit points.
   */
  private async cachedSearch(params: {
    q: string;
    sort: 'created' | 'updated' | 'comments' | 'reactions' | 'interactions';
    order: 'asc' | 'desc';
    per_page: number;
  }): Promise<{ total_count: number; items: GitHubSearchItem[] }> {
    const cacheKey = `search:${params.q}:${params.sort}:${params.order}:${params.per_page}`;
    return cachedTimeBased(getHttpCache(), cacheKey, SEARCH_CACHE_TTL_MS, async () => {
      const { data } = await this.octokit.search.issuesAndPullRequests(params);
      return data;
    });
  }

  /**
   * Fetch the authenticated user's starred repositories from GitHub.
   * Updates the state manager with the list and timestamp.
   */
  async fetchStarredRepos(): Promise<string[]> {
    info(MODULE, 'Fetching starred repositories...');
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
          info(MODULE, 'Reached pagination limit for starred repos (500)');
          break;
        }
      }

      info(MODULE, `Fetched ${starredRepos.length} starred repositories`);
      this.stateManager.setStarredRepos(starredRepos);
      return starredRepos;
    } catch (error) {
      const cachedRepos = this.stateManager.getStarredRepos();
      const errMsg = errorMessage(error);
      warn(MODULE, 'Error fetching starred repos:', errMsg);

      if (cachedRepos.length === 0) {
        warn(
          MODULE,
          `Failed to fetch starred repositories from GitHub API. ` +
            `No cached repos available. Error: ${errMsg}\n` +
            `Tip: Ensure your GITHUB_TOKEN has the 'read:user' scope and try again.`,
        );
      } else {
        warn(
          MODULE,
          `Failed to fetch starred repositories from GitHub API. ` +
            `Using ${cachedRepos.length} cached repos instead. Error: ${errMsg}`,
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
   * Shared pipeline for Phases 2 and 3: spam-filter, repo-exclusion, vetting, and star-count filter.
   * Extracts the common logic so each phase only needs to supply search results and context.
   */
  private async filterVetAndScore(
    items: GitHubSearchItem[],
    filterIssues: (items: GitHubSearchItem[]) => GitHubSearchItem[],
    excludedRepoSets: Set<string>[],
    remainingNeeded: number,
    minStars: number,
    phaseLabel: string,
  ): Promise<{ candidates: IssueCandidate[]; allVetFailed: boolean; rateLimitHit: boolean }> {
    const spamRepos = detectLabelFarmingRepos(items);
    if (spamRepos.size > 0) {
      const spamCount = items.filter((i) => spamRepos.has(i.repository_url.split('/').slice(-2).join('/'))).length;
      debug(
        MODULE,
        `[SPAM_FILTER] Filtered ${spamCount} issues from ${spamRepos.size} label-farming repos: ${[...spamRepos].join(', ')}`,
      );
    }

    const itemsToVet = filterIssues(items)
      .filter((item) => {
        const repoFullName = item.repository_url.split('/').slice(-2).join('/');
        if (spamRepos.has(repoFullName)) return false;
        return excludedRepoSets.every((s) => !s.has(repoFullName));
      })
      .slice(0, remainingNeeded * 2);

    if (itemsToVet.length === 0) {
      debug(MODULE, `[${phaseLabel}] All ${items.length} items filtered before vetting`);
      return { candidates: [], allVetFailed: false, rateLimitHit: false };
    }

    const {
      candidates: results,
      allFailed: allVetFailed,
      rateLimitHit,
    } = await this.vetter.vetIssuesParallel(
      itemsToVet.map((i) => i.html_url),
      remainingNeeded,
      'normal',
    );

    const starFiltered = results.filter((c) => {
      if (c.projectHealth.checkFailed) return true;
      const stars = c.projectHealth.stargazersCount ?? 0;
      return stars >= minStars;
    });
    const starFilteredCount = results.length - starFiltered.length;
    if (starFilteredCount > 0) {
      debug(MODULE, `[STAR_FILTER] Filtered ${starFilteredCount} ${phaseLabel} candidates below ${minStars} stars`);
    }

    return { candidates: starFiltered, allVetFailed, rateLimitHit };
  }

  /**
   * Search for issues matching our criteria.
   * Searches in priority order: merged-PR repos first (no label filter), then starred repos,
   * then general search, then actively maintained repos (#349).
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
    const minStars = config.minStars ?? 50;

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
        warn(MODULE, this.rateLimitWarning);
      }
    } catch (error) {
      // Fail fast on auth errors — no point searching with a bad token
      if (getHttpStatusCode(error) === 401) {
        throw error;
      }
      // Non-fatal: proceed with search for transient/network errors
      warn(MODULE, 'Could not check rate limit:', errorMessage(error));
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
    // When languages includes 'any', omit the language filter entirely
    const isAnyLanguage = languages.some((l) => l.toLowerCase() === 'any');
    const langQuery = isAnyLanguage ? '' : languages.map((l) => `language:${l}`).join(' ');
    // Phase 0 uses a broader query — established contributors don't need beginner labels
    const establishedQuery = `is:issue is:open ${langQuery} no:assignee`.replace(/  +/g, ' ').trim();
    // Phases 1+ use label-filtered query for discovery in unfamiliar repos
    const baseQuery = `is:issue is:open ${labelQuery} ${langQuery} no:assignee`.replace(/  +/g, ' ').trim();

    // Helper to filter issues
    const includeDocIssues = config.includeDocIssues ?? true;
    const aiBlocklisted = new Set(config.aiPolicyBlocklist ?? DEFAULT_CONFIG.aiPolicyBlocklist ?? []);
    if (aiBlocklisted.size > 0) {
      debug(
        MODULE,
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
      info(
        MODULE,
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
          info(MODULE, `Found ${mergedCandidates.length} candidates from merged-PR repos`);
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
          info(MODULE, `Found ${openCandidates.length} candidates from open-PR repos`);
        }
      }
    }

    // Phase 0.5: Search preferred organizations (explicit user preference)
    let phase0_5Error: string | null = null;
    const preferredOrgs = config.preferredOrgs ?? [];
    if (allCandidates.length < maxResults && preferredOrgs.length > 0) {
      // Filter out orgs already covered by Phase 0 repos
      const phase0Orgs = new Set(phase0Repos.map((r) => r.split('/')[0]?.toLowerCase()));
      const orgsToSearch = preferredOrgs.filter((org) => !phase0Orgs.has(org.toLowerCase())).slice(0, 5);

      if (orgsToSearch.length > 0) {
        info(MODULE, `Phase 0.5: Searching issues in ${orgsToSearch.length} preferred org(s)...`);
        const remainingNeeded = maxResults - allCandidates.length;
        const orgRepoFilter = orgsToSearch.map((org) => `org:${org}`).join(' OR ');
        const orgQuery = `${baseQuery} (${orgRepoFilter})`;

        try {
          const data = await this.cachedSearch({
            q: orgQuery,
            sort: 'created',
            order: 'desc',
            per_page: remainingNeeded * 3,
          });

          if (data.items.length > 0) {
            const filtered = filterIssues(data.items).filter((item) => {
              const repoFullName = item.repository_url.split('/').slice(-2).join('/');
              return !phase0RepoSet.has(repoFullName);
            });
            const {
              candidates: orgCandidates,
              allFailed: allVetFailed,
              rateLimitHit,
            } = await this.vetter.vetIssuesParallel(
              filtered.slice(0, remainingNeeded * 2).map((i) => i.html_url),
              remainingNeeded,
              'preferred_org',
            );
            allCandidates.push(...orgCandidates);
            if (allVetFailed) {
              phase0_5Error = 'All preferred org issue vetting failed';
            }
            if (rateLimitHit) {
              rateLimitHitDuringSearch = true;
            }
            info(MODULE, `Found ${orgCandidates.length} candidates from preferred orgs`);
          }
        } catch (error) {
          const errMsg = errorMessage(error);
          phase0_5Error = errMsg;
          if (isRateLimitError(error)) {
            rateLimitHitDuringSearch = true;
          }
          warn(MODULE, `Error searching preferred orgs: ${errMsg}`);
        }
      }
    }

    // Phase 1: Search starred repos (filter out already-searched Phase 0 repos)
    if (allCandidates.length < maxResults && starredRepos.length > 0) {
      const reposToSearch = starredRepos.filter((r) => !phase0RepoSet.has(r));
      if (reposToSearch.length > 0) {
        info(MODULE, `Phase 1: Searching issues in ${reposToSearch.length} starred repos...`);
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
          info(MODULE, `Found ${starredCandidates.length} candidates from starred repos`);
        }
      }
    }

    // Phase 2: General search (if still need more)
    let phase2Error: string | null = null;
    if (allCandidates.length < maxResults) {
      info(MODULE, 'Phase 2: General issue search...');
      const remainingNeeded = maxResults - allCandidates.length;
      try {
        const data = await this.cachedSearch({
          q: baseQuery,
          sort: 'created',
          order: 'desc',
          per_page: remainingNeeded * 3, // Fetch extra since some will be filtered
        });

        info(MODULE, `Found ${data.total_count} issues in general search, processing top ${data.items.length}...`);

        const seenRepos = new Set(allCandidates.map((c) => c.issue.repo));
        const {
          candidates: starFiltered,
          allVetFailed,
          rateLimitHit: vetRateLimitHit,
        } = await this.filterVetAndScore(
          data.items,
          filterIssues,
          [phase0RepoSet, starredRepoSet, seenRepos],
          remainingNeeded,
          minStars,
          'Phase 2',
        );

        allCandidates.push(...starFiltered);
        if (allVetFailed) {
          phase2Error = (phase2Error ? phase2Error + '; ' : '') + 'all vetting failed';
        }
        if (vetRateLimitHit) {
          rateLimitHitDuringSearch = true;
        }
        info(MODULE, `Found ${starFiltered.length} candidates from general search`);
      } catch (error) {
        const errMsg = errorMessage(error);
        phase2Error = errMsg;
        if (isRateLimitError(error)) {
          rateLimitHitDuringSearch = true;
        }
        warn(MODULE, `Error in general issue search: ${errMsg}`);
      }
    }

    // Phase 3: Actively maintained repos (#349)
    // Searches the "long tail" of well-maintained repos (50+ stars, recently pushed,
    // not archived) that Phase 2 may miss because they aren't trending or pre-filtered.
    // Uses label-free query to cast a wider net focused on repo health.
    let phase3Error: string | null = null;
    if (allCandidates.length < maxResults) {
      info(MODULE, 'Phase 3: Searching actively maintained repos...');
      const remainingNeeded = maxResults - allCandidates.length;
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const pushedSince = thirtyDaysAgo.toISOString().split('T')[0];
      // When user has category preferences, add a single topic filter to focus on relevant repos.
      // GitHub Search API AND-joins multiple topic: qualifiers, which is overly restrictive,
      // so we pick just the first topic to nudge results without eliminating valid matches.
      const categoryTopics = getTopicsForCategories(config.projectCategories ?? []);
      const topicQuery = categoryTopics.length > 0 ? `topic:${categoryTopics[0]}` : '';
      const phase3Query =
        `is:issue is:open no:assignee ${langQuery} ${topicQuery} stars:>=${minStars} pushed:>=${pushedSince} archived:false`
          .replace(/  +/g, ' ')
          .trim();

      try {
        const data = await this.cachedSearch({
          q: phase3Query,
          sort: 'updated',
          order: 'desc',
          per_page: remainingNeeded * 3,
        });

        info(
          MODULE,
          `Found ${data.total_count} issues in maintained-repo search, processing top ${data.items.length}...`,
        );

        const seenRepos = new Set(allCandidates.map((c) => c.issue.repo));
        const {
          candidates: starFiltered,
          allVetFailed,
          rateLimitHit: vetRateLimitHit,
        } = await this.filterVetAndScore(
          data.items,
          filterIssues,
          [phase0RepoSet, starredRepoSet, seenRepos],
          remainingNeeded,
          minStars,
          'Phase 3',
        );

        allCandidates.push(...starFiltered);
        if (allVetFailed) {
          phase3Error = 'all vetting failed';
        }
        if (vetRateLimitHit) {
          rateLimitHitDuringSearch = true;
        }
        info(MODULE, `Found ${starFiltered.length} candidates from maintained-repo search`);
      } catch (error) {
        const errMsg = errorMessage(error);
        phase3Error = errMsg;
        if (isRateLimitError(error)) {
          rateLimitHitDuringSearch = true;
        }
        warn(MODULE, `Error in maintained-repo search: ${errMsg}`);
      }
    }

    if (allCandidates.length === 0) {
      const phaseErrors = [
        phase0Error ? `Phase 0 (merged-PR repos): ${phase0Error}` : null,
        phase0_5Error ? `Phase 0.5 (preferred orgs): ${phase0_5Error}` : null,
        phase1Error ? `Phase 1 (starred repos): ${phase1Error}` : null,
        phase2Error ? `Phase 2 (general): ${phase2Error}` : null,
        phase3Error ? `Phase 3 (maintained repos): ${phase3Error}` : null,
      ].filter(Boolean);
      const details = phaseErrors.length > 0 ? ` ${phaseErrors.join('. ')}.` : '';

      // When rate limits caused zero results, return empty array with warning
      // instead of throwing, so callers can handle it gracefully
      if (rateLimitHitDuringSearch) {
        this.rateLimitWarning =
          `Search returned no results due to GitHub API rate limits.${details} ` +
          `Try again after the rate limit resets.`;
        return [];
      }

      throw new ValidationError(
        `No issue candidates found across all search phases.${details} ` +
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
      // Priority order: merged_pr > preferred_org > starred > normal
      const priorityOrder: Record<SearchPriority, number> = { merged_pr: 0, preferred_org: 1, starred: 2, normal: 3 };
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

        const data = await this.cachedSearch({
          q: batchQuery,
          sort: 'created',
          order: 'desc',
          per_page: Math.min(30, (maxResults - candidates.length) * 3),
        });

        if (data.items.length > 0) {
          const filtered = filterFn(data.items);
          const remainingNeeded = maxResults - candidates.length;
          const { candidates: vetted } = await this.vetter.vetIssuesParallel(
            filtered.slice(0, remainingNeeded * 2).map((i) => i.html_url),
            remainingNeeded,
            priority,
          );
          candidates.push(...vetted);
        }
      } catch (error) {
        failedBatches++;
        if (isRateLimitError(error)) {
          rateLimitFailures++;
        }
        const batchRepos = batch.join(', ');
        warn(MODULE, `Error searching issues in batch [${batchRepos}]:`, errorMessage(error));
      }
    }

    const allBatchesFailed = failedBatches === batches.length && batches.length > 0;
    const rateLimitHit = rateLimitFailures > 0;
    if (allBatchesFailed) {
      warn(
        MODULE,
        `All ${batches.length} batch(es) failed for ${priority} phase. ` +
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
   * Vet a specific issue (delegates to IssueVetter).
   */
  async vetIssue(issueUrl: string): Promise<IssueCandidate> {
    return this.vetter.vetIssue(issueUrl);
  }

  /**
   * Analyze issue requirements for clarity (delegates to IssueVetter).
   * Kept on class for backward compatibility.
   */
  analyzeRequirements(body: string): boolean {
    return this.vetter.analyzeRequirements(body);
  }

  /**
   * Calculate viability score for an issue (delegates to issue-scoring module).
   * Kept on class for backward compatibility with tests that call instance.calculateViabilityScore().
   */
  calculateViabilityScore(params: ViabilityScoreParams): number {
    return calcViabilityScore(params);
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
    info(MODULE, `Saved ${sorted.length} issues to ${outputFile}`);

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
