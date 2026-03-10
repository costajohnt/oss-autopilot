/**
 * Comments, Post, and Claim commands
 * Handles GitHub comment interactions
 */

import { getStateManager, getOctokit, parseGitHubUrl, requireGitHubToken } from '../core/index.js';
import { paginateAll } from '../core/pagination.js';
import { type CommentsOutput, type PostOutput, type ClaimOutput } from '../formatters/json.js';
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

export async function runComments(options: CommentsOptions): Promise<CommentsOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const token = requireGitHubToken();

  const stateManager = getStateManager();
  const octokit = getOctokit(token);

  // Parse PR URL
  const parsed = parseGitHubUrl(options.prUrl);
  if (!parsed || parsed.type !== 'pull') {
    throw new Error('Invalid PR URL format');
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
  };
}

export async function runPost(options: PostOptions): Promise<PostOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_OR_PR_URL_PATTERN, 'issue or PR');

  if (!options.message.trim()) {
    throw new Error('No message provided');
  }

  validateMessage(options.message);

  const token = requireGitHubToken();

  // Parse URL
  const parsed = parseGitHubUrl(options.url);
  if (!parsed) {
    throw new Error('Invalid GitHub URL format');
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
    throw new Error('Invalid issue URL format (must be an issue, not a PR)');
  }

  const { owner, repo, number } = parsed;

  const octokit = getOctokit(token);

  const { data: comment } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: number,
    body: message,
  });

  // Add to tracked issues — non-fatal if state save fails (comment already posted)
  try {
    const stateManager = getStateManager();
    stateManager.addIssue({
      id: number,
      url: options.issueUrl,
      repo: `${owner}/${repo}`,
      number,
      title: '(claimed)',
      status: 'claimed',
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      vetted: false,
    });
  } catch (error) {
    console.error(
      `Warning: Comment posted on ${options.issueUrl} but failed to save to local state: ${error instanceof Error ? error.message : error}`,
    );
  }

  return {
    commentUrl: comment.html_url,
    issueUrl: options.issueUrl,
  };
}
