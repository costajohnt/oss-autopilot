/**
 * Review Analysis - Review decision computation, unresponded comment detection,
 * and self-reply filtering for PR reviews.
 * Extracted from PRMonitor to isolate review-related logic (#263).
 */

import { FetchedPR, ReviewDecision } from './types.js';
import { isBotAuthor, isAcknowledgmentComment } from './comment-utils.js';

/** Inline review comment shape used for self-reply detection and body extraction (#199). */
export interface ReviewComment {
  id: number;
  user?: { login?: string; type?: string | null } | null;
  author_association?: string | null;
  body?: string | null;
  created_at: string;
  in_reply_to_id?: number;
  pull_request_review_id?: number | null;
}

/**
 * Determine review decision from reviews list.
 * Groups reviews by user, keeping each user's latest verdict, then checks
 * for CHANGES_REQUESTED or APPROVED states.
 *
 * Only APPROVED, CHANGES_REQUESTED and DISMISSED change a reviewer's standing
 * verdict on GitHub. COMMENTED is also what GitHub records for every inline
 * reply, so it must not overwrite an earlier verdict from the same reviewer.
 *
 * Bot-authored reviews (e.g. an AI review bot posting APPROVE) are ignored so a
 * bot alone never reads as maintainer approval or a changes request (#1840).
 */
export function determineReviewDecision(
  reviews: Array<{ state?: string | null; user?: { login?: string; type?: string | null } | null }>,
): ReviewDecision {
  if (reviews.length === 0) {
    return 'review_required';
  }

  // Group reviews by user, keeping each user's latest verdict
  const latestByUser = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    const state = review.state;
    if (!login || !state || isBotAuthor(login, review.user?.type)) continue;
    if (state === 'DISMISSED') {
      latestByUser.delete(login);
    } else if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') {
      latestByUser.set(login, state);
    }
  }

  const states = Array.from(latestByUser.values());

  if (states.includes('CHANGES_REQUESTED')) {
    return 'changes_requested';
  }

  if (states.includes('APPROVED')) {
    return 'approved';
  }

  return 'review_required';
}

/**
 * Get the date of the latest CHANGES_REQUESTED review (from any human reviewer).
 * Used to detect needs_changes status when review feedback is in inline comments.
 * Bot reviews are skipped (#1840): a bot re-reviewing every push would otherwise
 * move the date past the author's fix commit.
 */
export function getLatestChangesRequestedDate(
  reviews: Array<{
    state?: string | null;
    submitted_at?: string | null;
    user?: { login?: string; type?: string | null } | null;
  }>,
): string | undefined {
  let latest: string | undefined;
  for (const review of reviews) {
    if (review.state !== 'CHANGES_REQUESTED' || isBotAuthor(review.user?.login ?? '', review.user?.type)) continue;
    if (review.submitted_at && (!latest || review.submitted_at > latest)) {
      latest = review.submitted_at;
    }
  }
  return latest;
}

/**
 * Check if all inline comments in a COMMENTED review are self-replies.
 * A self-reply is when an author replies to their own earlier inline comment.
 * Used to filter out informational follow-ups that don't require contributor action (#199).
 */
export function isAllSelfReplies(reviewId: number, reviewComments: ReviewComment[]): boolean {
  const commentsForReview = reviewComments.filter((c) => c.pull_request_review_id === reviewId);

  if (commentsForReview.length === 0) return false;

  // Build map of ALL comment IDs -> lowercase author for parent lookup
  const authorMap = new Map<number, string>();
  for (const c of reviewComments) {
    if (c.user?.login) {
      authorMap.set(c.id, c.user.login.toLowerCase());
    }
  }

  return commentsForReview.every((comment) => {
    if (!comment.in_reply_to_id) return false; // New thread, not a reply
    const parentAuthor = authorMap.get(comment.in_reply_to_id);
    const commentAuthor = comment.user?.login?.toLowerCase();
    if (parentAuthor == null || commentAuthor == null || parentAuthor !== commentAuthor) return false;
    // A self-reply containing a question mark is likely a follow-up question
    // directed at the PR author, not an informational addendum (#498).
    // Null/empty body on a self-reply is anomalous — surface it rather than
    // silently filtering, since the safe direction is to notify.
    if (!comment.body) return false;
    if (comment.body.includes('?')) return false;
    return true;
  });
}

