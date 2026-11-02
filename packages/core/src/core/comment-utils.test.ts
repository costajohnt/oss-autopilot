/**
 * Tests for comment-utils
 */

import { describe, it, expect } from 'vitest';
import { isBotAuthor, isAcknowledgmentComment, isReactionOnlyComment, isQuoteReplyTo } from './comment-utils.js';

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

  it('should detect user-account bots with a -bot suffix', () => {
    expect(isBotAuthor('miq-bot')).toBe(true);
    expect(isBotAuthor('Some-Org-Bot')).toBe(true);
    expect(isBotAuthor('Dependabot[BOT]')).toBe(true);
    expect(isBotAuthor('k8s-ci-robot')).toBe(true);
    expect(isBotAuthor('Copilot')).toBe(true);
  });

  it('should treat REST user.type Bot as a bot regardless of login', () => {
    expect(isBotAuthor('some-app', 'Bot')).toBe(true);
    expect(isBotAuthor('octocat', 'User')).toBe(false);
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

describe('isReactionOnlyComment (#1862)', () => {
  it('treats "+1", "same here" and "any update" style comments as reactions', () => {
    expect(isReactionOnlyComment('+1')).toBe(true);
    expect(isReactionOnlyComment('+1!')).toBe(true);
    expect(isReactionOnlyComment('Same here.')).toBe(true);
    expect(isReactionOnlyComment('me too')).toBe(true);
    expect(isReactionOnlyComment('Any update?')).toBe(true);
    expect(isReactionOnlyComment('bump')).toBe(true);
  });

  it('treats emoji-only, shortcode-only and empty comments as reactions', () => {
    expect(isReactionOnlyComment('👍')).toBe(true);
    expect(isReactionOnlyComment('🎉 🎉')).toBe(true);
    expect(isReactionOnlyComment(':+1: :tada:')).toBe(true);
    expect(isReactionOnlyComment('')).toBe(true);
    expect(isReactionOnlyComment('   \n ')).toBe(true);
    expect(isReactionOnlyComment('+1 👍')).toBe(true);
  });

  it('keeps anything that says more', () => {
    expect(isReactionOnlyComment('Same here on Windows 11 with 3.2.0, the probe below reproduces it')).toBe(false);
    expect(isReactionOnlyComment('Thanks for wanting to work on this! I would rather see a flag.')).toBe(false);
    expect(isReactionOnlyComment('+1, and the fix should also cover the CLI path')).toBe(false);
    expect(isReactionOnlyComment('Any update on the review? Happy to rebase.')).toBe(false);
  });
});

describe('isQuoteReplyTo (#1862)', () => {
  const userComment = 'I can take this one.\nPlan: add a `--dry-run` flag and keep the default behaviour unchanged.';

  it('matches a GitHub "Quote reply" of the comment', () => {
    const reply =
      '> Plan: add a `--dry-run` flag and keep the default behaviour unchanged.\n\nPlease do not; a flag is the wrong shape here.';
    expect(isQuoteReplyTo(reply, userComment)).toBe(true);
  });

  it('matches a nested or whitespace-reflowed quote', () => {
    expect(isQuoteReplyTo('>> I can take   this one.\n\nGreat', userComment)).toBe(true);
    expect(isQuoteReplyTo('  >  i CAN take this one.', userComment)).toBe(true);
  });

  it('ignores quotes of someone else and quotes too short to identify a comment', () => {
    expect(isQuoteReplyTo('> We should close this as wontfix.\n\nAgreed', userComment)).toBe(false);
    expect(isQuoteReplyTo('> I can\n\nyes', userComment)).toBe(false);
    expect(isQuoteReplyTo('I can take this one.', userComment)).toBe(false);
  });

  it('never matches a short or empty source comment', () => {
    expect(isQuoteReplyTo('> +1\n\nsame', '+1')).toBe(false);
    expect(isQuoteReplyTo('> anything here at all', '')).toBe(false);
  });
});
