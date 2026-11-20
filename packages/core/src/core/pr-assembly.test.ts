/**
 * Tests for pr-assembly.ts: dormancy clock, informational checklist, issue
 * links, and comments on an approved PR.
 */

import { describe, it, expect } from 'vitest';
import { assembleFetchedPR, type PRSignals, type AssemblyConfig } from './pr-assembly.js';
import { shouldSuggestClose } from './pr-attention.js';

const CONFIG: AssemblyConfig = { githubUsername: 'contributor', dormantThresholdDays: 30, approachingDormantDays: 25 };

function daysAgo(n: number): string {
  const date = new Date(Date.now() - n * 86_400_000);
  return date.toISOString();
}

function signals(overrides: Partial<PRSignals> = {}): PRSignals {
  return {
    prUrl: 'https://github.com/o/r/pull/7',
    owner: 'o',
    repo: 'r',
    number: 7,
    id: 7,
    title: 'Fix thing',
    body: '',
    createdAt: daysAgo(60),
    updatedAt: daysAgo(60),
    hasMergeConflict: false,
    comments: [],
    reviews: [],
    reviewComments: [],
    ciStatus: { status: 'passing', failingCheckNames: [], failingCheckConclusions: new Map() },
    ...overrides,
  };
}

describe('assembleFetchedPR dormancy clock', () => {
  it("the contributor's own pings do not reset dormancy", async () => {
    const pr = await assembleFetchedPR(
      signals({
        // The pings bump updatedAt, which used to keep the PR "active" forever.
        updatedAt: daysAgo(1),
        comments: [
          { user: { login: 'maintainer' }, body: 'Will take a look', created_at: daysAgo(50) },
          { user: { login: 'contributor' }, body: 'Friendly ping', created_at: daysAgo(20) },
          { user: { login: 'contributor' }, body: 'Any update?', created_at: daysAgo(1) },
        ],
      }),
      CONFIG,
      undefined,
    );

    expect(pr.daysSinceActivity).toBeLessThanOrEqual(1);
    expect(pr.daysSinceMaintainerActivity).toBeGreaterThanOrEqual(49);
    expect(pr.stalenessTier).toBe('dormant');
    expect(pr.authorPingsSinceMaintainerActivity).toBe(2);
    expect(pr.status).toBe('waiting_on_maintainer');
    expect(shouldSuggestClose(pr)).toBe(true);
  });

  it('a maintainer comment keeps the PR active', async () => {
    const pr = await assembleFetchedPR(
      signals({
        updatedAt: daysAgo(3),
        comments: [
          { user: { login: 'contributor' }, body: 'Addressed', created_at: daysAgo(2) },
          { user: { login: 'maintainer' }, body: 'Thanks', created_at: daysAgo(3) },
        ],
      }),
      CONFIG,
      undefined,
    );
    expect(pr.stalenessTier).toBe('active');
    expect(shouldSuggestClose(pr)).toBe(false);
  });

  it('counts a maintainer force-push and commit (activityEvents) as maintainer activity', async () => {
    // uutils/coreutils#13331 shape: no maintainer comments for months, but a
    // maintainer committed and later force-pushed to the PR branch.
    const pr = await assembleFetchedPR(
      signals({
        createdAt: daysAgo(120),
        updatedAt: daysAgo(1),
        comments: [{ user: { login: 'contributor' }, body: 'ping', created_at: daysAgo(1) }],
        activityEvents: [
          { login: 'maintainer', at: daysAgo(65) },
          { login: 'maintainer', type: 'User', at: daysAgo(4) },
        ],
      }),
      CONFIG,
      undefined,
    );
    expect(pr.daysSinceMaintainerActivity).toBeLessThanOrEqual(4);
    expect(pr.stalenessTier).toBe('active');
  });

  it('measures from PR creation when nobody else has engaged', async () => {
    const pr = await assembleFetchedPR(signals({ createdAt: daysAgo(40), updatedAt: daysAgo(2) }), CONFIG, undefined);
    expect(pr.lastMaintainerActivityAt).toBe(pr.createdAt);
    expect(pr.stalenessTier).toBe('dormant');
  });
});

