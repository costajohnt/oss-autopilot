import { describe, it, expect } from 'vitest';
import { classifyLinkedPR } from './linked-pr-classification.js';

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
      // @ts-expect-error — runtime test for uppercase input
      const result = classifyLinkedPR({
        linkedPR: { author: { login: 'contributor' }, state: 'OPEN' },
        userLogin: 'costajohnt',
      });
      expect(result).toBe('other_open');
    });

    it('accepts uppercase MERGED from GraphQL', () => {
      // @ts-expect-error — runtime test for uppercase input
      const result = classifyLinkedPR({
        linkedPR: { author: { login: 'costajohnt' }, state: 'MERGED' },
        userLogin: 'costajohnt',
      });
      expect(result).toBe('user_merged');
    });
  });

  describe('ghost author handling', () => {
    it('treats a null author (deleted GitHub account) as other_X', () => {
      const result = classifyLinkedPR({
        // @ts-expect-error — runtime test: GitHub returns null author for deleted accounts
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
