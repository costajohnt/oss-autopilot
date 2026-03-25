/**
 * Issue Eligibility — checks whether an individual issue is claimable:
 * existing PR detection, claim-phrase scanning, user merge history,
 * and requirement clarity analysis.
 *
 * Extracted from issue-vetting.ts (#621) to isolate eligibility logic.
 */

import { Octokit } from '@octokit/rest';
import { paginateAll } from './pagination.js';
import { errorMessage } from './errors.js';
import { warn } from './logger.js';
import { getHttpCache } from './http-cache.js';
import { getSearchBudgetTracker } from './search-budget.js';

const MODULE = 'issue-eligibility';

/** Result of a vetting check that may be inconclusive due to API errors. */
export interface CheckResult {
  passed: boolean;
  inconclusive?: boolean;
  reason?: string;
}

/** Phrases that indicate someone has already claimed an issue. */
const CLAIM_PHRASES = [
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
] as const;

/**
 * Check whether an open PR already exists for the given issue.
 * Uses the timeline API (REST) to detect cross-referenced PRs, avoiding
 * the Search API's strict 30 req/min rate limit.
 */
export async function checkNoExistingPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<CheckResult> {
  try {
    // Use the timeline API (REST, not Search) to detect linked PRs.
    // This avoids consuming GitHub Search API quota (30 req/min limit).
    // Timeline captures formally linked PRs via cross-referenced events
    // but may miss PRs that only mention the issue number without a formal
    // link — an acceptable trade-off since most PRs use "Fixes #N" syntax.
    const timeline = await paginateAll((page) =>
      octokit.issues.listEventsForTimeline({
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

    return { passed: linkedPRs.length === 0 };
  } catch (error) {
    const errMsg = errorMessage(error);
    warn(
      MODULE,
      `Failed to check for existing PRs on ${owner}/${repo}#${issueNumber}: ${errMsg}. Assuming no existing PR.`,
    );
    return { passed: true, inconclusive: true, reason: errMsg };
  }
}

/** TTL for cached merged-PR counts per repo (15 minutes). */
const MERGED_PR_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Check how many merged PRs the authenticated user has in a repo.
 * Uses GitHub Search API. Returns 0 on error (non-fatal).
 * Results are cached per-repo for 15 minutes to avoid redundant Search API
 * calls when multiple issues from the same repo are vetted.
 */
export async function checkUserMergedPRsInRepo(octokit: Octokit, owner: string, repo: string): Promise<number> {
  const cache = getHttpCache();
  const cacheKey = `merged-prs:${owner}/${repo}`;

  // Manual cache check — do not use cachedTimeBased because we must NOT cache
  // error-path fallback values (a transient failure returning 0 would poison the
  // cache for 15 minutes, hiding that the user has merged PRs in the repo).
  const cached = cache.getIfFresh(cacheKey, MERGED_PR_CACHE_TTL_MS);
  if (cached != null && typeof cached === 'number') {
    return cached;
  }

  try {
    const tracker = getSearchBudgetTracker();
    await tracker.waitForBudget();
    try {
      // Use @me to search as the authenticated user
      const { data } = await octokit.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:pr is:merged author:@me`,
        per_page: 1, // We only need total_count
      });
      // Only cache successful results
      cache.set(cacheKey, '', data.total_count);
      return data.total_count;
    } finally {
      // Always record the call — failed requests still consume GitHub rate limit points
      tracker.recordCall();
    }
  } catch (error) {
    const errMsg = errorMessage(error);
    warn(MODULE, `Could not check merged PRs in ${owner}/${repo}: ${errMsg}. Defaulting to 0.`);
    return 0; // Not cached — next call will retry
  }
}

/**
 * Check whether an issue has been claimed by another contributor
 * by scanning recent comments for claim phrases.
 */
export async function checkNotClaimed(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  commentCount: number,
): Promise<CheckResult> {
  if (commentCount === 0) return { passed: true };

  try {
    // Paginate through all comments
    const comments = await octokit.paginate(
      octokit.issues.listComments,
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

    for (const comment of recentComments) {
      const body = (comment.body || '').toLowerCase();
      if (CLAIM_PHRASES.some((phrase) => body.includes(phrase))) {
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

/**
 * Analyze whether an issue body has clear, actionable requirements.
 * Returns true when at least two "clarity indicators" are present:
 * numbered/bulleted steps, code blocks, expected-behavior keywords, length > 200.
 */
export function analyzeRequirements(body: string): boolean {
  if (!body || body.length < 50) return false;

  // Check for clear structure
  const hasSteps = /\d\.|[-*]\s/.test(body);
  const hasCodeBlock = /```/.test(body);
  const hasExpectedBehavior = /expect|should|must|want/i.test(body);

  // Must have at least two indicators of clarity
  const indicators = [hasSteps, hasCodeBlock, hasExpectedBehavior, body.length > 200];
  return indicators.filter(Boolean).length >= 2;
}
