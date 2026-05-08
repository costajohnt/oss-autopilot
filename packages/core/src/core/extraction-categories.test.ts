/**
 * Tests for extraction-categories helpers (#1284).
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_EXTRACTION_CATEGORIES, validateCategories, resolveCategories } from './extraction-categories.js';

describe('DEFAULT_EXTRACTION_CATEGORIES', () => {
  it('contains the documented five default categories in order', () => {
    expect(DEFAULT_EXTRACTION_CATEGORIES).toEqual(['Code Style', 'Process', 'Architecture', 'Testing', 'Other']);
  });
});

describe('validateCategories', () => {
  it('rejects an empty list', () => {
    const r = validateCategories([]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/at least one/i);
  });

  it('rejects whitespace-only entries', () => {
    const r = validateCategories(['Code Style', '  ', 'Other']);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/empty/i);
  });

  it('rejects case-insensitive duplicates', () => {
    const r = validateCategories(['Code Style', 'code style', 'Other']);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/duplicate/i);
  });

  it('rejects categories longer than 40 chars', () => {
    const r = validateCategories(['Code Style', 'A'.repeat(50), 'Other']);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/longer than/i);
  });

  it('rejects more than 12 categories', () => {
    const many = Array.from({ length: 13 }, (_, i) => `Category ${i}`);
    const r = validateCategories(many);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/at most 12/i);
  });

  it('appends "Other" when the user forgot it', () => {
    const r = validateCategories(['Code Style', 'Security']);
    expect(r.ok).toBe(true);
    expect(r.normalized).toEqual(['Code Style', 'Security', 'Other']);
  });

  it('preserves ordering and an explicit "Other"', () => {
    const r = validateCategories(['Security', 'Code Style', 'Other']);
    expect(r.ok).toBe(true);
    expect(r.normalized).toEqual(['Security', 'Code Style', 'Other']);
  });

  it('trims surrounding whitespace from category names', () => {
    const r = validateCategories(['  Code Style  ', '  Security  ']);
    expect(r.ok).toBe(true);
    expect(r.normalized).toEqual(['Code Style', 'Security', 'Other']);
  });
});

describe('resolveCategories', () => {
  it('returns the default list when override is undefined', () => {
    expect(resolveCategories(undefined)).toBe(DEFAULT_EXTRACTION_CATEGORIES);
  });

  it('returns the default list when override is null', () => {
    expect(resolveCategories(null)).toBe(DEFAULT_EXTRACTION_CATEGORIES);
  });

  it('returns the default list when override is empty', () => {
    expect(resolveCategories([])).toBe(DEFAULT_EXTRACTION_CATEGORIES);
  });

  it('returns the normalized override when it validates', () => {
    expect(resolveCategories(['Security', 'Performance'])).toEqual(['Security', 'Performance', 'Other']);
  });

  it('falls back to the default list when override fails validation', () => {
    // Duplicates produce a validation error → fall back rather than
    // silently dropping the duplicate.
    expect(resolveCategories(['Code Style', 'code style'])).toBe(DEFAULT_EXTRACTION_CATEGORIES);
  });
});
