/**
 * Maintainer notes on recently merged PRs (#1861).
 *
 * The daily run stops looking at a PR once it merges, so a maintainer's
 * thank-you or follow-up note posted at merge time never surfaced. This
 * module decides, for one merged PR and its fetched activity, which notes
 * still wait for a word from the user: comments, reviews and inline review
 * comments from maintainers that landed after the user's last comment or
 * commit and no earlier than an hour before the merge, plus commits someone
 * else pushed on top of the user's last commit (the maintainer changed what
 * shipped).
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
    commit: {
      message?: string | null;
      author?: { date?: string | null } | null;
      committer?: { date?: string | null } | null;
    };
    /** More than one parent marks a merge commit ("Update branch"), which carries no new work. */
    parents?: Array<{ sha?: string }>;
  }>;
}

/** The four lists `PRMonitor.fetchMergedPRActivity` fetches, as named in truncation warnings. */
export type MergedPRActivityList = 'comments' | 'reviews' | 'review comments' | 'commits';

/** A candidate note with its full body kept for classification. */
interface RawNote extends MergedPRNote {
  body: string;
}

const THANKS_PATTERN =
  /\b(?:thanks|thank you|thank u|thx|appreciate[ds]?|kudos|nice work|great work|good work|well done|great job|nice job|good job)\b/i;

/**
 * Word stems that mean the note says more than thanks: something changed or
 * is still to come. Each matches at a word start (`\b` + stem + `\w*`), so
 * "fix" covers "fixed" / "fixes" but not "prefix".
 */
const CHANGE_STEMS = [
  'chang',
  'rework',
  'moved',
  'renam',
  'push',
  'commit',
  'instead',
  'replac',
  'revert',
  'follow[- ]?up',
  'release',
  'ship',
  'tweak',
  'adjust',
  'also',
  'however',
  'but',
  'fix',
  'add',
  'remov',
  'updat',
  'drop',
  'delet',
  'rebas',
  'squash',
  'simplif',
  'tid',
  'clean',
];
const CHANGE_PATTERN = new RegExp(String.raw`\b(?:${CHANGE_STEMS.join('|')})\w*`, 'i');

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

interface ThreadEntry {
  actor: Actor;
  body: string | null | undefined;
  at: string | null | undefined;
  kind: Exclude<MergedPRNoteKind, 'commit'>;
}

/** The comment-shaped activity (issue comments, reviews, inline comments) as one stream. */
function* threadEntries(activity: MergedPRActivity): Generator<ThreadEntry> {
  for (const comment of activity.comments) {
    yield { actor: comment, body: comment.body, at: comment.created_at, kind: 'comment' };
  }
  for (const review of activity.reviews) {
    yield { actor: review, body: review.body, at: review.submitted_at, kind: 'review' };
  }
  for (const comment of activity.reviewComments) {
    yield { actor: comment, body: comment.body, at: comment.created_at, kind: 'review_comment' };
  }
}

interface ThreadScan {
  /** Maintainer comments, reviews and inline comments inside the merge window, in input order. */
  candidates: RawNote[];
  /** Timestamp of the user's latest comment, review or inline comment; -Infinity when none. */
  lastUserCommentMs: number;
}

/**
 * Walk the comment-shaped activity once, separating the user's own entries
 * from maintainer candidates. The user's entries count whatever their body
 * (an empty-body APPROVED review is still a reply); a candidate needs a body
 * and the issue-comment maintainer rule of {@link isMaintainerEngagement}
 * for every kind, so a community member's "LGTM" review (CONTRIBUTOR / NONE)
 * is not a note. An unknown association (older data) still passes.
 */
function scanThread(activity: MergedPRActivity, username: string, earliestNoteMs: number): ThreadScan {
  const usernameLower = username.toLowerCase();
  const scan: ThreadScan = { candidates: [], lastUserCommentMs: -Infinity };
  const consider = ({ actor, body, at, kind }: ThreadEntry): void => {
    const atMs = parseMs(at);
    if (!at || atMs === undefined) return;
    if (actor.user?.login?.toLowerCase() === usernameLower) {
      scan.lastUserCommentMs = Math.max(scan.lastUserCommentMs, atMs);
      return;
    }
    const text = (body ?? '').trim();
    if (!text || atMs < earliestNoteMs || !isMaintainerEngagement(actor, username, 'issue-comment')) return;
    scan.candidates.push({
      kind,
      author: actor.user?.login ?? 'unknown',
      createdAt: at,
      excerpt: excerptOf(text),
      body: text,
    });
  };
  for (const entry of threadEntries(activity)) consider(entry);
  return scan;
}