/**
 * Get the body text of inline review comments for a COMMENTED review.
 * Returns the first non-empty comment body, or undefined.
 * Enables the acknowledgment filter to evaluate real content instead of
 * synthetic placeholders (#199).
 */
export function getInlineCommentBody(reviewId: number, reviewComments: ReviewComment[]): string | undefined {
  return reviewComments.find((c) => c.pull_request_review_id === reviewId && c.body?.trim())?.body?.trim();
}

/**
 * Check whether a review has any associated inline comments.
 * Used to prevent the acknowledgment filter from discarding reviews
 * that also posted inline comments (#829).
 */
export function reviewHasInlineComments(reviewId: number, reviewComments: ReviewComment[]): boolean {
  return reviewComments.some((c) => c.pull_request_review_id === reviewId);
}

/**
 * Earliest maintainer response timestamp across issue comments and submitted
 * reviews (#1461). A "response" is any comment or review by a non-bot
 * account other than the contributor — acknowledgments and approvals count,
 * since for latency purposes any human maintainer reply is a response.
 * Computed from data fetchPRDetails already holds in memory (zero extra API
 * calls). Returns undefined when no maintainer has responded yet.
 */
export function getFirstMaintainerResponseAt(
  comments: Array<{ user?: { login?: string } | null; created_at: string }>,
  reviews: Array<{ user?: { login?: string } | null; submitted_at?: string | null }>,
  username: string,
): string | undefined {
  const usernameLower = username.toLowerCase();
  let earliest: string | undefined;
  const consider = (author: string | undefined | null, createdAt: string | undefined | null) => {
    if (!author || !createdAt) return;
    if (author.toLowerCase() === usernameLower) return;
    if (isBotAuthor(author)) return;
    if (!earliest || new Date(createdAt).getTime() < new Date(earliest).getTime()) {
      earliest = createdAt;
    }
  };
  for (const comment of comments) consider(comment.user?.login, comment.created_at);
  for (const review of reviews) consider(review.user?.login, review.submitted_at);
  return earliest;
}

/**
 * Check if there are unresponded comments from maintainers.
 * Combines issue comments and review comments into a timeline,
 * then finds maintainer comments after the user's last comment.
 */
