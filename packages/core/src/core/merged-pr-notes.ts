/**
 * Maintainer notes on recently merged PRs (#1861).
 *
 * The daily run stops looking at a PR once it merges, so a maintainer's
 * thank-you or follow-up note posted at merge time never surfaced. This
 * module decides, for one merged PR and its fetched activity, which notes
 * still wait for a word from the user: comments, reviews and inline review
 * comments from maintainers that landed after the user's last comment and no
 * earlier than an hour before the merge, plus commits someone else pushed on
 * top of the user's last commit (the maintainer changed what shipped).
 *
 * Pure logic only. Fetching lives in `PRMonitor.fetchMergedPRActivity`;
 * orchestration, the dismiss check and the warnings live in
 * commands/daily-merged-pr-notes.ts.
 *
 * The <100-character acknowledgment filter in `isAcknowledgmentComment` is
 * deliberately NOT applied here: it exists so a thanks never marks an open PR
 * as needing work, and after merge a short thanks is exactly the note this
 * path is for.
 */

import type { MergedPR } from './types.js';
import { isBotAuthor } from './comment-utils.js';
import { isMaintainerEngagement } from './review-analysis.js';
import { debug } from './logger.js';

const MODULE = 'merged-pr-notes';

/**
 * How long before the merge a maintainer note still counts. A thanks typed
 * just before clicking merge belongs to the merge; process chatter resolved
 * earlier ("CI is failing", "needs a rebase") does not.
 */
export const MERGED_PR_NOTES_PRE_MERGE_GRACE_MS = 60 * 60 * 1000;

/** Longest excerpt carried in the digest; matches `lastMaintainerComment`. */
const EXCERPT_LENGTH = 200;

export type MergedPRNoteKind = 'comment' | 'review' | 'review_comment' | 'commit';

/** One maintainer note on a merged PR, as surfaced in the digest. */
export interface MergedPRNote {
  author: string;
  createdAt: string;
  kind: MergedPRNoteKind;
  /** First 200 characters of the comment body or the commit subject line. */
  excerpt: string;
}

/** A merged PR with at least one maintainer note the user has not answered. */
export interface MergedPRNotes {
  prUrl: string;
  repo: string;
  number: number;
  title: string;
  mergedAt: string;
  /** Oldest first. */
  notes: MergedPRNote[];
  /** Commits by someone other than the user pushed after the user's last commit. */
  maintainerCommits: number;
  /**
   * Heuristic: every note reads as thanks or praise (keyword, no question,
   * short, no change-related wording) and nobody pushed on top. The workflow
   * confirms this with the comment-decision classification before acting on
   * it; see {@link groupThanksOnlyAcknowledgments}.
   */
  thanksOnly: boolean;
  /**
   * Set when another thanks-only merged PR in the same repo was merged more
   * recently: one acknowledgment on that PR covers this one too, so the
   * workflow should not draft a separate reply here.
   */
  ackCoveredBy?: string;
}

type Actor = {
  user?: { login?: string; type?: string | null } | null;
  author_association?: string | null;
};

/**
 * Everything on a merged PR the selection reads, in the shapes the Octokit
 * list endpoints return (structural, so responses assign directly).
 */
export interface MergedPRActivity {
  comments: Array<Actor & { body?: string | null; created_at: string }>;
  reviews: Array<Actor & { body?: string | null; submitted_at?: string | null; state?: string | null }>;
  reviewComments: Array<Actor & { body?: string | null; created_at: string }>;
  commits: Array<{
    author?: { login?: string; type?: string | null } | null;
    commit: { message?: string | null; author?: { date?: string | null } | null };
  }>;
}

/** A candidate note with its full body kept for classification. */
interface RawNote extends MergedPRNote {
  body: string;
}

const THANKS_PATTERN =
  /\b(?:thanks|thank you|thank u|thx|appreciate[ds]?|kudos|nice work|great work|good work|well done|great job|nice job|good job)\b/i;

