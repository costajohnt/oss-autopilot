/**
 * CI gate (#1945): every GitHub write in `core` and `mcp-server` runs behind
 * `assertAttended` (core/errors.ts) or is on the named allowlist below.
 *
 * The unattended overnight run has to keep `node` allowed, so any CLI command
 * or MCP tool that writes to GitHub is reachable by the model in that run. The
 * guard was a convention tested per call site; this test fails when a new
 * write is added without it.
 *
 * A write counts as guarded when `assertAttended(` appears between the start
 * of its enclosing top-level declaration and the write itself. A write in a
 * helper whose callers hold the guard therefore fails here: guard the helper
 * too, or allowlist it with the reason.
 *
 * Limit: this is a regex scan over source text, not an AST or a call graph. It
 * misses a client that is neither named `*octokit` nor called with a
 * create/update/delete-style method, a destructured method, a `gh` or
 * `git push` built from non-literal arguments or run through a helper in a
 * file that does not import `child_process`, and writes made by dependencies.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

const PACKAGES_DIR = path.resolve(__dirname, '../..');
const SCAN_ROOTS = ['core/src', 'mcp-server/src'];

/** Unguarded on purpose. Key: `<file> <call>`, value: why it may run unattended. */
const ALLOWED: Record<string, string> = {
  'core/src/core/gist-state-store.ts gists.update':
    "state sync to the user's own private Gist; the overnight run records its results through it",
  'core/src/core/gist-state-store.ts gists.create':
    "creates the user's own private state Gist on first use; state sync, not a contribution",
  'core/src/commands/startup.ts method POST': 'POST to the local dashboard server (/api/refresh), not to GitHub',
  'core/src/core/auth.ts gh auth token': 'read-only: reads the local gh token',
  'core/src/core/auth.ts gh api user --jq .login': 'read-only: GET /user',
  'core/src/commands/doctor.ts gh --version': 'read-only: local version check',
  'core/src/commands/doctor.ts gh auth status': 'read-only: local auth check',
};

interface Detector {
  re: RegExp;
  /** The call's name, or null when the match is not a write. */
  call: (match: RegExpExecArray, source: string) => string | null;
}

/** `<namespace>.<method>` calls that only read. */
const READ_CALL = /^(?:(?:search|rateLimit|paginate)\.|\w+\.(?:get|list|check|compare|download))/;
const WRITE_NAMESPACES = new Set(
  'issues pulls repos git gists reactions activity actions checks orgs teams users'.split(' '),
);
const callName = (m: RegExpExecArray): string => `${m[1]}.${m[2]}`;

