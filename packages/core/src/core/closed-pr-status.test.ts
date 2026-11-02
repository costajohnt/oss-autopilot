/**
 * Tests for closed-pr-status.ts (#1863): which closed-unmerged PRs should
 * prompt a status update on their linked issue.
 */

import { describe, it, expect } from 'vitest';
import {
  CLOSED_PR_STATUS_WINDOW_DAYS,
  selectClosedPRStatusCandidates,
  toClosedPRStatusUpdate,
} from './closed-pr-status.js';
import type { ClosedPR } from './types.js';

const ISSUE = 'https://github.com/org/repo/issues/10';
/** Fixed clock; closes below sit a day inside the window. */
const NOW = new Date('2026-06-03T00:00:00Z');

function closedPR(overrides: Partial<ClosedPR> = {}): ClosedPR {
  return {
    url: 'https://github.com/org/repo/pull/20',
    repo: 'org/repo',
    number: 20,
    title: 'Closed attempt',
    closedAt: '2026-06-02T00:00:00Z',
    issueUrl: ISSUE,
    ...overrides,
  };
}

describe('selectClosedPRStatusCandidates', () => {
  it('keeps a closed PR whose issue has no other PR from the user', () => {
    const pr = closedPR();
    expect(selectClosedPRStatusCandidates([pr], [], NOW)).toEqual([pr]);
  });

  it('skips closed PRs with no parsed issue link', () => {
    expect(selectClosedPRStatusCandidates([closedPR({ issueUrl: undefined })], [], NOW)).toEqual([]);
  });

  it('skips closed PRs whose issue URL does not parse', () => {
    expect(selectClosedPRStatusCandidates([closedPR({ issueUrl: 'https://example.com/x' })], [], NOW)).toEqual([]);
  });

  it('skips a PR superseded by an open PR on the same issue', () => {
    const open = { url: 'https://github.com/org/repo/pull/21', issueUrl: ISSUE };
    expect(selectClosedPRStatusCandidates([closedPR()], [open], NOW)).toEqual([]);
  });

  it('skips a PR superseded by a merged PR on the same issue', () => {
    const merged = { url: 'https://github.com/org/repo/pull/19', issueUrl: ISSUE };
    expect(selectClosedPRStatusCandidates([closedPR()], [merged], NOW)).toEqual([]);
  });

  it('treats a successor that only mentions the issue (no closing keyword) as superseding', () => {
    const open = { url: 'https://github.com/org/repo/pull/21', mentionedIssueUrls: [ISSUE] };
    expect(selectClosedPRStatusCandidates([closedPR()], [open], NOW)).toEqual([]);
  });

  it('treats a successor that mentions the closed PR by number as superseding', () => {
    // "Supersedes #20" in the successor body resolves to org/repo#20, the closed PR.
    const open = {
      url: 'https://github.com/org/repo/pull/21',
      mentionedIssueUrls: ['https://github.com/org/repo/issues/20'],
    };
    expect(selectClosedPRStatusCandidates([closedPR()], [open], NOW)).toEqual([]);
  });

  it('compares URLs case-insensitively and ignores trailing slashes and fragments', () => {
    const closed = closedPR({ issueUrl: 'https://github.com/Org/Repo/issues/10/' });
    const open = {
      url: 'https://github.com/org/repo/pull/21',
      mentionedIssueUrls: ['https://github.com/ORG/REPO/issues/10#issuecomment-1'],
    };
    expect(selectClosedPRStatusCandidates([closed], [open], NOW)).toEqual([]);
    const closes = { url: 'https://github.com/org/repo/pull/22', issueUrl: 'https://github.com/ORG/repo/issues/10' };
    expect(selectClosedPRStatusCandidates([closed], [closes], NOW)).toEqual([]);
  });

  it('does not let a bare #N in another repo supersede', () => {
    // `#10` in other/lib resolves to other/lib#10, not org/repo#10.
    const open = {
      url: 'https://github.com/other/lib/pull/3',
      mentionedIssueUrls: ['https://github.com/other/lib/issues/10'],
    };
    const pr = closedPR();
    expect(selectClosedPRStatusCandidates([pr], [open], NOW)).toEqual([pr]);
  });

  it('ignores other PRs linked to different issues or with no link', () => {
    const pr = closedPR();
    const others = [
      { url: 'https://github.com/org/repo/pull/21', issueUrl: 'https://github.com/org/repo/issues/11' },
      { url: 'https://github.com/org/repo/pull/22' },
      { url: 'https://github.com/org/repo/pull/23', mentionedIssueUrls: [] },
    ];
    expect(selectClosedPRStatusCandidates([pr], others, NOW)).toEqual([pr]);
  });

  it('does not treat the closed PR itself as its own successor', () => {
    const pr = closedPR();
    const self = { url: 'https://github.com/ORG/repo/pull/20', issueUrl: ISSUE, mentionedIssueUrls: [ISSUE] };
    expect(selectClosedPRStatusCandidates([pr], [self], NOW)).toEqual([pr]);
  });

  it('drops a PR with an unparseable closedAt', () => {
    expect(selectClosedPRStatusCandidates([closedPR({ closedAt: '' })], [], NOW)).toEqual([]);
    expect(selectClosedPRStatusCandidates([closedPR({ closedAt: 'yesterday' })], [], NOW)).toEqual([]);
  });

  it('drops a PR closed outside the window even when the search returned it', () => {
    const stale = closedPR({ closedAt: '2026-05-01T00:00:00Z' });
    expect(selectClosedPRStatusCandidates([stale], [], NOW)).toEqual([]);
    const dayMs = 24 * 60 * 60 * 1000;
    const justOutside = new Date(NOW.getTime() - (CLOSED_PR_STATUS_WINDOW_DAYS * dayMs + 1));
    const edge = closedPR({ closedAt: justOutside.toISOString() });
    expect(selectClosedPRStatusCandidates([edge], [], NOW)).toEqual([]);
    const sixDaysAgo = new Date(NOW.getTime() - 6 * dayMs);
    const inside = closedPR({ closedAt: sixDaysAgo.toISOString() });
    expect(selectClosedPRStatusCandidates([inside], [], NOW)).toEqual([inside]);
  });

  it('keeps only the latest close when several closed PRs link the same issue', () => {
    const older = closedPR({
      url: 'https://github.com/org/repo/pull/18',
      number: 18,
      closedAt: '2026-06-01T00:00:00Z',
      issueUrl: 'https://github.com/ORG/repo/issues/10',
    });
    const newer = closedPR({ closedAt: '2026-06-02T12:00:00Z' });
    expect(selectClosedPRStatusCandidates([newer, older], [], NOW)).toEqual([newer]);
    expect(selectClosedPRStatusCandidates([older, newer], [], NOW)).toEqual([newer]);
  });
});

describe('toClosedPRStatusUpdate', () => {
  it('projects the digest fields only', () => {
    const pr = closedPR();
    expect(toClosedPRStatusUpdate({ ...pr, issueUrl: ISSUE })).toEqual({
      prUrl: pr.url,
      issueUrl: ISSUE,
      closedAt: pr.closedAt,
    });
  });
});
