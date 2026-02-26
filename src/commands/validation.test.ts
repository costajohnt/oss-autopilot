/**
 * Tests for shared URL validation patterns (validation.ts).
 * Command-level state logic is tested in shelve.test.ts, dismiss.test.ts, and state.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  PR_URL_PATTERN,
  ISSUE_URL_PATTERN,
  validateUrl,
  validatePRNumber,
  validateMessage,
  validateRepoIdentifier,
  validateGitHubUsername,
} from './validation.js';

describe('PR_URL_PATTERN', () => {
  it('should match valid PR URLs', () => {
    expect(PR_URL_PATTERN.test('https://github.com/owner/repo/pull/123')).toBe(true);
    expect(PR_URL_PATTERN.test('https://github.com/facebook/react/pull/1')).toBe(true);
    expect(PR_URL_PATTERN.test('https://github.com/vercel/next.js/pull/99999')).toBe(true);
  });

  it('should reject invalid PR URLs', () => {
    expect(PR_URL_PATTERN.test('https://github.com/owner/repo/issues/123')).toBe(false);
    expect(PR_URL_PATTERN.test('https://github.com/owner/repo/pull/')).toBe(false);
    expect(PR_URL_PATTERN.test('https://gitlab.com/owner/repo/pull/123')).toBe(false);
    expect(PR_URL_PATTERN.test('not-a-url')).toBe(false);
    expect(PR_URL_PATTERN.test('')).toBe(false);
    expect(PR_URL_PATTERN.test('https://github.com/owner/repo/pull/123/files')).toBe(false);
  });
});

describe('ISSUE_URL_PATTERN', () => {
  it('should match valid issue URLs', () => {
    expect(ISSUE_URL_PATTERN.test('https://github.com/owner/repo/issues/123')).toBe(true);
    expect(ISSUE_URL_PATTERN.test('https://github.com/facebook/react/issues/1')).toBe(true);
  });

  it('should reject invalid issue URLs', () => {
    expect(ISSUE_URL_PATTERN.test('https://github.com/owner/repo/pull/123')).toBe(false);
    expect(ISSUE_URL_PATTERN.test('https://github.com/owner/repo/issues/')).toBe(false);
    expect(ISSUE_URL_PATTERN.test('not-a-url')).toBe(false);
  });
});

describe('validateUrl', () => {
  it('should return valid URLs unchanged', () => {
    const url = 'https://github.com/owner/repo/pull/123';
    expect(validateUrl(url)).toBe(url);
  });

  it('should throw for URLs exceeding maximum length', () => {
    const longUrl = 'https://github.com/' + 'a'.repeat(2048);
    expect(() => validateUrl(longUrl)).toThrow('URL exceeds maximum length of 2048 characters');
  });

  it('should accept URLs at exactly the maximum length', () => {
    const url = 'x'.repeat(2048);
    expect(validateUrl(url)).toBe(url);
  });
});

describe('validatePRNumber', () => {
  it('should return valid PR numbers unchanged', () => {
    expect(validatePRNumber(1)).toBe(1);
    expect(validatePRNumber(42)).toBe(42);
    expect(validatePRNumber(999999)).toBe(999999);
  });

  it('should throw for zero', () => {
    expect(() => validatePRNumber(0)).toThrow('PR number must be a positive integer up to 999999');
  });

  it('should throw for negative numbers', () => {
    expect(() => validatePRNumber(-1)).toThrow('PR number must be a positive integer up to 999999');
  });

  it('should throw for numbers exceeding maximum', () => {
    expect(() => validatePRNumber(1000000)).toThrow('PR number must be a positive integer up to 999999');
  });

  it('should throw for non-integer values', () => {
    expect(() => validatePRNumber(1.5)).toThrow('PR number must be a positive integer up to 999999');
    expect(() => validatePRNumber(NaN)).toThrow('PR number must be a positive integer up to 999999');
    expect(() => validatePRNumber(Infinity)).toThrow('PR number must be a positive integer up to 999999');
  });
});

describe('validateMessage', () => {
  it('should return valid messages unchanged', () => {
    const msg = 'This is a valid message';
    expect(validateMessage(msg)).toBe(msg);
  });

  it('should accept messages at exactly the maximum length', () => {
    const msg = 'a'.repeat(1000);
    expect(validateMessage(msg)).toBe(msg);
  });

  it('should throw for messages exceeding maximum length', () => {
    const msg = 'a'.repeat(1001);
    expect(() => validateMessage(msg)).toThrow('Message exceeds maximum length of 1000 characters');
  });
});

describe('validateRepoIdentifier', () => {
  it('should return valid repo identifiers unchanged', () => {
    expect(validateRepoIdentifier('owner/repo')).toBe('owner/repo');
    expect(validateRepoIdentifier('facebook/react')).toBe('facebook/react');
    expect(validateRepoIdentifier('vercel/next.js')).toBe('vercel/next.js');
    expect(validateRepoIdentifier('my-org/my_repo')).toBe('my-org/my_repo');
  });

  it('should throw for identifiers without a slash', () => {
    expect(() => validateRepoIdentifier('justrepo')).toThrow('Invalid repository format');
  });

  it('should throw for identifiers with extra slashes', () => {
    expect(() => validateRepoIdentifier('owner/repo/extra')).toThrow('Invalid repository format');
  });

  it('should throw for empty string', () => {
    expect(() => validateRepoIdentifier('')).toThrow('Invalid repository format');
  });

  it('should throw for identifiers with spaces', () => {
    expect(() => validateRepoIdentifier('owner/my repo')).toThrow('Invalid repository format');
  });
});

describe('validateGitHubUsername', () => {
  it('should return valid usernames unchanged', () => {
    expect(validateGitHubUsername('octocat')).toBe('octocat');
    expect(validateGitHubUsername('john-doe')).toBe('john-doe');
    expect(validateGitHubUsername('User123')).toBe('User123');
    expect(validateGitHubUsername('a')).toBe('a');
    expect(validateGitHubUsername('a'.repeat(39))).toBe('a'.repeat(39));
  });

  it('should throw for an empty username', () => {
    expect(() => validateGitHubUsername('')).toThrow('GitHub username cannot be empty.');
  });

  it('should throw for usernames exceeding 39 characters', () => {
    const long = 'a'.repeat(40);
    expect(() => validateGitHubUsername(long)).toThrow(
      'exceeds the maximum allowed length of 39 characters',
    );
  });

  it('should throw for usernames with a leading hyphen', () => {
    expect(() => validateGitHubUsername('-bad')).toThrow('Invalid GitHub username');
  });

  it('should throw for usernames with a trailing hyphen', () => {
    expect(() => validateGitHubUsername('bad-')).toThrow('Invalid GitHub username');
  });

  it('should throw for usernames with consecutive hyphens', () => {
    expect(() => validateGitHubUsername('bad--name')).toThrow('cannot contain consecutive hyphens');
  });

  it('should throw for usernames with special characters', () => {
    expect(() => validateGitHubUsername('user_name')).toThrow('Invalid GitHub username');
    expect(() => validateGitHubUsername('user name')).toThrow('Invalid GitHub username');
    expect(() => validateGitHubUsername('user@name')).toThrow('Invalid GitHub username');
    expect(() => validateGitHubUsername('user.name')).toThrow('Invalid GitHub username');
  });

  it('should throw for usernames that are only a hyphen', () => {
    expect(() => validateGitHubUsername('-')).toThrow('Invalid GitHub username');
  });

  it('should accept usernames with hyphens in valid positions', () => {
    expect(validateGitHubUsername('a-b')).toBe('a-b');
    expect(validateGitHubUsername('my-org-name')).toBe('my-org-name');
  });
});
