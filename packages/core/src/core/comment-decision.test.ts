/**
 * Tests for `shouldDraftResponse` (#1286).
 *
 * Pin the skip-vs-draft rule shared between
 * `workflows/pre-commit-review.md` Step 7a and `pr-responder` Step 3.
 */

import { describe, it, expect } from 'vitest';
import { shouldDraftResponse } from './comment-decision.js';

describe('shouldDraftResponse', () => {
  it('does not draft when there is no feedback at all', () => {
    const r = shouldDraftResponse({ feedback: [], allRequestedChangesAddressed: true });
    expect(r.shouldDraft).toBe(false);
  });

  it('always drafts on a question', () => {
    const r = shouldDraftResponse({
      feedback: [{ category: 'question', needsComment: false, reason: 'maintainer asked' }],
      allRequestedChangesAddressed: true,
    });
    expect(r.shouldDraft).toBe(true);
    expect(r.reason).toMatch(/question/);
  });

  it('always drafts on a design discussion', () => {
    const r = shouldDraftResponse({
      feedback: [{ category: 'design_discussion', needsComment: false, reason: '' }],
      allRequestedChangesAddressed: true,
    });
    expect(r.shouldDraft).toBe(true);
  });

  it('always drafts on an explanation request', () => {
    const r = shouldDraftResponse({
      feedback: [{ category: 'explanation_request', needsComment: false, reason: '' }],
      allRequestedChangesAddressed: true,
    });
    expect(r.shouldDraft).toBe(true);
  });

  it('drafts when an item is intentionally left unchanged', () => {
    const r = shouldDraftResponse({
      feedback: [{ category: 'code_request', needsComment: true, reason: 'left tests as-is intentionally' }],
      allRequestedChangesAddressed: true,
    });
    expect(r.shouldDraft).toBe(true);
    expect(r.reason).toMatch(/intentionally|written explanation/);
  });

  it('skips when all code requests are addressed and no item needs explanation', () => {
    const r = shouldDraftResponse({
      feedback: [{ category: 'code_request', needsComment: false, reason: '' }],
      allRequestedChangesAddressed: true,
    });
    expect(r.shouldDraft).toBe(false);
    expect(r.reason).toMatch(/diff/);
  });

  it('drafts when not all requested changes are addressed', () => {
    const r = shouldDraftResponse({
      feedback: [{ category: 'code_request', needsComment: false, reason: '' }],
      allRequestedChangesAddressed: false,
    });
    expect(r.shouldDraft).toBe(true);
    expect(r.reason).toMatch(/not all/);
  });

  it('the always-draft category check wins over a missing-changes flag', () => {
    const r = shouldDraftResponse({
      feedback: [
        { category: 'question', needsComment: false, reason: '' },
        { category: 'code_request', needsComment: false, reason: '' },
      ],
      allRequestedChangesAddressed: false,
    });
    expect(r.shouldDraft).toBe(true);
    expect(r.reason).toMatch(/question/);
  });
});