describe('assembleFetchedPR incomplete checklist', () => {
  it('keeps the PR waiting and shows the checklist as a note', async () => {
    const pr = await assembleFetchedPR(
      signals({ createdAt: daysAgo(2), updatedAt: daysAgo(2), body: '- [x] Tests added\n- [ ] Docs updated\n' }),
      CONFIG,
      undefined,
    );
    expect(pr.hasIncompleteChecklist).toBe(true);
    expect(pr.status).toBe('waiting_on_maintainer');
    expect(pr.actionReasons).toBeUndefined();
    expect(pr.displayDescription).toContain('(note: checklist 1/2)');
  });
});

describe('assembleFetchedPR issue link (#1863)', () => {
  it('parses the closing keyword in the body into issueUrl', async () => {
    const pr = await assembleFetchedPR(signals({ body: 'Fixes #12\n\nDetails.' }), CONFIG, undefined);
    expect(pr.issueUrl).toBe('https://github.com/o/r/issues/12');
  });

  it('leaves issueUrl undefined when the body has no closing keyword', async () => {
    const pr = await assembleFetchedPR(signals({ body: 'See #12 for context.' }), CONFIG, undefined);
    expect(pr.issueUrl).toBeUndefined();
  });

  it('collects every mention from title and body into mentionedIssueUrls, keyword or not', async () => {
    const pr = await assembleFetchedPR(
      signals({ title: 'Supersedes #9', body: 'See #12 for context. Fixes other/lib#3.' }),
      CONFIG,
      undefined,
    );
    expect(pr.mentionedIssueUrls).toEqual([
      'https://github.com/o/r/issues/9',
      'https://github.com/o/r/issues/12',
      'https://github.com/other/lib/issues/3',
    ]);
  });

  it('leaves mentionedIssueUrls empty when nothing is mentioned', async () => {
    const pr = await assembleFetchedPR(signals({ body: 'No links here.' }), CONFIG, undefined);
    expect(pr.mentionedIssueUrls).toEqual([]);
  });
});

function approvalBy(login: string, days: number, body = '') {
  return { body, user: { login }, state: 'APPROVED', submitted_at: daysAgo(days), id: days };
}

