import { describe, it, expect } from 'vitest';
import {
  isDocOnlyIssue,
  isLabelFarming,
  hasTemplatedTitle,
  detectLabelFarmingRepos,
  applyPerRepoCap,
  DOC_ONLY_LABELS,
  BEGINNER_LABELS,
  type GitHubSearchItem,
} from './issue-filtering.js';

/** Helper to create a minimal GitHubSearchItem. */
function makeItem(overrides: Partial<GitHubSearchItem> = {}): GitHubSearchItem {
  return {
    html_url: 'https://github.com/owner/repo/issues/1',
    repository_url: 'https://api.github.com/repos/owner/repo',
    updated_at: '2025-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('isDocOnlyIssue', () => {
  it('returns false for items with no labels', () => {
    expect(isDocOnlyIssue(makeItem())).toBe(false);
    expect(isDocOnlyIssue(makeItem({ labels: [] }))).toBe(false);
  });

  it('returns true when all labels are doc-related', () => {
    expect(isDocOnlyIssue(makeItem({ labels: [{ name: 'documentation' }] }))).toBe(true);
    expect(isDocOnlyIssue(makeItem({ labels: [{ name: 'docs' }, { name: 'typo' }] }))).toBe(true);
  });

  it('returns false when labels are mixed', () => {
    expect(isDocOnlyIssue(makeItem({ labels: [{ name: 'documentation' }, { name: 'good first issue' }] }))).toBe(false);
  });

  it('handles string-format labels', () => {
    expect(isDocOnlyIssue(makeItem({ labels: ['documentation', 'spelling'] as any }))).toBe(true);
    expect(isDocOnlyIssue(makeItem({ labels: ['documentation', 'bug'] as any }))).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isDocOnlyIssue(makeItem({ labels: [{ name: 'Documentation' }] }))).toBe(true);
    expect(isDocOnlyIssue(makeItem({ labels: [{ name: 'DOCS' }] }))).toBe(true);
  });

  it('ignores labels with empty names', () => {
    expect(isDocOnlyIssue(makeItem({ labels: [{ name: '' }, { name: 'docs' }] }))).toBe(true);
    // All labels empty → not doc-only
    expect(isDocOnlyIssue(makeItem({ labels: [{ name: '' }] }))).toBe(false);
  });

  it('covers all DOC_ONLY_LABELS', () => {
    for (const label of DOC_ONLY_LABELS) {
      expect(isDocOnlyIssue(makeItem({ labels: [{ name: label }] }))).toBe(true);
    }
  });
});

describe('isLabelFarming', () => {
  it('returns false for items with no labels', () => {
    expect(isLabelFarming(makeItem())).toBe(false);
    expect(isLabelFarming(makeItem({ labels: [] }))).toBe(false);
  });

  it('returns false for fewer than 5 beginner labels', () => {
    const labels = ['good first issue', 'hacktoberfest', 'easy', 'beginner'].map((n) => ({ name: n }));
    expect(isLabelFarming(makeItem({ labels }))).toBe(false);
  });

  it('returns true for 5 or more beginner labels', () => {
    const labels = ['good first issue', 'hacktoberfest', 'easy', 'beginner', 'newbie'].map((n) => ({ name: n }));
    expect(isLabelFarming(makeItem({ labels }))).toBe(true);
  });

  it('is case-insensitive', () => {
    const labels = ['Good First Issue', 'HACKTOBERFEST', 'Easy', 'Beginner', 'NEWBIE'].map((n) => ({ name: n }));
    expect(isLabelFarming(makeItem({ labels }))).toBe(true);
  });

  it('only counts beginner labels, not others', () => {
    const labels = ['good first issue', 'hacktoberfest', 'bug', 'enhancement', 'help wanted'].map((n) => ({
      name: n,
    }));
    expect(isLabelFarming(makeItem({ labels }))).toBe(false);
  });

  it('BEGINNER_LABELS set has expected entries', () => {
    expect(BEGINNER_LABELS.size).toBeGreaterThanOrEqual(10);
    expect(BEGINNER_LABELS.has('good first issue')).toBe(true);
    expect(BEGINNER_LABELS.has('hacktoberfest')).toBe(true);
  });
});

describe('hasTemplatedTitle', () => {
  it('returns false for empty/null titles', () => {
    expect(hasTemplatedTitle('')).toBe(false);
  });

  it('detects templated titles with category nouns + number', () => {
    expect(hasTemplatedTitle('Add Trivia Question 61')).toBe(true);
    expect(hasTemplatedTitle('Create Entry #5')).toBe(true);
    expect(hasTemplatedTitle('Solve Problem 42')).toBe(true);
    expect(hasTemplatedTitle('Add code snippet 10')).toBe(true);
    expect(hasTemplatedTitle('New Challenge 3')).toBe(true);
  });

  it('does not flag legitimate titles', () => {
    expect(hasTemplatedTitle('Add support for Python 3')).toBe(false);
    expect(hasTemplatedTitle('Implement RFC 7231')).toBe(false);
    expect(hasTemplatedTitle('Fix bug in login flow')).toBe(false);
    expect(hasTemplatedTitle('Update dependencies to latest versions')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hasTemplatedTitle('ADD TRIVIA QUESTION 100')).toBe(true);
    expect(hasTemplatedTitle('add trivia question 100')).toBe(true);
  });
});

