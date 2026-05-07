/**
 * Tests for `computeComplianceScore` (#1245).
 *
 * Pins the weighted scoring, the per-check status decision logic, and
 * the rating-cutoff boundaries. Fixture-based — no network, no fixtures
 * stored on disk; each test constructs its own minimal `PRMetadata`.
 */

import { describe, it, expect } from 'vitest';
import {
  computeComplianceScore,
  type PRMetadata,
  type RepoContext,
  TITLE_LENGTH_BUDGET,
  RATING_CUTOFFS,
  FOCUSED_CHANGES,
} from './compliance-score.js';

function meta(overrides: Partial<PRMetadata> = {}): PRMetadata {
  return {
    title: 'feat(scope): add new thing',
    body: '## Summary\nDoes a thing.\n\n## Why\nIt was needed.\n\n## Test Plan\n- ran tests\n\nCloses #1',
    branch: 'feature/add-new-thing',
    filesChangedCount: 3,
    additions: 100,
    deletions: 20,
    files: ['src/foo.ts', 'src/foo.test.ts', 'README.md'],
    ...overrides,
  };
}

describe('computeComplianceScore — happy path', () => {
  it('scores a well-formed PR at 100', () => {
    const result = computeComplianceScore(meta());
    expect(result.score).toBe(100);
    expect(result.rating).toBe('ready');
    expect(result.emoji).toBe('🌟');
    for (const check of Object.values(result.checks)) {
      expect(check.status).toBe('pass');
    }
  });
});

