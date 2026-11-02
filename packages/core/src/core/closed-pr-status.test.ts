/**
 * Tests for closed-pr-status.ts (#1863): which closed-unmerged PRs should
 * prompt a status update on their linked issue.
 */

import { describe, it, expect } from 'vitest';
import { selectClosedPRStatusCandidates, toClosedPRStatusUpdate } from './closed-pr-status.js';
import type { ClosedPR } from './types.js';

const ISSUE = 'https://github.com/org/repo/issues/10';

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
    expect(selectClosedPRStatusCandidates([pr], [])).toEqual([pr]);
  });

  it('skips closed PRs with no parsed issue link', () => {
    expect(selectClosedPRStatusCandidates([closedPR({ issueUrl: undefined })], [])).toEqual([]);
  });

  it('skips a PR superseded by an open PR on the same issue', () => {
    const open = { url: 'https://github.com/org/repo/pull/21', issueUrl: ISSUE };
    expect(selectClosedPRStatusCandidates([closedPR()], [open])).toEqual([]);
  });

  it('skips a PR superseded by a merged PR on the same issue', () => {
    const merged = { url: 'https://github.com/org/repo/pull/19', issueUrl: ISSUE };
    expect(selectClosedPRStatusCandidates([closedPR()], [merged])).toEqual([]);
  });

  it('ignores other PRs linked to different issues or with no link', () => {
    const pr = closedPR();
    const others = [
      { url: 'https://github.com/org/repo/pull/21', issueUrl: 'https://github.com/org/repo/issues/11' },
      { url: 'https://github.com/org/repo/pull/22' },
    ];
    expect(selectClosedPRStatusCandidates([pr], others)).toEqual([pr]);
  });

  it('does not treat the closed PR itself as its own successor', () => {
    const pr = closedPR();
    expect(selectClosedPRStatusCandidates([pr], [{ url: pr.url, issueUrl: ISSUE }])).toEqual([pr]);
  });

  it('keeps only the latest close when several closed PRs link the same issue', () => {
    const older = closedPR({
      url: 'https://github.com/org/repo/pull/18',
      number: 18,
      closedAt: '2026-06-01T00:00:00Z',
    });
    const newer = closedPR({ closedAt: '2026-06-03T00:00:00Z' });
    expect(selectClosedPRStatusCandidates([newer, older], [])).toEqual([newer]);
    expect(selectClosedPRStatusCandidates([older, newer], [])).toEqual([newer]);
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
