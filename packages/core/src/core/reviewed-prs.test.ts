/**
 * scanReviewedPR (#1857): which reviewed PRs ask for another look, and what
 * the entry carries.
 */

import { describe, it, expect } from 'vitest';
import {
  REVIEWED_PR_MAX_COMMITS,
  REVIEWED_PR_MAX_QUESTIONS,
  scanReviewedPR,
  type ReviewedPRActivity,
  type ReviewedPRRef,
} from './reviewed-prs.js';

const USER = 'Reviewer';
const AUTHOR = 'author';
const REVIEWED_AT = '2026-06-02T12:00:00Z';
const REVIEWED_MS = Date.parse(REVIEWED_AT);
const HOUR_MS = 60 * 60 * 1000;

function iso(offsetMs: number): string {
  const date = new Date(REVIEWED_MS + offsetMs);
  return date.toISOString();
}

/** Timestamps around the review: two hours before, one hour before, one to four hours after. */
const BEFORE_2H = iso(-2 * HOUR_MS);
const BEFORE_1H = iso(-HOUR_MS);
const AFTER_1H = iso(HOUR_MS);
const AFTER_2H = iso(2 * HOUR_MS);
const AFTER_3H = iso(3 * HOUR_MS);
const AFTER_4H = iso(4 * HOUR_MS);

const ref: ReviewedPRRef = {
  url: 'https://github.com/org/repo/pull/7',
  repo: 'org/repo',
  number: 7,
  title: 'Add retries',
  author: AUTHOR,
  updatedAt: AFTER_1H,
};

const openPR = { headSha: 'head000', state: 'open', author: AUTHOR, title: 'Add retries' };

function activity(overrides: Partial<ReviewedPRActivity> = {}): ReviewedPRActivity {
  return { pr: openPR, comments: [], reviews: [], reviewComments: [], commits: [], ...overrides };
}

/** The scan over `ref` with the given activity, as the user. */
function scan(overrides: Partial<ReviewedPRActivity>) {
  return scanReviewedPR(ref, activity(overrides), USER);
}

function userReview(overrides: Partial<ReviewedPRActivity['reviews'][number]> = {}) {
  return {
    id: 100,
    user: { login: USER },
    body: 'Please split the retry helper out of the handler, it is doing two jobs now.',
    submitted_at: REVIEWED_AT,
    state: 'CHANGES_REQUESTED',
    commit_id: 'rev0000',
    html_url: 'https://github.com/org/repo/pull/7#pullrequestreview-100',
    ...overrides,
  };
}

const ids = { next: 1000 };
function comment(login: string, body: string, createdAt: string, extra: Record<string, unknown> = {}) {
  const id = ids.next;
  ids.next += 1;
  return { id, user: { login }, body, created_at: createdAt, ...extra };
}

function commit(
  login: string,
  authorDate: string,
  sha = `sha-${authorDate}`,
  committerLogin = login,
  committerDate = authorDate,
) {
  return {
    sha,
    author: { login },
    committer: { login: committerLogin },
    commit: { message: `Work by ${login}\n\nbody`, author: { date: authorDate }, committer: { date: committerDate } },
    parents: [{ sha: 'parent' }],
  };
}

const REVIEW = userReview();

/** The head the review was of (`commit_id`), as it appears in the PR's commit list. */
const REVIEWED_COMMIT = commit(AUTHOR, BEFORE_1H, 'rev0000');

/** A non-reaction reply by the author two hours after the review. */
const AUTHOR_REPLY = comment(AUTHOR, 'Split it into two helpers, PTAL.', AFTER_2H);

/** The author's merge of the base branch into the PR ("Update branch"). */
function mergeCommit(date: string, sha: string) {
  return { ...commit(AUTHOR, date, sha), parents: [{ sha: 'a' }, { sha: 'b' }] };
}

