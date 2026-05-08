/**
 * Tests for `extractRequirements` (#1279).
 */

import { describe, it, expect } from 'vitest';
import { extractRequirements, dedupeByCategory } from './contributing.js';

describe('extractRequirements — categories', () => {
  it('detects a tests requirement from "add unit tests"', () => {
    const r = extractRequirements('All PRs must add unit tests covering the change.');
    expect(r.find((x) => x.category === 'tests')).toBeDefined();
  });

  it('detects a tests requirement from "tests are required"', () => {
    const r = extractRequirements('Tests are required for every behavior change.');
    expect(r.find((x) => x.category === 'tests')).toBeDefined();
  });

  it('detects a documentation requirement', () => {
    const r = extractRequirements('Please update the documentation when public API changes.');
    expect(r.find((x) => x.category === 'documentation')).toBeDefined();
  });

  it('detects a changelog requirement', () => {
    const r = extractRequirements('Every PR must include a changelog entry under "Unreleased".');
    expect(r.find((x) => x.category === 'changelog')).toBeDefined();
  });

  it('detects a code-style requirement from a formatter mention', () => {
    const r = extractRequirements('Run prettier before opening a PR.');
    expect(r.find((x) => x.category === 'code_style')).toBeDefined();
  });

  it('detects a commit-format requirement from "Conventional Commits"', () => {
    const r = extractRequirements('We use Conventional Commits for all PR titles.');
    expect(r.find((x) => x.category === 'commit_format')).toBeDefined();
  });

  it('detects a CLA / DCO requirement', () => {
    const r = extractRequirements('All commits must include a Signed-off-by line (DCO).');
    expect(r.find((x) => x.category === 'cla_dco')).toBeDefined();
  });

  it('detects a branch-target requirement', () => {
    const r = extractRequirements('Submit pull requests against the develop branch.');
    expect(r.find((x) => x.category === 'branch_target')).toBeDefined();
  });

  it('detects a scope requirement', () => {
    const r = extractRequirements('Keep PRs focused on one logical change.');
    expect(r.find((x) => x.category === 'scope')).toBeDefined();
  });
});

describe('extractRequirements — behavior', () => {
  it('returns an empty array for empty input', () => {
    expect(extractRequirements('')).toEqual([]);
    expect(extractRequirements('   \n\n   ')).toEqual([]);
  });

  it('preserves the matching line as evidence', () => {
    const r = extractRequirements('Add unit tests for every change.');
    expect(r[0].evidence).toContain('Add unit tests');
  });

  it('truncates very long evidence to 200 chars', () => {
    const long = 'Every PR ' + 'must add unit tests '.repeat(40);
    const r = extractRequirements(long);
    expect(r[0].evidence.length).toBeLessThanOrEqual(201);
    expect(r[0].evidence.endsWith('…')).toBe(true);
  });

  it('fires a given rule at most once even if the document repeats the phrase', () => {
    const content = 'Add unit tests.\n\nAll PRs must add unit tests.\n\nMust add tests.';
    const r = extractRequirements(content);
    expect(r.filter((x) => x.category === 'tests')).toHaveLength(1);
  });

  it('handles a multi-requirement document', () => {
    const content = `
# Contributing

All PRs must add unit tests covering the change.
Update the documentation when public API changes.
Add a changelog entry under "Unreleased".
We use Conventional Commits for all PR titles.
All commits must include a Signed-off-by line.
Submit pull requests against the main branch.
Keep PRs focused on one logical change.
`;
    const cats = extractRequirements(content).map((x) => x.category);
    expect(new Set(cats)).toEqual(
      new Set(['tests', 'documentation', 'changelog', 'commit_format', 'cla_dco', 'branch_target', 'scope']),
    );
  });
});

describe('dedupeByCategory', () => {
  it('keeps the first entry per category', () => {
    const reqs = [
      { category: 'tests' as const, description: 'A', evidence: 'first' },
      { category: 'tests' as const, description: 'B', evidence: 'second' },
      { category: 'documentation' as const, description: 'C', evidence: 'third' },
    ];
    const r = dedupeByCategory(reqs);
    expect(r).toHaveLength(2);
    expect(r[0].evidence).toBe('first');
  });
});
