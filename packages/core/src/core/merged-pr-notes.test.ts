/**
 * Tests for merged-pr-notes.ts (#1861): which maintainer notes on a merged
 * PR still wait for the user, and how thanks-only PRs collapse per repo.
 */

import { describe, it, expect } from 'vitest';
import {
  MERGED_PR_NOTES_PRE_MERGE_GRACE_MS,
  collectMergedPRNotes,
  groupThanksOnlyAcknowledgments,
  isThanksOnlyNote,
  latestNoteAt,
  omitAcknowledgedViaCarrier,
  scanMergedPR,
  type MergedPRActivity,
  type MergedPRNotes,
} from './merged-pr-notes.js';
import type { MergedPR } from './types.js';

const USER = 'contributor';
const MERGED_AT = '2026-06-02T12:00:00Z';
const MERGED_MS = Date.parse(MERGED_AT);
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function iso(offsetMs: number): string {
  const date = new Date(MERGED_MS + offsetMs);
  return date.toISOString();
}

/** A second after the merge: the typical "merged, thanks!" timestamp. */
const AT_MERGE = iso(1000);
const AFTER_MERGE = iso(2000);

const PR: MergedPR = {
  url: 'https://github.com/org/repo/pull/20',
  repo: 'org/repo',
  number: 20,
  title: 'Fix the thing',
  mergedAt: MERGED_AT,
};

function activity(overrides: Partial<MergedPRActivity> = {}): MergedPRActivity {
  return { comments: [], reviews: [], reviewComments: [], commits: [], ...overrides };
}

type Comment = MergedPRActivity['comments'][number];
type Review = MergedPRActivity['reviews'][number];
type Commit = MergedPRActivity['commits'][number];

function comment(login: string, body: string, createdAt: string, extra: Partial<Comment> = {}): Comment {
  return { body, user: { login }, author_association: 'MEMBER', created_at: createdAt, ...extra };
}

function review(login: string, body: string, submittedAt: string, extra: Partial<Review> = {}): Review {
  return {
    body,
    user: { login },
    author_association: 'MEMBER',
    submitted_at: submittedAt,
    state: 'COMMENTED',
    ...extra,
  };
}

function commit(login: string | undefined, date: string, message = 'Handle two more cases'): Commit {
  return {
    author: login === undefined ? null : { login },
    committer: login === undefined ? null : { login },
    commit: { message, author: { date }, committer: { date } },
    parents: [{ sha: 'p1' }],
  };
}

/** `commit` after someone else rebased the branch: committer identity and date rewritten, author date kept. */
function rebasedBy(base: Commit, committer: string, rebasedAt: string): Commit {
  return { ...base, committer: { login: committer }, commit: { ...base.commit, committer: { date: rebasedAt } } };
}

/** GitHub's "Update branch" / merge-from-base commit: two parents, no new work. */
function mergeCommit(login: string, date: string): Commit {
  return {
    author: { login },
    commit: { message: "Merge branch 'main' into fix", author: { date }, committer: { date } },
    parents: [{ sha: 'a' }, { sha: 'b' }],
  };
}