describe('scanReviewedPR: when a reviewed PR is listed (#1857)', () => {
  it('lists a PR where the author pushed after the review, with the reviewed and head SHAs and the commits', () => {
    const entry = scan({
      reviews: [REVIEW],
      commits: [REVIEWED_COMMIT, commit(AUTHOR, AFTER_1H, 'new1')],
    });
    expect(entry).toEqual({
      prUrl: ref.url,
      repo: 'org/repo',
      number: 7,
      title: 'Add retries',
      author: AUTHOR,
      reviewedAt: REVIEWED_AT,
      reviewedSha: 'rev0000',
      headSha: 'head000',
      rebased: false,
      mergedUpstream: false,
      baseUnknown: false,
      commits: [{ sha: 'new1', author: AUTHOR, date: AFTER_1H, subject: 'Work by author' }],
      moreCommits: 0,
      authorComments: 0,
      questions: [],
      moreQuestions: 0,
      latestActivityAt: AFTER_1H,
    });
  });

  it('returns null when nothing happened after the review', () => {
    const entry = scan({
      reviews: [REVIEW],
      commits: [commit(AUTHOR, BEFORE_2H, 'first'), REVIEWED_COMMIT],
      comments: [comment(AUTHOR, 'Ready for review', BEFORE_2H)],
    });
    expect(entry).toBeNull();
  });

  it("returns null when the user's own later comment is the last word", () => {
    const entry = scan({
      reviews: [REVIEW],
      commits: [REVIEWED_COMMIT, commit(AUTHOR, AFTER_1H)],
      comments: [comment(USER, 'Looks good now, thanks for splitting it.', AFTER_2H)],
    });
    expect(entry).toBeNull();
  });

  it('returns null for a PR the user authored, one that is no longer open, or one the user never reviewed', () => {
    const pushed = activity({ reviews: [REVIEW], commits: [REVIEWED_COMMIT, commit(AUTHOR, AFTER_1H)] });
    const byUser = scanReviewedPR(ref, { ...pushed, pr: { ...openPR, author: USER } }, USER);
    const closed = scanReviewedPR(ref, { ...pushed, pr: { ...openPR, state: 'closed' } }, USER);
    const unreviewed = scan({ commits: [commit(AUTHOR, AFTER_1H)] });
    expect([byUser, closed, unreviewed]).toEqual([null, null, null]);
  });

  it('lists a PR where the author replied, counting the reply but not listing it as a question', () => {
    const entry = scan({
      reviews: [REVIEW],
      comments: [comment(AUTHOR, 'Pushed the split, the helper now lives in retry.ts.', AFTER_1H)],
    });
    expect(entry?.authorComments).toBe(1);
    expect(entry?.questions).toEqual([]);
    expect(entry?.latestActivityAt).toBe(AFTER_1H);
  });

  it('does not treat a push or an author reply as a follow-up when the user only reacted ("+1"), but still lists a question for them', () => {
    const reacted = {
      comments: [comment(USER, '+1', REVIEWED_AT), comment(AUTHOR, 'Pushed the fix.', AFTER_1H)],
      commits: [commit(AUTHOR, BEFORE_1H, 'first'), commit(AUTHOR, AFTER_1H)],
    };
    expect(scan(reacted)).toBeNull();

    const question = comment(AUTHOR, `@${USER} does this cover your case?`, AFTER_2H);
    const asked = scan({ ...reacted, comments: [...reacted.comments, question] });
    expect(asked?.questions.map((q) => q.reason)).toEqual(['mention']);
    expect(asked?.commits).toHaveLength(1);

    // An empty-body APPROVED review is a review, so a later push counts.
    const approved = scan({
      reviews: [userReview({ body: '', state: 'APPROVED' })],
      commits: [REVIEWED_COMMIT, commit(AUTHOR, AFTER_1H)],
    });
    expect(approved?.commits).toHaveLength(1);
  });

  it('ignores bot comments and commits, commits by the user, and reaction-only replies from the author', () => {
    const entry = scan({
      reviews: [REVIEW],
      comments: [
        comment('github-actions[bot]', `@${USER} the build passed`, AFTER_1H),
        comment('Copilot', 'I pushed fixes', AFTER_1H, { user: { login: 'Copilot', type: 'Bot' } }),
        comment(AUTHOR, '👍', AFTER_1H),
      ],
      commits: [REVIEWED_COMMIT, commit('pre-commit-ci[bot]', AFTER_1H), commit(USER, AFTER_2H, 'mine')],
    });
    expect(entry).toBeNull();
  });

  it("lists a co-maintainer's commit after the review, not only the author's", () => {
    const entry = scan({ reviews: [REVIEW], commits: [REVIEWED_COMMIT, commit('maintainer', AFTER_1H, 'theirs')] });
    expect(entry?.commits.map((c) => [c.sha, c.author])).toEqual([['theirs', 'maintainer']]);
    expect(entry?.authorComments).toBe(0);
  });

  it("ignores the user's own pending review and its draft comments as their last word", () => {
    const pending = userReview({ id: 101, submitted_at: null, state: 'PENDING', commit_id: 'head000', body: '' });
    const draft = {
      id: 900,
      user: { login: USER },
      body: 'Still a tight loop here (draft, not submitted).',
      created_at: AFTER_3H,
      commit_id: 'head000',
      pull_request_review_id: 101,
    };
    const entry = scan({
      reviews: [REVIEW, pending],
      reviewComments: [draft],
      commits: [REVIEWED_COMMIT, commit(AUTHOR, AFTER_1H, 'new1')],
    });
    expect(entry?.reviewedAt).toBe(REVIEWED_AT);
    expect(entry?.reviewedSha).toBe('rev0000');
    expect(entry?.commits.map((c) => c.sha)).toEqual(['new1']);
  });
});

