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
  user?: { login?: string } | null;
  body?: string | null;
  created_at: string;
  in_reply_to_id?: number;
  pull_request_review_id?: number | null;
}

/**
 * Determine review decision from reviews list.
 * Groups reviews by user, keeping only the latest from each user,
 * then checks for CHANGES_REQUESTED or APPROVED states.
 */
export function determineReviewDecision(
  reviews: Array<{ state?: string | null; user?: { login?: string } | null }>,
): ReviewDecision {
  if (reviews.length === 0) {
    return 'review_required';
  }

  // Group reviews by user, keeping only the latest from each user
  const latestByUser = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    const state = review.state;
    if (login && state) {
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
 * Get the date of the latest CHANGES_REQUESTED review (from any reviewer).
 * Used to detect needs_changes status when review feedback is in inline comments.
 */
export function getLatestChangesRequestedDate(
  reviews: Array<{ state?: string | null; submitted_at?: string | null }>,
): string | undefined {
  let latest: string | undefined;
  for (const review of reviews) {
    if (review.state === 'CHANGES_REQUESTED' && review.submitted_at) {
      if (!latest || review.submitted_at > latest) {
        latest = review.submitted_at;
      }
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
    return parentAuthor != null && commentAuthor != null && parentAuthor === commentAuthor;
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
 * Check if there are unresponded comments from maintainers.
 * Combines issue comments and review comments into a timeline,
 * then finds maintainer comments after the user's last comment.
 */
export function checkUnrespondedComments(
  comments: Array<{ user?: { login?: string } | null; body?: string | null; created_at: string }>,
  reviews: Array<{
    user?: { login?: string } | null;
    body?: string | null;
    submitted_at?: string | null;
    state?: string | null;
    id?: number;
  }>,
  reviewComments: ReviewComment[],
  username: string,
): { hasUnrespondedComment: boolean; lastMaintainerComment?: FetchedPR['lastMaintainerComment'] } {
  // Combine comments and reviews into a timeline
  const timeline: Array<{ author: string; body: string; createdAt: string; isUser: boolean }> = [];
  const usernameLower = username.toLowerCase();

  for (const comment of comments) {
    const author = comment.user?.login || 'unknown';
    timeline.push({
      author,
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

    // For inline-only COMMENTED reviews, skip pure self-replies (#199)
    if (!body && review.state === 'COMMENTED' && review.id != null) {
      if (isAllSelfReplies(review.id, reviewComments)) {
        continue;
      }
    }

    // Resolve body: prefer actual text, then inline comment text, then synthetic placeholder
    const resolvedBody =
      body ||
      (review.id != null ? getInlineCommentBody(review.id, reviewComments) : undefined) ||
      (review.state === 'CHANGES_REQUESTED'
        ? '(requested changes via inline review comments)'
        : '(posted inline review comments)');

    timeline.push({
      author,
      body: resolvedBody,
      createdAt: review.submitted_at,
      isUser: author.toLowerCase() === usernameLower,
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

  for (const item of timeline) {
    if (item.isUser) continue; // Skip user's own comments
    if (item.author === 'unknown') continue; // Skip deleted/null accounts
    if (isBotAuthor(item.author)) continue; // Skip bots

    const itemTime = new Date(item.createdAt);
    if (!lastUserCommentTime || itemTime > lastUserCommentTime) {
      lastMaintainerComment = {
        author: item.author,
        body: item.body.slice(0, 200) + (item.body.length > 200 ? '...' : ''),
        createdAt: item.createdAt,
      };
    }
  }

  // Filter out pure acknowledgment comments that don't require a response
  if (lastMaintainerComment && isAcknowledgmentComment(lastMaintainerComment.body)) {
    lastMaintainerComment = undefined;
  }

  return {
    hasUnrespondedComment: !!lastMaintainerComment,
    lastMaintainerComment,
  };
}
