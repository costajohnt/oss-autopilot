/**
 * Tests for shared validation patterns (validation.ts).
 * Command-level state logic is tested in shelve.test.ts, dismiss.test.ts, and state.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  PR_URL_PATTERN,
  ISSUE_URL_PATTERN,
  ISSUE_OR_PR_URL_PATTERN,
  validateUrl,
  validatePRNumber,
  validateMessage,
  validateRepoIdentifier,
  validateGitHubUsername,
  validateGitHubUrl,
} from './validation.js';
import { ValidationError } from '../core/errors.js';

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

describe('ISSUE_OR_PR_URL_PATTERN (#416)', () => {
  it.each([
    ['https://github.com/owner/repo/issues/123', 'issue URL'],
    ['https://github.com/owner/repo/pull/123', 'PR URL'],
    ['https://github.com/my-org/my-repo/pull/1', 'hyphenated PR'],
    ['https://github.com/owner/repo.js/pull/42', 'dotted repo PR'],
  ])('should match %s (%s)', (url) => {
    expect(ISSUE_OR_PR_URL_PATTERN.test(url)).toBe(true);
  });

  it.each([
    ['https://gitlab.com/owner/repo/pull/1', 'non-GitHub host'],
    ['http://github.com/owner/repo/pull/1', 'HTTP (non-HTTPS)'],
    ['https://github.com/owner/repo/pull/123/', 'trailing slash'],
    ['https://github.com/owner/repo/pulls', 'pulls listing'],
    ['https://github.com/owner/repo', 'bare repo URL'],
    ['', 'empty string'],
  ])('should reject %s (%s)', (url) => {
    expect(ISSUE_OR_PR_URL_PATTERN.test(url)).toBe(false);
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
    expect(validatePRNumber(999_999)).toBe(999_999);
  });

  it('should throw for zero', () => {
    expect(() => validatePRNumber(0)).toThrow('PR number must be a positive integer up to 999999');
  });

  it('should throw for negative numbers', () => {
    expect(() => validatePRNumber(-1)).toThrow('PR number must be a positive integer up to 999999');
  });

  it('should throw for numbers exceeding maximum', () => {
    expect(() => validatePRNumber(1_000_000)).toThrow('PR number must be a positive integer up to 999999');
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

describe('validateGitHubUrl', () => {
  it('should pass for valid PR URLs', () => {
    expect(() => validateGitHubUrl('https://github.com/owner/repo/pull/123', PR_URL_PATTERN, 'PR')).not.toThrow();
  });

  it('should throw for invalid PR URL', () => {
    expect(() => validateGitHubUrl('bad-url', PR_URL_PATTERN, 'PR')).toThrow('Invalid PR URL');
  });

  it('should throw for invalid issue URL', () => {
    expect(() => validateGitHubUrl('bad-url', ISSUE_URL_PATTERN, 'issue')).toThrow('Invalid issue URL');
  });

  it('should include expected format in error message', () => {
    expect(() => validateGitHubUrl('bad-url', PR_URL_PATTERN, 'PR')).toThrow(
      'Expected format: https://github.com/owner/repo/pull/123',
    );
  });

  it('should throw with combined format for issue or PR (#416)', () => {
    expect(() => validateGitHubUrl('bad-url', ISSUE_OR_PR_URL_PATTERN, 'issue or PR')).toThrow(
      'Invalid issue or PR URL',
    );
    expect(() => validateGitHubUrl('bad-url', ISSUE_OR_PR_URL_PATTERN, 'issue or PR')).toThrow(
      'Expected format: https://github.com/owner/repo/issues/123 or https://github.com/owner/repo/pull/123',
    );
  });
});

describe('validateGitHubUsername', () => {
  describe('valid usernames', () => {
    it('should accept a normal username', () => {
      expect(validateGitHubUsername('octocat')).toBe('octocat');
    });

    it('should accept a username with hyphens', () => {
      expect(validateGitHubUsername('my-cool-name')).toBe('my-cool-name');
    });

    it('should accept a single character username', () => {
      expect(validateGitHubUsername('a')).toBe('a');
    });

    it('should accept a username at the max length of 39 characters', () => {
      const username = 'a'.repeat(39);
      expect(validateGitHubUsername(username)).toBe(username);
    });

    it('should accept a username with numbers', () => {
      expect(validateGitHubUsername('user123')).toBe('user123');
    });

    it('should accept a username starting with a number', () => {
      expect(validateGitHubUsername('123user')).toBe('123user');
    });

    it('should trim whitespace from the username', () => {
      expect(validateGitHubUsername('  octocat  ')).toBe('octocat');
    });
  });

  describe('invalid usernames', () => {
    it('should reject an empty string', () => {
      expect(() => validateGitHubUsername('')).toThrow(ValidationError);
      expect(() => validateGitHubUsername('')).toThrow('cannot be empty');
    });

    it('should reject a whitespace-only string', () => {
      expect(() => validateGitHubUsername('   ')).toThrow(ValidationError);
      expect(() => validateGitHubUsername('   ')).toThrow('cannot be empty');
    });

    it('should reject a username longer than 39 characters', () => {
      const username = 'a'.repeat(40);
      expect(() => validateGitHubUsername(username)).toThrow(ValidationError);
      expect(() => validateGitHubUsername(username)).toThrow('at most 39 characters');
    });

    it('should reject a username starting with a hyphen', () => {
      expect(() => validateGitHubUsername('-octocat')).toThrow(ValidationError);
      expect(() => validateGitHubUsername('-octocat')).toThrow('cannot start with a hyphen');
    });

    it('should reject a username ending with a hyphen', () => {
      expect(() => validateGitHubUsername('octocat-')).toThrow(ValidationError);
      expect(() => validateGitHubUsername('octocat-')).toThrow('cannot end with a hyphen');
    });

    it('should reject a username with consecutive hyphens', () => {
      expect(() => validateGitHubUsername('octo--cat')).toThrow(ValidationError);
      expect(() => validateGitHubUsername('octo--cat')).toThrow('consecutive hyphens');
    });

    it('should reject a username with special characters', () => {
      expect(() => validateGitHubUsername('octo.cat')).toThrow(ValidationError);
      expect(() => validateGitHubUsername('octo_cat')).toThrow(ValidationError);
      expect(() => validateGitHubUsername('octo@cat')).toThrow(ValidationError);
      expect(() => validateGitHubUsername('octo cat')).toThrow(ValidationError);
    });

    it('should reject a username with special characters with the right message', () => {
      expect(() => validateGitHubUsername('octo.cat')).toThrow('alphanumeric characters and hyphens');
    });

    it.each(['example-user', 'your-username', 'your-github-username', 'EXAMPLE-USER', 'Your-Username'])(
      'should reject placeholder username %s (case-insensitive)',
      (placeholder) => {
        expect(() => validateGitHubUsername(placeholder)).toThrow(ValidationError);
        expect(() => validateGitHubUsername(placeholder)).toThrow('looks like a placeholder');
      },
    );
  });
});
