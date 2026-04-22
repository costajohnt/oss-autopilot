/**
 * Tests for the dashboard-data runtime schema (#1050).
 */

import { describe, it, expect } from 'vitest';
import { validateDashboardData } from './dashboard-data-schema.js';

function minimalValidPayload(): Record<string, unknown> {
  return {
    stats: {
      activePRs: 3,
      shelvedPRs: 0,
      mergedPRs: 12,
      closedPRs: 1,
      mergeRate: '92%',
    },
    prsByRepo: { 'octocat/spoon-knife': { active: 1, merged: 2, closed: 0 } },
    topRepos: [{ repo: 'octocat/spoon-knife', active: 1, merged: 2, closed: 0 }],
    monthlyMerged: { '2026-01': 2 },
    monthlyOpened: { '2026-01': 3 },
    monthlyClosed: { '2026-01': 0 },
    activePRs: [],
    shelvedPRUrls: [],
    recentlyMergedPRs: [],
    recentlyClosedPRs: [],
    autoUnshelvedPRs: [],
    commentedIssues: [],
    issueResponses: [],
    allMergedPRs: [],
    allClosedPRs: [],
  };
}

describe('validateDashboardData', () => {
  it('accepts a minimal valid payload', () => {
    const result = validateDashboardData(minimalValidPayload());
    expect(result.ok).toBe(true);
  });

  it('accepts optional fields (repoMetadata, partialFailures, lastUpdated)', () => {
    const payload = {
      ...minimalValidPayload(),
      repoMetadata: { 'octocat/spoon-knife': { stars: 100 } },
      partialFailures: ['repo-metadata'],
      lastUpdated: '2026-01-25T10:00:00Z',
    };
    const result = validateDashboardData(payload);
    expect(result.ok).toBe(true);
  });

  it('rejects payload missing stats (top-level drift)', () => {
    const payload = minimalValidPayload();
    delete payload.stats;
    const result = validateDashboardData(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/stats/);
    }
  });

  it('rejects payload with wrong type for a primitive field', () => {
    const payload = minimalValidPayload();
    (payload.stats as { mergeRate: unknown }).mergeRate = 42; // should be string
    const result = validateDashboardData(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/mergeRate/);
    }
  });

  it('rejects completely invalid input (null / string / number)', () => {
    expect(validateDashboardData(null).ok).toBe(false);
    expect(validateDashboardData('string').ok).toBe(false);
    expect(validateDashboardData(42).ok).toBe(false);
    expect(validateDashboardData(undefined).ok).toBe(false);
  });

  it('allows unknown nested fields on array items (loose nested validation)', () => {
    // Nested PR shape is pinned loosely — `z.unknown()` — so server-side
    // additions don't break the dashboard's parse. This is intentional.
    const payload = {
      ...minimalValidPayload(),
      activePRs: [{ url: '…', title: '…', someNewFutureField: 'whatever' }],
    };
    const result = validateDashboardData(payload);
    expect(result.ok).toBe(true);
  });

  it('truncates long error lists with "+N more"', () => {
    // Construct a payload with many missing required fields so we trip >3 issues.
    const result = validateDashboardData({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/\+\d+ more/);
    }
  });
});
