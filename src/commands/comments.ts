/**
 * Comments, Post, and Claim commands
 * Handles GitHub comment interactions
 */

import { getStateManager, getOctokit, parseGitHubUrl, formatRelativeTime } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

interface CommentsOptions {
  prUrl: string;
  showBots?: boolean;
  json?: boolean;
}

interface PostOptions {
  url: string;
  message?: string;
  stdin?: boolean;
  json?: boolean;
}

interface ClaimOptions {
  issueUrl: string;
  message?: string;
  json?: boolean;
}

export async function runComments(options: CommentsOptions): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (options.json) {
      outputJsonError('GITHUB_TOKEN environment variable is required');
    } else {
      console.error('Error: GITHUB_TOKEN environment variable is required');
      console.error('Set it with: export GITHUB_TOKEN=$(gh auth token)');
    }
    process.exit(1);
  }

  const stateManager = getStateManager();
  const octokit = getOctokit(token);

  // Parse PR URL
  const parsed = parseGitHubUrl(options.prUrl);
  if (!parsed || parsed.type !== 'pull') {
    if (options.json) {
      outputJsonError('Invalid PR URL format');
    } else {
      console.error('Invalid PR URL format');
    }
    process.exit(1);
  }

  const { owner, repo, number: pull_number } = parsed;

  // Get PR details
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });

  // Get review comments (inline code comments)
  const { data: reviewComments } = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number,
    per_page: 100,
  });

  // Get issue comments (general PR discussion)
  const { data: issueComments } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: pull_number,
    per_page: 100,
  });

  // Get reviews
  const { data: reviews } = await octokit.pulls.listReviews({
    owner,
    repo,
    pull_number,
    per_page: 100,
  });

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
    .filter(r => filterComment(r) && r.body && r.body.trim())
    .sort((a, b) => new Date(b.submitted_at || 0).getTime() - new Date(a.submitted_at || 0).getTime());

  if (options.json) {
    outputJson({
      pr: {
        title: pr.title,
        state: pr.state,
        mergeable: pr.mergeable,
        head: pr.head.ref,
        base: pr.base.ref,
        url: pr.html_url,
      },
      reviews: relevantReviews.map(r => ({
        user: r.user?.login,
        state: r.state,
        body: r.body,
        submittedAt: r.submitted_at,
      })),
      reviewComments: relevantReviewComments.map(c => ({
        user: c.user?.login,
        body: c.body,
        path: c.path,
        createdAt: c.created_at,
      })),
      issueComments: relevantIssueComments.map(c => ({
        user: c.user?.login,
        body: c.body,
        createdAt: c.created_at,
      })),
      summary: {
        reviewCount: relevantReviews.length,
        inlineCommentCount: relevantReviewComments.length,
        discussionCommentCount: relevantIssueComments.length,
      },
    });
    return;
  }

  // Text output
  if (!options.json) {
    console.log(`\n💬 Fetching comments for: ${options.prUrl}\n`);
  }

  console.log(`## ${pr.title}\n`);
  console.log(`**Status:** ${pr.state} | **Mergeable:** ${pr.mergeable ?? 'checking...'}`);
  console.log(`**Branch:** ${pr.head.ref} → ${pr.base.ref}`);
  console.log(`**URL:** ${pr.html_url}\n`);

  if (relevantReviews.length > 0) {
    console.log('### Reviews (newest first)\n');
    for (const review of relevantReviews) {
      const state = review.state === 'APPROVED' ? '✅' :
                    review.state === 'CHANGES_REQUESTED' ? '❌' : '💬';
      const time = review.submitted_at ? formatRelativeTime(review.submitted_at) : '';
      console.log(`${state} **@${review.user?.login}** (${review.state}) - ${time}`);
      if (review.body) {
        console.log(`> ${review.body.split('\n').join('\n> ')}\n`);
      }
    }
  }

  if (relevantReviewComments.length > 0) {
    console.log('### Inline Comments (newest first)\n');
    for (const comment of relevantReviewComments) {
      const time = formatRelativeTime(comment.created_at);
      console.log(`**@${comment.user?.login}** on \`${comment.path}\` - ${time}`);
      console.log(`> ${comment.body.split('\n').join('\n> ')}`);
      if (comment.diff_hunk) {
        console.log(`\`\`\`diff\n${comment.diff_hunk.slice(-500)}\n\`\`\``);
      }
      console.log('');
    }
  }

  if (relevantIssueComments.length > 0) {
    console.log('### Discussion (newest first)\n');
    for (const comment of relevantIssueComments) {
      const time = formatRelativeTime(comment.created_at);
      console.log(`**@${comment.user?.login}** - ${time}`);
      console.log(`> ${comment.body?.split('\n').join('\n> ')}\n`);
    }
  }

  if (relevantReviewComments.length === 0 &&
      relevantIssueComments.length === 0 &&
      relevantReviews.length === 0) {
    console.log('No comments from other users.\n');
  }

  console.log('---');
  console.log(`**Summary:** ${relevantReviews.length} reviews, ${relevantReviewComments.length} inline comments, ${relevantIssueComments.length} discussion comments`);
}

