/**
 * Issue Discovery — orchestrates multi-phase issue search across GitHub.
 *
 * Delegates filtering, scoring, vetting, and search infrastructure to focused modules (#356, #621):
 * - issue-filtering.ts  — spam detection, doc-only filtering, per-repo caps
 * - issue-scoring.ts   — viability scores, repo quality bonuses
 * - issue-vetting.ts   — vetting orchestration, recommendation + viability scoring
 * - issue-eligibility.ts — PR existence, claim detection, requirements analysis
 * - repo-health.ts     — project health checks, contribution guidelines
 * - search-phases.ts   — search helpers, caching, batched repo search
 */

import * as fs from 'fs';
import * as path from 'path';
import { Octokit } from '@octokit/rest';
import { getOctokit, checkRateLimit } from './github.js';
import { getStateManager } from './state.js';
import { daysBetween, getDataDir } from './utils.js';
import { DEFAULT_CONFIG, type SearchPriority, type IssueCandidate, SCOPE_LABELS } from './types.js';
import { ValidationError, errorMessage, getHttpStatusCode, isRateLimitError } from './errors.js';
import { debug, info, warn } from './logger.js';
import { type GitHubSearchItem, isDocOnlyIssue, applyPerRepoCap } from './issue-filtering.js';
import { IssueVetter } from './issue-vetting.js';
import { getTopicsForCategories } from './category-mapping.js';
import {
  buildLabelQuery,
  buildEffectiveLabels,
  interleaveArrays,
  cachedSearchIssues,
  filterVetAndScore,
  searchInRepos,
} from './search-phases.js';

const MODULE = 'issue-discovery';

/**
 * Multi-phase issue discovery engine that searches GitHub for contributable issues.
 *
 * Search phases (in priority order):
 * 1. Repos where user has merged PRs (highest merge probability)
 * 2. Preferred organizations
 * 3. Starred repos
 * 4. General label-filtered search
 * 5. Actively maintained repos
 *
 * Each candidate is vetted for claimability and scored 0-100 for viability.
 */
export class IssueDiscovery {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;
  private githubToken: string;
  private vetter: IssueVetter;

  /** Set after searchIssues() runs if rate limits affected the search (low pre-flight quota or mid-search rate limit hits). */
  rateLimitWarning: string | null = null;

  /** @param githubToken - GitHub personal access token or token from `gh auth token` */
  constructor(githubToken: string) {
    this.githubToken = githubToken;
    this.octokit = getOctokit(githubToken);
    this.stateManager = getStateManager();
    this.vetter = new IssueVetter(this.octokit, this.stateManager);
  }

  /**
   * Fetch the authenticated user's starred repositories from GitHub.
   * Updates the state manager with the list and timestamp.
   * @returns Array of starred repo names in "owner/repo" format
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
   * Get starred repos, fetching from GitHub if cache is stale.
   * @returns Array of starred repo names in "owner/repo" format
   */
  async getStarredReposWithRefresh(): Promise<string[]> {
    if (this.stateManager.isStarredReposStale()) {
      return this.fetchStarredRepos();
    }
    return this.stateManager.getStarredRepos();
  }

