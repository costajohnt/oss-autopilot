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

const MODULE = 'issue-eligibility';

/** Result of a vetting check that may be inconclusive due to API errors. */
export interface CheckResult {
  passed: boolean;
  inconclusive?: boolean;
  reason?: string;
}

/** Phrases that indicate someone has already claimed an issue. */
export const CLAIM_PHRASES = [
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
 * Searches both the PR search index and the issue timeline for linked PRs.
 */
export async function checkNoExistingPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<CheckResult> {
  try {
    // Search for PRs that mention this issue
    const { data } = await octokit.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} is:pr ${issueNumber}`,
      per_page: 5,
    });

    // Also check timeline for linked PRs
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
export async function checkUserMergedPRsInRepo(octokit: Octokit, owner: string, repo: string): Promise<number> {
  try {
    // Use @me to search as the authenticated user
    const { data } = await octokit.search.issuesAndPullRequests({
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
    // Paginate through all comments (up to 100)
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