const DETECTORS: Detector[] = [
  // Octokit REST on a client named *octokit: anything that is not a read.
  {
    re: /octokit\??\.(?:rest\.)?(\w+)\.(\w+)\(/gi,
    call: (m) => (READ_CALL.test(callName(m)) ? null : callName(m)),
  },
  // Octokit REST on any other receiver: recognizable mutator names only.
  {
    re: /\.(\w+)\.((?:create|update|delete|add|remove|merge|set|replace|dismiss|submit|request|lock|unlock)[A-Z]\w*)\(/g,
    call: (m) => (WRITE_NAMESPACES.has(m[1]) ? callName(m) : null),
  },
  { re: /[`'"]\s*mutation\b/g, call: () => 'graphql mutation' },
  { re: /\.request\(\s*[`'"](POST|PUT|PATCH|DELETE)\b/g, call: (m) => `request ${m[1]}` },
  { re: /method:\s*[`'"](POST|PUT|PATCH|DELETE)\b/g, call: (m) => `method ${m[1]}` },
  // Pushes: a literal 'push' argument in a file that can spawn processes.
  {
    re: /[`'"]push[`'"]|[`'"]git\s+push\b/g,
    call: (_m, source) => (source.includes('child_process') ? 'git push' : null),
  },
  // gh CLI: every invocation is a hit; the read-only ones are allowlisted by their arguments.
  { re: /[`'"]gh[`'"]\s*,\s*(\[[^\]]*\]|\w+)/g, call: (m) => ['gh', ...(m[1].match(/[\w.-]+/g) ?? [])].join(' ') },
  { re: /\bexec(?:Sync)?\(\s*[`'"](gh|git)\b/g, call: (m) => `exec ${m[1]}` },
];

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const TOP_LEVEL_DECLARATION = /^(?:export )?(?:default )?(?:async )?(?:function|class|const) /;

interface Finding {
  /** `<file> <call>`, the allowlist key. */
  key: string;
  line: number;
  guarded: boolean;
}

function isGuarded(lines: string[], hitLine: number): boolean {
  let start = hitLine;
  while (start > 0 && !TOP_LEVEL_DECLARATION.test(lines[start])) start--;
  return lines.slice(start, hitLine + 1).some((line) => line.includes('assertAttended('));
}

function scanSource(file: string, raw: string): Finding[] {
  // Comment lines are blanked (not removed) so line numbers still match the file.
  const lines = raw.split('\n').map((line) => (COMMENT_LINE.test(line) ? '' : line));
  const source = lines.join('\n');
  // Keyed by call and line: two detectors can match the same call.
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const { re, call } of DETECTORS) {
    for (const match of source.matchAll(re)) {
      const name = call(match, source);
      const hitLine = source.slice(0, match.index).split('\n').length - 1;
      if (name === null || seen.has(`${name}:${hitLine}`)) continue;
      seen.add(`${name}:${hitLine}`);
      const key = `${file} ${name}`;
      findings.push({ key, line: hitLine + 1, guarded: isGuarded(lines, hitLine) });
    }
  }
  return findings;
}

function scanRoot(root: string): Finding[] {
  const dir = path.join(PACKAGES_DIR, root);
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.test.ts') && !rel.includes('test-lib'))
    .flatMap((rel) => {
      const file = path.posix.join(root, rel.split(path.sep).join('/'));
      return scanSource(file, fs.readFileSync(path.join(dir, rel), 'utf8'));
    });
}

const FINDINGS = SCAN_ROOTS.flatMap((root) => scanRoot(root));
const UNGUARDED = FINDINGS.filter((finding) => !finding.guarded);
const ALLOWED_KEYS = new Set(Object.keys(ALLOWED));

/** Scanner fixture: the unguarded calls in a one-function file with this body. */
const unguardedCalls = (body: string): string[] =>
  scanSource('x.ts', `import { execFileSync } from 'node:child_process';\nexport async function run() {\n${body}\n}\n`)
    .filter((finding) => !finding.guarded)
    .map((finding) => finding.key);

describe('unattended write guard (#1945)', () => {
  it('sees the writes that are known to be guarded', () => {
    const guarded = new Set(FINDINGS.filter((finding) => finding.guarded).map((finding) => finding.key));
    expect(guarded).toContain('core/src/commands/comments.ts issues.createComment');
    expect(guarded).toContain('core/src/commands/overnight-push-prep.ts git push');
  });

  it('every GitHub write calls assertAttended first or is allowlisted', () => {
    const violations = UNGUARDED.filter((finding) => !ALLOWED_KEYS.has(finding.key)).map(
      (finding) => `${finding.key} (line ${finding.line})`,
    );
    expect(
      violations,
      'GitHub write without assertAttended() before it in the same top-level function. ' +
        'Add the guard, or add the entry to ALLOWED with the reason it may run unattended.',
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    const stale = Object.keys(ALLOWED).filter((key) => UNGUARDED.every((finding) => finding.key !== key));
    expect(stale, 'ALLOWED entry no longer matches an unguarded write; remove it.').toEqual([]);
  });

  describe('scanner', () => {
    it.each([
      ['await octokit.pulls.create({ owner, repo });', 'x.ts pulls.create'],
      ['await this.octokit.rest.issues.lock({ owner, repo });', 'x.ts issues.lock'],
      ['await client.issues.addLabels({ owner, repo });', 'x.ts issues.addLabels'],
      ['await octokit.issues.addLabels({ owner, repo });', 'x.ts issues.addLabels'],
      ['await octokit.graphql(`mutation { addStar(input: $input) { clientMutationId } }`);', 'x.ts graphql mutation'],
      ["await octokit.request('POST /repos/{owner}/{repo}/forks');", 'x.ts request POST'],
      ["await octokit.request({ method: 'DELETE', url });", 'x.ts method DELETE'],
      ["execFileSync('git', ['-C', dir, 'push', 'origin', branch]);", 'x.ts git push'],
      ["execFileSync('gh', ['pr', 'comment', url, '--body', body]);", 'x.ts gh pr comment url --body body'],
      ["execSync('gh pr merge 1');", 'x.ts exec gh'],
    ])('flags an unguarded %s', (body, key) => {
      expect(unguardedCalls(body)).toEqual([key]);
    });

    it('accepts a write that follows assertAttended in the same function', () => {
      expect(unguardedCalls("assertAttended('open a PR');\nawait octokit.pulls.create({ owner, repo });")).toEqual([]);
    });

    it('does not accept a guard that lives in a different function', () => {
      const body = "assertAttended('x');\n}\nexport async function other() {\nawait octokit.pulls.create({});";
      expect(unguardedCalls(body)).toEqual(['x.ts pulls.create']);
    });

    it('ignores reads and comments', () => {
      const body = 'await octokit.pulls.get({ owner, repo });\n// await octokit.pulls.create({ owner, repo });';
      expect(unguardedCalls(body)).toEqual([]);
    });
  });
});