describe('detectLabelFarmingRepos', () => {
  it('returns empty set for empty input', () => {
    expect(detectLabelFarmingRepos([]).size).toBe(0);
  });

  it('flags repos with a single issue that has 5+ beginner labels', () => {
    const items = [
      makeItem({
        repository_url: 'https://api.github.com/repos/spam/repo',
        labels: ['good first issue', 'hacktoberfest', 'easy', 'beginner', 'newbie'].map((n) => ({ name: n })),
      }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.has('spam/repo')).toBe(true);
  });

  it('flags repos with 3+ templated-title issues', () => {
    const items = [
      makeItem({
        repository_url: 'https://api.github.com/repos/spam/repo',
        title: 'Add Question 1',
      }),
      makeItem({
        repository_url: 'https://api.github.com/repos/spam/repo',
        title: 'Add Question 2',
      }),
      makeItem({
        repository_url: 'https://api.github.com/repos/spam/repo',
        title: 'Add Question 3',
      }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.has('spam/repo')).toBe(true);
  });

  it('does not flag repos with only 2 templated-title issues', () => {
    const items = [
      makeItem({
        repository_url: 'https://api.github.com/repos/ok/repo',
        title: 'Add Question 1',
      }),
      makeItem({
        repository_url: 'https://api.github.com/repos/ok/repo',
        title: 'Add Question 2',
      }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.has('ok/repo')).toBe(false);
  });

  it('does not flag legitimate repos', () => {
    const items = [
      makeItem({
        repository_url: 'https://api.github.com/repos/good/repo',
        title: 'Fix memory leak in parser',
        labels: [{ name: 'bug' }, { name: 'good first issue' }],
      }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.size).toBe(0);
  });

  it('separates repos correctly', () => {
    const items = [
      makeItem({
        repository_url: 'https://api.github.com/repos/spam/repo',
        labels: ['good first issue', 'hacktoberfest', 'easy', 'beginner', 'newbie'].map((n) => ({ name: n })),
      }),
      makeItem({
        repository_url: 'https://api.github.com/repos/legit/repo',
        title: 'Fix a real bug',
        labels: [{ name: 'bug' }],
      }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.has('spam/repo')).toBe(true);
    expect(spamRepos.has('legit/repo')).toBe(false);
  });

  it('flags repo via label farming even if templated-title count is below threshold', () => {
    // First item triggers label farming (5+ beginner labels) and has a templated title.
    // The `continue` in detectLabelFarmingRepos skips the templated-title count for this item.
    // The repo is still flagged because label farming is a strong signal.
    const items = [
      makeItem({
        repository_url: 'https://api.github.com/repos/tricky/repo',
        title: 'Add Question 1',
        labels: ['good first issue', 'hacktoberfest', 'easy', 'beginner', 'newbie'].map((n) => ({ name: n })),
      }),
      makeItem({
        repository_url: 'https://api.github.com/repos/tricky/repo',
        title: 'Add Question 2',
      }),
    ];
    const spamRepos = detectLabelFarmingRepos(items);
    expect(spamRepos.has('tricky/repo')).toBe(true);
  });
});

describe('applyPerRepoCap', () => {
  function makeCandidate(repo: string, id: number) {
    return { issue: { repo }, id };
  }

  it('returns all candidates when under cap', () => {
    const candidates = [makeCandidate('a/b', 1), makeCandidate('c/d', 2)];
    const result = applyPerRepoCap(candidates, 2);
    expect(result).toHaveLength(2);
  });

  it('caps per-repo count', () => {
    const candidates = [
      makeCandidate('a/b', 1),
      makeCandidate('a/b', 2),
      makeCandidate('a/b', 3),
      makeCandidate('c/d', 4),
    ];
    const result = applyPerRepoCap(candidates, 2);
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.id)).toEqual([1, 2, 4]);
  });

  it('preserves order', () => {
    const candidates = [makeCandidate('a/b', 1), makeCandidate('c/d', 2), makeCandidate('a/b', 3)];
    const result = applyPerRepoCap(candidates, 1);
    expect(result.map((c) => c.id)).toEqual([1, 2]);
  });

  it('handles empty input', () => {
    expect(applyPerRepoCap([], 5)).toEqual([]);
  });

  it('handles maxPerRepo of 0', () => {
    const candidates = [makeCandidate('a/b', 1)];
    expect(applyPerRepoCap(candidates, 0)).toEqual([]);
  });

  it('preserves original object references', () => {
    const c1 = makeCandidate('a/b', 1);
    const c2 = makeCandidate('c/d', 2);
    const result = applyPerRepoCap([c1, c2], 5);
    expect(result[0]).toBe(c1);
    expect(result[1]).toBe(c2);
  });
});