describe('assembleFetchedPR approved PR with a maintainer comment (#1920)', () => {
  const question = { user: { login: 'maintainer' }, body: 'Can you add a test for the empty case?' };
  const noChecks = { status: 'unknown' as const, failingCheckNames: [], failingCheckConclusions: new Map() };

  it('someone else approving before the question does not settle it', async () => {
    const pr = await assembleFetchedPR(
      signals({ reviews: [approvalBy('drive-by', 10)], comments: [{ ...question, created_at: daysAgo(5) }] }),
      CONFIG,
      undefined,
    );
    expect(pr.reviewDecision).toBe('approved');
    expect(pr.status).toBe('needs_addressing');
    expect(pr.actionReason).toBe('needs_response');
    expect(pr.actionReasons).toEqual(['needs_response']);
  });

  it('someone else approving before the question does not settle it when the PR has no CI checks', async () => {
    const pr = await assembleFetchedPR(
      signals({
        reviews: [approvalBy('drive-by', 10)],
        comments: [{ ...question, created_at: daysAgo(5) }],
        ciStatus: noChecks,
      }),
      CONFIG,
      undefined,
    );
    expect(pr.actionReason).toBe('needs_response');
  });

  it('someone else approving after the question does not settle it', async () => {
    const pr = await assembleFetchedPR(
      signals({ reviews: [approvalBy('drive-by', 10)], comments: [{ ...question, created_at: daysAgo(15) }] }),
      CONFIG,
      undefined,
    );
    expect(pr.reviewDecision).toBe('approved');
    expect(pr.actionReason).toBe('needs_response');
  });

  it('the commenter approving after their question settles it', async () => {
    const pr = await assembleFetchedPR(
      signals({ reviews: [approvalBy('maintainer', 10)], comments: [{ ...question, created_at: daysAgo(15) }] }),
      CONFIG,
      undefined,
    );
    expect(pr.hasUnrespondedComment).toBe(true);
    expect(pr.waitReason).toBe('pending_merge');
    expect(pr.actionReasons).toBeUndefined();
  });

  it('matches the commenter to their approval case-insensitively', async () => {
    const pr = await assembleFetchedPR(
      signals({ reviews: [approvalBy('Maintainer', 10)], comments: [{ ...question, created_at: daysAgo(15) }] }),
      CONFIG,
      undefined,
    );
    expect(pr.waitReason).toBe('pending_merge');
  });

  it("the approving review's own note stays pending_merge (#1507)", async () => {
    const note = 'Nice work. I will merge this after the release is cut.';
    const pr = await assembleFetchedPR(signals({ reviews: [approvalBy('maintainer', 10, note)] }), CONFIG, undefined);
    expect(pr.hasUnrespondedComment).toBe(true);
    expect(pr.waitReason).toBe('pending_merge');
  });

  it('the approver asking a separate question after approving needs a response', async () => {
    const pr = await assembleFetchedPR(
      signals({ reviews: [approvalBy('maintainer', 10)], comments: [{ ...question, created_at: daysAgo(5) }] }),
      CONFIG,
      undefined,
    );
    expect(pr.actionReason).toBe('needs_response');
  });

  it("the commenter's later approval does not settle it once that approval is dismissed", async () => {
    const pr = await assembleFetchedPR(
      signals({
        reviews: [
          approvalBy('drive-by', 20),
          approvalBy('maintainer', 10),
          { user: { login: 'maintainer' }, state: 'DISMISSED', body: '', submitted_at: daysAgo(9), id: 99 },
        ],
        comments: [{ ...question, created_at: daysAgo(15) }],
      }),
      CONFIG,
      undefined,
    );
    expect(pr.reviewDecision).toBe('approved');
    expect(pr.actionReason).toBe('needs_response');
  });

  it.each(['Thanks!', 'LGTM'])('a pure acknowledgment after the approval (%s) stays pending_merge', async (body) => {
    const pr = await assembleFetchedPR(
      signals({
        reviews: [approvalBy('drive-by', 10)],
        comments: [{ body, user: { login: 'maintainer' }, created_at: daysAgo(5) }],
      }),
      CONFIG,
      undefined,
    );
    expect(pr.hasUnrespondedComment).toBe(false);
    expect(pr.waitReason).toBe('pending_merge');
  });

  it('a question after the approval that the author answered stays pending_merge', async () => {
    const pr = await assembleFetchedPR(
      signals({
        reviews: [approvalBy('drive-by', 10)],
        comments: [
          { ...question, created_at: daysAgo(5) },
          { user: { login: 'contributor' }, body: 'Added in the latest push.', created_at: daysAgo(4) },
        ],
      }),
      CONFIG,
      undefined,
    );
    expect(pr.waitReason).toBe('pending_merge');
  });

  it('a standing changes request still wins over another reviewer approving', async () => {
    const pr = await assembleFetchedPR(
      signals({
        reviews: [
          approvalBy('drive-by', 10),
          { user: { login: 'maintainer' }, state: 'CHANGES_REQUESTED', body: '', submitted_at: daysAgo(5), id: 2 },
        ],
      }),
      CONFIG,
      { date: daysAgo(20), author: 'contributor' },
    );
    expect(pr.reviewDecision).toBe('changes_requested');
    expect(pr.status).toBe('needs_addressing');
    expect(pr.actionReasons).toEqual(['needs_response', 'needs_changes']);
  });
});
