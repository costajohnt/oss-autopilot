/**
 * CI gate (#1945): every GitHub write in `core` and `mcp-server` runs behind
 * `assertAttended` (core/errors.ts) or is on the named allowlist below.
 *
 * The unattended overnight run has to keep `node` allowed, so any CLI command
 * or MCP tool that writes to GitHub is reachable by the model in that run. The
 * guard was a convention tested per call site; this test fails when a new
 * write is added without it.
 *
 * A write counts as guarded only when `assertAttended(...)` is a direct body
 * statement (two-space indent) of the top-level function that contains the
 * write, before the write. A guard in a caller, a sibling handler, a class
 * method, a branch or a nested closure does not count: guard the containing
 * function, or allowlist the write with the reason.
 *
 * Limit: this is a regex scan over source text, not an AST or a call graph. It
 * misses a client that is neither named `*octokit` nor called with a
 * create/update/delete-style method, a destructured method, computed member
 * access, a route or method held in a variable (including `{ method }`
 * shorthand), `octokit.paginate('POST ...')`, a `gh` or `git push` built from
 * non-literal arguments, a shell-string `exec`, and writes made by dependencies.
 *
 * `packages/dashboard` is not scanned: it is a browser SPA with no GitHub
 * client; its POSTs go to the local dashboard server, whose handlers are in core.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

const PACKAGES_DIR = path.resolve(__dirname, '../..');
const SCAN_ROOTS = ['core/src', 'mcp-server/src'];

/** Unguarded on purpose. Key: `<file> <call>`, value: why it may run unattended. */
const ALLOWED: Record<string, string> = {
  'core/src/core/gist-state-store.ts gists.update':
    "state sync to the user's own state Gist (created private); the overnight run records its results through it",
  'core/src/core/gist-state-store.ts gists.create':
    "creates the user's own private state Gist on first use; state sync, not a contribution",
  'core/src/commands/startup.ts method POST': 'POST to the local dashboard server (/api/refresh), not to GitHub',
  'core/src/core/merged-pr-notes.ts git push': "not a process argument: 'push' is an entry in a word list",
  'core/src/core/auth.ts gh auth token': 'read-only: reads the local gh token',
  'core/src/core/auth.ts gh api user --jq .login': 'read-only: GET /user',
  'core/src/commands/doctor.ts gh --version': 'read-only: local version check',
  'core/src/commands/doctor.ts gh auth status': 'read-only: local auth check',
};

interface Detector {
  re: RegExp;
  /** The call's name, or null when the match is not a write. */
  call: (match: RegExpExecArray) => string | null;
}

/** `<namespace>.<method>` calls that only read. */
const READ_CALL = /^(?:(?:search|rateLimit|paginate|log|hook|auth)\.|\w+\.(?:get|list|check|compare|download))/;
const WRITE_NAMESPACES = new Set(
  'issues pulls repos git gists reactions activity actions checks orgs teams users'.split(' '),
);
const callName = (m: RegExpExecArray): string => `${m[1]}.${m[2]}`;

