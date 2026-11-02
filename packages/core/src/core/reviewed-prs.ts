/**
 * Review follow-ups (#1857): open PRs the user reviewed or commented on but
 * did not author, where the author has moved the thread since.
 *
 * `/oss` only tracked PRs the user authored, so a reviewer never heard when
 * the author pushed fixes or asked them something, and had to build the
 * compare URL by hand. This module decides, for one reviewed PR and its
 * fetched activity, whether anything happened after the user's last review
 * or comment that asks for another look:
 * - the author (or anyone else who is not the user or a bot) pushed a
 *   non-merge commit after the review;
 * - the author posted a comment, review or inline review comment after it;
 * - anyone other than the user addressed them: a reply in one of the user's
 *   inline threads, a quote of the user's own prose, or an @mention. These
 *   are the "questions for you".
 *
 * "Pushed after the review" is decided by position, not by date, whenever
 * the review names the head it was made against (`commit_id` on reviews
 * and inline comments): Git dates say when a commit was written, not when
 * it was pushed, so the commits after the reviewed one in the PR's commit
 * list are the new ones. The reviewed SHA also lets the daily phase ask
 * GitHub for `<reviewedSha>...<headSha>`, and the scan flags the cases where
 * that range would mislead: the reviewed commit is gone from the list
 * (`rebased`), upstream was merged in after it (`mergedUpstream`), or the
 * user's last word was a plain comment that names no head (`baseUnknown`).
 *
 * Pure logic only. Fetching lives in reviewed-prs-fetch.ts behind
 * `PRMonitor.fetchReviewedOpenPRs`, `PRMonitor.fetchReviewedPRActivity`
 * and `PRMonitor.fetchCompareStatus`; orchestration, the compare call, the
 * dismiss check and the warnings live in commands/daily-reviewed-prs.ts.
 */

import { isBotAuthor, isQuoteReplyTo, isReactionOnlyComment, proseWithoutCode } from './comment-utils.js';
import { debug } from './logger.js';

const MODULE = 'reviewed-prs';

/** Longest excerpt carried in the digest; matches `lastMaintainerComment`. */
const EXCERPT_LENGTH = 200;

/** Commits listed per entry; the compare URL has the rest. */
export const REVIEWED_PR_MAX_COMMITS = 25;

/** Questions listed per entry, oldest first; the thread has the rest. */
export const REVIEWED_PR_MAX_QUESTIONS = 10;

export type ReviewedPRQuestionKind = 'comment' | 'review' | 'review_comment';

/** Why a comment counts as addressed to the user. */
export type ReviewedPRQuestionReason = 'reply' | 'quote' | 'mention';

/** A comment on a reviewed PR that is addressed to the user. */
export interface ReviewedPRQuestion {
  author: string;
  createdAt: string;
  kind: ReviewedPRQuestionKind;
  reason: ReviewedPRQuestionReason;
  /** First 200 characters of the comment body. */
  excerpt: string;
  /** Link to the comment on github.com, when the API returned one. */
  url?: string;
}

/** One non-merge commit pushed after the user's last review or comment. */
export interface ReviewedPRCommit {
  sha: string;
  /** GitHub login of the commit author; `unknown` when no account is linked. */
  author: string;
  date: string;
  /** Commit subject line, first 200 characters. */
  subject: string;
}