export function checkUnrespondedComments(
  comments: Array<{ user?: { login?: string; type?: string | null } | null; body?: string | null; created_at: string }>,
  reviews: Array<{
    user?: { login?: string; type?: string | null } | null;
    body?: string | null;
    submitted_at?: string | null;
    state?: string | null;
    id?: number;
  }>,
  reviewComments: ReviewComment[],
  username: string,
): { hasUnrespondedComment: boolean; lastMaintainerComment?: FetchedPR['lastMaintainerComment'] } {
  // Combine comments and reviews into a timeline
  const timeline: Array<{
    author: string;
    userType?: string | null;
    body: string;
    createdAt: string;
    isUser: boolean;
    reviewId?: number;
  }> = [];
  const usernameLower = username.toLowerCase();

  for (const comment of comments) {
    const author = comment.user?.login || 'unknown';
    timeline.push({
      author,
      userType: comment.user?.type,
      body: comment.body || '',
      createdAt: comment.created_at,
      isUser: author.toLowerCase() === usernameLower,
    });
  }

  for (const review of reviews) {
    if (!review.submitted_at) continue;
    const body = (review.body || '').trim();
    // Include COMMENTED and CHANGES_REQUESTED reviews even without body text —
    // they indicate inline review comments were posted and need a response (#151, #431).
    // CHANGES_REQUESTED with only inline comments is actionable maintainer feedback.
    // Skip other empty-body reviews (APPROVED, DISMISSED) as those are state changes.
    if (!body && review.state !== 'COMMENTED' && review.state !== 'CHANGES_REQUESTED') continue;
    const author = review.user?.login || 'unknown';

    // For inline-only COMMENTED reviews, skip pure self-replies (#199).
    // CHANGES_REQUESTED reviews are always actionable regardless of self-replies.
    if (!body && review.state === 'COMMENTED' && review.id != null && isAllSelfReplies(review.id, reviewComments)) {
      continue;
    }

    // Resolve body: prefer actual text, then inline comment text, then synthetic placeholder
    const resolvedBody =
      body ||
      (review.id == null ? undefined : getInlineCommentBody(review.id, reviewComments)) ||
      (review.state === 'CHANGES_REQUESTED'
        ? '(requested changes via inline review comments)'
        : '(posted inline review comments)');

    timeline.push({
      author,
      userType: review.user?.type,
      body: resolvedBody,
      createdAt: review.submitted_at,
      isUser: author.toLowerCase() === usernameLower,
      reviewId: review.id,
    });
  }

  // Sort by date
  timeline.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Find the last user comment
  let lastUserCommentTime: Date | null = null;
  for (const item of timeline) {
    if (item.isUser) {
      lastUserCommentTime = new Date(item.createdAt);
    }
  }

  // Find maintainer comments after the user's last comment
  let lastMaintainerComment: FetchedPR['lastMaintainerComment'] | undefined;
  let lastMaintainerReviewId: number | undefined;

  for (const item of timeline) {
    if (item.isUser) continue; // Skip user's own comments
    if (item.author === 'unknown') continue; // Skip deleted/null accounts
    if (isBotAuthor(item.author, item.userType)) continue; // Skip bots

    const itemTime = new Date(item.createdAt);
    if (!lastUserCommentTime || itemTime > lastUserCommentTime) {
      lastMaintainerComment = {
        author: item.author,
        body: item.body.slice(0, 200) + (item.body.length > 200 ? '...' : ''),
        createdAt: item.createdAt,
      };
      lastMaintainerReviewId = item.reviewId;
    }
  }

  // Filter out pure acknowledgment comments that don't require a response.
  // Skip the filter when the review has inline comments — those indicate
  // feedback beyond the summary body that likely needs a response (#829).
  const lastReviewHasInlineComments =
    lastMaintainerReviewId != null && reviewHasInlineComments(lastMaintainerReviewId, reviewComments);
  if (lastMaintainerComment && isAcknowledgmentComment(lastMaintainerComment.body) && !lastReviewHasInlineComments) {
    lastMaintainerComment = undefined;
  }

  return {
    hasUnrespondedComment: !!lastMaintainerComment,
    lastMaintainerComment,
  };
}

/** A non-comment PR event: a commit, force-push, review request or label. */
export interface ActivityEvent {
  login?: string | null;
  /** REST `user.type` / GraphQL `__typename` of the actor (`'Bot'` for apps). */
  type?: string | null;
  at?: string | null;
  /**
   * True for commits and force-pushes. A push by a bot still counts as
   * maintainer activity (a maintainer's own GitHub App pushing fixes), unless
   * the bot is an auto-fixer or dependency bot in {@link PUSH_BOT_DENYLIST}.
   */
  isPush?: boolean;
}

/**
 * Bots whose pushes are automation, not maintainer engagement. Compared
 * case-insensitively with any `[bot]` suffix stripped.
 */
const PUSH_BOT_DENYLIST: ReadonlySet<string> = new Set([
  'pre-commit-ci',
  'autofix-ci',
  'prettier-ci',
  'github-actions',
  'dependabot',
  'renovate',
  'web-flow',
]);