describe('collectMergedPRNotes: comments, reviews and inline comments', () => {
  it('surfaces a short thanks-only comment posted at merge (no <100-char filter on this path)', () => {
    const act = activity({ comments: [comment('maintainer', 'Thanks!', AT_MERGE)] });
    expect(collectMergedPRNotes(PR, act, USER)).toEqual({
      prUrl: 'https://github.com/org/repo/pull/20',
      repo: 'org/repo',
      number: 20,
      title: 'Fix the thing',
      mergedAt: MERGED_AT,
      notes: [{ author: 'maintainer', createdAt: AT_MERGE, kind: 'comment', excerpt: 'Thanks!' }],
      maintainerCommits: 0,
      thanksOnly: true,
    });
  });

  it('ignores a comment posted more than an hour before the merge (process chatter resolved earlier)', () => {
    const tooEarly = iso(-MERGED_PR_NOTES_PRE_MERGE_GRACE_MS - 1000);
    const justInTime = iso(-MERGED_PR_NOTES_PRE_MERGE_GRACE_MS);
    const early = activity({ comments: [comment('maintainer', 'CI is failing', tooEarly)] });
    expect(collectMergedPRNotes(PR, early, USER)).toBeNull();
    const inTime = activity({ comments: [comment('maintainer', 'Thanks, merging', justInTime)] });
    const result = collectMergedPRNotes(PR, inTime, USER);
    expect(result?.notes.map((n) => n.createdAt)).toEqual([justInTime]);
  });

  it('returns nothing once the user replied after the note', () => {
    const act = activity({
      comments: [
        comment('maintainer', 'Thanks for the PR!', AT_MERGE),
        comment(USER.toUpperCase(), 'Glad it helped', AFTER_MERGE, { author_association: 'CONTRIBUTOR' }),
      ],
    });
    expect(collectMergedPRNotes(PR, act, USER)).toBeNull();
  });

  it("keeps notes newer than the user's last reply and drops older ones", () => {
    const act = activity({
      comments: [
        comment('maintainer', 'One small nit', iso(-1000)),
        comment(USER, 'Done', iso(0)),
        comment('maintainer', 'Thanks!', AT_MERGE),
      ],
    });
    const result = collectMergedPRNotes(PR, act, USER);
    expect(result?.notes.map((n) => n.excerpt)).toEqual(['Thanks!']);
  });

  it("treats the user's review and inline review comment as replies too", () => {
    const byReview = activity({
      comments: [comment('maintainer', 'Thanks!', AT_MERGE)],
      reviews: [{ user: { login: USER }, body: 'Looks right', submitted_at: AFTER_MERGE, state: 'COMMENTED' }],
    });
    expect(collectMergedPRNotes(PR, byReview, USER)).toBeNull();
    const byInline = activity({
      comments: [comment('maintainer', 'Thanks!', AT_MERGE)],
      reviewComments: [{ user: { login: USER }, body: 'Agreed', created_at: AFTER_MERGE }],
    });
    expect(collectMergedPRNotes(PR, byInline, USER)).toBeNull();
  });

  it("counts the user's empty-body APPROVED review as a reply", () => {
    const act = activity({
      comments: [comment('maintainer', 'Thanks!', AT_MERGE)],
      reviews: [{ user: { login: USER }, body: '', submitted_at: AFTER_MERGE, state: 'APPROVED' }],
    });
    expect(collectMergedPRNotes(PR, act, USER)).toBeNull();
  });

  it('still surfaces a maintainer thanks when only a bot commented after it', () => {
    const act = activity({
      comments: [
        comment('maintainer', 'Thanks!', AT_MERGE),
        comment('github-actions[bot]', 'This PR is included in release v1.2.0', AFTER_MERGE, {
          user: { login: 'github-actions[bot]', type: 'Bot' },
          author_association: 'NONE',
        }),
      ],
    });
    expect(collectMergedPRNotes(PR, act, USER)?.notes.map((n) => n.excerpt)).toEqual(['Thanks!']);
  });

  it('ignores bots, deleted accounts, and drive-by issue comments without a maintainer association', () => {
    const act = activity({
      comments: [
        comment('github-actions[bot]', 'Thanks for your contribution!', AT_MERGE),
        comment('copilot', 'Thanks!', AT_MERGE, { user: { login: 'Copilot', type: 'Bot' } }),
        { user: null, body: 'Thanks!', created_at: AT_MERGE },
        comment('passerby', 'thanks, this fixed it for me too', AT_MERGE, { author_association: 'NONE' }),
      ],
    });
    expect(collectMergedPRNotes(PR, act, USER)).toBeNull();
  });

  it('includes reviews with a body and inline review comments from maintainers, not from community members', () => {
    const act = activity({
      reviews: [
        review('codeowner', 'LGTM, thanks', iso(500), { state: 'APPROVED' }),
        review('codeowner', '', iso(600), { state: 'APPROVED' }),
        review('other', '  ', iso(700)),
        // A community "LGTM" is not a maintainer note.
        review('fan', 'LGTM!', iso(750), { author_association: 'CONTRIBUTOR', state: 'APPROVED' }),
        review('passerby', 'LGTM', iso(760), { author_association: 'NONE', state: 'APPROVED' }),
      ],
      reviewComments: [
        {
          user: { login: 'codeowner' },
          author_association: 'OWNER',
          body: 'moved this helper up',
          created_at: iso(800),
        },
        { user: { login: 'fan' }, author_association: 'CONTRIBUTOR', body: 'nice', created_at: iso(900) },
        // Unknown association (older data) still passes, as on the issue-comment path.
        { user: { login: 'legacy' }, body: 'tidied the import order', created_at: iso(950) },
      ],
    });
    const result = collectMergedPRNotes(PR, act, USER);
    expect(result?.notes).toEqual([
      { author: 'codeowner', createdAt: iso(500), kind: 'review', excerpt: 'LGTM, thanks' },
      { author: 'codeowner', createdAt: iso(800), kind: 'review_comment', excerpt: 'moved this helper up' },
      { author: 'legacy', createdAt: iso(950), kind: 'review_comment', excerpt: 'tidied the import order' },
    ]);
    expect(result?.thanksOnly).toBe(false);
  });

  it('sorts notes oldest first and truncates long excerpts at 200 characters', () => {
    const long = `Thanks ${'x'.repeat(300)}`;
    const act = activity({
      comments: [comment('maintainer', long, AFTER_MERGE), comment('maintainer', 'first  line\nsecond', AT_MERGE)],
    });
    const result = collectMergedPRNotes(PR, act, USER);
    expect(result?.notes.map((n) => n.excerpt)).toEqual(['first line second', `${long.slice(0, 200)}...`]);
  });

  it('returns null when mergedAt does not parse or nothing is left', () => {
    const act = activity({ comments: [comment('maintainer', 'Thanks', AT_MERGE)] });
    expect(collectMergedPRNotes({ ...PR, mergedAt: '' }, act, USER)).toBeNull();
    expect(collectMergedPRNotes(PR, activity(), USER)).toBeNull();
  });
});

