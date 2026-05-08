/**
 * Tests for maintainer-hint label helpers (#1264).
 */

import { describe, it, expect } from 'vitest';
import { MAINTAINER_HINT_LABELS, formatMaintainerHints } from './maintainer-hints.js';

describe('MAINTAINER_HINT_LABELS', () => {
  it('covers every documented hint with a human label', () => {
    expect(MAINTAINER_HINT_LABELS.demo_requested).toBe('demo/screenshot requested');
    expect(MAINTAINER_HINT_LABELS.tests_requested).toBe('tests requested');
    expect(MAINTAINER_HINT_LABELS.changes_requested).toBe('code changes requested');
    expect(MAINTAINER_HINT_LABELS.docs_requested).toBe('documentation requested');
    expect(MAINTAINER_HINT_LABELS.rebase_requested).toBe('rebase requested');
  });
});

describe('formatMaintainerHints', () => {
  it('joins multiple hints with ", " in supplied order', () => {
    expect(formatMaintainerHints(['tests_requested', 'docs_requested'])).toBe(
      'tests requested, documentation requested',
    );
  });

  it('returns the single label for a one-element array', () => {
    expect(formatMaintainerHints(['rebase_requested'])).toBe('rebase requested');
  });

  it('returns an empty string for an empty array', () => {
    expect(formatMaintainerHints([])).toBe('');
  });

  it('drops unknown hint values silently', () => {
    expect(formatMaintainerHints(['tests_requested', 'unknown_thing', 'docs_requested'])).toBe(
      'tests requested, documentation requested',
    );
  });
});
