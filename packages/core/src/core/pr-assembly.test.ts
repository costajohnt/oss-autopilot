/**
 * Tests for pr-assembly.ts: dormancy clock and informational checklist.
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