describe('collectMergedPRNotes: commits', () => {
  it("flags a maintainer commit pushed after the user's last commit as a 'changed what shipped' note", () => {
    const maintainerPushAt = iso(-2 * DAY_MS);
    const act = activity({
      commits: [
        commit(USER, iso(-3 * DAY_MS), 'Fix the thing'),
        commit('maintainer', maintainerPushAt, 'Handle two more cases\n\nLonger body here'),
      ],
      comments: [comment('maintainer', 'thank you', AT_MERGE)],
    });
    const result = collectMergedPRNotes(PR, act, USER);
    expect(result?.maintainerCommits).toBe(1);
    expect(result?.thanksOnly).toBe(false);
    expect(result?.notes).toEqual([
      { author: 'maintainer', createdAt: maintainerPushAt, kind: 'commit', excerpt: 'Handle two more cases' },
      { author: 'maintainer', createdAt: AT_MERGE, kind: 'comment', excerpt: 'thank you' },
    ]);
  });

  it("does not flag commits before the user's last commit, after the user's last comment, by bots, or without a linked account", () => {
    const earlier = iso(-5 * DAY_MS);
    const later = iso(-DAY_MS);
    const thanks = comment('maintainer', 'Thanks!', AT_MERGE);
    const userAck = comment(USER, 'thanks for the extra cases', iso(-60 * MINUTE_MS));
    const notFlagged = [
      activity({ comments: [thanks], commits: [commit('maintainer', earlier), commit(USER, later)] }),
      activity({ comments: [thanks, userAck], commits: [commit(USER, earlier), commit('maintainer', later)] }),
      activity({ comments: [thanks], commits: [commit(USER, earlier), commit('pre-commit-ci[bot]', later)] }),
      activity({ comments: [thanks], commits: [commit(USER, earlier), commit(undefined, later)] }),
    ];
    for (const act of notFlagged) {
      const result = collectMergedPRNotes(PR, act, USER);
      expect(result?.notes.filter((n) => n.kind === 'commit')).toEqual([]);
      expect(result?.maintainerCommits).toBe(0);
    }
  });

  it('skips merge commits ("Update branch") on both sides: not a maintainer note, not the user\'s last commit', () => {
    const userFixAt = iso(-3 * DAY_MS);
    const maintainerPushAt = iso(-2 * DAY_MS);
    // A maintainer's "Update branch" is not a change to what shipped.
    const byMaintainer = activity({
      comments: [comment('maintainer', 'Thanks!', AT_MERGE)],
      commits: [commit(USER, userFixAt, 'Fix'), mergeCommit('maintainer', maintainerPushAt)],
    });
    const result = collectMergedPRNotes(PR, byMaintainer, USER);
    expect(result?.maintainerCommits).toBe(0);
    expect(result?.thanksOnly).toBe(true);
    // The user's own "Update branch" after a maintainer commit does not hide that commit.
    const byUser = activity({
      comments: [comment('maintainer', 'Thanks!', AT_MERGE)],
      commits: [
        commit(USER, userFixAt, 'Fix'),
        commit('maintainer', maintainerPushAt),
        mergeCommit(USER, iso(-DAY_MS)),
      ],
    });
    expect(collectMergedPRNotes(PR, byUser, USER)?.notes.map((n) => n.kind)).toEqual(['commit', 'comment']);
  });

  it("treats the user's commit after a review as answering it (changes requested 45 min before merge, fix pushed 30 min before)", () => {
    const changesRequested = review('maintainer', 'Please handle the empty case too', iso(-45 * MINUTE_MS), {
      state: 'CHANGES_REQUESTED',
    });
    const fixPushed = commit(USER, iso(-30 * MINUTE_MS), 'Handle the empty case');
    const answered = activity({ reviews: [changesRequested], commits: [fixPushed] });
    expect(collectMergedPRNotes(PR, answered, USER)).toBeNull();
    // A note after the fix still surfaces.
    const withThanks = activity({
      reviews: [changesRequested],
      commits: [fixPushed],
      comments: [comment('maintainer', 'Thanks!', AT_MERGE)],
    });
    expect(collectMergedPRNotes(PR, withThanks, USER)?.notes.map((n) => n.excerpt)).toEqual(['Thanks!']);
  });

  it("dates the user's own rebase by committer date, falling back to the author date", () => {
    const reviewAt = iso(-45 * MINUTE_MS);
    // Authored before the review, rebased (committed) by the user after it.
    const rebasedFix = rebasedBy(commit(USER, iso(-2 * DAY_MS), 'Fix'), USER, iso(-30 * MINUTE_MS));
    const act = activity({
      reviews: [review('maintainer', 'Please handle the empty case too', reviewAt, { state: 'CHANGES_REQUESTED' })],
      commits: [rebasedFix],
    });
    expect(collectMergedPRNotes(PR, act, USER)).toBeNull();

    const authorDateOnly: Commit = {
      author: { login: 'maintainer' },
      committer: { login: 'maintainer' },
      commit: { message: 'Cover one more case', author: { date: iso(-DAY_MS) }, committer: null },
    };
    const fallback = activity({ commits: [commit(USER, iso(-2 * DAY_MS)), authorDateOnly] });
    expect(collectMergedPRNotes(PR, fallback, USER)?.notes).toEqual([
      { author: 'maintainer', createdAt: iso(-DAY_MS), kind: 'commit', excerpt: 'Cover one more case' },
    ]);
    const committerDateOnly: Commit = {
      author: { login: USER },
      committer: { login: 'maintainer' },
      commit: { message: 'Fix', author: null, committer: { date: iso(-2 * DAY_MS) } },
    };
    const userFallback = activity({ commits: [committerDateOnly, commit('maintainer', iso(-DAY_MS))] });
    expect(collectMergedPRNotes(PR, userFallback, USER)?.maintainerCommits).toBe(1);
  });

  describe("a maintainer's rebase rewrites every committer date, so the user's commits keep their author date", () => {
    const userFixAt = iso(-3 * DAY_MS);
    const maintainerPushAt = iso(-2 * DAY_MS);
    const noteBeforeRebaseAt = iso(-50 * MINUTE_MS);
    const rebasedAt = iso(-20 * MINUTE_MS);
    const expectedNotes = [
      { author: 'maintainer', createdAt: maintainerPushAt, kind: 'commit', excerpt: 'Handle two more cases' },
      { author: 'maintainer', createdAt: noteBeforeRebaseAt, kind: 'comment', excerpt: 'I also tightened the regex' },
      { author: 'maintainer', createdAt: AT_MERGE, kind: 'comment', excerpt: 'Thanks!' },
    ];

    it.each([
      ['a local rebase and force push', 'maintainer'],
      ['"Update branch" with rebase on github.com', 'web-flow'],
    ])('after %s (committer %s)', (_how, committer) => {
      const act = activity({
        comments: [
          comment('maintainer', 'I also tightened the regex', noteBeforeRebaseAt),
          comment('maintainer', 'Thanks!', AT_MERGE),
        ],
        commits: [
          rebasedBy(commit(USER, userFixAt, 'Fix'), committer, rebasedAt),
          rebasedBy(commit('maintainer', maintainerPushAt), committer, rebasedAt),
        ],
      });
      const result = collectMergedPRNotes(PR, act, USER);
      expect(result?.notes).toEqual(expectedNotes);
      expect(result?.maintainerCommits).toBe(1);
      expect(result?.thanksOnly).toBe(false);
    });
  });
});

