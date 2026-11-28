/**
 * One closing-keyword grammar, three consumers (#2048). Each row pins what
 * the merged-PR ledger (`closingIssueUrl`), the compliance score's issue
 * reference check and preflight's `no-closing-keyword-in-commit` rule make of
 * the same text, so a grammar change shows up here row by row.
 */

import { describe, expect, it } from 'vitest';
import { closingIssueUrl } from './github-stats.js';
import { computeComplianceScore } from './compliance-score.js';
import { checkCommitRules, type PreflightFacts } from './pr-preflight.js';

const PR = 'https://github.com/owner/repo/pull/9';
const OWN = 'https://github.com/owner/repo/issues/12';

function complianceStatus(body: string): string {
  const meta = { title: 'fix: x', body, branch: 'fix/x', filesChangedCount: 1, additions: 1, deletions: 0, files: [] };
  return computeComplianceScore(meta).checks.issueReference.status;
}

function commitBreaksRule(message: string): boolean {
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
    ['Fixes: #12', OWN, 'fail', true],
    ['Fixes:#12', OWN, 'fail', false],
    ['fixes other/lib#12', 'https://github.com/other/lib/issues/12', 'fail', true],
    ['Closes https://github.com/o/r/issues/12', 'https://github.com/o/r/issues/12', 'warn', true],
    ['Closes http://github.com/o/r/issues/12', undefined, 'warn', true],
    ['Fixes https://github.com/o/r/pull/12', undefined, 'fail', false],
    ['resolves #1, #2', 'https://github.com/owner/repo/issues/1', 'pass', true],
    ['Fixed in #12', undefined, 'fail', false],
    ['prefixes #12', undefined, 'fail', false],
    ['fixes #12abc', undefined, 'pass', true],
    ['Fixes (#12)', undefined, 'fail', true],
    ['Fixes\n#12', OWN, 'pass', false],
    ['See #12', undefined, 'warn', false],
    ['Use `Fixes #12` to link', undefined, 'pass', true],
    ['```\nFixes #12\n```', undefined, 'pass', true],
    ['<!-- Fixes #12 -->', undefined, 'pass', true],
    ['fix: x\n\nFixes #12', OWN, 'pass', true],
    ['fix: #12 crash', OWN, 'fail', true],
  ])('%j: ledger %s, compliance %s, commit rule broken %s', (text, ledger, compliance, broken) => {
    expect(closingIssueUrl(text, PR)).toBe(ledger);
    expect(complianceStatus(text)).toBe(compliance);
    expect(commitBreaksRule(text)).toBe(broken);
  });
});