describe('scanReviewedPR: which commits are new (#1857)', () => {
  it('takes the commits after the reviewed one in list order, so a commit written before the review but pushed after it counts', () => {
    // Authored 09:30, review at 10:00 against its parent, pushed at 11:00: new, whatever the date says.
    const entry = scan({
      reviews: [REVIEW],
      commits: [commit(AUTHOR, BEFORE_2H, 'rev0000'), commit(AUTHOR, BEFORE_1H, 'written-earlier')],
    });
    expect(entry?.commits.map((c) => c.sha)).toEqual(['written-earlier']);
    expect(entry?.rebased).toBe(false);
    expect(entry?.baseUnknown).toBe(false);
  });

  it('lists a cherry-pick carrying an old author date when it follows the reviewed commit, and reports that date as the latest activity', () => {
    const entry = scan({
      reviews: [REVIEW],
      commits: [REVIEWED_COMMIT, commit(AUTHOR, BEFORE_2H, 'cherry-pick', AUTHOR, BEFORE_2H)],
    });
    expect(entry?.commits.map((c) => c.sha)).toEqual(['cherry-pick']);
    expect(entry?.latestActivityAt).toBe(BEFORE_2H);
  });

  it('does not list commits before the reviewed one, even when they are dated after the review', () => {
    const entry = scan({
      reviews: [REVIEW],
      commits: [commit(AUTHOR, AFTER_1H, 'odd-date-before'), REVIEWED_COMMIT],
    });
    expect(entry).toBeNull();
  });

  it('flags a merge of the base branch after the review as mergedUpstream and lists only the non-merge commits after it', () => {
    const entry = scan({
      reviews: [REVIEW],
      commits: [REVIEWED_COMMIT, mergeCommit(AFTER_1H, 'merge-main'), commit(AUTHOR, AFTER_2H, 'fix')],
    });
    expect(entry?.mergedUpstream).toBe(true);
    expect(entry?.rebased).toBe(false);
    expect(entry?.commits.map((c) => c.sha)).toEqual(['fix']);
    // A merge before the reviewed commit is history the review already saw.
    const earlier = scan({
      reviews: [REVIEW],
      commits: [mergeCommit(BEFORE_2H, 'merge-main'), REVIEWED_COMMIT, commit(AUTHOR, AFTER_1H, 'fix')],
    });
    expect(earlier?.mergedUpstream).toBe(false);
  });

  it('falls back to dates and flags rebased when the reviewed commit is gone from the list (force-push)', () => {
    const entry = scan({
      reviews: [REVIEW],
      commits: [
        commit(AUTHOR, BEFORE_2H, 'kept-old'),
        // Author date before the review, committer web-flow after: a maintainer's rebase of old work.
        commit(AUTHOR, BEFORE_1H, 'rebased', 'web-flow', AFTER_1H),
        // The author's own amend: the committer date is theirs, so the force-pushed fix counts.
        commit(AUTHOR, BEFORE_1H, 'amended', AUTHOR, AFTER_1H),
        commit(AUTHOR, AFTER_2H, 'new'),
      ],
    });
    expect(entry?.rebased).toBe(true);
    expect(entry?.reviewedSha).toBe('rev0000');
    expect(entry?.commits.map((c) => c.sha)).toEqual(['amended', 'new']);
  });

  it('does not call a reviewed commit missing from a cut commit list a rebase: commits by date, baseUnknown, no range', () => {
    // The newest commits are the ones a cap drops, so the reviewed one may simply be past the cut.
    const commits = [commit(AUTHOR, BEFORE_2H, 'old'), commit(AUTHOR, AFTER_1H, 'new')];
    const entry = scan({ commits, reviews: [REVIEW], truncatedLists: ['commits'] });
    expect(entry).toMatchObject({ reviewedSha: 'rev0000', rebased: false, mergedUpstream: false, baseUnknown: true });
    expect(entry?.commits.map((c) => c.sha)).toEqual(['new']);
    // A cut elsewhere says nothing about the commit list: still a rebase.
    const other = scan({ commits, reviews: [REVIEW], truncatedLists: ['comments'] });
    expect(other).toMatchObject({ rebased: true, baseUnknown: false });
    // Nothing dated after the review in the cut list: not a rebase, and no commits to flag as approximate.
    const quiet = scan({
      reviews: [REVIEW],
      commits: [commits[0]],
      truncatedLists: ['commits'],
      comments: [AUTHOR_REPLY],
    });
    expect(quiet).toMatchObject({ rebased: false, baseUnknown: false, commits: [] });
  });

  it('carries the newest qualifying comment as latestCommentAt, and leaves it out when only commits qualified', () => {
    const commitsOnly = scan({ reviews: [REVIEW], commits: [REVIEWED_COMMIT, commit(AUTHOR, AFTER_3H, 'new')] });
    expect(commitsOnly?.latestActivityAt).toBe(AFTER_3H);
    expect(commitsOnly).not.toHaveProperty('latestCommentAt');

    const withReply = scan({
      reviews: [REVIEW],
      commits: [REVIEWED_COMMIT, commit(AUTHOR, AFTER_3H, 'new')],
      // The bystander's remark does not qualify; the author's reply does, and it is older than the push.
      comments: [comment('bystander', 'Nice change.', AFTER_4H), AUTHOR_REPLY],
    });
    expect(withReply?.latestActivityAt).toBe(AFTER_3H);
    expect(withReply?.latestCommentAt).toBe(AFTER_2H);
  });

  it("ignores merge commits and the user's commits in the date fallback too", () => {
    const entry = scan({
      reviews: [REVIEW],
      commits: [mergeCommit(AFTER_1H, 'merge'), commit(USER, AFTER_1H, 'mine')],
    });
    expect(entry).toBeNull();
  });
});