describe('scanMergedPR', () => {
  it("reports a thanks-only thread and the user's last comment even once the user has replied", () => {
    const act = activity({
      comments: [comment('maintainer', 'Thanks!', AT_MERGE), comment(USER, 'Happy to help', AFTER_MERGE)],
    });
    expect(scanMergedPR(PR, act, USER)).toEqual({
      pending: null,
      thanksOnlyThread: true,
      lastUserCommentMs: Date.parse(AFTER_MERGE),
    });
  });

  it('does not call a thread thanks-only when it had a substantive note, a maintainer commit, or no note at all', () => {
    const substantive = activity({ comments: [comment('maintainer', 'Thanks, I renamed the flag', AT_MERGE)] });
    expect(scanMergedPR(PR, substantive, USER).thanksOnlyThread).toBe(false);
    const pushedOnTop = activity({
      comments: [comment('maintainer', 'Thanks!', AT_MERGE)],
      commits: [commit(USER, iso(-2 * DAY_MS)), commit('maintainer', iso(-DAY_MS))],
    });
    expect(scanMergedPR(PR, pushedOnTop, USER).thanksOnlyThread).toBe(false);
    expect(scanMergedPR(PR, activity(), USER)).toEqual({
      pending: null,
      thanksOnlyThread: false,
      lastUserCommentMs: -Infinity,
    });
  });
});

