/**
 * One closing-keyword grammar, three consumers (#2048). Each row pins what
 * the merged-PR ledger (`closingIssueUrl`), the compliance score's issue
 * reference check and preflight's `no-closing-keyword-in-commit` rule make of
 * the same text, so a grammar change shows up here row by row.
 */

import { describe, expect, it } from 'vitest';
import { closingIssueUrl } from './github-stats.js';
import { findClosingRefs } from './urls.js';
import { computeComplianceScore } from './compliance-score.js';
import { checkCommitRules, type PreflightFacts } from './pr-preflight.js';

const PR = 'https://github.com/owner/repo/pull/9';
const OWN = 'https://github.com/owner/repo/issues/12';

function complianceStatus(body: string): string {
  const meta = { body, title: 'fix: x', branch: 'fix/x', filesChangedCount: 1, additions: 1, deletions: 0, files: [] };
  return computeComplianceScore(meta).checks.issueReference.status;
}

function isCommitRuleBroken(message: string): boolean {
  const facts = {
    repo: 'up/proj',
    branchCommits: [message],
    policy: {
      commitRules: ['no-closing-keyword-in-commit'],
      aiPolicy: 'allowed',
      cla: 'none',
      prGate: 'none',
      source: [],
      reviewedByUser: true,
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  } as unknown as PreflightFacts;
  return checkCommitRules(facts).status === 'fail';
}

describe('closing keywords across consumers (#2048)', () => {
  // [text, ledger issue URL, compliance issueReference status, commit rule broken]
  it.each<[string, string | undefined, string, boolean]>([
    ['Fixes #12', OWN, 'pass', true],
    ['FIXES #12', OWN, 'pass', true],
    ['Fixes: #12', OWN, 'pass', true],
    ['Fixes:#12', OWN, 'pass', true],
    ['fixes other/lib#12', 'https://github.com/other/lib/issues/12', 'pass', true],
    ['Closes https://github.com/o/r/issues/12', 'https://github.com/o/r/issues/12', 'pass', true],
    // eslint-disable-next-line unicorn/prefer-https -- the http form is the case under test
    ['Closes http://github.com/o/r/issues/12', 'https://github.com/o/r/issues/12', 'pass', true],
    ['Fixes https://github.com/o/r/pull/12', undefined, 'fail', false],
    ['resolves #1, #2', 'https://github.com/owner/repo/issues/1', 'pass', true],
    ['Fixed in #12', undefined, 'fail', false],
    ['prefixes #12', undefined, 'fail', false],
    ['fixes #12abc', undefined, 'fail', false],
    ['Fixes (#12)', undefined, 'fail', false],
    ['Fixes\n#12', OWN, 'pass', true],
    ['See #12', undefined, 'warn', false],
    ['Use `Fixes #12` to link', undefined, 'fail', true],
    ['```\nFixes #12\n```', undefined, 'fail', true],
    ['<!-- Fixes #12 -->', undefined, 'fail', true],
    ['fix: x\n\nFixes #12', OWN, 'pass', true],
    ['fix: #12 crash', OWN, 'pass', true],
  ])('%j: ledger %s, compliance %s, commit rule broken %s', (text, ledger, compliance, broken) => {
    expect(closingIssueUrl(text, PR)).toBe(ledger);
    expect(complianceStatus(text)).toBe(compliance);
    expect(isCommitRuleBroken(text)).toBe(broken);
  });
});

describe('findClosingRefs (#2048)', () => {
  it('returns every keyword-led ref in order, with the repo it names', () => {
    expect(findClosingRefs('Fixes #1, #2 and closes up/proj#3; resolves https://github.com/o/r/issues/4')).toEqual([
      { repo: null, number: 1 },
      { repo: 'up/proj', number: 3 },
      { repo: 'o/r', number: 4 },
    ]);
  });

  it('reads code and HTML comments only when the text is not Markdown', () => {
    const text = '<!-- Fixes #1 -->\n`closes #2`\n```\nresolves #3\n```\nFixes #4';
    expect(findClosingRefs(text).map((ref) => ref.number)).toEqual([1, 2, 3, 4]);
    expect(findClosingRefs(text, { markdown: true }).map((ref) => ref.number)).toEqual([4]);
  });

  it('reads only the first 65,536 characters of Markdown', () => {
    const text = `${'x'.repeat(65_536)} Fixes #1`;
    expect(findClosingRefs(text)).toHaveLength(1);
    expect(findClosingRefs(text, { markdown: true })).toEqual([]);
  });
});