/** A PR the user reviewed where the author has moved the thread since. */
export interface ReviewedPRFollowUp {
  prUrl: string;
  repo: string;
  number: number;
  title: string;
  /** GitHub login of the PR author. */
  author: string;
  /** When the user last reviewed or commented on the PR. */
  reviewedAt: string;
  /**
   * Head SHA the user's last review or inline comment was made against
   * (`commit_id`). Absent when their last word was a plain comment, which
   * names no head; `baseUnknown` then says whether that matters.
   */
  reviewedSha?: string;
  headSha: string;
  /**
   * `<reviewedSha>...<headSha>`, set only when GitHub confirmed
   * `reviewedSha` is an ancestor of the head and none of `rebased`,
   * `mergedUpstream` or `baseUnknown` applies, so the range shows exactly
   * what changed since the review.
   */
  compareRange?: string;
  /** github.com compare page for `compareRange`. */
  compareUrl?: string;
  /**
   * The reviewed commit is gone from the PR's commit list or is no longer
   * an ancestor of the head (force-push or rebase). There is no honest
   * range; read `commits`, which were then picked by date.
   */
  rebased: boolean;
  /**
   * A merge commit follows the reviewed one (upstream merged into the
   * branch), so `<reviewedSha>...<headSha>` would include the upstream
   * changes. No range; read the per-commit diffs of `commits`.
   */
  mergedUpstream: boolean;
  /**
   * The user's last word was a plain comment, which names no head, and
   * commits were pushed since: `commits` were picked by date, which can
   * miss a cherry-pick or rebased fix carrying an older date, and no range
   * is offered. False when nothing was pushed or when `reviewedSha` is known.
   */
  baseUnknown: boolean;
  /**
   * Non-merge commits by someone other than the user or a bot after the
   * review, oldest first; capped. The commits after `reviewedSha` in the
   * PR's commit list when it is known and still there, else those dated
   * after `reviewedAt`.
   */
  commits: ReviewedPRCommit[];
  /** Commits dropped from `commits` by the cap. */
  moreCommits: number;
  /** Comments by the PR author after `reviewedAt` (questions included). */
  authorComments: number;
  /** Comments addressed to the user after `reviewedAt`, oldest first; capped. */
  questions: ReviewedPRQuestion[];
  /** Questions dropped from `questions` by the cap. */
  moreQuestions: number;
  /**
   * Newest date among the commits and comments that qualified the PR; the
   * dismiss stamp is compared with this. Can predate `reviewedAt` when the
   * only new work is a commit carrying an old author date (cherry-pick).
   */
  latestActivityAt: string;
}

/** What the search returned for one reviewed PR. */
export interface ReviewedPRRef {
  url: string;
  repo: string;
  number: number;
  title: string;
  /** GitHub login of the PR author. */
  author: string;
  /** Search API `updated_at`; moves on any activity, so a dismiss at or after it has nothing new to show. */
  updatedAt: string;
}

/** The account behind a comment, review or inline comment, as Octokit returns it. */
export interface ReviewedPRActor {
  user?: { login?: string; type?: string | null } | null;
}

/**
 * Everything on a reviewed PR the scan reads, in the shapes the Octokit
 * endpoints return (structural, so responses assign directly).
 */
export interface ReviewedPRActivity {
  pr: {
    headSha: string;
    /** `open` for everything the search returned; anything else is skipped (closed between search and fetch). */
    state: string;
    author?: string;
    title?: string;
  };
  comments: Array<ReviewedPRActor & { id?: number; body?: string | null; created_at: string; html_url?: string }>;
  reviews: Array<
    ReviewedPRActor & {
      id?: number;
      body?: string | null;
      submitted_at?: string | null;
      state?: string | null;
      commit_id?: string | null;
      html_url?: string;
    }
  >;
  reviewComments: Array<
    ReviewedPRActor & {
      id?: number;
      body?: string | null;
      created_at: string;
      commit_id?: string | null;
      in_reply_to_id?: number;
      /** The review the comment was submitted with; draft comments of the user's own PENDING review carry its id. */
      pull_request_review_id?: number | null;
      html_url?: string;
    }
  >;
  /** Oldest first, in branch order (GitHub's `listCommits`); the last entry is the head. */
  commits: Array<{
    sha: string;
    author?: { login?: string; type?: string | null } | null;
    /** GitHub account that last rewrote the commit (`web-flow` for rebases done on github.com). */
    committer?: { login?: string; type?: string | null } | null;
    commit: {
      message?: string | null;
      author?: { date?: string | null } | null;
      committer?: { date?: string | null } | null;
    };
    /** More than one parent marks a merge commit ("Update branch"), which carries no new work. */
    parents?: Array<{ sha?: string }>;
  }>;
}

/** The lists `PRMonitor.fetchReviewedPRActivity` fetches, as named in truncation warnings. */
export type ReviewedPRActivityList = 'comments' | 'reviews' | 'review comments' | 'commits';

function parseMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function excerptOf(body: string): string {
  const flat = body.replaceAll(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH)}...` : flat;
}

function byTime<T extends { createdAt: string }>(a: T, b: T): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

function isUserLogin(login: string | undefined, usernameLower: string): boolean {
  return login?.toLowerCase() === usernameLower;
}

/** `@login` as a whole token: not inside an email, a handle like `@login-bot`, or a path. */
function mentionPattern(username: string): RegExp {
  const escaped = username.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`(?<![\w-])@${escaped}(?![\w-])`, 'i');
}

/** The comment-shaped activity (issue comments, reviews, inline comments) as one stream. */
interface ThreadEntry {
  actor: ReviewedPRActor;
  body: string;
  at: string;
  atMs: number;
  kind: ReviewedPRQuestionKind;
  url?: string;
  /** Inline comments: the thread the comment belongs to (its root comment id). */
  threadId?: number;
  /** Reviews and inline comments: the head commit they were made against. */
  commitId?: string;
}

type ThreadEntryInput = Omit<ThreadEntry, 'at' | 'atMs' | 'body' | 'commitId'> & {
  at: string | null | undefined;
  body: string | null | undefined;
  commitId?: string | null;
};

/** One thread entry, or undefined when its timestamp is missing or unreadable. */
function toThreadEntry({ at, body, commitId, ...rest }: ThreadEntryInput): ThreadEntry | undefined {
  const atMs = parseMs(at);
  if (!at || atMs === undefined) return undefined;
  return { ...rest, at, atMs, body: body ?? '', ...(commitId && { commitId }) };
}

/**
 * The comment-shaped activity as one stream. GitHub returns the
 * authenticated user's own PENDING review (unsubmitted, `submitted_at`
 * null) and can return its draft comments (`pull_request_review_id` of that
 * review); neither has been said yet, so both are left out rather than
 * counted as the user's last word.
 */
function threadEntries(activity: ReviewedPRActivity): ThreadEntry[] {
  const pendingReviewIds = new Set(
    activity.reviews.filter((r) => r.state === 'PENDING' && r.id !== undefined).map((r) => r.id),
  );
  const inputs: ThreadEntryInput[] = [
    ...activity.comments.map((c): ThreadEntryInput => ({
      actor: c,
      body: c.body,
      at: c.created_at,
      kind: 'comment',
      url: c.html_url,
    })),
    ...activity.reviews
      .filter((r) => r.state !== 'PENDING')
      .map((r): ThreadEntryInput => ({
        actor: r,
        body: r.body,
        at: r.submitted_at,
        kind: 'review',
        url: r.html_url,
        commitId: r.commit_id,
      })),
    ...activity.reviewComments
      .filter((c) => c.pull_request_review_id == null || !pendingReviewIds.has(c.pull_request_review_id))
      .map((c): ThreadEntryInput => ({
        actor: c,
        body: c.body,
        at: c.created_at,
        kind: 'review_comment',
        url: c.html_url,
        threadId: c.in_reply_to_id ?? c.id,
        commitId: c.commit_id,
      })),
  ];
  return inputs.map((input) => toThreadEntry(input)).filter((entry) => entry !== undefined);
}

/** What the user themselves did on the PR. */
interface UserActivity {
  /** The user's latest comment, review or inline comment; undefined when they left none. */
  last?: ThreadEntry;
  /**
   * The user reviewed the PR in substance: a review (any verdict, body or
   * not), an inline comment, or a plain comment that says more than a
   * reaction. False when their only words were "+1"-style comments, which
   * the `commenter:` search still returns.
   */
  reviewed: boolean;
  /** Inline threads the user wrote in, with the time of their latest comment there. */
  threadLastMs: Map<number, number>;
  /** Bodies of everything the user wrote, for quote detection. */
  bodies: string[];
}

function scanUser(entries: readonly ThreadEntry[], usernameLower: string): UserActivity {
  const user: UserActivity = { reviewed: false, threadLastMs: new Map(), bodies: [] };
  for (const entry of entries) {
    if (!isUserLogin(entry.actor.user?.login, usernameLower)) continue;
    if (!user.last || entry.atMs > user.last.atMs) user.last = entry;
    if (entry.kind !== 'comment' || !isReactionOnlyComment(entry.body)) user.reviewed = true;
    if (entry.body.trim()) user.bodies.push(entry.body);
    if (entry.threadId !== undefined) {
      user.threadLastMs.set(entry.threadId, Math.max(user.threadLastMs.get(entry.threadId) ?? -Infinity, entry.atMs));
    }
  }
  return user;
}

/**
 * The date a commit was pushed under: the committer date when the author
 * also committed it (their own amend or rebase moved it, which is the
 * force-push case this feature exists for), the author date when someone
 * else rewrote it (a maintainer's rebase does not make the author's old
 * work new). Either falls back to the other when missing.
 */
function commitDateOf(entry: ReviewedPRActivity['commits'][number]): string | null | undefined {
  const authorDate = entry.commit.author?.date;
  const committerDate = entry.commit.committer?.date;
  const login = entry.author?.login?.toLowerCase();
  const isOwnRewrite = login !== undefined && entry.committer?.login?.toLowerCase() === login;
  return isOwnRewrite ? (committerDate ?? authorDate) : (authorDate ?? committerDate);
}

interface DatedCommit extends ReviewedPRCommit {
  atMs: number;
  isUser: boolean;
  isBot: boolean;
}

type CommitEntry = ReviewedPRActivity['commits'][number];

/** More than one parent: an "Update branch" or upstream merge, which carries no new work of its own. */
function isMergeCommit(entry: CommitEntry): boolean {
  return (entry.parents?.length ?? 0) > 1;
}

/** A dated non-merge commit, or undefined for a merge commit or one without a usable date. */
function toDatedCommit(entry: CommitEntry, usernameLower: string): DatedCommit | undefined {
  if (isMergeCommit(entry)) return undefined;
  const date = commitDateOf(entry);
  const atMs = parseMs(date);
  if (!date || atMs === undefined) return undefined;
  const login = entry.author?.login;
  return {
    date,
    atMs,
    sha: entry.sha,
    author: login ?? 'unknown',
    subject: excerptOf((entry.commit.message ?? '').split('\n', 1)[0]),
    isUser: isUserLogin(login, usernameLower),
    isBot: login !== undefined && isBotAuthor(login, entry.author?.type),
  };
}

/** Non-merge commits with a usable date, by non-bot accounts other than the user, in list order. */
function othersCommits(commits: readonly CommitEntry[], usernameLower: string): DatedCommit[] {
  return commits
    .map((entry) => toDatedCommit(entry, usernameLower))
    .filter((commit) => commit !== undefined)
    .filter((commit) => !commit.isUser && !commit.isBot);
}

/** The commits pushed after the user's last word, and what that says about a compare range. */
interface CommitsSince {
  /** Non-merge commits by non-bot accounts other than the user, in list order. */
  pushed: DatedCommit[];
  /** `commit_id` of the user's last review or inline comment; absent for a plain comment. */
  reviewedSha?: string;
  /** `reviewedSha` is not in the PR's commit list: the branch was rebased or force-pushed since. */
  rebased: boolean;
  /** A merge commit follows `reviewedSha`: `<reviewedSha>...<headSha>` would include upstream. */
  mergedUpstream: boolean;
  /** Plain-comment last word with commits dated after it: the reviewed head is unknown. */
  baseUnknown: boolean;
}

/**
 * A review or inline comment names the head it was made against
 * (`commit_id`), so the commits after it in the PR's commit list (oldest
 * first, branch order) are the new ones whatever their dates say: Git dates
 * record when a commit was written, not when it was pushed, so a
 * cherry-pick or a rebased fix can carry a date older than the review.
 * When the reviewed commit is gone from the list the branch was rebased or
 * force-pushed; dates are all that is left, and `rebased` says so. A merge
 * commit after the reviewed one means upstream was merged in, so a compare
 * range would show upstream's changes too (`mergedUpstream`).
 *
 * A plain comment names no head: its commits are the ones dated after it,
 * and `baseUnknown` is set when there are any, so the workflow knows the
 * list is approximate and offers no range.
 */
function commitsSince(activity: ReviewedPRActivity, last: ThreadEntry, usernameLower: string): CommitsSince {
  const datedAfterLast = (): DatedCommit[] =>
    othersCommits(activity.commits, usernameLower).filter((commit) => commit.atMs > last.atMs);
  const reviewedSha = last.commitId;
  if (reviewedSha === undefined) {
    const pushed = datedAfterLast();
    return { pushed, rebased: false, mergedUpstream: false, baseUnknown: pushed.length > 0 };
  }
  const index = activity.commits.findIndex((commit) => commit.sha === reviewedSha);
  if (index === -1) {
    return { reviewedSha, pushed: datedAfterLast(), rebased: true, mergedUpstream: false, baseUnknown: false };
  }
  const after = activity.commits.slice(index + 1);
  return {
    reviewedSha,
    pushed: othersCommits(after, usernameLower),
    rebased: false,
    mergedUpstream: after.some((commit) => isMergeCommit(commit)),
    baseUnknown: false,
  };
}

/**
 * Why an entry is addressed to the user, or undefined when it is not. An
 * @mention counts only in the author's own prose: not inside a quoted line,
 * a code fence or an inline code span (someone else's words, or a literal).
 */
function questionReason(entry: ThreadEntry, user: UserActivity, mention: RegExp): ReviewedPRQuestionReason | undefined {
  if (entry.threadId !== undefined) {
    const userLastMs = user.threadLastMs.get(entry.threadId);
    if (userLastMs !== undefined && entry.atMs > userLastMs) return 'reply';
  }
  if (user.bodies.some((body) => isQuoteReplyTo(entry.body, body))) return 'quote';
  if (mention.test(proseWithoutCode(entry.body))) return 'mention';
  return undefined;
}

/** What others did after the user's last word. */
interface ActivitySince {
  authorComments: number;
  /** Oldest first. */
  questions: ReviewedPRQuestion[];
  /** Newest qualifying commit or comment; empty when nothing qualified. */
  latestAt: string;
}

/** Newest-timestamp tracker over the activity that qualifies the PR. */
function latestTracker(): { note: (at: string, atMs: number) => void; at: () => string } {
  let latest = { at: '', atMs: -Infinity };
  return {
    note: (at, atMs) => {
      if (atMs > latest.atMs) latest = { at, atMs };
    },
    at: () => latest.at,
  };
}

interface ScanContext {
  usernameLower: string;
  authorLower: string;
  user: UserActivity;
  mention: RegExp;
}

/**
 * Whether `entry` counts, and why: `question` when it is addressed to the
 * user, `author` when it is a non-reaction reply by the PR author, or
 * nothing for everyone else (the user, bots, bystanders not addressing them).
 */
function classifyEntry(
  entry: ThreadEntry,
  { usernameLower, authorLower, user, mention }: ScanContext,
): { reason?: ReviewedPRQuestionReason; isAuthorReply: boolean; text: string } | undefined {
  const login = entry.actor.user?.login;
  const text = entry.body.trim();
  if (!login || !text || isUserLogin(login, usernameLower) || isBotAuthor(login, entry.actor.user?.type)) {
    return undefined;
  }
  const reason = questionReason(entry, user, mention);
  const isAuthorReply = login.toLowerCase() === authorLower && !isReactionOnlyComment(text);
  if (!reason && !isAuthorReply) return undefined;
  return { reason, isAuthorReply, text };
}

/** The comment activity after the user's last word, with `pushed` folded into `latestAt`. */
function collectActivitySince(
  entries: readonly ThreadEntry[],
  pushed: readonly DatedCommit[],
  context: ScanContext,
): ActivitySince {
  const reviewedMs = context.user.last?.atMs ?? Infinity;
  const latest = latestTracker();
  for (const commit of pushed) latest.note(commit.date, commit.atMs);
  const questions: ReviewedPRQuestion[] = [];
  let authorComments = 0;
  for (const entry of entries) {
    const verdict = entry.atMs > reviewedMs ? classifyEntry(entry, context) : undefined;
    if (!verdict) continue;
    if (verdict.isAuthorReply) authorComments++;
    latest.note(entry.at, entry.atMs);
    if (verdict.reason) {
      const { kind, at: createdAt, url } = entry;
      const login = entry.actor.user?.login ?? 'unknown';
      questions.push({
        kind,
        createdAt,
        author: login,
        reason: verdict.reason,
        excerpt: excerptOf(verdict.text),
        ...(url !== undefined && { url }),
      });
    }
  }
  questions.sort(byTime);
  return { authorComments, questions, latestAt: latest.at() };
}

/** Reasons the scan skips a PR before looking at what happened since the review. */
function skipReason(activity: ReviewedPRActivity, author: string, username: string): string | null {
  if (activity.pr.state !== 'open') return `state is ${activity.pr.state}, not open`;
  if (isUserLogin(author, username.toLowerCase())) return 'authored by the user';
  return null;
}

/** Why nothing is reported for a scanned PR, or null when the follow-up stands. */
function quietReason(since: ActivitySince, pushed: number, user: UserActivity, username: string): string | null {
  if (since.questions.length > 0) return null;
  if (!user.reviewed) return `${username} only reacted on it and nobody addressed them`;
  if (pushed === 0 && since.authorComments === 0) return 'nothing since the review';
  return null;
}

/**
 * Scan one reviewed PR's activity. Returns the follow-up when something
 * after the user's last comment, review or inline comment asks for another
 * look, or null when:
 * - the user never commented or reviewed (the search can return a PR whose
 *   only comment of theirs was deleted), or the PR is no longer open;
 * - nothing happened since: no non-merge commit by a non-bot account other
 *   than the user, no non-reaction comment by the PR author, and no comment
 *   addressed to the user (reply in one of their inline threads, quote of
 *   their prose, @mention) by anyone who is not the user or a bot;
 * - the user's only words on the PR were reactions ("+1", "same here"):
 *   then pushes and author replies are not for them, and only a comment
 *   addressed to them counts.
 *
 * `rebased`, `mergedUpstream` and `baseUnknown` come from the commit list
 * (see `commitsSince`); `compareRange` and `compareUrl` are left for the
 * daily phase, which asks GitHub whether `reviewedSha` is still an ancestor
 * of the head when none of the three applies.
 */
export function scanReviewedPR(
  ref: ReviewedPRRef,
  activity: ReviewedPRActivity,
  username: string,
): ReviewedPRFollowUp | null {
  const author = activity.pr.author ?? ref.author;
  const skip = skipReason(activity, author, username);
  if (skip !== null) {
    debug(MODULE, `Skipping ${ref.url}: ${skip}`);
    return null;
  }
  const usernameLower = username.toLowerCase();
  const entries = threadEntries(activity);
  const user = scanUser(entries, usernameLower);
  if (!user.last) {
    debug(MODULE, `Skipping ${ref.url}: no comment or review by ${username}`);
    return null;
  }
  const { pushed, reviewedSha, rebased, mergedUpstream, baseUnknown } = commitsSince(
    activity,
    user.last,
    usernameLower,
  );
  const since = collectActivitySince(entries, pushed, {
    user,
    usernameLower,
    authorLower: author.toLowerCase(),
    mention: mentionPattern(username),
  });
  const quiet = quietReason(since, pushed.length, user, username);
  if (quiet !== null) {
    debug(MODULE, `Skipping ${ref.url}: ${quiet}`);
    return null;
  }

  return {
    author,
    rebased,
    mergedUpstream,
    baseUnknown,
    prUrl: ref.url,
    repo: ref.repo,
    number: ref.number,
    title: activity.pr.title ?? ref.title,
    reviewedAt: user.last.at,
    ...(reviewedSha !== undefined && { reviewedSha }),
    headSha: activity.pr.headSha,
    commits: pushed.slice(0, REVIEWED_PR_MAX_COMMITS).map(({ sha, author: login, date, subject }) => ({
      sha,
      date,
      subject,
      author: login,
    })),
    moreCommits: Math.max(0, pushed.length - REVIEWED_PR_MAX_COMMITS),
    authorComments: since.authorComments,
    questions: since.questions.slice(0, REVIEWED_PR_MAX_QUESTIONS),
    moreQuestions: Math.max(0, since.questions.length - REVIEWED_PR_MAX_QUESTIONS),
    latestActivityAt: since.latestAt,
  };
}
