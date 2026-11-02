/**
 * Review follow-ups (#1857): dismissing a reviewed PR through the real
 * `dismiss` command against a real StateManager over a temp dir (paths.js
 * redirected, same pattern as dashboard-override-partition.test.ts). The
 * orchestration suite mocks the state manager, so this is where the
 * persistence claim is checked: a dismissed PR stays hidden across a fresh
 * StateManager until newer activity lands, and a second dismiss re-stamps.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import type { ReviewedPRActivity, ReviewedPRActivityList, ReviewedPRRef } from '../core/reviewed-prs.js';
import type { DailyWarning } from '../formatters/json.js';

/** Temp data dir for the real StateManager; a holder so the hooks mutate a property, not a module binding. */
const tmp = { dir: '' };

vi.mock('../core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/paths.js')>();
  const dir = () => {
    if (!tmp.dir) throw new Error('tmp.dir not set');
    if (!fs.existsSync(tmp.dir)) fs.mkdirSync(tmp.dir, { recursive: true, mode: 0o700 });
    return tmp.dir;
  };
  return {
    ...actual,
    getDataDir: dir,
    getStatePath: () => path.join(dir(), 'state.json'),
    getBackupDir: () => {
      const backupDir = path.join(dir(), 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      return backupDir;
    },
    getLegacyStatePath: () => path.join(dir(), 'legacy-data', 'state.json'),
    getLegacyBackupDir: () => path.join(dir(), 'legacy-data', 'backups'),
  };
});

import { getStateManager, resetStateManager } from '../core/index.js';
import { runDismiss, runUndismiss } from './dismiss.js';
import { runReviewedPRsPhase, type ReviewedPRSource } from './daily-reviewed-prs.js';

const USER = 'testuser';
const AUTHOR = 'author';
const PR_URL = 'https://github.com/org/repo/pull/7';
const REVIEWED_AT = '2026-06-02T12:00:00Z';
const HOUR_MS = 60 * 60 * 1000;

function iso(offsetMs: number): string {
  const date = new Date(Date.parse(REVIEWED_AT) + offsetMs);
  return date.toISOString();
}

/** Hours after the review, as the fake clock and the fixtures use them. */
const AT_1H = iso(HOUR_MS);
const AT_2H = iso(2 * HOUR_MS);
const AT_3H = iso(3 * HOUR_MS);
const AT_4H = iso(4 * HOUR_MS);
const AT_5H = iso(5 * HOUR_MS);

/** Full SHAs, as `dismiss --head` requires and GitHub reports PR heads. */
const HEAD_1 = '1'.repeat(40);
const HEAD_2 = '2'.repeat(40);

const ref: ReviewedPRRef = {
  url: PR_URL,
  repo: 'org/repo',
  number: 7,
  title: 'PR 7',
  author: AUTHOR,
  updatedAt: iso(HOUR_MS),
};

function authorCommit(date: string, sha: string) {
  return {
    sha,
    author: { login: AUTHOR },
    committer: { login: AUTHOR },
    commit: { message: `Fix ${sha}`, author: { date }, committer: { date } },
    parents: [{ sha: 'p' }],
  };
}

/** The author pushed `commitDates` after the user's review (made against `rev0000`, the first commit). */
function activityWith(...commitDates: string[]): ReviewedPRActivity & { truncatedLists: ReviewedPRActivityList[] } {
  return {
    pr: { headSha: 'head000', state: 'open', author: AUTHOR },
    comments: [],
    reviews: [
      { id: 1, user: { login: USER }, body: 'Please split this.', submitted_at: REVIEWED_AT, commit_id: 'rev0000' },
    ],
    reviewComments: [],
    commits: [authorCommit(iso(-HOUR_MS), 'rev0000'), ...commitDates.map((date, i) => authorCommit(date, `c${i}`))],
    truncatedLists: [],
  };
}

/** `activity` at `headSha`, with `comments` on top (the author's reply, a bot's or a bystander's remark). */
function atHead(
  activity: ReturnType<typeof activityWith>,
  headSha: string,
  comments: ReviewedPRActivity['comments'] = [],
): ReturnType<typeof activityWith> {
  return { ...activity, comments, pr: { ...activity.pr, headSha } };
}

/** Comments that never qualify a follow-up, posted after the skip at two hours. */
const BOT_COMMENT_3H = {
  id: 900,
  user: { login: 'dependabot[bot]', type: 'Bot' },
  body: 'Bumped the lockfile.',
  created_at: AT_3H,
};
const BYSTANDER_COMMENT_4H = { id: 901, user: { login: 'bystander' }, body: 'Nice change.', created_at: AT_4H };

