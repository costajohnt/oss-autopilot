/**
 * Tests for engaged-issues.ts (#1862): which issues count as "being worked
 * on", keyed and ranked for the issue conversation monitor.
 */

import { describe, it, expect } from 'vitest';
import { collectEngagedIssues, toIssueEngagement, type EngagedIssuesInput } from './engaged-issues.js';

const ISSUE = 'https://github.com/Org/Repo/issues/10';
const KEY = 'org/repo#10';

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
      input({ claims: [{ url: `${ISSUE}#issuecomment-1`, updatedAt: '2026-06-01T00:00:00Z' }] }),
    );
    expect(Array.from(engaged, ([, e]) => e)).toEqual([
      {
        key: KEY,
        url: 'https://github.com/Org/Repo/issues/10',
        reason: 'claim',
        since: '2026-06-01T00:00:00Z',
        fetchWhenMissing: true,
      },
    ]);
  });

  it('links an open PR through its closing keyword and through plain mentions', () => {
    const engaged = collectEngagedIssues(
      input({
        openPRs: [
          {
            url: 'https://github.com/org/repo/pull/20',
            issueUrl: ISSUE,
            mentionedIssueUrls: ['https://github.com/org/repo/issues/11'],
            createdAt: '2026-06-02T00:00:00Z',
          },
        ],
      }),
    );
    expect(Array.from(engaged, ([key]) => key)).toEqual([KEY, 'org/repo#11']);
    expect(engaged.get('org/repo#11')).toMatchObject({
      reason: 'open_pr',
      prUrl: 'https://github.com/org/repo/pull/20',
      since: '2026-06-02T00:00:00Z',
      fetchWhenMissing: true,
    });
  });

  it('dates a closed or merged PR by its opening time, falling back to the close or merge', () => {
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
    expect(engaged.get('org/repo#11')).toMatchObject({ reason: 'merged_pr', since: '2026-06-03T00:00:00Z' });
  });

  it('marks ledger links as not fetched when missing: they count only when the search finds the issue', () => {
    const engaged = collectEngagedIssues(
      input({
        ledgerClosedPRs: [
          { url: 'https://github.com/org/repo/pull/20', issueUrl: ISSUE, closedAt: '2025-01-01T00:00:00Z' },
        ],
        ledgerMergedPRs: [
          {
            url: 'https://github.com/org/repo/pull/21',
            issueUrl: 'https://github.com/org/repo/issues/11',
            mergedAt: '2025-01-02T00:00:00Z',
          },
        ],
      }),
    );
    expect(engaged.get(KEY)).toMatchObject({ reason: 'closed_pr', fetchWhenMissing: false });
    expect(engaged.get('org/repo#11')).toMatchObject({ reason: 'merged_pr', fetchWhenMissing: false });
  });

  it('merges several engagements of one issue: strongest reason, latest since, fetch if any is live', () => {
    const engaged = collectEngagedIssues(
      input({
        ledgerMergedPRs: [
          { url: 'https://github.com/org/repo/pull/5', issueUrl: ISSUE, mergedAt: '2025-01-01T00:00:00Z' },
        ],
        claims: [{ url: ISSUE, updatedAt: '2026-06-05T00:00:00Z' }],
        openPRs: [{ url: 'https://github.com/org/repo/pull/20', issueUrl: ISSUE, createdAt: '2026-06-02T00:00:00Z' }],
      }),
    );
    expect(Array.from(engaged, ([, e]) => e)).toEqual([
      {
        key: KEY,
        url: 'https://github.com/Org/Repo/issues/10',
        reason: 'open_pr',
        prUrl: 'https://github.com/org/repo/pull/20',
        since: '2026-06-05T00:00:00Z',
        fetchWhenMissing: true,
      },
    ]);
  });

  it('keeps a parseable since over an unreadable one', () => {
    const engaged = collectEngagedIssues(
      input({
        claims: [
          { url: ISSUE, updatedAt: 'not a date' },
          { url: ISSUE.toLowerCase(), updatedAt: '2026-06-05T00:00:00Z' },
        ],
      }),
    );
    expect(engaged.get(KEY)?.since).toBe('2026-06-05T00:00:00Z');
    expect(
      collectEngagedIssues(
        input({
          claims: [
            { url: ISSUE, updatedAt: '2026-06-05T00:00:00Z' },
            { url: ISSUE, updatedAt: '' },
          ],
        }),
      ).get(KEY)?.since,
    ).toBe('2026-06-05T00:00:00Z');
  });

  it('orders the map strongest reason first so a capped direct fetch keeps open-PR and claimed issues', () => {
    const engaged = collectEngagedIssues(
      input({
        recentlyMergedPRs: [
          {
            url: 'https://github.com/org/repo/pull/1',
            issueUrl: 'https://github.com/org/repo/issues/1',
            mergedAt: '2026-06-01T00:00:00Z',
          },
        ],
        recentlyClosedPRs: [
          {
            url: 'https://github.com/org/repo/pull/2',
            issueUrl: 'https://github.com/org/repo/issues/2',
            closedAt: '2026-06-01T00:00:00Z',
          },
        ],
        claims: [{ url: 'https://github.com/org/repo/issues/3', updatedAt: '2026-06-01T00:00:00Z' }],
        openPRs: [
          {
            url: 'https://github.com/org/repo/pull/4',
            issueUrl: 'https://github.com/org/repo/issues/4',
            createdAt: '2026-06-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(Array.from(engaged, ([, e]) => e.reason)).toEqual(['open_pr', 'claim', 'closed_pr', 'merged_pr']);
  });

  it('skips links that do not parse as GitHub issue or PR URLs and PRs without an issue link', () => {
    const engaged = collectEngagedIssues(
      input({
        claims: [{ url: 'https://example.com/issues/1', updatedAt: '2026-06-01T00:00:00Z' }],
        openPRs: [{ url: 'https://github.com/org/repo/pull/20', createdAt: '2026-06-02T00:00:00Z' }],
        recentlyClosedPRs: [{ url: 'https://github.com/org/repo/pull/21', closedAt: '2026-06-02T00:00:00Z' }],
      }),
    );
    expect(engaged.size).toBe(0);
  });
});

describe('toIssueEngagement', () => {
  it('projects reason, prUrl and since, omitting prUrl for claims', () => {
    const engaged = collectEngagedIssues(
      input({
        claims: [{ url: ISSUE, updatedAt: '2026-06-01T00:00:00Z' }],
        openPRs: [
          {
            url: 'https://github.com/org/repo/pull/20',
            issueUrl: 'https://github.com/org/repo/issues/11',
            createdAt: '2026-06-02T00:00:00Z',
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
  });
});