  /**
   * Search for issues matching our criteria.
   * Searches in priority order: merged-PR repos first (no label filter), then starred repos,
   * then general search, then actively maintained repos.
   * Filters out issues from low-scoring and excluded repos.
   *
   * @param options - Search configuration
   * @param options.languages - Programming languages to filter by
   * @param options.labels - Issue labels to search for
   * @param options.maxResults - Maximum candidates to return (default: 10)
   * @returns Scored and sorted issue candidates
   * @throws {ValidationError} If no candidates found and no rate limits prevented the search
   *
   * @example
   * ```typescript
   * import { IssueDiscovery, requireGitHubToken } from '@oss-autopilot/core';
   *
   * const discovery = new IssueDiscovery(requireGitHubToken());
   * const candidates = await discovery.searchIssues({ maxResults: 5 });
   * for (const c of candidates) {
   *   console.log(`${c.issue.repo}#${c.issue.number}: ${c.viabilityScore}/100`);
   * }
   * ```
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
    const scopes = config.scope; // undefined = legacy mode
    const labels = options.labels || (scopes ? buildEffectiveLabels(scopes, config.labels) : config.labels);
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
    const labelQuery = buildLabelQuery(labels);
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
          } = await searchInRepos(
            this.octokit,
            this.vetter,
            mergedPhase0Repos,
            establishedQuery,
            remainingNeeded,
            'merged_pr',
            filterIssues,
          );
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
          } = await searchInRepos(
            this.octokit,
            this.vetter,
            openPhase0Repos,
            establishedQuery,
            remainingNeeded,
            'starred',
            filterIssues,
          );
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
          const data = await cachedSearchIssues(this.octokit, {
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
          } = await searchInRepos(
            this.octokit,
            this.vetter,
            reposToSearch.slice(0, 10),
            baseQuery,
            remainingNeeded,
            'starred',
            filterIssues,
          );
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
    // When multiple scope tiers are active, fire one query per tier and interleave
    // results to prevent high-volume tiers (e.g., "enhancement") from drowning out
    // beginner results.
    let phase2Error: string | null = null;
    if (allCandidates.length < maxResults) {
      info(MODULE, 'Phase 2: General issue search...');
      const remainingNeeded = maxResults - allCandidates.length;
      const seenRepos = new Set(allCandidates.map((c) => c.issue.repo));

      // Build per-tier label groups. Multi-tier when 2+ scopes; single-tier otherwise.
      const tierLabelGroups: { tier: string; tierLabels: string[] }[] = [];
      if (scopes && scopes.length > 1) {
        for (const scope of scopes) {
          const scopeLabels = SCOPE_LABELS[scope] ?? [];
          if (scopeLabels.length === 0) {
            warn(MODULE, `Scope "${scope}" has no labels, skipping tier`);
            continue;
          }
          tierLabelGroups.push({ tier: scope, tierLabels: scopeLabels });
        }
        // Custom labels not in any tier get their own pseudo-tier
        const allScopeLabels = new Set(scopes.flatMap((s) => SCOPE_LABELS[s] ?? []));
        const customOnly = config.labels.filter((l) => !allScopeLabels.has(l));
        if (customOnly.length > 0) {
          tierLabelGroups.push({ tier: 'custom', tierLabels: customOnly });
        }
      } else {
        tierLabelGroups.push({ tier: 'general', tierLabels: labels });
      }

      const budgetPerTier = Math.ceil(remainingNeeded / tierLabelGroups.length);
      const tierResults: IssueCandidate[][] = [];

      for (const { tier, tierLabels } of tierLabelGroups) {
        const tierQuery = `is:issue is:open ${buildLabelQuery(tierLabels)} ${langQuery} no:assignee`
          .replace(/  +/g, ' ')
          .trim();

        try {
          const data = await cachedSearchIssues(this.octokit, {
            q: tierQuery,
            sort: 'created',
            order: 'desc',
            per_page: budgetPerTier * 3,
          });

          info(MODULE, `Phase 2 [${tier}]: ${data.total_count} total, processing top ${data.items.length}...`);

          const {
            candidates: tierCandidates,
            allVetFailed,
            rateLimitHit: vetRateLimitHit,
          } = await filterVetAndScore(
            this.vetter,
            data.items,
            filterIssues,
            [phase0RepoSet, starredRepoSet, seenRepos],
            budgetPerTier,
            minStars,
            `Phase 2 [${tier}]`,
          );

          tierResults.push(tierCandidates);
          // Update seenRepos so later tiers don't return duplicate repos
          for (const c of tierCandidates) seenRepos.add(c.issue.repo);
          if (allVetFailed) {
            phase2Error = (phase2Error ? phase2Error + '; ' : '') + `${tier}: all vetting failed`;
          }
          if (vetRateLimitHit) {
            rateLimitHitDuringSearch = true;
          }
          info(MODULE, `Found ${tierCandidates.length} candidates from ${tier} tier`);
        } catch (error) {
          if (getHttpStatusCode(error) === 401) throw error;
          const errMsg = errorMessage(error);
          phase2Error = (phase2Error ? phase2Error + '; ' : '') + `${tier}: ${errMsg}`;
          if (isRateLimitError(error)) {
            rateLimitHitDuringSearch = true;
          }
          warn(MODULE, `Error in ${tier} tier search: ${errMsg}`);
          tierResults.push([]);
        }
      }

      const interleaved = interleaveArrays(tierResults);
      if (interleaved.length === 0 && phase2Error) {
        warn(MODULE, `All ${tierLabelGroups.length} scope tiers failed in Phase 2: ${phase2Error}`);
      }
      allCandidates.push(...interleaved.slice(0, remainingNeeded));
    }

    // Phase 3: Actively maintained repos (#349)
    let phase3Error: string | null = null;
    if (allCandidates.length < maxResults) {
      info(MODULE, 'Phase 3: Searching actively maintained repos...');
      const remainingNeeded = maxResults - allCandidates.length;
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const pushedSince = thirtyDaysAgo.toISOString().split('T')[0];
      const categoryTopics = getTopicsForCategories(config.projectCategories ?? []);
      const topicQuery = categoryTopics.length > 0 ? `topic:${categoryTopics[0]}` : '';
      const phase3Query =
        `is:issue is:open no:assignee ${langQuery} ${topicQuery} stars:>=${minStars} pushed:>=${pushedSince} archived:false`
          .replace(/  +/g, ' ')
          .trim();

      try {
        const data = await cachedSearchIssues(this.octokit, {
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
        } = await filterVetAndScore(
          this.vetter,
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
    if (rateLimitHitDuringSearch) {
      this.rateLimitWarning =
        `Search results may be incomplete: GitHub API rate limits were hit during search. ` +
        `Found ${allCandidates.length} candidate${allCandidates.length === 1 ? '' : 's'} but some search phases failed. ` +
        `Try again after the rate limit resets for complete results.`;
    }

    // Sort by priority first, then by recommendation, then by viability score
    allCandidates.sort((a, b) => {
      const priorityOrder: Record<SearchPriority, number> = { merged_pr: 0, preferred_org: 1, starred: 2, normal: 3 };
      const priorityDiff = priorityOrder[a.searchPriority] - priorityOrder[b.searchPriority];
      if (priorityDiff !== 0) return priorityDiff;

      const recommendationOrder = { approve: 0, needs_review: 1, skip: 2 };
      const recDiff = recommendationOrder[a.recommendation] - recommendationOrder[b.recommendation];
      if (recDiff !== 0) return recDiff;

      return b.viabilityScore - a.viabilityScore;
    });

    // Apply per-repo cap: max 2 issues from any single repo (#105)
    const capped = applyPerRepoCap(allCandidates, 2);

    return capped.slice(0, maxResults);
  }

  /**
   * Vet a specific issue for claimability and project health.
   * @param issueUrl - Full GitHub issue URL
   * @returns The vetted issue candidate with recommendation and scores
   * @throws {ValidationError} If the URL is invalid or the issue cannot be fetched
   */
  async vetIssue(issueUrl: string): Promise<IssueCandidate> {
    return this.vetter.vetIssue(issueUrl);
  }

  /**
   * Save search results to ~/.oss-autopilot/found-issues.md.
   * Results are sorted by viability score (highest first).
   * @param candidates - Issue candidates to save
   * @returns Absolute path to the written file
   */
  saveSearchResults(candidates: IssueCandidate[]): string {
    // Sort by viability score descending
    const sorted = [...candidates].sort((a, b) => b.viabilityScore - a.viabilityScore);

    const outputDir = getDataDir();
    const outputFile = path.join(outputDir, 'found-issues.md');

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
   * Format issue candidate as a markdown display string.
   * @param candidate - The issue candidate to format
   * @returns Multi-line markdown string with vetting details
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
