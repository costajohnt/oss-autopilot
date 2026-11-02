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
  type MergedPRActivity,
  type MergedPRNotes,
} from './merged-pr-notes.js';
import type { MergedPR } from './types.js';

const USER = 'contributor';
const MERGED_AT = '2026-06-02T12:00:00Z';
const MERGED_MS = Date.parse(MERGED_AT);
const DAY_MS = 24 * 60 * 60 * 1000;

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

function comment(login: string, body: string, createdAt: string, extra: Partial<Comment> = {}): Comment {
  return { body, user: { login }, author_association: 'MEMBER', created_at: createdAt, ...extra };
}

function commit(login: string | undefined, date: string, message = 'Handle two more cases') {
  return { author: login === undefined ? null : { login }, commit: { message, author: { date } } };
}

describe('collectMergedPRNotes', () => {
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

  it('includes reviews with a body and inline review comments from any non-bot account', () => {
    const act = activity({
      reviews: [
        {
          user: { login: 'codeowner' },
          author_association: 'CONTRIBUTOR',
          body: 'LGTM, thanks',
          submitted_at: iso(500),
          state: 'APPROVED',
        },
        { user: { login: 'codeowner' }, body: '', submitted_at: iso(600), state: 'APPROVED' },
        { user: { login: 'other' }, body: '  ', submitted_at: iso(700), state: 'COMMENTED' },
      ],
      reviewComments: [
        {
          user: { login: 'codeowner' },
          author_association: 'CONTRIBUTOR',
          body: 'moved this helper up',
          created_at: iso(800),
        },
      ],
    });
    const result = collectMergedPRNotes(PR, act, USER);
    expect(result?.notes).toEqual([
      { author: 'codeowner', createdAt: iso(500), kind: 'review', excerpt: 'LGTM, thanks' },
      { author: 'codeowner', createdAt: iso(800), kind: 'review_comment', excerpt: 'moved this helper up' },
    ]);
    expect(result?.thanksOnly).toBe(false);
  });

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
    const userAck = comment(USER, 'thanks for the extra cases', iso(-60 * 60 * 1000));
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

describe('isThanksOnlyNote', () => {
  it.each([
    'Thanks for the PR, I really appreciate it. Have a great weekend!',
    'thank you',
    'LGTM, nice work',
    'Thanks for the fix!',
  ])('accepts %j', (body) => {
    expect(isThanksOnlyNote(body)).toBe(true);
  });

  it.each([
    'Thanks! Could you also open a follow-up for the docs?',
    'Thanks. I reworked the flag into a positional argument because it reads better.',
    'Thanks, I pushed a commit on top covering two extra cases.',
    'This ships in the next release via the dependency bump.',
    `Thanks ${'for everything '.repeat(20)}`,
    '',
  ])('rejects %j', (body) => {
    expect(isThanksOnlyNote(body)).toBe(false);
  });
});

function entry(prUrl: string, repo: string, mergedAt: string, isThanksOnly: boolean): MergedPRNotes {
  return {
    prUrl,
    repo,
    mergedAt,
    number: Number(prUrl.split('/').pop()),
    title: 't',
    notes: [{ author: 'm', createdAt: mergedAt, kind: 'comment', excerpt: 'Thanks' }],
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