describe('isThanksOnlyNote', () => {
  it.each([
    'Thanks for the PR, I really appreciate it. Have a great weekend!',
    'thank you',
    'LGTM, nice work',
    'Thanks for the patch!',
    'Thanks! Is this in 2.0',
  ])('accepts %j', (body) => {
    expect(isThanksOnlyNote(body)).toBe(true);
  });

  it.each([
    // Conservative by design: "fix" reads as a change stem, so this thanks
    // is handled on its own instead of being folded into a repo-wide ack.
    'Thanks for the fix!',
    'Thanks! Could you also open a follow-up for the docs?',
    'Thanks. I reworked the flag into a positional argument because it reads better.',
    'Thanks, I pushed a commit on top covering two extra cases.',
    'This ships in the next release via the dependency bump.',
    'Thanks! Does this need a changelog entry?',
    // Same shape as the accepted "Thanks! Is this in 2.0": the question mark alone rejects it.
    'Thanks! Is this in 2.0?',
    `Thanks ${'for everything '.repeat(20)}`,
    '',
  ])('rejects %j', (body) => {
    expect(isThanksOnlyNote(body)).toBe(false);
  });

  it.each([
    ['fix', 'Thanks, fixed the typo on the way in'],
    ['add', 'Thanks, added a test for the empty case'],
    ['remov', 'Thanks! Removed the stray console.log'],
    ['updat', 'Thanks, updated the snapshot'],
    ['drop', 'Thanks, dropped the unused import'],
    ['delet', 'Thanks, deleted the dead branch'],
    ['rebas', 'Thanks, rebased onto main before merging'],
    ['squash', 'Thanks, squashed the fixups'],
    ['simplif', 'Thanks, simplified the loop a bit'],
    ['tid', 'Thanks, tidied the imports'],
    ['clean', 'Thanks, cleaned up the naming'],
  ])('rejects the %s stem: %j', (_stem, body) => {
    expect(isThanksOnlyNote(body)).toBe(false);
  });

  it('matches stems at a word start only', () => {
    expect(isThanksOnlyNote('Thanks, the prefix idea was great')).toBe(true);
    expect(isThanksOnlyNote('Thanks, nice and readable')).toBe(true);
  });
});