describe('scanReviewedPR: questions for you (#1857)', () => {
  const inlineRoot = {
    id: 500,
    user: { login: USER },
    body: 'This retry loop never backs off; a tight loop on a 503 will hammer the service.',
    created_at: REVIEWED_AT,
    commit_id: 'rev0000',
    html_url: 'https://github.com/org/repo/pull/7#discussion_r500',
  };

  it("lists a reply in the user's inline thread as a question, with excerpt, kind and url", () => {
    const reply = {
      id: 501,
      user: { login: AUTHOR },
      body: 'Would exponential backoff with a 30s cap be enough here, or do you want jitter too?',
      created_at: AFTER_1H,
      in_reply_to_id: 500,
      html_url: 'https://github.com/org/repo/pull/7#discussion_r501',
    };
    const entry = scan({ reviewComments: [inlineRoot, reply] });
    expect(entry?.questions).toEqual([
      {
        author: AUTHOR,
        createdAt: AFTER_1H,
        kind: 'review_comment',
        reason: 'reply',
        excerpt: 'Would exponential backoff with a 30s cap be enough here, or do you want jitter too?',
        url: 'https://github.com/org/repo/pull/7#discussion_r501',
      },
    ]);
    expect(entry?.authorComments).toBe(1);
    expect(entry?.reviewedSha).toBe('rev0000');
  });

  it('does not count a reply in a thread the user never wrote in, unless it quotes or mentions them', () => {
    const otherRoot = { id: 600, user: { login: 'maintainer' }, body: 'Nit: rename this.', created_at: BEFORE_1H };
    const reply = {
      id: 601,
      user: { login: 'maintainer' },
      body: 'Actually leave it, the name is fine as it is.',
      created_at: AFTER_1H,
      in_reply_to_id: 600,
    };
    expect(scan({ reviews: [REVIEW], reviewComments: [otherRoot, reply] })).toBeNull();
  });

  it("lists a comment that quotes the user's review prose and one that @mentions them, from anyone but the user or a bot", () => {
    const entry = scan({
      reviews: [REVIEW],
      comments: [
        comment(
          'maintainer',
          `> split the retry helper out of the handler\n\nAgreed, let's do that before merging.`,
          AFTER_1H,
        ),
        comment('someone', `@${USER.toUpperCase()} can you take another look?`, AFTER_2H),
        comment('someone', `mail me at ${USER}@example.com, or see @${USER}-bot`, AFTER_3H),
        comment('someone', 'Unrelated +1', AFTER_4H),
      ],
    });
    expect(entry?.questions.map((q) => [q.author, q.reason, q.kind])).toEqual([
      ['maintainer', 'quote', 'comment'],
      ['someone', 'mention', 'comment'],
    ]);
    expect(entry?.authorComments).toBe(0);
    expect(entry?.latestActivityAt).toBe(AFTER_2H);
  });

  it('does not read an @mention inside a quoted line, a code fence or inline code as addressed to the user', () => {
    const quoted = `> @${USER} said this earlier\n\nAnd I disagree with the premise.`;
    const fenced = `Run this:\n\`\`\`\ngit log --author=@${USER}\n\`\`\`\nthen check the output.`;
    const inline = `Use \`@${USER}\` as the handle placeholder in the template.`;
    const entry = scan({
      reviews: [REVIEW],
      comments: [
        comment('someone', quoted, AFTER_1H),
        comment('someone', fenced, AFTER_2H),
        comment('someone', inline, AFTER_3H),
        comment('someone', `See \`retry.ts\`, @${USER}, is that what you meant?`, AFTER_4H),
      ],
    });
    expect(entry?.questions.map((q) => [q.reason, q.createdAt])).toEqual([['mention', AFTER_4H]]);
  });

  it('caps the question and commit lists and reports how many were dropped', () => {
    const comments = Array.from({ length: REVIEWED_PR_MAX_QUESTIONS + 2 }, (_, i) =>
      comment(AUTHOR, `@${USER} question ${i}`, iso((i + 1) * 1000)),
    );
    const commits = Array.from({ length: REVIEWED_PR_MAX_COMMITS + 3 }, (_, i) =>
      commit(AUTHOR, iso((i + 1) * 1000), `c${i}`),
    );
    const entry = scan({ comments, reviews: [REVIEW], commits: [REVIEWED_COMMIT, ...commits] });
    expect(entry?.questions).toHaveLength(REVIEWED_PR_MAX_QUESTIONS);
    expect(entry?.moreQuestions).toBe(2);
    expect(entry?.commits).toHaveLength(REVIEWED_PR_MAX_COMMITS);
    expect(entry?.moreCommits).toBe(3);
    expect(entry?.questions[0].excerpt).toBe(`@${USER} question 0`);
  });

  it('truncates long excerpts to 200 characters', () => {
    const entry = scan({ reviews: [REVIEW], comments: [comment(AUTHOR, `@${USER} ${'x'.repeat(300)}`, AFTER_1H)] });
    expect(entry?.questions[0].excerpt).toHaveLength(203);
    expect(entry?.questions[0].excerpt.endsWith('...')).toBe(true);
  });
});

