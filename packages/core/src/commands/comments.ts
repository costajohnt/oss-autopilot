/**
 * Comments, Post, and Claim commands
 * Handles GitHub comment interactions
 */

import { getStateManager, getOctokit, parseGitHubUrl, requireGitHubToken, maybeCheckpoint } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { warn } from '../core/logger.js';

const MODULE = 'comments';
import { paginateAll } from '../core/pagination.js';
import { type CommentsOutput, type PostOutput, type ClaimOutput } from '../formatters/json.js';
import { buildStalenessWarning } from '../formatters/json.js';
import {
  validateUrl,
  validateMessage,
  validateGitHubUrl,
  PR_URL_PATTERN,
  ISSUE_OR_PR_URL_PATTERN,
  ISSUE_URL_PATTERN,
} from './validation.js';

export { type CommentsOutput, type PostOutput, type ClaimOutput } from '../formatters/json.js';

interface CommentsOptions {
  prUrl: string;
  showBots?: boolean;
}

interface PostOptions {
  url: string;
  message: string;
}

interface ClaimOptions {
  issueUrl: string;
  message?: string;
}

/**
 * Fetch all comments, reviews, and inline review comments for a PR.
 * Filters out the user's own comments and optionally bot comments.
 *
 * @param options - Comment fetch options
 * @param options.prUrl - Full GitHub PR URL
 * @param options.showBots - Include bot comments (default: false)
 * @returns Categorized comments with review, inline, and discussion sections
 * @throws {ValidationError} If the URL is not a valid GitHub PR URL
 */
export async function runComments(options: CommentsOptions): Promise<CommentsOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const token = requireGitHubToken();

  const stateManager = getStateManager();
  const octokit = getOctokit(token);

  // Parse PR URL
  const parsed = parseGitHubUrl(options.prUrl);
  if (!parsed || parsed.type !== 'pull') {
    throw new ValidationError('Invalid PR URL format');
  }

  const { owner, repo, number: pull_number } = parsed;

  // Get PR details
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });

  // Fetch review comments, issue comments, and reviews in parallel
  const [reviewComments, issueComments, reviews] = await Promise.all([
    paginateAll((page) =>
      octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number,
        per_page: 100,
        page,
      }),
    ),
    paginateAll((page) =>
      octokit.issues.listComments({
        owner,
        repo,
        issue_number: pull_number,
        per_page: 100,
        page,
      }),
    ),
    paginateAll((page) =>
      octokit.pulls.listReviews({
        owner,
        repo,
        pull_number,
        per_page: 100,
        page,
      }),
    ),
  ]);

  // Filter out own comments, optionally show bots
  const username = stateManager.getState().config.githubUsername;

  const filterComment = (c: { user?: { login?: string; type?: string } | null }) => {
    if (!c.user) return false;
    if (c.user.login === username) return false;
    if (c.user.type === 'Bot' && !options.showBots) return false;
    return true;
  };

  const relevantReviewComments = reviewComments
    .filter(filterComment)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const relevantIssueComments = issueComments
    .filter(filterComment)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const relevantReviews = reviews
    .filter((r) => filterComment(r) && r.body && r.body.trim())
    .sort((a, b) => new Date(b.submitted_at || 0).getTime() - new Date(a.submitted_at || 0).getTime());

  const staleness = stateManager.getStateStaleness();
  return {
    pr: {
      title: pr.title,
      state: pr.state,
      mergeable: pr.mergeable,
      head: pr.head.ref,
      base: pr.base.ref,
      url: pr.html_url,
    },
    reviews: relevantReviews.map((r) => ({
      user: r.user?.login,
      state: r.state,
      body: r.body ?? null,
      submittedAt: r.submitted_at ?? null,
    })),
    reviewComments: relevantReviewComments.map((c) => ({
      user: c.user?.login,
      body: c.body,
      path: c.path,
      createdAt: c.created_at,
    })),
    issueComments: relevantIssueComments.map((c) => ({
      user: c.user?.login,
      body: c.body,
      createdAt: c.created_at,
    })),
    summary: {
      reviewCount: relevantReviews.length,
      inlineCommentCount: relevantReviewComments.length,
      discussionCommentCount: relevantIssueComments.length,
    },
    ...(staleness ? { warnings: [buildStalenessWarning(staleness)] } : {}),
  };
}

