/**
 * Tests for list-mark-done (#1299).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { markIssueAsDone, runMarkIssueListItemDone } from './list-mark-done.js';

const ISSUE_A = 'https://github.com/foo/bar/issues/1';
const ISSUE_B = 'https://github.com/foo/bar/issues/2';
const ISSUE_C = 'https://github.com/baz/qux/issues/42';
const PR_A = 'https://github.com/foo/bar/pull/123';
const PR_C = 'https://github.com/baz/qux/pull/9';

describe('markIssueAsDone (pure transform)', () => {
  it('strikes the issue line, appends a Done sub-bullet, and strikes the heading when no other issues remain', () => {
    const content = [
      '# My List',
      '',
      '## Pursue',
      '',
      `### foo/bar (1.2k★) — A library`,
      `- [#1](${ISSUE_A}) — Test mic while "muted"`,
      '  - **Low complexity** — Help wanted, unassigned.',
      '',
    ].join('\n');

    const result = markIssueAsDone(content, {
      issueUrl: ISSUE_A,
      prUrl: PR_A,
      prStatus: 'CI passing',
    });

    expect(result.marked).toBe(true);
    expect(result.repoHeadingStruck).toBe(true);
    expect(result.remainingUnderRepo).toBe(0);

    expect(result.content).toContain(`### ~~foo/bar (1.2k★) — A library~~`);
    expect(result.content).toContain(`- ~~[#1](${ISSUE_A}) — Test mic while "muted"~~`);
    expect(result.content).toContain(`  - **Done** — PR [#123](${PR_A}) submitted, CI passing.`);
    // Original sub-bullet is preserved (we append, not replace).
    expect(result.content).toContain('  - **Low complexity** — Help wanted, unassigned.');
  });

  it('does not strike the heading when other issues under it are still open', () => {
    const content = [
      '## Pursue',
      '',
      `### foo/bar`,
      `- [#1](${ISSUE_A}) — first`,
      `- [#2](${ISSUE_B}) — second`,
      '',
    ].join('\n');

    const result = markIssueAsDone(content, {
      issueUrl: ISSUE_A,
      prUrl: PR_A,
      prStatus: 'merged',
    });

    expect(result.marked).toBe(true);
    expect(result.repoHeadingStruck).toBe(false);
    expect(result.remainingUnderRepo).toBe(1);

    expect(result.content).toContain(`### foo/bar`);
    expect(result.content).not.toContain(`### ~~foo/bar~~`);
    expect(result.content).toContain(`- ~~[#1](${ISSUE_A}) — first~~`);
    expect(result.content).toContain(`- [#2](${ISSUE_B}) — second`);
  });

  it('is idempotent — already-marked issues are a no-op', () => {
    const content = [
      `### foo/bar`,
      `- ~~[#1](${ISSUE_A}) — first~~`,
      `  - **Done** — PR [#10](https://github.com/foo/bar/pull/10) submitted, CI passing.`,
      `- [#2](${ISSUE_B}) — second`,
      '',
    ].join('\n');

    const result = markIssueAsDone(content, {
      issueUrl: ISSUE_A,
      prUrl: PR_A,
      prStatus: 'merged',
    });

    expect(result.marked).toBe(false);
    expect(result.reason).toMatch(/already/);
    expect(result.content).toBe(content);
    // remainingUnderRepo reflects current state.
    expect(result.remainingUnderRepo).toBe(1);
  });

  it('returns marked=false when the URL is not found', () => {
    const content = '## Pursue\n\n### foo/bar\n- [#9](https://github.com/foo/bar/issues/9) — other\n';
    const result = markIssueAsDone(content, {
      issueUrl: ISSUE_A,
      prUrl: PR_A,
      prStatus: 'merged',
    });
    expect(result.marked).toBe(false);
    expect(result.reason).toMatch(/not found/);
    expect(result.content).toBe(content);
  });

  it('strikes the second issue and the heading once the last open issue closes', () => {
    const content = [
      `### baz/qux`,
      `- ~~[#1](${ISSUE_A}) — old~~`,
      `  - **Done** — PR [#1](https://github.com/baz/qux/pull/1) submitted, merged.`,
      `- [#42](${ISSUE_C}) — last open`,
      '',
    ].join('\n');

    const result = markIssueAsDone(content, {
      issueUrl: ISSUE_C,
      prUrl: PR_C,
      prStatus: 'CI passing',
    });

    expect(result.marked).toBe(true);
    expect(result.repoHeadingStruck).toBe(true);
    expect(result.remainingUnderRepo).toBe(0);
    expect(result.content).toContain(`### ~~baz/qux~~`);
  });

  it('does not match a URL whose number is a prefix of another listed URL (substring guard)', () => {
    // `issues/1` is a substring of `issues/10`. Without the digit-boundary
    // guard, marking issue 1 would clobber whichever appears first.
    const URL_1 = 'https://github.com/foo/bar/issues/1';
    const URL_10 = 'https://github.com/foo/bar/issues/10';
    const content = [`### foo/bar`, `- [#10](${URL_10}) — ten`, `- [#1](${URL_1}) — one`, ''].join('\n');
    const result = markIssueAsDone(content, { issueUrl: URL_1, prUrl: PR_A, prStatus: 'merged' });
    expect(result.marked).toBe(true);
    // Issue 10 must remain untouched.
    expect(result.content).toContain(`- [#10](${URL_10}) — ten`);
    expect(result.content).toContain(`- ~~[#1](${URL_1}) — one~~`);
    // The Done sub-bullet should reference issue 1, not issue 10.
    expect(result.content).toContain(`- **Done** — PR [#123](${PR_A}) submitted, merged.`);
  });

  it('preserves the trailing newline shape of the source', () => {
    const withNewline = `### foo/bar\n- [#1](${ISSUE_A}) — x\n`;
    const withoutNewline = `### foo/bar\n- [#1](${ISSUE_A}) — x`;
    const a = markIssueAsDone(withNewline, { issueUrl: ISSUE_A, prUrl: PR_A, prStatus: 'merged' });
    const b = markIssueAsDone(withoutNewline, { issueUrl: ISSUE_A, prUrl: PR_A, prStatus: 'merged' });
    expect(a.content.endsWith('\n')).toBe(true);
    expect(b.content.endsWith('\n')).toBe(false);
  });

  it('falls back to "PR" label when the PR URL has no number segment', () => {
    const content = `### foo/bar\n- [#1](${ISSUE_A}) — x\n`;
    const result = markIssueAsDone(content, {
      issueUrl: ISSUE_A,
      prUrl: 'https://example.com/some-non-pr-url',
      prStatus: 'submitted',
    });
    expect(result.marked).toBe(true);
    expect(result.content).toContain(
      '  - **Done** — PR [PR](https://example.com/some-non-pr-url) submitted, submitted.',
    );
  });

  it('does not strike a heading that lacks any issue lines (prose-only section is left alone)', () => {
    const content = ['### foo/bar', 'Some intro prose.', '', '<!-- intentionally no issue lines yet -->', ''].join(
      '\n',
    );
    // No issue line to find, so this just exercises the not-found path.
    const result = markIssueAsDone(content, {
      issueUrl: ISSUE_A,
      prUrl: PR_A,
      prStatus: 'merged',
    });
    expect(result.marked).toBe(false);
    expect(result.content).toBe(content);
  });
});

describe('runMarkIssueListItemDone (filesystem)', () => {
  let tmpDir: string;
  let listPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-mark-done-test-'));
    listPath = path.join(tmpDir, 'list.md');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads, marks, writes atomically, and returns the resolved file path', async () => {
    fs.writeFileSync(listPath, [`### foo/bar`, `- [#1](${ISSUE_A}) — x`, ''].join('\n'));
    const out = await runMarkIssueListItemDone({
      issueUrl: ISSUE_A,
      prUrl: PR_A,
      prStatus: 'CI passing',
      listPath,
    });
    expect(out.marked).toBe(true);
    expect(out.repoHeadingStruck).toBe(true);
    expect(out.filePath).toBe(path.resolve(listPath));
    expect(out.url).toBe(ISSUE_A);

    const after = fs.readFileSync(listPath, 'utf8');
    expect(after).toContain(`### ~~foo/bar~~`);
    expect(after).toContain(`  - **Done** — PR [#123](${PR_A}) submitted, CI passing.`);
  });

  it('throws when the file does not exist', async () => {
    await expect(
      runMarkIssueListItemDone({
        issueUrl: ISSUE_A,
        prUrl: PR_A,
        prStatus: 'merged',
        listPath,
      }),
    ).rejects.toThrow(/File not found/);
  });

  it('does not write when the URL is not present', async () => {
    const original = `### foo/bar\n- [#9](https://github.com/foo/bar/issues/9) — other\n`;
    fs.writeFileSync(listPath, original);
    const before = fs.statSync(listPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const out = await runMarkIssueListItemDone({
      issueUrl: ISSUE_A,
      prUrl: PR_A,
      prStatus: 'merged',
      listPath,
    });
    expect(out.marked).toBe(false);
    const after = fs.statSync(listPath).mtimeMs;
    expect(after).toBe(before);
    expect(fs.readFileSync(listPath, 'utf8')).toBe(original);
  });

  it('leaves no temp file behind on a successful write', async () => {
    fs.writeFileSync(listPath, `### foo/bar\n- [#1](${ISSUE_A}) — x\n`);
    await runMarkIssueListItemDone({
      issueUrl: ISSUE_A,
      prUrl: PR_A,
      prStatus: 'merged',
      listPath,
    });
    const siblings = fs.readdirSync(tmpDir);
    // Only the list.md should remain — no `.tmp-*` files left over.
    expect(siblings).toEqual(['list.md']);
  });
});
