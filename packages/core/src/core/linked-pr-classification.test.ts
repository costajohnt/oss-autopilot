import { describe, it, expect } from 'vitest';
import { classifyLinkedPR, isLinkedPRStalled, STALLED_PR_THRESHOLD_DAYS } from './linked-pr-classification.js';

describe('classifyLinkedPR', () => {
  it('returns none when there is no linked PR', () => {
    const result = classifyLinkedPR({ linkedPR: null, userLogin: 'costajohnt' });
    expect(result).toBe('none');
  });

  it('returns user_open when the user authored the open linked PR', () => {
    const result = classifyLinkedPR({
      linkedPR: { author: { login: 'costajohnt' }, state: 'open' },
      userLogin: 'costajohnt',
    });
    expect(result).toBe('user_open');
  });

  it('returns user_closed when the user authored the closed linked PR', () => {
    const result = classifyLinkedPR({
      linkedPR: { author: { login: 'costajohnt' }, state: 'closed' },
      userLogin: 'costajohnt',
    });
    expect(result).toBe('user_closed');
  });

  it('returns other_open when someone else authored the open linked PR', () => {
    const result = classifyLinkedPR({
      linkedPR: { author: { login: 'dependabot[bot]' }, state: 'open' },
      userLogin: 'costajohnt',
    });
    expect(result).toBe('other_open');
  });

  it('returns other_closed when someone else authored the closed linked PR', () => {
    const result = classifyLinkedPR({
      linkedPR: { author: { login: 'contributor' }, state: 'closed' },
      userLogin: 'costajohnt',
    });
    expect(result).toBe('other_closed');
  });

  it('compares logins case-insensitively (GitHub usernames are case-insensitive)', () => {
    const result = classifyLinkedPR({
      linkedPR: { author: { login: 'CostaJohnt' }, state: 'open' },
      userLogin: 'costajohnt',
    });
    expect(result).toBe('user_open');
  });

  it('treats empty userLogin as non-match (cannot be the user)', () => {
    const result = classifyLinkedPR({
      linkedPR: { author: { login: 'contributor' }, state: 'open' },
      userLogin: '',
    });
    expect(result).toBe('other_open');
  });

  it('treats a missing author login as other_X (defensive — cannot prove it is the user)', () => {
    const result = classifyLinkedPR({
      linkedPR: { author: { login: '' }, state: 'closed' },
      userLogin: 'costajohnt',
    });
    expect(result).toBe('other_closed');
  });

  describe('merged PRs', () => {
    it('classifies a user-authored merged PR as user_merged', () => {
      const result = classifyLinkedPR({
        linkedPR: { author: { login: 'costajohnt' }, state: 'merged' },
        userLogin: 'costajohnt',
      });
      expect(result).toBe('user_merged');
    });

    it("classifies someone else's merged PR as other_merged", () => {
      const result = classifyLinkedPR({
        linkedPR: { author: { login: 'contributor' }, state: 'merged' },
        userLogin: 'costajohnt',
      });
      expect(result).toBe('other_merged');
    });
  });

  describe('state casing and normalization', () => {
    it('accepts uppercase state values (GraphQL PullRequestState enum)', () => {
      const result = classifyLinkedPR({
        // @ts-expect-error — runtime test for uppercase input
        linkedPR: { author: { login: 'contributor' }, state: 'OPEN' },
        userLogin: 'costajohnt',
      });
      expect(result).toBe('other_open');
    });

    it('accepts uppercase MERGED from GraphQL', () => {
      const result = classifyLinkedPR({
        // @ts-expect-error — runtime test for uppercase input
        linkedPR: { author: { login: 'costajohnt' }, state: 'MERGED' },
        userLogin: 'costajohnt',
      });
      expect(result).toBe('user_merged');
    });
  });

  describe('ghost author handling', () => {
    it('treats a null author (deleted GitHub account) as other_X', () => {
      const result = classifyLinkedPR({
        linkedPR: { author: null, state: 'closed' },
        userLogin: 'costajohnt',
      });
      expect(result).toBe('other_closed');
    });

    it('treats a missing author field as other_X', () => {
      const result = classifyLinkedPR({
        // @ts-expect-error — runtime test: malformed payload without author
        linkedPR: { state: 'open' },
        userLogin: 'costajohnt',
      });
      expect(result).toBe('other_open');
    });
  });
});

describe('isLinkedPRStalled', () => {
  // Fixed clock so the test is deterministic regardless of when it runs.
  const now = new Date('2026-05-09T00:00:00Z');

  it('exposes a 30-day threshold constant matching scout', () => {
    expect(STALLED_PR_THRESHOLD_DAYS).toBe(30);
  });

  it('returns false when linkedPR is null or undefined', () => {
    expect(isLinkedPRStalled(null, now)).toBe(false);
    expect(isLinkedPRStalled(undefined, now)).toBe(false);
  });

  it('returns false when the PR is closed even if updatedAt is ancient', () => {
    expect(isLinkedPRStalled({ author: { login: 'a' }, state: 'closed', updatedAt: '2020-01-01T00:00:00Z' }, now)).toBe(
      false,
    );
  });

  it('returns false when the PR is merged even if updatedAt is ancient', () => {
    expect(isLinkedPRStalled({ author: { login: 'a' }, state: 'merged', updatedAt: '2020-01-01T00:00:00Z' }, now)).toBe(
      false,
    );
  });

  it('returns false when updatedAt is missing on an open PR (unknown age)', () => {
    expect(isLinkedPRStalled({ author: { login: 'a' }, state: 'open' }, now)).toBe(false);
  });

  it('returns false for an open PR updated within the threshold', () => {
    // 29 days before `now` — still fresh.
    expect(isLinkedPRStalled({ author: { login: 'a' }, state: 'open', updatedAt: '2026-04-10T00:00:00Z' }, now)).toBe(
      false,
    );
  });

  it('returns true for an open PR last updated more than 30 days ago', () => {
    // ~60 days before `now`.
    expect(isLinkedPRStalled({ author: { login: 'a' }, state: 'open', updatedAt: '2026-03-09T00:00:00Z' }, now)).toBe(
      true,
    );
  });

  it('respects a custom thresholdDays override', () => {
    // 10 days old: stalled at threshold=7 but not at threshold=30.
    const linkedPR = { author: { login: 'a' }, state: 'open' as const, updatedAt: '2026-04-29T00:00:00Z' };
    expect(isLinkedPRStalled(linkedPR, now, 7)).toBe(true);
    expect(isLinkedPRStalled(linkedPR, now, 30)).toBe(false);
  });

  it('returns false when updatedAt is an unparseable string', () => {
    expect(isLinkedPRStalled({ author: { login: 'a' }, state: 'open', updatedAt: 'not-a-date' }, now)).toBe(false);
  });
});
