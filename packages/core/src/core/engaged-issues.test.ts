/**
 * Tests for engaged-issues.ts (#1862): which issues count as "being worked
 * on", keyed and ranked for the issue conversation monitor.
 */

import { describe, it, expect } from 'vitest';
import {
  collectEngagedIssues,
  toIssueEngagement,
  LEDGER_LINK_MAX_AGE_DAYS,
  type EngagedIssuesInput,
} from './engaged-issues.js';

const ISSUE = 'https://github.com/Org/Repo/issues/10';
const KEY = 'org/repo#10';
/** Reference "now" for the ledger age bound; the fixed ledger dates below are inside it. */
const NOW = new Date('2026-06-10T00:00:00Z');

/** ISO stamp `days` before {@link NOW}. */
function daysBeforeNow(days: number): string {
  const stamp = new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
  return stamp.toISOString();
}

function input(overrides: Partial<EngagedIssuesInput> = {}): EngagedIssuesInput {
  return {
    claims: [],
    openPRs: [],
    recentlyClosedPRs: [],
    recentlyMergedPRs: [],
    ledgerClosedPRs: [],
    ledgerMergedPRs: [],
    ...overrides,
  };
}

describe('collectEngagedIssues', () => {
  it('returns an empty map when nothing is claimed or linked', () => {
    expect(collectEngagedIssues(input()).size).toBe(0);
  });

  it('keys a claim by issueRefKey with a canonical URL and the claim stamp as since', () => {
    const engaged = collectEngagedIssues(
      input({ claims: [{ url: `${ISSUE}#issuecomment-1`, updatedAt: '2026-06-01T00:00:00Z', status: 'claimed' }] }),
    );
    expect(Array.from(engaged, ([, e]) => e)).toEqual([
      {
        key: KEY,
        url: 'https://github.com/Org/Repo/issues/10',
        reason: 'claim',
        since: '2026-06-01T00:00:00Z',
        claimed: true,
        fetchWhenMissing: true,
      },
    ]);
  });

  it('does not count a candidate as a claim', () => {
    const engaged = collectEngagedIssues(
      input({
        claims: [
          { url: ISSUE, updatedAt: '2026-06-01T00:00:00Z', status: 'candidate' },
          { url: 'https://github.com/org/repo/issues/11', updatedAt: '2026-06-01T00:00:00Z', status: 'in_progress' },
          { url: 'https://github.com/org/repo/issues/12', updatedAt: '2026-06-01T00:00:00Z', status: 'pr_submitted' },
        ],
      }),
    );
    expect(Array.from(engaged, ([key]) => key)).toEqual(['org/repo#11', 'org/repo#12']);
  });

  it('links an open PR through its closing keyword only, not through plain mentions in the body', () => {
    const pr = {
      url: 'https://github.com/org/repo/pull/20',
      issueUrl: ISSUE,
      // "similar to #11" in the body: named, not worked on. The type no longer
      // accepts it; this guards against the field creeping back in at runtime.
      mentionedIssueUrls: ['https://github.com/org/repo/issues/11'],
      createdAt: '2026-06-02T00:00:00Z',
    };
    const engaged = collectEngagedIssues(input({ openPRs: [pr] }));
    expect(Array.from(engaged, ([key]) => key)).toEqual([KEY]);
    expect(engaged.get(KEY)).toMatchObject({
      reason: 'open_pr',
      prUrl: 'https://github.com/org/repo/pull/20',
      since: '2026-06-02T00:00:00Z',
      fetchWhenMissing: true,
    });
  });

  it('dates a closed or merged PR by its opening time and leaves since unset without one', () => {
    const engaged = collectEngagedIssues(
      input({
        recentlyClosedPRs: [
          {
            url: 'https://github.com/org/repo/pull/20',
            issueUrl: ISSUE,
            openedAt: '2026-05-20T00:00:00Z',
            closedAt: '2026-06-02T00:00:00Z',
          },
        ],
        recentlyMergedPRs: [
          {
            url: 'https://github.com/org/repo/pull/21',
            issueUrl: 'https://github.com/org/repo/issues/11',
            mergedAt: '2026-06-03T00:00:00Z',
          },
        ],
      }),
    );
    expect(engaged.get(KEY)).toMatchObject({ reason: 'closed_pr', since: '2026-05-20T00:00:00Z' });
    // The merge time is not when the user engaged; the monitor falls back to
    // the user's last comment rather than treating replies before the merge
    // as answered.
    expect(engaged.get('org/repo#11')).toEqual({
      key: 'org/repo#11',
      url: 'https://github.com/org/repo/issues/11',
      reason: 'merged_pr',
      prUrl: 'https://github.com/org/repo/pull/21',
      claimed: false,
      fetchWhenMissing: true,
    });
    expect(engaged.get('org/repo#11')).not.toHaveProperty('since');
  });

  it('skips links that do not parse as GitHub issue or PR URLs and PRs without an issue link', () => {
    const engaged = collectEngagedIssues(
      input({
        claims: [{ url: 'https://example.com/issues/1', updatedAt: '2026-06-01T00:00:00Z', status: 'claimed' }],
        openPRs: [{ url: 'https://github.com/org/repo/pull/20', createdAt: '2026-06-02T00:00:00Z' }],
        recentlyClosedPRs: [{ url: 'https://github.com/org/repo/pull/21', closedAt: '2026-06-02T00:00:00Z' }],
      }),
    );
    expect(engaged.size).toBe(0);
  });
});