interface CommitScan {
  /** Non-merge commits by a non-bot account other than the user, in input order. */
  commitNotes: RawNote[];
  /** Commit date of the user's latest non-merge commit; -Infinity when none. */
  lastUserCommitMs: number;
}

/**
 * Walk the PR's commits once, by GitHub author login. Timestamps use the
 * committer date (the author date survives rebases, so a fix the user
 * rebased onto the base branch would otherwise predate the review it
 * answers) and fall back to the author date when it is missing. Merge
 * commits (more than one parent, e.g. GitHub's "Update branch") carry no
 * new work and are skipped on both sides.
 */
function scanCommits(commits: MergedPRActivity['commits'], usernameLower: string): CommitScan {
  const scan: CommitScan = { commitNotes: [], lastUserCommitMs: -Infinity };
  const consider = (entry: MergedPRActivity['commits'][number]): void => {
    if ((entry.parents?.length ?? 0) > 1) return;
    const date = entry.commit.committer?.date ?? entry.commit.author?.date;
    const atMs = parseMs(date);
    if (!date || atMs === undefined) return;
    const login = entry.author?.login;
    if (login?.toLowerCase() === usernameLower) {
      scan.lastUserCommitMs = Math.max(scan.lastUserCommitMs, atMs);
      return;
    }
    // A commit with no linked GitHub account is left alone: there is no way
    // to tell whose it is, so never claim a maintainer pushed on top.
    if (!login || isBotAuthor(login, entry.author?.type)) return;
    const subject = (entry.commit.message ?? '').split('\n', 1)[0].trim();
    scan.commitNotes.push({
      kind: 'commit',
      author: login,
      createdAt: date,
      excerpt: excerptOf(subject),
      body: subject,
    });
  };
  for (const entry of commits) consider(entry);
  return scan;
}

/** Everything the daily phase needs to know about one merged PR's thread. */
export interface MergedPRScan {
  /** Notes still waiting for the user, or null when there are none. */
  pending: MergedPRNotes | null;
  /**
   * The maintainer notes inside the merge window, answered or not, were all
   * thanks and nobody pushed on top: this PR can carry the repo's single
   * acknowledgment. False when there were no maintainer notes at all.
   */
  thanksOnlyThread: boolean;
  /** Timestamp of the user's latest comment, review or inline comment; -Infinity when none. */
  lastUserCommentMs: number;
}

/**
 * Scan one merged PR's activity. {@link MergedPRScan.pending} holds the
 * notes that still wait for the user, following these rules:
 *
 * A comment, review (non-empty body) or inline review comment counts when:
 * - it is maintainer engagement in the issue-comment sense of
 *   {@link isMaintainerEngagement} (never the user, never a bot; an OWNER /
 *   MEMBER / COLLABORATOR association when one is known, for reviews and
 *   inline comments too);
 * - it was posted after the user's last comment, review, inline review
 *   comment AND last commit on the PR, so anything the user already answered
 *   in words or in code drops out;
 * - it was posted no earlier than {@link MERGED_PR_NOTES_PRE_MERGE_GRACE_MS}
 *   before `mergedAt`.
 *
 * A commit counts when it is not a merge commit, its GitHub author is a
 * non-bot account other than the user and its commit date is after both the
 * user's last commit and the user's last comment. Commits are not bound to
 * the merge time: a maintainer who pushed on top the day before merging
 * still changed what shipped.
 */