/** Author associations that mark a commenter as a repo maintainer. */
const MAINTAINER_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Minimum gap since the previous activity (maintainer or contributor) for a
 * contributor comment to count as a "ping". A same-day reply to a maintainer
 * is conversation, not a nudge.
 */
export const PING_MIN_GAP_DAYS = 7;

type ActorFields = {
  user?: { login?: string; type?: string | null } | null;
  author_association?: string | null;
};

/**
 * Latest maintainer activity on a PR, falling back to `createdAt` when no
 * maintainer has engaged, plus the number of contributor pings since then.
 *
 * Maintainer activity is any of:
 * - an issue comment by an OWNER / MEMBER / COLLABORATOR, so drive-by "+1"
 *   comments don't reset the clock (when the association is unknown, as on
 *   older data, any non-contributor non-bot author counts);
 * - a review or inline review comment by any non-contributor non-bot user
 *   (codeowners often show as CONTRIBUTOR);
 * - a commit authored or committed by someone else, or a force-push by
 *   someone else, including bots such as a maintainer's own GitHub App,
 *   except auto-fixer / dependency bots ({@link PUSH_BOT_DENYLIST});
 * - a review request or label by a non-contributor non-bot actor.
 *
 * Staleness is measured from this timestamp rather than `updatedAt`, because
 * `updatedAt` is bumped by the contributor's own follow-ups and rebases, so a
 * PR the maintainers have ignored for months never looked dormant.
 *
 * A contributor comment counts as a ping only when it comes at least
 * {@link PING_MIN_GAP_DAYS} after the previous activity (the maintainer
 * activity or the contributor's own previous comment).
 */
export function getLastMaintainerActivity(
  comments: Array<ActorFields & { created_at: string }>,
  reviews: Array<ActorFields & { submitted_at?: string | null }>,
  reviewComments: Array<ActorFields & { created_at: string }>,
  events: ActivityEvent[],
  username: string,
  createdAt: string,
): { lastMaintainerActivityAt: string; authorPingsSinceMaintainerActivity: number } {
  const usernameLower = username.toLowerCase();
  let latest = createdAt;
  let latestMs = Date.parse(createdAt);
  const consider = (
    login: string | undefined | null,
    type: string | undefined | null,
    at: string | undefined | null,
    isPush = false,
  ) => {
    if (!login || !at) return;
    const lower = login.toLowerCase();
    if (lower === usernameLower) return;
    if (isPush ? PUSH_BOT_DENYLIST.has(lower.replace(/\[bot\]$/, '')) : isBotAuthor(login, type)) return;
    const ms = Date.parse(at);
    if (ms > latestMs) {
      latest = at;
      latestMs = ms;
    }
  };
  for (const c of comments) {
    const association = c.author_association;
    if (association && !MAINTAINER_ASSOCIATIONS.has(association)) continue;
    consider(c.user?.login, c.user?.type, c.created_at);
  }
  for (const r of reviews) consider(r.user?.login, r.user?.type, r.submitted_at);
  for (const c of reviewComments) consider(c.user?.login, c.user?.type, c.created_at);
  for (const e of events) consider(e.login, e.type, e.at, e.isPush);

  const authorCommentTimes = comments
    .filter((c) => c.user?.login?.toLowerCase() === usernameLower)
    .map((c) => Date.parse(c.created_at))
    .filter((ms) => ms > latestMs);
  authorCommentTimes.sort((a, b) => a - b);
  const minGapMs = PING_MIN_GAP_DAYS * 86_400_000;
  let previousMs = latestMs;
  let authorPingsSinceMaintainerActivity = 0;
  for (const ms of authorCommentTimes) {
    if (ms - previousMs >= minGapMs) authorPingsSinceMaintainerActivity++;
    previousMs = ms;
  }
  return { lastMaintainerActivityAt: latest, authorPingsSinceMaintainerActivity };
}
