/**
 * issue-thread command (#1932).
 *
 * The fenced way to read an issue: title, body and every comment come back
 * wrapped in `<github-content>` with author and author association. Raw
 * `gh issue view` output passes through no code in this repo, so an agent
 * told to read a thread with it reads stranger-written text unfenced. The
 * unattended implement mode (agents/overnight-preparer.md) reads threads
 * through this command instead.
 */

import { getOctokit, parseGitHubUrl, requireGitHubToken } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { paginateAllDetailed } from '../core/pagination.js';
import { wrapUntrustedContent } from '../core/untrusted-content.js';
import type { DailyWarning, IssueThreadOutput } from '../formatters/json.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export interface IssueThreadOptions {
  issueUrl: string;
}

/**
 * Per-body character cap, applied before fencing. GitHub allows 65,536
 * characters per body; a thread is read whole by an agent, so one pasted log
 * must not crowd out the rest.
 * ponytail: per-body cap only. Thread length is bounded by the shared
 * pagination cap (1000 comments); add a whole-thread budget if that proves
 * too much for a reader.
 */
export const MAX_ISSUE_THREAD_BODY_CHARS = 20_000;

/** Cut an over-long body, saying how much was dropped. */
function capBody(body: string): string {
  if (body.length <= MAX_ISSUE_THREAD_BODY_CHARS) return body;
  const dropped = body.length - MAX_ISSUE_THREAD_BODY_CHARS;
  return `${body.slice(0, MAX_ISSUE_THREAD_BODY_CHARS)}\n[truncated: ${dropped} more characters]`;
}

/**
 * Fetch one issue's title, body and comments, each fenced as untrusted content.
 *
 * Nothing is filtered: bot comments and the user's own comments are part of
 * the discussion an implementer needs. Comments come oldest first.
 *
 * @throws {ValidationError} If the URL is not a valid GitHub issue URL.
 */
export async function runIssueThread(options: IssueThreadOptions): Promise<IssueThreadOutput> {
  validateUrl(options.issueUrl);
  validateGitHubUrl(options.issueUrl, ISSUE_URL_PATTERN, 'issue');

  const parsed = parseGitHubUrl(options.issueUrl);
  if (!parsed || parsed.type !== 'issues') {
    throw new ValidationError(`Not a parseable GitHub issue URL: ${options.issueUrl}`);
  }
  const { owner, repo, number: issueNumber } = parsed;

  const octokit = getOctokit(requireGitHubToken());
  const [{ data: issue }, commentsResult] = await Promise.all([
    octokit.issues.get({ owner, repo, issue_number: issueNumber }),
    paginateAllDetailed((page) =>
      octokit.issues.listComments({ owner, repo, page, issue_number: issueNumber, per_page: 100 }),
    ),
  ]);

  const label = `${owner}/${repo}#${issueNumber}`;
  const rawBodies = [issue.body ?? '', ...commentsResult.items.map((c) => c.body ?? '')];
  const cappedCount = rawBodies.filter((b) => b.length > MAX_ISSUE_THREAD_BODY_CHARS).length;

  const warnings: DailyWarning[] = [];
  if (commentsResult.truncated) {
    warnings.push({
      phase: 'fetch',
      operation: 'fetch issue comments (truncated)',
      message: `Pagination cap reached fetching comments for ${label}; the newest comments may be missing.`,
    });
  }
  if (cappedCount > 0) {
    warnings.push({
      phase: 'fetch',
      operation: 'cap issue thread bodies',
      message: `${cappedCount} body or comment(s) on ${label} exceeded ${MAX_ISSUE_THREAD_BODY_CHARS} characters and were cut.`,
    });
  }

  const issueAuthor = issue.user?.login;
  return {
    url: issue.html_url,
    owner,
    repo,
    number: issueNumber,
    state: issue.state,
    title: wrapUntrustedContent(issue.title, label, {
      author: issueAuthor,
      association: issue.author_association,
      source: 'issue-title',
    }),
    author: issueAuthor ?? null,
    authorAssociation: issue.author_association ?? null,
    createdAt: issue.created_at,
    body: wrapUntrustedContent(capBody(issue.body ?? ''), label, {
      author: issueAuthor,
      association: issue.author_association,
      source: 'issue-body',
    }),
    comments: commentsResult.items.map((c) => ({
      author: c.user?.login ?? null,
      authorAssociation: c.author_association ?? null,
      createdAt: c.created_at,
      body: wrapUntrustedContent(capBody(c.body ?? ''), label, {
        author: c.user?.login,
        association: c.author_association,
        source: 'issue-comment',
      }),
    })),
    ...(warnings.length > 0 && { warnings }),
  };
}