/** Wording that means the note says more than thanks: something changed or is still to come. */
const CHANGE_PATTERN =
  /\b(?:chang|rework|moved|renam|push|commit|instead|replac|revert|follow[- ]?up|release|ship|tweak|adjust|also|however|but)\w*/i;

/**
 * Whether a note is thanks or praise and nothing else. Conservative: a
 * question mark, change-related wording, or a long body all disqualify it,
 * so a "thanks, but I renamed the flag" never collapses into a bare ack.
 */
export function isThanksOnlyNote(body: string): boolean {
  const text = body.trim();
  if (!text || text.length > 160 || text.includes('?')) return false;
  return THANKS_PATTERN.test(text) && !CHANGE_PATTERN.test(text);
}

function excerptOf(body: string): string {
  const flat = body.replaceAll(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH)}...` : flat;
}

function parseMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Insert `note` keeping `notes` ordered oldest first (lists are tiny). */
function insertByTime(notes: RawNote[], note: RawNote): void {
  let index = notes.length;
  while (index > 0 && Date.parse(notes[index - 1].createdAt) > Date.parse(note.createdAt)) index--;
  notes.splice(index, 0, note);
}

function toMergedPRNote({ author, createdAt, kind, excerpt }: RawNote): MergedPRNote {
  return { author, createdAt, kind, excerpt };
}

interface ThreadScan {
  /** Maintainer comments, reviews and inline comments inside the merge window, in input order. */
  candidates: RawNote[];
  /** Author date of the user's latest comment, review or inline comment; -Infinity when none. */
  lastUserCommentMs: number;
}

/** Walk the comment-shaped activity once, separating the user's own entries from maintainer candidates. */
function scanThread(activity: MergedPRActivity, username: string, earliestNoteMs: number): ThreadScan {
  const usernameLower = username.toLowerCase();
  const scan: ThreadScan = { candidates: [], lastUserCommentMs: -Infinity };

  const consider = (
    actor: Actor,
    body: string | null | undefined,
    at: string | null | undefined,
    kind: MergedPRNoteKind,
  ) => {
    const atMs = parseMs(at);
    if (!at || atMs === undefined) return;
    if (actor.user?.login?.toLowerCase() === usernameLower) {
      scan.lastUserCommentMs = Math.max(scan.lastUserCommentMs, atMs);
      return;
    }
    const text = (body ?? '').trim();
    const engagement = kind === 'comment' ? 'issue-comment' : 'review';
    if (!text || atMs < earliestNoteMs || !isMaintainerEngagement(actor, username, engagement)) return;
    scan.candidates.push({
      kind,
      author: actor.user?.login ?? 'unknown',
      createdAt: at,
      excerpt: excerptOf(text),
      body: text,
    });
  };

  for (const comment of activity.comments) consider(comment, comment.body, comment.created_at, 'comment');
  for (const review of activity.reviews) consider(review, review.body, review.submitted_at, 'review');
  for (const comment of activity.reviewComments) consider(comment, comment.body, comment.created_at, 'review_comment');
  return scan;
}

interface CommitScan {
  /** Commits by a non-bot account other than the user, in input order. */
  commitNotes: RawNote[];
  /** Author date of the user's latest commit; -Infinity when none. */
  lastUserCommitMs: number;
}

/** Walk the PR's commits once, by GitHub author login and author date. */
function scanCommits(commits: MergedPRActivity['commits'], usernameLower: string): CommitScan {
  const scan: CommitScan = { commitNotes: [], lastUserCommitMs: -Infinity };
  for (const entry of commits) {
    const date = entry.commit.author?.date;
    const atMs = parseMs(date);
    if (!date || atMs === undefined) continue;
    const login = entry.author?.login;
    const isUserCommit = login?.toLowerCase() === usernameLower;
    if (isUserCommit) {
      scan.lastUserCommitMs = Math.max(scan.lastUserCommitMs, atMs);
    }
    // A commit with no linked GitHub account is left alone: there is no way
    // to tell whose it is, so never claim a maintainer pushed on top.
    if (!isUserCommit && login && !isBotAuthor(login, entry.author?.type)) {
      const subject = (entry.commit.message ?? '').split('\n', 1)[0].trim();
      scan.commitNotes.push({
        kind: 'commit',
        author: login,
        createdAt: date,
        excerpt: excerptOf(subject),
        body: subject,
      });
    }
  }
  return scan;
}

/**
 * Collect the maintainer notes on one merged PR that still wait for the
 * user, or null when there are none.
 *
 * A comment, review (non-empty body) or inline review comment counts when:
 * - it is maintainer engagement in the {@link isMaintainerEngagement} sense
 *   (never the user, never a bot; issue comments need an OWNER / MEMBER /
 *   COLLABORATOR association when one is known);
 * - it was posted after the user's last comment, review or inline review
 *   comment on the PR, so anything the user already answered drops out;
 * - it was posted no earlier than {@link MERGED_PR_NOTES_PRE_MERGE_GRACE_MS}
 *   before `mergedAt`.
 *
 * A commit counts when its GitHub author is a non-bot account other than
 * the user and its author date is after both the user's last commit and the
 * user's last comment. Commits are not bound to the merge time: a maintainer
 * who pushed on top the day before merging still changed what shipped.
 */
export function collectMergedPRNotes(pr: MergedPR, activity: MergedPRActivity, username: string): MergedPRNotes | null {
  const mergedMs = parseMs(pr.mergedAt);
  if (mergedMs === undefined) {
    debug(MODULE, `Skipping ${pr.url}: mergedAt ${JSON.stringify(pr.mergedAt)} does not parse`);
    return null;
  }
  const thread = scanThread(activity, username, mergedMs - MERGED_PR_NOTES_PRE_MERGE_GRACE_MS);
  const commits = scanCommits(activity.commits, username.toLowerCase());

  const notes: RawNote[] = [];
  for (const note of thread.candidates) {
    if (Date.parse(note.createdAt) > thread.lastUserCommentMs) insertByTime(notes, note);
  }
  for (const note of commits.commitNotes) {
    const atMs = Date.parse(note.createdAt);
    if (atMs > thread.lastUserCommentMs && atMs > commits.lastUserCommitMs) insertByTime(notes, note);
  }
  if (notes.length === 0) return null;

  const maintainerCommits = notes.filter((note) => note.kind === 'commit').length;
  const isThanksOnly = maintainerCommits === 0 && notes.every((note) => isThanksOnlyNote(note.body));
  return {
    maintainerCommits,
    thanksOnly: isThanksOnly,
    prUrl: pr.url,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    mergedAt: pr.mergedAt,
    notes: notes.map((note) => toMergedPRNote(note)),
  };
}

/** ISO timestamp of the newest note, for the dismiss comparison in the daily phase. */
export function latestNoteAt(entry: Pick<MergedPRNotes, 'notes'>): string {
  let latest = entry.notes[0].createdAt;
  for (const note of entry.notes) {
    if (Date.parse(note.createdAt) > Date.parse(latest)) latest = note.createdAt;
  }
  return latest;
}

/**
 * When several thanks-only merged PRs share a repo, mark all but the most
 * recently merged one as covered by it (`ackCoveredBy`), so the user is
 * offered one acknowledgment per repo instead of N near-identical comments.
 * Entries with substantive notes are untouched. Returns a new array in the
 * input order.
 */
export function groupThanksOnlyAcknowledgments(entries: readonly MergedPRNotes[]): MergedPRNotes[] {
  const latestThanksByRepo = new Map<string, MergedPRNotes>();
  for (const entry of entries) {
    if (!entry.thanksOnly) continue;
    const key = entry.repo.toLowerCase();
    const current = latestThanksByRepo.get(key);
    if (!current || Date.parse(entry.mergedAt) > Date.parse(current.mergedAt)) latestThanksByRepo.set(key, entry);
  }
  return entries.map((entry) => {
    if (!entry.thanksOnly) return { ...entry };
    const carrier = latestThanksByRepo.get(entry.repo.toLowerCase());
    if (!carrier || carrier === entry) return { ...entry };
    return { ...entry, ackCoveredBy: carrier.prUrl };
  });
}