function entry(prUrl: string, repo: string, mergedAt: string, isThanksOnly: boolean, noteAt = mergedAt): MergedPRNotes {
  return {
    prUrl,
    repo,
    mergedAt,
    number: Number(prUrl.split('/').pop()),
    title: 't',
    notes: [{ author: 'm', createdAt: noteAt, kind: 'comment', excerpt: 'Thanks' }],
    maintainerCommits: 0,
    thanksOnly: isThanksOnly,
  };
}

describe('groupThanksOnlyAcknowledgments', () => {
  it('points older thanks-only PRs in a repo at the most recently merged one', () => {
    const grouped = groupThanksOnlyAcknowledgments([
      entry('https://github.com/org/repo/pull/1', 'org/repo', '2026-06-01T00:00:00Z', true),
      entry('https://github.com/org/repo/pull/3', 'Org/Repo', '2026-06-03T00:00:00Z', true),
      entry('https://github.com/org/repo/pull/2', 'org/repo', '2026-06-02T00:00:00Z', true),
    ]);
    expect(grouped.map((e) => [e.prUrl, e.ackCoveredBy])).toEqual([
      ['https://github.com/org/repo/pull/1', 'https://github.com/org/repo/pull/3'],
      ['https://github.com/org/repo/pull/3', undefined],
      ['https://github.com/org/repo/pull/2', 'https://github.com/org/repo/pull/3'],
    ]);
  });

  it('leaves substantive entries, other repos, and a lone thanks alone', () => {
    const input = [
      entry('https://github.com/org/repo/pull/1', 'org/repo', '2026-06-01T00:00:00Z', false),
      entry('https://github.com/org/repo/pull/2', 'org/repo', '2026-06-02T00:00:00Z', true),
      entry('https://github.com/org/other/pull/9', 'org/other', '2026-06-03T00:00:00Z', true),
    ];
    const grouped = groupThanksOnlyAcknowledgments(input);
    expect(grouped.every((e) => e.ackCoveredBy === undefined)).toBe(true);
    expect(grouped).toEqual(input);
    // Does not mutate the input.
    expect(input.every((e) => !('ackCoveredBy' in e))).toBe(true);
  });

  it('does not cover an older thanks with a newer PR whose note is thanks plus a question', () => {
    const older: MergedPR = { ...PR, url: 'https://github.com/org/repo/pull/1', number: 1, mergedAt: iso(-DAY_MS) };
    const newer: MergedPR = { ...PR, url: 'https://github.com/org/repo/pull/2', number: 2 };
    const olderThanks = comment('maintainer', 'Thanks!', iso(-DAY_MS + 1000));
    const newerThanksAndQuestion = comment('maintainer', 'Thanks! Does this need a changelog entry?', AT_MERGE);
    const olderNotes = collectMergedPRNotes(older, activity({ comments: [olderThanks] }), USER);
    const newerNotes = collectMergedPRNotes(newer, activity({ comments: [newerThanksAndQuestion] }), USER);
    expect(olderNotes?.thanksOnly).toBe(true);
    expect(newerNotes?.thanksOnly).toBe(false);
    const grouped = groupThanksOnlyAcknowledgments([olderNotes!, newerNotes!]);
    expect(grouped.map((e) => e.ackCoveredBy)).toEqual([undefined, undefined]);
  });
});

