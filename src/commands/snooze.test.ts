/**
 * Tests for shared URL validation patterns.
 * Command-level snooze/unsnooze state logic is tested in state.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { PR_URL_PATTERN, ISSUE_URL_PATTERN } from './validation.js';

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