describe('collectEngagedIssues: ledger links, own PRs and merging', () => {
  it('marks ledger links as not fetched when missing: they count only when the search finds the issue', () => {
    const engaged = collectEngagedIssues(
      input({
        ledgerClosedPRs: [
          { url: 'https://github.com/org/repo/pull/20', issueUrl: ISSUE, closedAt: '2026-05-01T00:00:00Z' },
        ],
        ledgerMergedPRs: [
          {
            url: 'https://github.com/org/repo/pull/21',
            issueUrl: 'https://github.com/org/repo/issues/11',
            mergedAt: '2026-05-02T00:00:00Z',
          },
        ],
      }),
      { now: NOW },
    );
    expect(engaged.get(KEY)).toMatchObject({ reason: 'closed_pr', fetchWhenMissing: false });
    expect(engaged.get('org/repo#11')).toMatchObject({ reason: 'merged_pr', fetchWhenMissing: false });
  });

  it(`drops ledger links older than ${LEDGER_LINK_MAX_AGE_DAYS} days: a months-old merge does not widen the reply rule`, () => {
    const justInside = daysBeforeNow(LEDGER_LINK_MAX_AGE_DAYS - 1);
    const justOutside = daysBeforeNow(LEDGER_LINK_MAX_AGE_DAYS + 1);
    const engaged = collectEngagedIssues(
      input({
        ledgerMergedPRs: [
          { url: 'https://github.com/org/repo/pull/1', issueUrl: ISSUE, mergedAt: justInside },
          {
            url: 'https://github.com/org/repo/pull/2',
            issueUrl: 'https://github.com/org/repo/issues/11',
            mergedAt: justOutside,
          },
          {
            url: 'https://github.com/org/repo/pull/3',
            issueUrl: 'https://github.com/org/repo/issues/12',
            mergedAt: '2025-01-01T00:00:00Z',
          },
        ],
        ledgerClosedPRs: [
          {
            url: 'https://github.com/org/repo/pull/4',
            issueUrl: 'https://github.com/org/repo/issues/13',
            closedAt: justOutside,
          },
          {
            url: 'https://github.com/org/repo/pull/5',
            issueUrl: 'https://github.com/org/repo/issues/14',
            closedAt: 'garbage',
          },
        ],
      }),
      { now: NOW },
    );
    expect(Array.from(engaged, ([key]) => key)).toEqual([KEY]);
  });

  it('keeps recent closed and merged PRs regardless of age: the recent lists are the live window', () => {
    const engaged = collectEngagedIssues(
      input({
        recentlyMergedPRs: [
          { url: 'https://github.com/org/repo/pull/1', issueUrl: ISSUE, mergedAt: '2025-01-01T00:00:00Z' },
        ],
      }),
      { now: NOW },
    );
    expect(engaged.get(KEY)).toMatchObject({ reason: 'merged_pr', fetchWhenMissing: true });
  });

  it("skips a closing link that names one of the user's own PRs, so it never costs a direct fetch", () => {
    const engaged = collectEngagedIssues(
      input({
        openPRs: [
          // "closes #20" on a follow-up PR, where #20 is the user's own earlier PR.
          {
            url: 'https://github.com/org/repo/pull/30',
            issueUrl: 'https://github.com/org/repo/issues/20',
            createdAt: '2026-06-02T00:00:00Z',
          },
          { url: 'https://github.com/org/repo/pull/31', issueUrl: ISSUE, createdAt: '2026-06-02T00:00:00Z' },
        ],
        ledgerMergedPRs: [
          { url: 'https://github.com/Org/Repo/pull/20', issueUrl: ISSUE, mergedAt: '2026-05-20T00:00:00Z' },
        ],
        // A claim pointing at an own PR number (the claim flow stored a PR URL) is skipped too.
        claims: [{ url: 'https://github.com/org/repo/pull/31', updatedAt: '2026-06-01T00:00:00Z', status: 'claimed' }],
      }),
      { now: NOW },
    );
    expect(Array.from(engaged, ([key]) => key)).toEqual([KEY]);
  });

  it('merges several engagements of one issue: strongest reason, latest since, claimed and fetched if any is', () => {
    const engaged = collectEngagedIssues(
      input({
        ledgerMergedPRs: [
          { url: 'https://github.com/org/repo/pull/5', issueUrl: ISSUE, mergedAt: '2026-05-01T00:00:00Z' },
        ],
        claims: [{ url: ISSUE, updatedAt: '2026-06-05T00:00:00Z', status: 'claimed' }],
        openPRs: [{ url: 'https://github.com/org/repo/pull/20', issueUrl: ISSUE, createdAt: '2026-06-02T00:00:00Z' }],
      }),
      { now: NOW },
    );
    expect(Array.from(engaged, ([, e]) => e)).toEqual([
      {
        key: KEY,
        url: 'https://github.com/Org/Repo/issues/10',
        reason: 'open_pr',
        prUrl: 'https://github.com/org/repo/pull/20',
        since: '2026-06-05T00:00:00Z',
        // The open PR wins the reason, but the claim is not forgotten.
        claimed: true,
        fetchWhenMissing: true,
      },
    ]);
  });

  it('marks an issue linked only from PRs as not claimed, in either fold order', () => {
    const openPR = { url: 'https://github.com/org/repo/pull/20', issueUrl: ISSUE, createdAt: '2026-06-02T00:00:00Z' };
    const mergedPR = { url: 'https://github.com/org/repo/pull/5', issueUrl: ISSUE, mergedAt: '2026-06-01T00:00:00Z' };
    expect(collectEngagedIssues(input({ openPRs: [openPR] })).get(KEY)?.claimed).toBe(false);
    expect(collectEngagedIssues(input({ openPRs: [openPR], recentlyMergedPRs: [mergedPR] })).get(KEY)?.claimed).toBe(
      false,
    );
  });

  it('drops prUrl when a claim outranks a closed-PR link, and keeps the only known since', () => {
    const engaged = collectEngagedIssues(
      input({
        recentlyClosedPRs: [
          { url: 'https://github.com/org/repo/pull/20', issueUrl: ISSUE, closedAt: '2026-06-02T00:00:00Z' },
        ],
        claims: [{ url: ISSUE, updatedAt: '2026-06-05T00:00:00Z', status: 'claimed' }],
      }),
    );
    expect(engaged.get(KEY)).toEqual({
      key: KEY,
      url: 'https://github.com/Org/Repo/issues/10',
      reason: 'claim',
      since: '2026-06-05T00:00:00Z',
      claimed: true,
      fetchWhenMissing: true,
    });
  });

  it('keeps a parseable since over an unreadable one', () => {
    const engaged = collectEngagedIssues(
      input({
        claims: [
          { url: ISSUE, updatedAt: 'not a date', status: 'claimed' },
          { url: ISSUE.toLowerCase(), updatedAt: '2026-06-05T00:00:00Z', status: 'claimed' },
        ],
      }),
    );
    expect(engaged.get(KEY)?.since).toBe('2026-06-05T00:00:00Z');
    expect(
      collectEngagedIssues(
        input({
          claims: [
            { url: ISSUE, updatedAt: '2026-06-05T00:00:00Z', status: 'claimed' },
            { url: ISSUE, updatedAt: '', status: 'claimed' },
          ],
        }),
      ).get(KEY)?.since,
    ).toBe('2026-06-05T00:00:00Z');
  });

  it('orders the map strongest reason first so a capped direct fetch keeps open-PR and claimed issues', () => {
    const engaged = collectEngagedIssues(
      input({
        // Issue and PR numbers share one sequence on GitHub, so the fixtures
        // keep them distinct (a link to #1 from PR #1 would be an own-PR link).
        recentlyMergedPRs: [
          {
            url: 'https://github.com/org/repo/pull/1',
            issueUrl: 'https://github.com/org/repo/issues/101',
            mergedAt: '2026-06-01T00:00:00Z',
          },
        ],
        recentlyClosedPRs: [
          {
            url: 'https://github.com/org/repo/pull/2',
            issueUrl: 'https://github.com/org/repo/issues/102',
            closedAt: '2026-06-01T00:00:00Z',
          },
        ],
        claims: [
          { url: 'https://github.com/org/repo/issues/103', updatedAt: '2026-06-01T00:00:00Z', status: 'claimed' },
        ],
        openPRs: [
          {
            url: 'https://github.com/org/repo/pull/4',
            issueUrl: 'https://github.com/org/repo/issues/104',
            createdAt: '2026-06-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(Array.from(engaged, ([, e]) => e.reason)).toEqual(['open_pr', 'claim', 'closed_pr', 'merged_pr']);
  });
});

describe('toIssueEngagement', () => {
  it('projects reason, prUrl and since, omitting prUrl for claims and since when unknown', () => {
    const engaged = collectEngagedIssues(
      input({
        claims: [{ url: ISSUE, updatedAt: '2026-06-01T00:00:00Z', status: 'claimed' }],
        openPRs: [
          {
            url: 'https://github.com/org/repo/pull/20',
            issueUrl: 'https://github.com/org/repo/issues/11',
            createdAt: '2026-06-02T00:00:00Z',
          },
        ],
        recentlyMergedPRs: [
          {
            url: 'https://github.com/org/repo/pull/21',
            issueUrl: 'https://github.com/org/repo/issues/12',
            mergedAt: '2026-06-03T00:00:00Z',
          },
        ],
      }),
    );
    expect(toIssueEngagement(engaged.get(KEY)!)).toEqual({ reason: 'claim', since: '2026-06-01T00:00:00Z' });
    expect(toIssueEngagement(engaged.get('org/repo#11')!)).toEqual({
      reason: 'open_pr',
      prUrl: 'https://github.com/org/repo/pull/20',
      since: '2026-06-02T00:00:00Z',
    });
    expect(toIssueEngagement(engaged.get('org/repo#12')!)).toEqual({
      reason: 'merged_pr',
      prUrl: 'https://github.com/org/repo/pull/21',
    });
  });
});