function authorReply(date: string) {
  return { id: 902, user: { login: AUTHOR }, body: 'Split it into two helpers, PTAL.', created_at: date };
}

/** `updatedAt` is the search's `updated_at`, which moves with every push or comment. */
function source(activity: ReturnType<typeof activityWith>, updatedAt = ref.updatedAt): ReviewedPRSource {
  return {
    fetchReviewedOpenPRs: vi.fn().mockResolvedValue({ prs: [{ ...ref, updatedAt }], warnings: [] }),
    fetchReviewedPRActivity: vi.fn().mockResolvedValue(activity),
    fetchCompareStatus: vi.fn().mockResolvedValue('ahead'),
  };
}

async function runPhase(activity: ReturnType<typeof activityWith>, updatedAt?: string) {
  const warnings: DailyWarning[] = [];
  const entries = await runReviewedPRsPhase(source(activity, updatedAt), warnings);
  expect(warnings).toEqual([]);
  return entries;
}

describe('review follow-ups: dismiss hides the PR until newer activity (real StateManager, #1857)', () => {
  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewed-prs-dismiss-'));
    resetStateManager();
    getStateManager().updateConfig({ githubUsername: USER });
  });

  afterEach(() => {
    resetStateManager();
    fs.rmSync(tmp.dir, { recursive: true, force: true });
    tmp.dir = '';
  });

  it('hides a dismissed PR across a fresh StateManager, and shows it again once the author pushes after the dismiss', async () => {
    vi.useFakeTimers();
    try {
      // Run 1: the author pushed an hour after the review; the PR is listed.
      vi.setSystemTime(new Date(iso(2 * HOUR_MS)));
      const pushed = activityWith(iso(HOUR_MS));
      const firstRun = await runPhase(pushed);
      expect(firstRun.map((e) => e.prUrl)).toEqual([PR_URL]);

      // The workflow's "skip": the existing dismiss command with the PR URL.
      await expect(runDismiss({ url: PR_URL })).resolves.toMatchObject({ dismissed: true, url: PR_URL });
      expect(fs.existsSync(path.join(tmp.dir, 'state.json'))).toBe(true);

      // Run 2 on a fresh StateManager (reloads state.json): hidden.
      resetStateManager();
      expect(await runPhase(pushed)).toEqual([]);

      // Run 3: a newer push after the dismiss brings it back, with only the new commit as the latest activity.
      vi.setSystemTime(new Date(iso(4 * HOUR_MS)));
      const pushedAgain = activityWith(iso(HOUR_MS), iso(3 * HOUR_MS));
      const again = { ...pushedAgain, pr: { ...pushedAgain.pr, headSha: 'head111' } };
      const entries = await runPhase(again, iso(3 * HOUR_MS));
      expect(entries.map((e) => [e.prUrl, e.latestActivityAt, e.commits.length])).toEqual([
        [PR_URL, iso(3 * HOUR_MS), 2],
      ]);

      // A second dismiss re-stamps (PR URLs refresh), so the newer activity is covered too.
      await expect(runDismiss({ url: PR_URL })).resolves.toMatchObject({ dismissed: true });
      resetStateManager();
      expect(await runPhase(again, iso(3 * HOUR_MS))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resurfaces a dismissed PR when a commit pushed after the dismiss carries an older date (cherry-pick), going by the search update', async () => {
    vi.useFakeTimers();
    try {
      // Dismissed two hours after the review, with one commit pushed an hour after it.
      vi.setSystemTime(new Date(iso(2 * HOUR_MS)));
      const pushedOnce = activityWith(iso(HOUR_MS));
      expect(await runPhase(pushedOnce)).toHaveLength(1);
      await runDismiss({ url: PR_URL });
      resetStateManager();

      // The author then cherry-picks a commit written before the review; its date predates the dismiss,
      // but it follows the reviewed commit in the list and the search's updated_at moved with the push.
      vi.setSystemTime(new Date(iso(4 * HOUR_MS)));
      const cherryPicked = activityWith(iso(HOUR_MS), iso(-2 * HOUR_MS));
      const entries = await runPhase(cherryPicked, iso(3 * HOUR_MS));
      expect(entries.map((e) => e.commits.map((c) => c.sha))).toEqual([['c0', 'c1']]);

      // With no push since the dismiss (search update before the stamp), the same list stays hidden.
      expect(await runPhase(cherryPicked, iso(HOUR_MS))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the per-PR fetch entirely when the dismiss is at or after the search update', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(iso(2 * HOUR_MS)));
      await runDismiss({ url: PR_URL });
      resetStateManager();
      const src = source(activityWith(iso(HOUR_MS)));
      const warnings: DailyWarning[] = [];
      expect(await runReviewedPRsPhase(src, warnings)).toEqual([]);
      expect(src.fetchReviewedPRActivity).not.toHaveBeenCalled();
      expect(warnings).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('review follow-ups: a skip that records the head sticks until a push or a comment (real StateManager, #1857)', () => {
  /** One commit pushed an hour after the review, at `HEAD_1`: what the user saw when skipping. */
  const pushedOnce = atHead(activityWith(AT_1H), HEAD_1);

  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewed-prs-dismiss-head-'));
    resetStateManager();
    getStateManager().updateConfig({ githubUsername: USER });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStateManager();
    fs.rmSync(tmp.dir, { recursive: true, force: true });
    tmp.dir = '';
  });

  /** The heads of the entries the phase lists for `activity`. */
  async function listedHeads(activity: ReturnType<typeof activityWith>, updatedAt?: string): Promise<string[]> {
    const entries = await runPhase(activity, updatedAt);
    return entries.map((e) => e.headSha);
  }

  /** Run 1 at two hours: the PR is listed; the workflow's "skip" records the head; a fresh StateManager reloads it. */
  async function skipWithHead(head?: string) {
    vi.setSystemTime(new Date(AT_2H));
    expect(await listedHeads(pushedOnce)).toEqual([HEAD_1]);
    await expect(runDismiss({ url: PR_URL, head })).resolves.toMatchObject({ dismissed: true, url: PR_URL });
    resetStateManager();
    expect(getStateManager().getDismissedPRHead(PR_URL)).toBe(head);
  }

  it('stays hidden through a bot comment, a bystander comment and a search update after the dismiss at the same head', async () => {
    await skipWithHead(HEAD_1);
    vi.setSystemTime(new Date(AT_5H));
    // Neither comment qualifies, and the search's updated_at moved past the stamp (a label change would do the same).
    const noise = atHead(activityWith(AT_1H), HEAD_1, [BOT_COMMENT_3H, BYSTANDER_COMMENT_4H]);
    const src = source(noise, AT_4H);
    const warnings: DailyWarning[] = [];
    expect(await runReviewedPRsPhase(src, warnings)).toEqual([]);
    // The update alone no longer settles it: the PR was fetched and the head compared.
    expect(src.fetchReviewedPRActivity).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
  });

  it('is listed again after a new push (different head), even when the new commit carries an old date', async () => {
    await skipWithHead(HEAD_1);
    vi.setSystemTime(new Date(AT_5H));
    const cherryPicked = atHead(activityWith(AT_1H, iso(-2 * HOUR_MS)), HEAD_2);
    const entries = await runPhase(cherryPicked, AT_4H);
    expect(entries.map((e) => [e.headSha, e.commits.map((c) => c.sha)])).toEqual([[HEAD_2, ['c0', 'c1']]]);
  });

  it('is listed again after an author reply posted after the dismiss, but not one posted before it', async () => {
    await skipWithHead(HEAD_1);
    vi.setSystemTime(new Date(AT_5H));
    const repliedAfter = atHead(activityWith(AT_1H), HEAD_1, [authorReply(AT_3H)]);
    const entries = await runPhase(repliedAfter, AT_3H);
    expect(entries.map((e) => [e.headSha, e.authorComments, e.latestCommentAt])).toEqual([[HEAD_1, 1, AT_3H]]);

    // A reply from before the skip (the user saw it) with a later bystander update: still hidden.
    const repliedBefore = atHead(activityWith(AT_1H), HEAD_1, [authorReply(AT_1H), BYSTANDER_COMMENT_4H]);
    expect(await runPhase(repliedBefore, AT_4H)).toEqual([]);
  });

  it('keeps the stamp-only rule for a dismiss without --head: the same bot comment resurfaces the PR', async () => {
    await skipWithHead();
    vi.setSystemTime(new Date(AT_5H));
    const noise = atHead(activityWith(AT_1H), HEAD_1, [BOT_COMMENT_3H]);
    expect(await listedHeads(noise, AT_3H)).toEqual([HEAD_1]);
  });

  it('undismiss clears the recorded head, so the PR is listed again with nothing new on it', async () => {
    await skipWithHead(HEAD_1);
    await expect(runUndismiss({ url: PR_URL })).resolves.toMatchObject({ undismissed: true });
    resetStateManager();
    expect(getStateManager().getDismissedPRHead(PR_URL)).toBeUndefined();
    expect(await listedHeads(pushedOnce)).toEqual([HEAD_1]);
  });
});
