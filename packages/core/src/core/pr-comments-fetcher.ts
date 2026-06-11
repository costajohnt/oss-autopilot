/**
 * Fetch the raw review-comment bundle for a PR (#867 PR 3).
 *
 * Returns reviews, inline review comments, and issue-level comments for a
 * single PR with the contributor's own comments + bots filtered out. The
 * `authorAssociation` field is preserved on every entry so the host's
 * extraction prompt can weight maintainer voices (OWNER/MEMBER/COLLABORATOR)
 * differently from community feedback (CONTRIBUTOR/NONE).
 *
 * No LLM calls happen here — this is the data layer feeding the host's
 * `extract-learnings` prompt. The bundle structure is the contract; the
 * extraction is the host's responsibility.
 */
import type { Octokit } from '@octokit/rest';
import { paginateAll } from './pagination.js';
import { wrapUntrustedContent } from './untrusted-content.js';
import { isBotAuthor } from './comment-utils.js';
import { parseGitHubUrl } from './urls.js';
import { ValidationError, errorMessage } from './errors.js';
import { debug, warn } from './logger.js';

const MODULE = 'pr-comments-fetcher';

/** Default concurrency for {@link fetchPRCommentBundlesBatch}. */
const DEFAULT_BATCH_CONCURRENCY = 3;

/** A single review (top-level) on a PR. */
export interface PRReviewEntry {
  author: string;
  authorAssociation: string;
  /** `<github-content>`-fenced review body (#1372). */
  body: string;
  submittedAt: string;
}

/** An inline review comment (anchored to a file/line) on a PR. */
export interface PRReviewCommentEntry {
  author: string;
  authorAssociation: string;
  /** `<github-content>`-fenced comment body (#1372). */
  body: string;
  path: string;
  createdAt: string;
}

/** An issue-level comment posted on the PR thread. */
export interface PRIssueCommentEntry {
  author: string;
  authorAssociation: string;
  /** `<github-content>`-fenced comment body (#1372). */
  body: string;
  createdAt: string;
}

/**
 * The full comment bundle returned for a single PR. Field order matches
 * the typical narrative arc of a PR review (top-level reviews → inline
 * comments → general thread chatter), so the host's extraction prompt can
 * walk the bundle linearly.
 */
export interface PRCommentBundle {
  prUrl: string;
  prTitle: string;
  repo: string; // owner/repo
  /** ISO-8601 timestamp the PR was merged or closed; whichever applies. */
  mergedAt: string;
  reviews: PRReviewEntry[];
  reviewComments: PRReviewCommentEntry[];
  issueComments: PRIssueCommentEntry[];
}

/**
 * Fetch a single PR's comment bundle. Filters out the authenticated user's
 * own comments and bots. Throws {@link ValidationError} on a non-PR URL.
 */
export async function fetchPRCommentBundle(
  octokit: Octokit,
  prUrl: string,
  githubUsername: string,
): Promise<PRCommentBundle> {
  const parsed = parseGitHubUrl(prUrl);
  if (!parsed || parsed.type !== 'pull') {
    throw new ValidationError(`Invalid PR URL: ${prUrl}`);
  }

  const { owner, repo, number: pull_number } = parsed;
  const repoFull = `${owner}/${repo}`;

  // Fetch the PR + all three comment streams in parallel. We always fetch
  // every page — corpus quality depends on having every reviewer voice, not
  // just the first 100 comments.
  const [{ data: pr }, reviews, reviewComments, issueComments] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number }),
    paginateAll((page) =>
      octokit.pulls.listReviews({
        owner,
        repo,
        pull_number,
        per_page: 100,
        page,
      }),
    ),
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
  ]);

  const ownLogin = githubUsername.toLowerCase();

  /**
   * Drop entries that aren't useful corpus: the user's own comments, bots,
   * and entries with no author at all (deleted accounts surface as null
   * user from GitHub's REST API).
   */
  const isWorthKeeping = (login: string | undefined | null): boolean => {
    if (!login) return false;
    if (login.toLowerCase() === ownLogin) return false;
    if (isBotAuthor(login)) return false;
    return true;
  };

  const mergedAt = pr.merged_at ?? pr.closed_at ?? '';

  // Fence every body at fetch time (#1372): the bundle's only consumer is
  // `guidelines fetch-corpus`, whose output goes straight into the host's
  // extract-learnings prompt — there is no human-display or string-matching
  // consumer downstream, so fetch-time wrapping is safe here.
  const fenceLabel = `${repoFull}#${pull_number}`;
  const fence = (body: string, source: string, author: string, association: string) =>
    wrapUntrustedContent(body, fenceLabel, { author, association, source });

  return {
    prUrl,
    prTitle: pr.title,
    repo: repoFull,
    mergedAt,
    reviews: reviews
      .filter((r) => isWorthKeeping(r.user?.login))
      .map((r) => ({
        author: r.user?.login ?? '',
        authorAssociation: r.author_association ?? 'NONE',
        body: fence(r.body ?? '', 'pr-review', r.user?.login ?? '', r.author_association ?? 'NONE'),
        submittedAt: r.submitted_at ?? '',
      })),
    reviewComments: reviewComments
      .filter((c) => isWorthKeeping(c.user?.login))
      .map((c) => ({
        author: c.user?.login ?? '',
        authorAssociation: c.author_association ?? 'NONE',
        body: fence(c.body ?? '', 'pr-review-comment', c.user?.login ?? '', c.author_association ?? 'NONE'),
        path: c.path ?? '',
        createdAt: c.created_at ?? '',
      })),
    issueComments: issueComments
      .filter((c) => isWorthKeeping(c.user?.login))
      .map((c) => ({
        author: c.user?.login ?? '',
        authorAssociation: c.author_association ?? 'NONE',
        body: fence(c.body ?? '', 'pr-issue-comment', c.user?.login ?? '', c.author_association ?? 'NONE'),
        createdAt: c.created_at ?? '',
      })),
  };
}

/**
 * Fetch comment bundles for many PRs with a small concurrency cap (default 3).
 *
 * Failures on individual PRs are logged and recorded — the batch returns
 * `{ bundles, failures }` so the caller can decide whether to retry, surface
 * a partial-data banner, or proceed. Rationale: extraction quality is already
 * a partial-information problem (users contribute to many repos and many PRs),
 * so a single 404 / rate limit on one PR should not deny the host the corpus
 * from the other 4 — but the failure should still be visible (#1209 L8).
 */
export interface PRCommentBundlesBatchResult {
  bundles: PRCommentBundle[];
  failures: Array<{ prUrl: string; error: string }>;
}

export async function fetchPRCommentBundlesBatch(
  octokit: Octokit,
  prUrls: string[],
  githubUsername: string,
  concurrency: number = DEFAULT_BATCH_CONCURRENCY,
): Promise<PRCommentBundlesBatchResult> {
  const bundles: PRCommentBundle[] = [];
  const failures: Array<{ prUrl: string; error: string }> = [];
  const queue = [...prUrls];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) return;
      try {
        const bundle = await fetchPRCommentBundle(octokit, url, githubUsername);
        bundles.push(bundle);
      } catch (err) {
        const errorMsg = errorMessage(err);
        failures.push({ prUrl: url, error: errorMsg });
        warn(MODULE, `Skipping ${url}: ${errorMsg}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, prUrls.length) }, worker);
  await Promise.all(workers);

  debug(MODULE, `Fetched ${bundles.length}/${prUrls.length} comment bundles (${failures.length} failed)`);
  return { bundles, failures };
}
