/**
 * Tests for the daily merge-loop reconciliation (#1463).
 *
 * The join under test: a recently merged PR's URL found inside a curated-list
 * entry's block (entry line or indented sub-bullet) auto-marks that entry
 * done via the same transform `list-mark-done` uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DailyWarning } from '../formatters/json.js';

// detectIssueListPath reads the configured list path from state — mock the
// barrel so each test can point it at a tmp file (or at nothing).
const mockGetState = vi.fn();
vi.mock('../core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/index.js')>();
  return {
    ...actual,
    getStateManager: vi.fn(() => ({ getState: mockGetState })),
  };
});

import { findListEntryUrlByPrUrl, reconcileMergedPRsWithList } from './merge-loop.js';

const ISSUE_A = 'https://github.com/foo/bar/issues/1';
const ISSUE_B = 'https://github.com/foo/bar/issues/2';
const PR_A = 'https://github.com/foo/bar/pull/123';
const PR_B = 'https://github.com/foo/bar/pull/456';

function makeList(): string {
  return [
    '# My List',
    '',
    '## Pursue',
    '',
    '### foo/bar',
    `- [#1](${ISSUE_A}) — first issue`,
    `  - **In Progress** — PR [#123](${PR_A}) open, awaiting review.`,
    `- [#2](${ISSUE_B}) — second issue`,
    '',
  ].join('\n');
}

function setIssueListPath(p: string | undefined): void {
  mockGetState.mockReturnValue({ config: { issueListPath: p } });
}

describe('findListEntryUrlByPrUrl', () => {
  it('finds the entry whose sub-bullet mentions the PR URL and returns the entry-line URL', () => {
    expect(findListEntryUrlByPrUrl(makeList(), PR_A)).toBe(ISSUE_A);
  });

  it('finds an entry whose entry line itself is the PR URL', () => {
    const content = `- [#123](${PR_A}) — direct PR entry\n`;
    expect(findListEntryUrlByPrUrl(content, PR_A)).toBe(PR_A);
  });

  it('returns undefined when no block mentions the PR URL', () => {
    expect(findListEntryUrlByPrUrl(makeList(), PR_B)).toBeUndefined();
  });

  it('does not match a longer PR number sharing a prefix (#1442 boundary rule)', () => {
    const content = [`- [#1](${ISSUE_A}) — entry`, `  - **In Progress** — PR ${PR_A}4 open.`, ''].join('\n');
    expect(findListEntryUrlByPrUrl(content, PR_A)).toBeUndefined();
  });

  it('skips a mentioning block whose entry line has no GitHub URL', () => {
    const content = ['- a loose note with no link', `  - mentions ${PR_A} in passing`, ''].join('\n');
    expect(findListEntryUrlByPrUrl(content, PR_A)).toBeUndefined();
  });
});

describe('reconcileMergedPRsWithList', () => {
  let tmpDir: string;
  let listPath: string;
  let warnings: DailyWarning[];

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-loop-test-'));
    listPath = path.join(tmpDir, 'issue-list.md');
    warnings = [];
  });

  afterEach(() => {
    fs.chmodSync(tmpDir, 0o755);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks a list entry done when a merged PR URL appears in its sub-bullets (real file write)', () => {
    fs.writeFileSync(listPath, makeList(), 'utf8');
    setIssueListPath(listPath);

    const updates = reconcileMergedPRsWithList({
      mergedPRs: [{ url: PR_A, mergedAt: '2026-06-10T12:00:00Z' }],
      warnings,
    });

    expect(updates).toEqual([
      {
        prUrl: PR_A,
        issueUrl: ISSUE_A,
        listPath: path.resolve(listPath),
        repoHeadingStruck: false,
      },
    ]);
    const written = fs.readFileSync(listPath, 'utf8');
    expect(written).toContain(`- ~~[#1](${ISSUE_A}) — first issue~~`);
    expect(written).toContain(`  - **Done** — PR [#123](${PR_A}) submitted, merged 2026-06-10.`);
    // Unrelated entry untouched.
    expect(written).toContain(`- [#2](${ISSUE_B}) — second issue`);
    expect(warnings).toEqual([]);
  });

  it('is a silent no-op when there are no merged PRs', () => {
    setIssueListPath(listPath);
    expect(reconcileMergedPRsWithList({ mergedPRs: [], warnings })).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('is a silent no-op when no curated list exists', () => {
    setIssueListPath(undefined);
    expect(reconcileMergedPRsWithList({ mergedPRs: [{ url: PR_A }], warnings })).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('is a silent no-op when no list entry mentions the merged PR', () => {
    const original = makeList();
    fs.writeFileSync(listPath, original, 'utf8');
    setIssueListPath(listPath);

    expect(reconcileMergedPRsWithList({ mergedPRs: [{ url: PR_B }], warnings })).toBeUndefined();
    expect(fs.readFileSync(listPath, 'utf8')).toBe(original);
    expect(warnings).toEqual([]);
  });

  it('is idempotent — an already-marked entry is a quiet no-op on a re-run', () => {
    fs.writeFileSync(listPath, makeList(), 'utf8');
    setIssueListPath(listPath);

    const first = reconcileMergedPRsWithList({ mergedPRs: [{ url: PR_A }], warnings });
    expect(first).toHaveLength(1);
    const afterFirst = fs.readFileSync(listPath, 'utf8');

    const second = reconcileMergedPRsWithList({ mergedPRs: [{ url: PR_A }], warnings });
    expect(second).toBeUndefined();
    expect(fs.readFileSync(listPath, 'utf8')).toBe(afterFirst);
    expect(warnings).toEqual([]);
  });

  it('strikes the repo heading when the merge completes the last open issue under it', () => {
    const content = [
      '### foo/bar',
      `- [#1](${ISSUE_A}) — only issue`,
      `  - **In Progress** — PR [#123](${PR_A}) open.`,
      '',
    ].join('\n');
    fs.writeFileSync(listPath, content, 'utf8');
    setIssueListPath(listPath);

    const updates = reconcileMergedPRsWithList({ mergedPRs: [{ url: PR_A }], warnings });

    expect(updates?.[0].repoHeadingStruck).toBe(true);
    expect(fs.readFileSync(listPath, 'utf8')).toContain('### ~~foo/bar~~');
  });

  it('records a merge-loop warning instead of crashing when the list cannot be written', () => {
    fs.writeFileSync(listPath, makeList(), 'utf8');
    setIssueListPath(listPath);
    // Read succeeds; the tmp-file write inside the read-only directory fails.
    fs.chmodSync(tmpDir, 0o555);

    const original = fs.readFileSync(listPath, 'utf8');
    const updates = reconcileMergedPRsWithList({ mergedPRs: [{ url: PR_A }], warnings });

    expect(updates).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].phase).toBe('merge-loop');
    expect(warnings[0].operation).toBe('auto-mark merged list entries');
    expect(warnings[0].message).toContain('write issue list');
    fs.chmodSync(tmpDir, 0o755);
    expect(fs.readFileSync(listPath, 'utf8')).toBe(original);
  });

  it('records a merge-loop warning when the list cannot be read', () => {
    fs.writeFileSync(listPath, makeList(), 'utf8');
    setIssueListPath(listPath);
    fs.chmodSync(listPath, 0o000);

    const updates = reconcileMergedPRsWithList({ mergedPRs: [{ url: PR_A }], warnings });

    expect(updates).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].phase).toBe('merge-loop');
    expect(warnings[0].message).toContain('read issue list');
    fs.chmodSync(listPath, 0o644);
  });

  it('handles multiple merged PRs in one pass, marking each matching entry', () => {
    const content = [
      '### foo/bar',
      `- [#1](${ISSUE_A}) — first`,
      `  - **In Progress** — PR [#123](${PR_A}) open.`,
      `- [#2](${ISSUE_B}) — second`,
      `  - **In Progress** — PR [#456](${PR_B}) open.`,
      '',
    ].join('\n');
    fs.writeFileSync(listPath, content, 'utf8');
    setIssueListPath(listPath);

    const updates = reconcileMergedPRsWithList({
      mergedPRs: [{ url: PR_A }, { url: PR_B }],
      warnings,
    });

    expect(updates).toHaveLength(2);
    expect(updates?.[1].repoHeadingStruck).toBe(true); // second mark completes the repo
    const written = fs.readFileSync(listPath, 'utf8');
    expect(written).toContain(`- ~~[#1](${ISSUE_A}) — first~~`);
    expect(written).toContain(`- ~~[#2](${ISSUE_B}) — second~~`);
  });
});