export function scanMergedPR(pr: MergedPR, activity: MergedPRActivity, username: string): MergedPRScan {
  const mergedMs = parseMs(pr.mergedAt);
  if (mergedMs === undefined) {
    debug(MODULE, `Skipping ${pr.url}: mergedAt ${JSON.stringify(pr.mergedAt)} does not parse`);
    return { pending: null, thanksOnlyThread: false, lastUserCommentMs: -Infinity };
  }
  const thread = scanThread(activity, username, mergedMs - MERGED_PR_NOTES_PRE_MERGE_GRACE_MS);
  const commits = scanCommits(activity.commits, username.toLowerCase());
  const threadCutoffMs = Math.max(thread.lastUserCommentMs, commits.lastUserCommitMs);

  // Commits by someone else after the user's last commit: "changed what shipped".
  const commitNotes = commits.commitNotes.filter((note) => Date.parse(note.createdAt) > commits.lastUserCommitMs);
  const isThanksOnlyThread =
    thread.candidates.length > 0 &&
    commitNotes.length === 0 &&
    thread.candidates.every((note) => isThanksOnlyNote(note.body));
  const scan: MergedPRScan = {
    pending: null,
    thanksOnlyThread: isThanksOnlyThread,
    lastUserCommentMs: thread.lastUserCommentMs,
  };

  const notes: RawNote[] = [];
  for (const note of thread.candidates) {
    if (Date.parse(note.createdAt) > threadCutoffMs) insertByTime(notes, note);
  }
  for (const note of commitNotes) {
    if (Date.parse(note.createdAt) > thread.lastUserCommentMs) insertByTime(notes, note);
  }
  if (notes.length === 0) return scan;

  const maintainerCommits = notes.filter((note) => note.kind === 'commit').length;
  scan.pending = {
    prUrl: pr.url,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    mergedAt: pr.mergedAt,
    notes: notes.map((note) => toMergedPRNote(note)),
    thanksOnly: maintainerCommits === 0 && notes.every((note) => isThanksOnlyNote(note.body)),
    maintainerCommits,
  };
  return scan;
}

/**
 * Collect the maintainer notes on one merged PR that still wait for the
 * user, or null when there are none. See {@link scanMergedPR} for the rules.
 */
export function collectMergedPRNotes(pr: MergedPR, activity: MergedPRActivity, username: string): MergedPRNotes | null {
  return scanMergedPR(pr, activity, username).pending;
}

/** ISO timestamp of the newest note, for the dismiss comparison in the daily phase. */
export function latestNoteAt(entry: Pick<MergedPRNotes, 'notes'>): string {
  let latest = entry.notes[0].createdAt;
  for (const note of entry.notes) {
    if (Date.parse(note.createdAt) > Date.parse(latest)) latest = note.createdAt;
  }
  return latest;
}

/** A merged PR that could carry a repo's acknowledgment, with the user's last word on it. */
export interface CarrierReply {
  prUrl: string;
  repo: string;
  mergedAt: string;
  /** Timestamp of the user's latest comment or review on that PR; -Infinity when none. */
  lastUserCommentMs: number;
}

/**
 * Drop the thanks-only entries the user already acknowledged through the
 * group's carrier: {@link groupThanksOnlyAcknowledgments} points older
 * thanks-only PRs in a repo at the most recently merged one, and the
 * workflow posts one acknowledgment there. On the next run that carrier has
 * no pending note of its own, so without this step the covered PRs would
 * come back as a new group. A thanks-only entry is covered when the user
 * commented on a thanks-only PR in the same repo that merged after it, and
 * that comment is newer than the entry's newest note. Substantive entries
 * are never dropped here.
 */
export function omitAcknowledgedViaCarrier(
  entries: readonly MergedPRNotes[],
  carriers: readonly CarrierReply[],
): MergedPRNotes[] {
  return entries.filter((entry) => {
    if (!entry.thanksOnly) return true;
    const repoKey = entry.repo.toLowerCase();
    const entryMergedMs = Date.parse(entry.mergedAt);
    const newestNoteMs = Date.parse(latestNoteAt(entry));
    const carrier = carriers.find(
      (candidate) =>
        candidate.prUrl !== entry.prUrl &&
        candidate.repo.toLowerCase() === repoKey &&
        Date.parse(candidate.mergedAt) > entryMergedMs &&
        candidate.lastUserCommentMs > newestNoteMs,
    );
    if (carrier) {
      debug(MODULE, `${entry.prUrl}: thanks acknowledged through the user's comment on ${carrier.prUrl}; skipping`);
    }
    return !carrier;
  });
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
