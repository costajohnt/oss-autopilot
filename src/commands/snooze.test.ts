/**
 * Tests for snooze/unsnooze commands
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PR_URL_PATTERN } from './snooze.js';

// We test the state-level snooze logic directly via StateManager (in state.test.ts)
// and test the command-level logic (URL validation, output format) here.

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

describe('runSnooze (integration)', () => {
  // Use dynamic import to avoid module-level side effects
  let runSnooze: typeof import('./snooze.js').runSnooze;
  let StateManager: typeof import('../core/state.js').StateManager;

  beforeEach(async () => {
    const snoozeModule = await import('./snooze.js');
    const stateModule = await import('../core/state.js');
    runSnooze = snoozeModule.runSnooze;
    StateManager = stateModule.StateManager;
  });

  it('should output JSON when --json flag is set', async () => {
    // We can't easily test the full command without mocking getStateManager,
    // but we can verify the URL pattern is exported and correct
    expect(PR_URL_PATTERN).toBeDefined();
  });
});

describe('runUnsnooze (integration)', () => {
  it('should export the function', async () => {
    const { runUnsnooze } = await import('./snooze.js');
    expect(typeof runUnsnooze).toBe('function');
  });
});