export async function runPost(options: PostOptions): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (options.json) {
      outputJsonError('GITHUB_TOKEN environment variable is required');
    } else {
      console.error('Error: GITHUB_TOKEN environment variable is required');
      console.error('Set it with: export GITHUB_TOKEN=$(gh auth token)');
    }
    process.exit(1);
  }

  let message = options.message;

  // Read from stdin if specified
  if (options.stdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    message = Buffer.concat(chunks).toString('utf-8').trim();
  }

  if (!message) {
    if (options.json) {
      outputJsonError('No message provided');
    } else {
      console.error('Error: No message provided');
    }
    process.exit(1);
  }

  // Parse URL
  const parsed = parseGitHubUrl(options.url);
  if (!parsed) {
    if (options.json) {
      outputJsonError('Invalid GitHub URL format');
    } else {
      console.error('Invalid GitHub URL format');
    }
    process.exit(1);
  }

  const { owner, repo, number } = parsed;
  const octokit = getOctokit(token);

  if (!options.json) {
    console.log('\n📝 Posting comment to:', options.url);
    console.log('---');
    console.log(message);
    console.log('---\n');
  }

  try {
    const { data: comment } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: message,
    });

    // Mark PR as read since we just responded
    const stateManager = getStateManager();
    if (stateManager.markPRAsRead(options.url)) {
      stateManager.save();
    }

    if (options.json) {
      outputJson({
        success: true,
        commentUrl: comment.html_url,
        url: options.url,
      });
    } else {
      console.log('✅ Comment posted successfully!');
      console.log(`   ${comment.html_url}`);
    }
  } catch (error) {
    if (options.json) {
      outputJsonError(error instanceof Error ? error.message : 'Unknown error');
    } else {
      console.error('❌ Failed to post comment:', error instanceof Error ? error.message : error);
    }
    process.exit(1);
  }
}

export async function runClaim(options: ClaimOptions): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (options.json) {
      outputJsonError('GITHUB_TOKEN environment variable is required');
    } else {
      console.error('Error: GITHUB_TOKEN environment variable is required');
      console.error('Set it with: export GITHUB_TOKEN=$(gh auth token)');
    }
    process.exit(1);
  }

  // Parse URL
  const parsed = parseGitHubUrl(options.issueUrl);
  if (!parsed || parsed.type !== 'issues') {
    if (options.json) {
      outputJsonError('Invalid issue URL format (must be an issue, not a PR)');
    } else {
      console.error('Invalid issue URL format (must be an issue, not a PR)');
    }
    process.exit(1);
  }

  const { owner, repo, number } = parsed;

  // Default claim message or custom
  const message = options.message ||
    "Hi! I'd like to work on this issue. Could you assign it to me?";

  if (!options.json) {
    console.log('\n🙋 Claiming issue:', options.issueUrl);
    console.log('---');
    console.log(message);
    console.log('---\n');
  }

  const octokit = getOctokit(token);

  try {
    const { data: comment } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: message,
    });

    // Add to tracked issues
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
    stateManager.save();

    if (options.json) {
      outputJson({
        success: true,
        commentUrl: comment.html_url,
        issueUrl: options.issueUrl,
      });
    } else {
      console.log('✅ Issue claimed!');
      console.log(`   ${comment.html_url}`);
    }
  } catch (error) {
    if (options.json) {
      outputJsonError(error instanceof Error ? error.message : 'Unknown error');
    } else {
      console.error('❌ Failed to claim issue:', error instanceof Error ? error.message : error);
    }
    process.exit(1);
  }
}
