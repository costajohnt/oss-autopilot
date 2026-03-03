/**
 * Tests for comment-utils
 */

import { describe, it, expect } from 'vitest';
import { isBotAuthor, isAcknowledgmentComment } from './comment-utils.js';

describe('isBotAuthor', () => {
  it('should detect authors with [bot] suffix', () => {
    expect(isBotAuthor('dependabot[bot]')).toBe(true);
    expect(isBotAuthor('renovate[bot]')).toBe(true);
    expect(isBotAuthor('codecov[bot]')).toBe(true);
    expect(isBotAuthor('some-custom-app[bot]')).toBe(true);
  });

  it('should detect known bot usernames without [bot] suffix', () => {
    expect(isBotAuthor('allcontributors')).toBe(true);
    expect(isBotAuthor('codecov-commenter')).toBe(true);
    expect(isBotAuthor('greenkeeper')).toBe(true);
    expect(isBotAuthor('imgbot')).toBe(true);
    expect(isBotAuthor('netlify')).toBe(true);
    expect(isBotAuthor('renovate')).toBe(true);
    expect(isBotAuthor('snyk-bot')).toBe(true);
    expect(isBotAuthor('sonarcloud')).toBe(true);
    expect(isBotAuthor('stale')).toBe(true);
    expect(isBotAuthor('vercel')).toBe(true);
    expect(isBotAuthor('changeset-bot')).toBe(true);
    expect(isBotAuthor('claassistant')).toBe(true);
  });

  it('should be case-insensitive for known bot usernames', () => {
    expect(isBotAuthor('Renovate')).toBe(true);
    expect(isBotAuthor('NETLIFY')).toBe(true);
    expect(isBotAuthor('ImgBot')).toBe(true);
    expect(isBotAuthor('Vercel')).toBe(true);
  });

  it('should return false for regular usernames', () => {
    expect(isBotAuthor('johndoe')).toBe(false);
    expect(isBotAuthor('octocat')).toBe(false);
    expect(isBotAuthor('some-developer')).toBe(false);
    expect(isBotAuthor('bot-lover')).toBe(false);
  });

  it('should not match partial bot name substrings', () => {
    // "stale" is a known bot, but "staleman" is not
    expect(isBotAuthor('staleman')).toBe(false);
    // "netlify" is known but "netlify-user" is not
    expect(isBotAuthor('netlify-user')).toBe(false);
  });
});

describe('isAcknowledgmentComment', () => {
  it('should detect basic acknowledgment keywords', () => {
    expect(isAcknowledgmentComment('thanks')).toBe(true);
    expect(isAcknowledgmentComment('thank you')).toBe(true);
    expect(isAcknowledgmentComment('LGTM')).toBe(true);
    expect(isAcknowledgmentComment('looks good')).toBe(true);
    expect(isAcknowledgmentComment('noted')).toBe(true);
    expect(isAcknowledgmentComment('got it')).toBe(true);
  });

  it('should detect review/follow-up acknowledgments', () => {
    expect(isAcknowledgmentComment('will review')).toBe(true);
    expect(isAcknowledgmentComment("we'll review")).toBe(true);
    expect(isAcknowledgmentComment("we'll get to this")).toBe(true);
    expect(isAcknowledgmentComment('will look')).toBe(true);
    expect(isAcknowledgmentComment('will check')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isAcknowledgmentComment('Thanks!')).toBe(true);
    expect(isAcknowledgmentComment('LGTM')).toBe(true);
    expect(isAcknowledgmentComment('Looks Good')).toBe(true);
    expect(isAcknowledgmentComment('Will Review')).toBe(true);
  });

  it('should match keywords embedded in short messages', () => {
    expect(isAcknowledgmentComment('Thanks for the fix!')).toBe(true);
    expect(isAcknowledgmentComment('LGTM, ship it')).toBe(true);
    expect(isAcknowledgmentComment('Looks good to me')).toBe(true);
  });

  it('should reject comments with question marks', () => {
    expect(isAcknowledgmentComment('thanks?')).toBe(false);
    expect(isAcknowledgmentComment('looks good, but can you fix the tests?')).toBe(false);
    expect(isAcknowledgmentComment('will review - when is the deadline?')).toBe(false);
  });

  it('should reject comments longer than 100 characters', () => {
    const longAck = 'thanks ' + 'a'.repeat(100);
    expect(longAck.length).toBeGreaterThan(100);
    expect(isAcknowledgmentComment(longAck)).toBe(false);
  });

  it('should reject empty or falsy input', () => {
    expect(isAcknowledgmentComment('')).toBe(false);
  });

  it('should reject non-acknowledgment comments', () => {
    expect(isAcknowledgmentComment('Please fix the lint errors')).toBe(false);
    expect(isAcknowledgmentComment('This needs a rebase')).toBe(false);
    expect(isAcknowledgmentComment('Can you add tests')).toBe(false);
    expect(isAcknowledgmentComment('I disagree with this approach')).toBe(false);
  });
});