describe('omitAcknowledgedViaCarrier', () => {
  const older = entry(
    'https://github.com/org/repo/pull/1',
    'org/repo',
    '2026-06-01T00:00:00Z',
    true,
    '2026-06-01T00:00:01Z',
  );
  const carrier = { prUrl: 'https://github.com/org/repo/pull/3', repo: 'Org/Repo', mergedAt: '2026-06-03T00:00:00Z' };

  it("drops a thanks-only entry once the user commented on a later-merged thanks-only PR in the repo after the entry's note", () => {
    const acked = [{ ...carrier, lastUserCommentMs: Date.parse('2026-06-03T00:05:00Z') }];
    expect(omitAcknowledgedViaCarrier([older], acked)).toEqual([]);
  });

  it('keeps the entry when the comment predates its note, is on an older PR, another repo, or itself', () => {
    const beforeNote = [{ ...carrier, lastUserCommentMs: Date.parse('2026-05-31T00:00:00Z') }];
    const olderPR = [
      { ...carrier, mergedAt: '2026-05-30T00:00:00Z', lastUserCommentMs: Date.parse('2026-06-03T00:05:00Z') },
    ];
    const otherRepo = [{ ...carrier, repo: 'org/other', lastUserCommentMs: Date.parse('2026-06-03T00:05:00Z') }];
    const itself = [{ ...carrier, prUrl: older.prUrl, lastUserCommentMs: Date.parse('2026-06-03T00:05:00Z') }];
    const never = [{ ...carrier, lastUserCommentMs: -Infinity }];
    for (const carriers of [beforeNote, olderPR, otherRepo, itself, never, []]) {
      expect(omitAcknowledgedViaCarrier([older], carriers)).toEqual([older]);
    }
  });

  it('never drops a substantive entry', () => {
    const substantive = { ...older, thanksOnly: false };
    const acked = [{ ...carrier, lastUserCommentMs: Date.parse('2026-06-03T00:05:00Z') }];
    expect(omitAcknowledgedViaCarrier([substantive], acked)).toEqual([substantive]);
  });
});

describe('latestNoteAt', () => {
  it('returns the newest note timestamp regardless of order', () => {
    const notes: MergedPRNotes['notes'] = [
      { author: 'm', createdAt: '2026-06-02T00:00:00Z', kind: 'comment', excerpt: 'b' },
      { author: 'm', createdAt: '2026-06-03T00:00:00Z', kind: 'commit', excerpt: 'c' },
      { author: 'm', createdAt: '2026-06-01T00:00:00Z', kind: 'review', excerpt: 'a' },
    ];
    expect(latestNoteAt({ notes })).toBe('2026-06-03T00:00:00Z');
  });
});
