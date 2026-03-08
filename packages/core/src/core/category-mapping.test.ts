import { describe, it, expect } from 'vitest';
import { repoBelongsToCategory, getTopicsForCategories, CATEGORY_TOPICS, CATEGORY_ORGS } from './category-mapping.js';
import type { ProjectCategory } from './types.js';

describe('repoBelongsToCategory', () => {
  it('returns false for empty categories', () => {
    expect(repoBelongsToCategory('eslint/eslint', [])).toBe(false);
  });

  it('returns true when repo owner matches a category org', () => {
    expect(repoBelongsToCategory('eslint/eslint', ['devtools'])).toBe(true);
    expect(repoBelongsToCategory('kubernetes/kubernetes', ['infrastructure'])).toBe(true);
    expect(repoBelongsToCategory('freeCodeCamp/freeCodeCamp', ['education'])).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(repoBelongsToCategory('ESLint/eslint', ['devtools'])).toBe(true);
    expect(repoBelongsToCategory('KUBERNETES/dashboard', ['infrastructure'])).toBe(true);
  });

  it('returns false when repo owner does not match', () => {
    expect(repoBelongsToCategory('facebook/react', ['devtools'])).toBe(false);
    expect(repoBelongsToCategory('random-user/project', ['nonprofit'])).toBe(false);
  });

  it('checks across multiple categories', () => {
    expect(repoBelongsToCategory('vercel/next.js', ['devtools', 'web-frameworks'])).toBe(true);
    expect(repoBelongsToCategory('eslint/eslint', ['nonprofit', 'devtools'])).toBe(true);
  });

  it('handles invalid repo format gracefully', () => {
    expect(repoBelongsToCategory('', ['devtools'])).toBe(false);
    expect(repoBelongsToCategory('no-slash', ['devtools'])).toBe(false);
  });
});

describe('getTopicsForCategories', () => {
  it('returns empty array for empty categories', () => {
    expect(getTopicsForCategories([])).toEqual([]);
  });

  it('returns topics for a single category', () => {
    const topics = getTopicsForCategories(['devtools']);
    expect(topics).toEqual(expect.arrayContaining(CATEGORY_TOPICS.devtools));
    expect(topics.length).toBe(CATEGORY_TOPICS.devtools.length);
  });

  it('deduplicates topics across categories', () => {
    const topics = getTopicsForCategories(['devtools', 'infrastructure']);
    const allTopics = [...CATEGORY_TOPICS.devtools, ...CATEGORY_TOPICS.infrastructure];
    const uniqueTopics = [...new Set(allTopics)];
    expect(topics.length).toBe(uniqueTopics.length);
  });

  it('returns topics for all categories without duplicates', () => {
    const allCategories: ProjectCategory[] = [
      'nonprofit',
      'devtools',
      'infrastructure',
      'web-frameworks',
      'data-ml',
      'education',
    ];
    const topics = getTopicsForCategories(allCategories);
    // Should have no duplicates
    expect(topics.length).toBe(new Set(topics).size);
    // Should contain at least one topic from each category
    for (const category of allCategories) {
      expect(topics).toEqual(expect.arrayContaining([CATEGORY_TOPICS[category][0]]));
    }
  });
});

describe('CATEGORY_ORGS', () => {
  it('has orgs for every category', () => {
    const categories: ProjectCategory[] = [
      'nonprofit',
      'devtools',
      'infrastructure',
      'web-frameworks',
      'data-ml',
      'education',
    ];
    for (const category of categories) {
      expect(CATEGORY_ORGS[category].length).toBeGreaterThan(0);
    }
  });
});