describe('scanReviewedPR: the reviewed SHA (#1857)', () => {
  const plainComment = comment(USER, 'Reviewed locally, two things: the lock and the retry cap.', REVIEWED_AT);

  it('takes commit_id from the latest review or inline comment, whichever is the last word', () => {
    const later = {
      id: 700,
      user: { login: USER },
      body: 'One more thing here.',
      created_at: AFTER_1H,
      commit_id: 'rev1111',
    };
    const entry = scan({
      reviews: [REVIEW],
      reviewComments: [later],
      commits: [REVIEWED_COMMIT, commit(AUTHOR, BEFORE_1H, 'rev1111'), commit(AUTHOR, AFTER_2H, 'new')],
    });
    expect(entry?.reviewedAt).toBe(AFTER_1H);
    expect(entry?.reviewedSha).toBe('rev1111');
    expect(entry?.commits.map((c) => c.sha)).toEqual(['new']);
  });

  it('for a plain comment, names no reviewed SHA, picks the commits dated after it and flags baseUnknown', () => {
    const entry = scan({
      comments: [plainComment],
      commits: [
        commit(AUTHOR, BEFORE_2H, 'first'),
        commit(AUTHOR, BEFORE_1H, 'second'),
        commit(AUTHOR, AFTER_1H, 'third'),
      ],
    });
    expect(entry?.reviewedSha).toBeUndefined();
    expect(entry?.baseUnknown).toBe(true);
    expect(entry?.rebased).toBe(false);
    expect(entry?.commits.map((c) => c.sha)).toEqual(['third']);
  });

  it('for a plain comment with no push since (author replied only), leaves baseUnknown false', () => {
    const entry = scan({
      comments: [plainComment, comment(AUTHOR, 'Fixed the lock, the cap is next.', AFTER_1H)],
      commits: [commit(AUTHOR, BEFORE_1H, 'only')],
    });
    expect(entry?.authorComments).toBe(1);
    expect(entry?.baseUnknown).toBe(false);
    expect(entry?.reviewedSha).toBeUndefined();
  });

  it('falls back to the search title and author when the PR payload has none', () => {
    const entry = scan({
      pr: { headSha: 'head000', state: 'open' },
      reviews: [REVIEW],
      commits: [REVIEWED_COMMIT, commit(AUTHOR, AFTER_1H)],
    });
    expect(entry?.title).toBe('Add retries');
    expect(entry?.author).toBe(AUTHOR);
  });
});