describe('issueReference check — verified linked issues (#1246 B)', () => {
  it('passes when the linked issue is open in the same repo', () => {
    const ctx: RepoContext = {
      linkedIssues: [{ number: 42, repo: 'owner/repo', crossRepo: false, state: 'open' }],
    };
    const result = computeComplianceScore(meta({ body: 'Closes #42' }), ctx);
    expect(result.checks.issueReference.status).toBe('pass');
  });

  it('warns on a recently-closed linked issue', () => {
    const ctx: RepoContext = {
      linkedIssues: [{ number: 42, repo: 'owner/repo', crossRepo: false, state: 'closed', closedDaysAgo: 7 }],
    };
    const result = computeComplianceScore(meta({ body: 'Closes #42' }), ctx);
    expect(result.checks.issueReference.status).toBe('warn');
    expect(result.checks.issueReference.detail).toMatch(/7 days ago/);
  });

  it('fails on a long-stale closed linked issue', () => {
    const ctx: RepoContext = {
      linkedIssues: [{ number: 42, repo: 'owner/repo', crossRepo: false, state: 'closed', closedDaysAgo: 365 }],
    };
    const result = computeComplianceScore(meta({ body: 'Closes #42' }), ctx);
    expect(result.checks.issueReference.status).toBe('fail');
    expect(result.checks.issueReference.detail).toMatch(/stale/);
  });

  it('fails when the linked issue does not exist', () => {
    const ctx: RepoContext = {
      linkedIssues: [{ number: 999, repo: 'owner/repo', crossRepo: false, state: 'not_found' }],
    };
    const result = computeComplianceScore(meta({ body: 'Closes #999' }), ctx);
    expect(result.checks.issueReference.status).toBe('fail');
    expect(result.checks.issueReference.detail).toMatch(/does not exist/);
  });

  it('warns on a cross-repo open reference', () => {
    const ctx: RepoContext = {
      linkedIssues: [{ number: 5, repo: 'other/repo', crossRepo: true, state: 'open' }],
    };
    const result = computeComplianceScore(meta({ body: 'See other/repo#5' }), ctx);
    expect(result.checks.issueReference.status).toBe('warn');
    expect(result.checks.issueReference.detail).toMatch(/cross-repo/);
  });

  it('takes the worst single result when multiple references are listed', () => {
    const ctx: RepoContext = {
      linkedIssues: [
        { number: 1, repo: 'owner/repo', crossRepo: false, state: 'open' },
        { number: 2, repo: 'owner/repo', crossRepo: false, state: 'not_found' },
      ],
    };
    const result = computeComplianceScore(meta({ body: 'Closes #1, fixes #2' }), ctx);
    expect(result.checks.issueReference.status).toBe('fail');
    expect(result.checks.issueReference.detail).toMatch(/#2/);
  });

  it('falls back to regex-only when no verification data is supplied', () => {
    const result = computeComplianceScore(meta({ body: 'Closes #999' }));
    expect(result.checks.issueReference.status).toBe('pass');
  });

  it('still fails when the body has no reference at all, even with verification context', () => {
    const ctx: RepoContext = { linkedIssues: [] };
    const result = computeComplianceScore(meta({ body: 'No reference here.' }), ctx);
    expect(result.checks.issueReference.status).toBe('fail');
  });
});

describe('issueReference check', () => {
  it('passes on a closing keyword', () => {
    expect(computeComplianceScore(meta({ body: 'Closes #42' })).checks.issueReference.status).toBe('pass');
    expect(computeComplianceScore(meta({ body: 'Fixes #42' })).checks.issueReference.status).toBe('pass');
    expect(computeComplianceScore(meta({ body: 'fixed #42' })).checks.issueReference.status).toBe('pass');
    expect(computeComplianceScore(meta({ body: 'resolved #42' })).checks.issueReference.status).toBe('pass');
  });
  it('warns on a non-closing reference', () => {
    expect(computeComplianceScore(meta({ body: 'Relates to #42' })).checks.issueReference.status).toBe('warn');
    expect(
      computeComplianceScore(meta({ body: 'See https://github.com/o/r/issues/42' })).checks.issueReference.status,
    ).toBe('warn');
  });
  it('fails on no reference', () => {
    expect(
      computeComplianceScore(meta({ body: 'Just a description, no issue ref.' })).checks.issueReference.status,
    ).toBe('fail');
  });
});

describe('description check', () => {
  it('fails on empty body', () => {
    expect(computeComplianceScore(meta({ body: '   ' })).checks.description.status).toBe('fail');
  });
  it('passes when all three sections present', () => {
    const body = '## Summary\nx\n\n## Why\ny\n\n## Test Plan\nz';
    expect(computeComplianceScore(meta({ body })).checks.description.status).toBe('pass');
  });
  it('warns when only some sections present', () => {
    const body = '## Summary\nx\n(no why, no test plan)';
    expect(computeComplianceScore(meta({ body })).checks.description.status).toBe('warn');
  });
  it('warns when length is non-trivial but no sections', () => {
    const body = 'a'.repeat(100);
    expect(computeComplianceScore(meta({ body })).checks.description.status).toBe('warn');
  });
});

describe('focusedChanges check', () => {
  it('passes under both thresholds', () => {
    const result = computeComplianceScore(
      meta({ filesChangedCount: FOCUSED_CHANGES.passFiles - 1, additions: 50, deletions: 50 }),
    );
    expect(result.checks.focusedChanges.status).toBe('pass');
  });
  it('warns when files in the warn band', () => {
    const result = computeComplianceScore(
      meta({ filesChangedCount: FOCUSED_CHANGES.passFiles + 1, additions: 100, deletions: 100 }),
    );
    expect(result.checks.focusedChanges.status).toBe('warn');
  });
  it('warns when lines in the warn band', () => {
    const result = computeComplianceScore(meta({ filesChangedCount: 5, additions: 300, deletions: 200 }));
    expect(result.checks.focusedChanges.status).toBe('warn');
  });
  it('fails when files exceed the warn ceiling', () => {
    const result = computeComplianceScore(
      meta({ filesChangedCount: FOCUSED_CHANGES.warnFiles + 1, additions: 50, deletions: 50 }),
    );
    expect(result.checks.focusedChanges.status).toBe('fail');
  });
  it('fails when lines exceed the warn ceiling', () => {
    const result = computeComplianceScore(meta({ filesChangedCount: 5, additions: 500, deletions: 500 }));
    expect(result.checks.focusedChanges.status).toBe('fail');
  });
});

describe('tests check', () => {
  it('passes when a test file is included', () => {
    const result = computeComplianceScore(meta({ files: ['src/foo.test.ts'] }));
    expect(result.checks.tests.status).toBe('pass');
    const result2 = computeComplianceScore(meta({ files: ['__tests__/foo.ts'] }));
    expect(result2.checks.tests.status).toBe('pass');
    const result3 = computeComplianceScore(meta({ files: ['spec/foo_spec.rb'] }));
    expect(result3.checks.tests.status).toBe('pass');
  });
  it('fails when no test file in a test-requiring project', () => {
    const result = computeComplianceScore(meta({ files: ['src/foo.ts'] }));
    expect(result.checks.tests.status).toBe('fail');
  });
  it('warns when project has no test infrastructure', () => {
    const ctx: RepoContext = { hasTestInfrastructure: false };
    const result = computeComplianceScore(meta({ files: ['src/foo.ts'] }), ctx);
    expect(result.checks.tests.status).toBe('warn');
  });
});

describe('title check', () => {
  it('passes a Conventional Commits title within budget', () => {
    expect(computeComplianceScore(meta({ title: 'feat: add login' })).checks.title.status).toBe('pass');
    expect(computeComplianceScore(meta({ title: 'fix(api): correct timeout' })).checks.title.status).toBe('pass');
  });
  it('warns on a title that exceeds the byte budget', () => {
    const longTitle = 'feat: ' + 'a'.repeat(TITLE_LENGTH_BUDGET);
    expect(computeComplianceScore(meta({ title: longTitle })).checks.title.status).toBe('warn');
  });
  it('warns on a non-conventional but descriptive title', () => {
    expect(
      computeComplianceScore(meta({ title: 'Adding the login feature with OAuth support' })).checks.title.status,
    ).toBe('warn');
  });
  it('fails on vague placeholders', () => {
    for (const t of ['WIP', 'asdfasdf', 'Update file.js', 'test']) {
      expect(computeComplianceScore(meta({ title: t })).checks.title.status).toBe('fail');
    }
  });
});

describe('branch check', () => {
  it('passes a descriptive branch name', () => {
    expect(computeComplianceScore(meta({ branch: 'feature/add-auth' })).checks.branch.status).toBe('pass');
    expect(computeComplianceScore(meta({ branch: 'fix-bug' })).checks.branch.status).toBe('pass');
    expect(computeComplianceScore(meta({ branch: 'issue_123' })).checks.branch.status).toBe('pass');
  });
  it('fails GitHub-default and root branch names', () => {
    expect(computeComplianceScore(meta({ branch: 'patch-1' })).checks.branch.status).toBe('fail');
    expect(computeComplianceScore(meta({ branch: 'main' })).checks.branch.status).toBe('fail');
    expect(computeComplianceScore(meta({ branch: 'master' })).checks.branch.status).toBe('fail');
  });
  it('warns when branch lacks a separator', () => {
    expect(computeComplianceScore(meta({ branch: 'fixthebug' })).checks.branch.status).toBe('warn');
  });
});

describe('rating cutoffs', () => {
  it('rates ≥ 90 as ready', () => {
    expect(computeComplianceScore(meta()).rating).toBe('ready');
  });
  it('rates 75–89 as minor', () => {
    // Drop to minor by warning on title (10-pt category, half = 5pt loss
    // leaves us at 95). Add a second warn (description partial) to push
    // below 90 but stay above 75.
    const result = computeComplianceScore(
      meta({
        title: 'Adding the login feature with OAuth support', // warn (-5pt)
        body: '## Summary\nDoes a thing.\n\nCloses #1', // warn (-12.5pt) — partial sections
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(RATING_CUTOFFS.minor);
    expect(result.score).toBeLessThan(RATING_CUTOFFS.ready);
    expect(result.rating).toBe('minor');
  });
  it('rates 60–74 as fix_first', () => {
    // Two failures + a warn: drop title (-10), tests (-15), focused (-10
    // half) — start from 100, end ~65.
    const result = computeComplianceScore(
      meta({
        title: 'WIP',
        files: ['src/foo.ts'],
        filesChangedCount: 12,
        additions: 200,
        deletions: 100,
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(RATING_CUTOFFS.fixFirst);
    expect(result.score).toBeLessThan(RATING_CUTOFFS.minor);
    expect(result.rating).toBe('fix_first');
  });
  it('rates < 60 as significant_work', () => {
    const result = computeComplianceScore(
      meta({
        title: 'WIP',
        body: '',
        files: ['src/foo.ts'],
        branch: 'patch-1',
      }),
    );
    expect(result.score).toBeLessThan(RATING_CUTOFFS.fixFirst);
    expect(result.rating).toBe('significant_work');
  });
});