const DETECTORS: Detector[] = [
  // Octokit REST on a client named *octokit or built by getOctokit(...): anything that is not a read.
  {
    re: /octokit(?:\([^)]*\))?\??\.(?:rest\.)?(\w+)\.(\w+)\(/gi,
    call: (m) => (READ_CALL.test(callName(m)) ? null : callName(m)),
  },
  // Octokit REST on any other receiver: mutator verbs on the known namespaces.
  {
    re: /\.(\w+)\.((?:create|update|delete|add|remove|merge|set|replace|dismiss|submit|request|lock|unlock)(?:[A-Z]\w*)?)\(/g,
    call: (m) => (WRITE_NAMESPACES.has(m[1]) ? callName(m) : null),
  },
  { re: /[`'"]\s*mutation(?:\s+\w+)?\s*[({]/g, call: () => 'graphql mutation' },
  { re: /\.request\(\s*[`'"](POST|PUT|PATCH|DELETE)\b/gi, call: (m) => `request ${m[1].toUpperCase()}` },
  { re: /method:\s*[`'"](POST|PUT|PATCH|DELETE)\b/gi, call: (m) => `method ${m[1].toUpperCase()}` },
  // Pushes: any literal 'push' argument, wherever the process is spawned.
  { re: /[`'"]push[`'"]|[`'"]git\s+push\b/g, call: () => 'git push' },
  // gh CLI: every invocation is a hit; the read-only ones are allowlisted by their arguments.
  { re: /[`'"]gh[`'"]\s*,\s*(\[[^\]]*\]|\w+)/g, call: (m) => ['gh', ...(m[1].match(/[\w.-]+/g) ?? [])].join(' ') },
];

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const TOP_LEVEL_DECLARATION = /^(?:export )?(?:default )?(?:async )?(?:function|class|const) /;
const FUNCTION_START = /^(?:export )?(?:default )?(?:async )?function |=> \{$/;
/** A direct body statement of a top-level function: exactly one indent level. */
const DIRECT_GUARD = /^ {2}assertAttended\(/;

interface Finding {
  /** `<file> <call>`, the allowlist key. */
  key: string;
  line: number;
  guarded: boolean;
}

function isGuarded(lines: string[], hitLine: number): boolean {
  let start = hitLine;
  while (start > 0 && !TOP_LEVEL_DECLARATION.test(lines[start])) start--;
  return FUNCTION_START.test(lines[start]) && lines.slice(start, hitLine).some((line) => DIRECT_GUARD.test(line));
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
      const name = call(match);
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

/** Scanner fixtures: the unguarded calls in a source text, and a one-function file with this body. */
const unguardedCalls = (source: string): string[] =>
  scanSource('x.ts', source)
    .filter((finding) => !finding.guarded)
    .map((finding) => finding.key);
const inFunction = (body: string): string => `export async function run() {\n${body}\n}\n`;

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
      'GitHub write without assertAttended() as a direct statement of the top-level function before it. ' +
        'The guard must be in the function that contains the call, not in its caller. ' +
        'Add the guard, or add the entry to ALLOWED with the reason it may run unattended. ' +
        'If this call only reads, add its verb to READ_CALL.',
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    const stale = Object.keys(ALLOWED).filter((key) => UNGUARDED.every((finding) => finding.key !== key));
    expect(stale, 'ALLOWED entry no longer matches an unguarded write; remove it.').toEqual([]);
  });

  describe('scanner', () => {
    it.each([
      ['await octokit.pulls.create({ owner, repo });', 'x.ts pulls.create'],
      ['await getOctokit(token).pulls.merge({ owner, repo });', 'x.ts pulls.merge'],
      ['await client.issues.lock({ owner, repo });', 'x.ts issues.lock'],
      ['await client.issues.addLabels({ owner, repo });', 'x.ts issues.addLabels'],
      ['await octokit.graphql(`mutation { addStar(input: $input) { clientMutationId } }`);', 'x.ts graphql mutation'],
      ["await octokit.request('post /repos/{owner}/{repo}/forks');", 'x.ts request POST'],
      ["await octokit.request({ method: 'DELETE', url });", 'x.ts method DELETE'],
      ["git(dir, ['push', 'origin', branch]);", 'x.ts git push'],
      ["execFileSync('gh', ['pr', 'comment', url, '--body', body]);", 'x.ts gh pr comment url --body body'],
    ])('flags an unguarded %s', (body, key) => {
      expect(unguardedCalls(inFunction(body))).toEqual([key]);
    });

    it('accepts a write that follows assertAttended in the same function', () => {
      const body = "  assertAttended('open a PR');\n  await octokit.pulls.create({ owner, repo });";
      expect(unguardedCalls(inFunction(body))).toEqual([]);
    });

    it('does not accept a guard that lives in a different function', () => {
      const body = "  assertAttended('x');\n}\nexport async function other() {\n  await octokit.pulls.create({});";
      expect(unguardedCalls(inFunction(body))).toEqual(['x.ts pulls.create']);
    });

    it('does not accept a guard inside a branch', () => {
      const body = "  if (flag) {\n    assertAttended('x');\n  }\n  await octokit.pulls.create({});";
      expect(unguardedCalls(inFunction(body))).toEqual(['x.ts pulls.create']);
    });

    it('does not accept a guard in a sibling handler of one registry', () => {
      const source = [
        'export const commands = [',
        "  { run: async () => {\n      assertAttended('x');\n    } },",
        '  { run: async () => {\n      await octokit.pulls.create({});\n    } },',
        '];',
      ].join('\n');
      expect(unguardedCalls(source)).toEqual(['x.ts pulls.create']);
    });

    it('ignores reads, logging, comments and prose that starts with "mutation"', () => {
      const body = [
        'await octokit.pulls.get({ owner, repo });',
        "octokit.log.warn('slow');",
        "warn('mutation was lost');",
        '// await octokit.pulls.create({ owner, repo });',
      ].join('\n');
      expect(unguardedCalls(inFunction(body))).toEqual([]);
    });
  });
});