/**
 * Post a comment on a GitHub issue or PR.
 *
 * @param options - Post options
 * @param options.url - Full GitHub issue or PR URL
 * @param options.message - Comment body text
 * @returns Object with commentUrl (the new comment's URL) and url (the original issue/PR URL)
 * @throws {ValidationError} If the URL or message is invalid
 */
export async function runPost(options: PostOptions): Promise<PostOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_OR_PR_URL_PATTERN, 'issue or PR');

  if (!options.message.trim()) {
    throw new ValidationError('No message provided');
  }

  validateMessage(options.message);

  const token = requireGitHubToken();

  // Parse URL
  const parsed = parseGitHubUrl(options.url);
  if (!parsed) {
    throw new ValidationError('Invalid GitHub URL format');
  }

  const { owner, repo, number } = parsed;
  const octokit = getOctokit(token);

  const { data: comment } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: number,
    body: options.message,
  });

  return {
    commentUrl: comment.html_url,
    url: options.url,
  };
}

/**
 * Post a claim comment on a GitHub issue and track it locally.
 *
 * @param options - Claim options
 * @param options.issueUrl - Full GitHub issue URL
 * @param options.message - Custom claim message (default: standard claim text)
 * @returns URLs of the created comment and claimed issue
 * @throws {ValidationError} If the URL or message is invalid
 */
export async function runClaim(options: ClaimOptions): Promise<ClaimOutput> {
  validateUrl(options.issueUrl);
  validateGitHubUrl(options.issueUrl, ISSUE_URL_PATTERN, 'issue');

  const token = requireGitHubToken();

  // Default claim message or custom
  const message = options.message || "Hi! I'd like to work on this issue. Could you assign it to me?";

  validateMessage(message);

  // Parse URL
  const parsed = parseGitHubUrl(options.issueUrl);
  if (!parsed || parsed.type !== 'issues') {
    throw new ValidationError('Invalid issue URL format (must be an issue, not a PR)');
  }

  const { owner, repo, number } = parsed;

  const octokit = getOctokit(token);

  const { data: comment } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: number,
    body: message,
  });

  // Fetch the real issue title + labels so the tracked entry has useful metadata
  // rather than a permanent "(claimed)" placeholder that never gets backfilled
  // (#1056 M24). Best-effort: if the fetch fails, fall back to the placeholder
  // so state still records the claim.
  let issueTitle = '(claimed)';
  let issueLabels: string[] = [];
  let issueCreatedAt = new Date().toISOString();
  try {
    const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: number });
    if (issue.title) issueTitle = issue.title;
    issueLabels = (issue.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
      .filter((name): name is string => Boolean(name));
    if (issue.created_at) issueCreatedAt = issue.created_at;
  } catch (error) {
    warn(
      MODULE,
      `Claimed ${options.issueUrl} but failed to enrich issue metadata (title/labels): ${error instanceof Error ? error.message : error}`,
    );
  }

  // Add to tracked issues — non-fatal if state save fails (comment already posted)
  try {
    const stateManager = getStateManager();
    stateManager.addIssue({
      id: number,
      url: options.issueUrl,
      repo: `${owner}/${repo}`,
      number,
      title: issueTitle,
      status: 'claimed',
      labels: issueLabels,
      createdAt: issueCreatedAt,
      updatedAt: new Date().toISOString(),
      vetted: false,
    });
    // Push state to Gist if in Gist mode. Best-effort — logs on failure
    // rather than silently swallowing, so operators see the degraded-sync
    // signal (#1036 audit H1).
    await maybeCheckpoint(stateManager, MODULE);
  } catch (error) {
    // Structured warning instead of bare console.error so the breadcrumb shows
    // up in the plugin's log pipeline (#1056 M24).
    warn(
      MODULE,
      `Comment posted on ${options.issueUrl} but failed to save to local state: ${error instanceof Error ? error.message : error}`,
    );
  }

  return {
    commentUrl: comment.html_url,
    issueUrl: options.issueUrl,
  };
}
