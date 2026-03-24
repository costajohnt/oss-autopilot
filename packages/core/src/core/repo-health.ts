/**
 * Repo Health — project health checks and contribution guidelines fetching.
 *
 * Extracted from issue-vetting.ts (#621) to isolate repo-level checks
 * from issue-level eligibility logic.
 */

import { Octokit } from '@octokit/rest';
import { daysBetween } from './utils.js';
import { type ContributionGuidelines, type ProjectHealth } from './types.js';
import { errorMessage } from './errors.js';
import { warn } from './logger.js';
import { getHttpCache, cachedRequest, cachedTimeBased } from './http-cache.js';

const MODULE = 'repo-health';

// ── Cache for contribution guidelines ──

const guidelinesCache = new Map<string, { guidelines: ContributionGuidelines | undefined; fetchedAt: number }>();

/** TTL for cached contribution guidelines (1 hour). */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** TTL for cached project health results (4 hours). Health data (stars, commits, CI) changes slowly. */
const HEALTH_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

/** Max entries in the guidelines cache before pruning. */
const CACHE_MAX_SIZE = 100;

/** Remove expired and excess entries from the guidelines cache. */
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

// ── Project health ──

/**
 * Check the health of a GitHub project: recent commits, CI status, star/fork counts.
 * Results are cached for HEALTH_CACHE_TTL_MS (4 hours).
 */
export async function checkProjectHealth(octokit: Octokit, owner: string, repo: string): Promise<ProjectHealth> {
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
          octokit.repos.get({ owner, repo, headers }) as Promise<{
            data: {
              open_issues_count: number;
              pushed_at: string;
              stargazers_count: number;
              forks_count: number;
              language: string | null;
            };
            headers: Record<string, string>;
          }>,
      );

      // Get recent commits
      const { data: commits } = await octokit.repos.listCommits({
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
        const { data: workflows } = await octokit.actions.listRepoWorkflows({
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
        language: repoData.language,
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

// ── Contribution guidelines ──

/**
 * Fetch and parse CONTRIBUTING.md (or variants) from a GitHub repo.
 * Probes multiple paths in parallel: CONTRIBUTING.md, .github/CONTRIBUTING.md,
 * docs/CONTRIBUTING.md, contributing.md. Results are cached for CACHE_TTL_MS.
 */
export async function fetchContributionGuidelines(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<ContributionGuidelines | undefined> {
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
      octokit.repos.getContent({ owner, repo, path: file }).then(({ data }) => {
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
      const guidelines = parseContributionGuidelines(result.value);
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

/**
 * Parse the raw content of a CONTRIBUTING.md file to extract structured guidelines:
 * branch naming, commit format, test framework, linter, formatter, CLA requirement.
 */
export function parseContributionGuidelines(content: string): ContributionGuidelines {
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
