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
 * function, or allowlist the write with its count and the reason. The count
 * is exact, so a second call next to an allowlisted one fails until reviewed.
 *
 * Limit: this is a regex scan over source text, not an AST or a call graph. It
 * misses a client that is neither named `*octokit` nor called with a
 * create/update/delete-style method, a destructured method, computed member
 * access, a route or method held in a variable (including `{ method }`
 * shorthand, also in `fetch`), `octokit.paginate('POST ...')`, a `gh` or `git push` built from
 * non-literal arguments, a shell-string `exec`, and writes made by dependencies.
 *
 * A second gate (#1936) covers the MCP tools: a tool that reaches a command
 * guarded this way must ask the user through `requireApproval`, or be exempt
 * by name. It parses `tools.ts`, requires the handler argument of each
 * `registerTool` call to be the `requireApproval(...)` call itself, and only
 * sees commands named inside that `registerTool` call. A command counts as
 * guarded when an exported function in `core/src/commands` or `core/src/core`
 * (declared or `export const` arrow) has a top-level guard, conditional or not.
 *
 * `packages/dashboard` is not scanned: it is a browser SPA with no GitHub
 * client; its POSTs go to the local dashboard server, whose handlers are in core.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const PACKAGES_DIR = path.resolve(__dirname, '../..');
const SCAN_ROOTS = ['core/src', 'mcp-server/src'];

/**
 * Unguarded on purpose. Key: `<file> <call>`. `count` is how many unguarded
 * calls with that key the file has; any other number fails, so a new call
 * next to an allowlisted one needs its own review and a count bump. `why` is
 * the reason every one of those calls may run unattended.
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'core/src/core/gist-state-store.ts gists.update': {
    count: 1,
    why: "state sync to the user's own state Gist (created private); the overnight run records its results through it",
  },
  'core/src/core/gist-state-store.ts gists.create': {
    count: 2,
    why: "creates the user's own private state Gist on first use (and again when it is missing); state sync, not a contribution",
  },
  'core/src/commands/startup.ts fetch POST': {
    count: 1,
    why: 'POST to the local dashboard server (/api/refresh), not to GitHub',
  },
  'core/src/core/merged-pr-notes.ts git push': {
    count: 1,
    why: "not a process argument: 'push' is an entry in a word list",
  },
  'core/src/core/auth.ts gh auth token': {
    count: 2,
    why: 'read-only: reads the local gh token (sync and async readers)',
  },
  'core/src/core/auth.ts gh api user --jq .login': { count: 1, why: 'read-only: GET /user' },
  'core/src/commands/doctor.ts gh --version': { count: 1, why: 'read-only: local version check' },
  'core/src/commands/doctor.ts gh auth status': { count: 1, why: 'read-only: local auth check' },
};

interface Detector {
  re: RegExp;
  /** The call's name, or null when the match is not a write. `source` is the scanned text. */
  call: (match: RegExpExecArray, source: string) => string | null;
}

/** `<namespace>.<method>` calls that only read. */
const READ_CALL = /^(?:(?:search|rateLimit|paginate|log|hook|auth)\.|\w+\.(?:get|list|check|compare|download))/;
const WRITE_NAMESPACES = new Set(
  'issues pulls repos git gists reactions activity actions checks orgs teams users'.split(' '),
);
const callName = (m: RegExpExecArray): string => `${m[1]}.${m[2]}`;
/** Prefixes of Octokit REST methods that write. */
const WRITE_VERBS = [
  'create update delete add remove merge set replace dismiss submit request lock unlock',
  'star unstar transfer rename reRun rerequest cancel upload enable disable approve',
  'follow unfollow block unblock accept decline mark',
]
  .join(' ')
  .split(' ');
const WRITE_METHOD = new RegExp(String.raw`\.(\w+)\.((?:${WRITE_VERBS.join('|')})(?:[A-Z]\w*)?)\(`, 'g');
/**
 * True when the match at `index` is inside the arguments of a raw `fetch(`
 * call: the nearest `fetch(` before it, with no `;` in between.
 */
function insideFetch(source: string, index: number): boolean {
  const before = source.slice(Math.max(0, index - 500), index);
  const starts = [...before.matchAll(/\bfetch\(/g)];
  const last = starts.at(-1);
  return last !== undefined && !before.slice(last.index).includes(';');
}

const DETECTORS: Detector[] = [
  // Octokit REST on a client named *octokit or built by getOctokit(...): anything that is not a read.
  {
    re: /octokit(?:\([^)]*\))?\??\.(?:rest\.)?(\w+)\.(\w+)\(/gi,
    call: (m) => (READ_CALL.test(callName(m)) ? null : callName(m)),
  },
  // Octokit REST on any other receiver: mutator verbs on the known namespaces.
  { re: WRITE_METHOD, call: (m) => (WRITE_NAMESPACES.has(m[1]) ? callName(m) : null) },
  { re: /[`'"]\s*mutation(?:\s+\w+)?\s*[({]/g, call: () => 'graphql mutation' },
  { re: /\.request\(\s*[`'"](POST|PUT|PATCH|DELETE)\b/gi, call: (m) => `request ${m[1].toUpperCase()}` },
  // A non-GET method literal; inside a raw `fetch(...)` it gets its own key, so an
  // allowlisted fetch to a local server never covers a request to GitHub.
  {
    re: /method:\s*[`'"](POST|PUT|PATCH|DELETE)\b/gi,
    call: (m, source) => `${insideFetch(source, m.index) ? 'fetch' : 'method'} ${m[1].toUpperCase()}`,
  },
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
/**
 * A guard that makes the function refuse unattended for some inputs: a direct
 * statement, or a one-line `if (...) assertAttended(...)` at the same level
 * (`runCleanup` refuses only with `--apply`). It marks a command as needing a
 * person (the MCP gate below); it does not guard the writes after it.
 */
const ATTENDED_GUARD = /^ {2}(?:if \(.+\) )?assertAttended\(/;

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

/** Non-test TypeScript files under `root` (relative to packages/), with their text. */
function sourceFiles(root: string): { file: string; raw: string }[] {
  const dir = path.join(PACKAGES_DIR, root);
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.test.ts') && !rel.includes('test-lib'))
    .map((rel) => ({
      file: path.posix.join(root, rel.split(path.sep).join('/')),
      raw: fs.readFileSync(path.join(dir, rel), 'utf8'),
    }));
}

/**
 * The unguarded writes that do not match ALLOWED: a key it does not list, or a
 * listed key found a different number of times (zero included: a stale entry).
 */
function allowlistViolations(unguarded: Finding[], allowed: Record<string, { count: number }>): string[] {
  const lines = new Map<string, number[]>();
  for (const finding of unguarded) lines.set(finding.key, [...(lines.get(finding.key) ?? []), finding.line]);
  const keys = new Set([...lines.keys(), ...Object.keys(allowed)]);
  return [...keys].flatMap((key) => {
    const found = lines.get(key) ?? [];
    const expected = allowed[key]?.count ?? 0;
    if (found.length === expected) return [];
    const where = found.length > 0 ? ` (lines ${found.join(', ')})` : '';
    return [`${key}: ${found.length} unguarded, ${expected} allowed${where}`];
  });
}

const FINDINGS = SCAN_ROOTS.flatMap(sourceFiles).flatMap(({ file, raw }) => scanSource(file, raw));
const UNGUARDED = FINDINGS.filter((finding) => !finding.guarded);

// ── MCP approval gate (#1936) ─────────────────────────────────────────
// A command that refuses unattended is one that needs a person. When an MCP
// tool reaches such a command, the tool must ask that person through
// `requireApproval` (mcp-server/src/trust-boundary.ts) or be listed here.

/** Guarded commands an MCP tool may call without `requireApproval`. Value: why. */
const MCP_APPROVAL_EXEMPT: Record<string, string> = {};

/** `export [async] function f(` or `export const f = [async] (...) =>` / `= function`. */
const EXPORTED_FUNCTION =
  /^export (?:async )?function (\w+)\b|^export const (\w+)(?::[^=]+)? = (?:async )?(?:function\b|\(|\w+ =>)/;

/**
 * Exported top-level functions that refuse unattended: an ATTENDED_GUARD line
 * in the body, which ends at the next line starting with `}`.
 */
function attendedOnlyFunctions(raw: string): string[] {
  const lines = raw.split('\n');
  return lines.flatMap((line, index) => {
    const match = EXPORTED_FUNCTION.exec(line);
    const name = match?.[1] ?? match?.[2];
    if (name === undefined) return [];
    const length = lines.slice(index + 1).findIndex((bodyLine) => bodyLine.startsWith('}'));
    const body = lines.slice(index + 1, length === -1 ? undefined : index + 1 + length);
    return body.some((bodyLine) => ATTENDED_GUARD.test(bodyLine)) ? [name] : [];
  });
}

/**
 * The attended-only commands each `server.registerTool(...)` call references
 * when its handler argument is not itself a `requireApproval(...)` call. A
 * gate nested deeper, or mentioned only in a comment, does not count.
 */
function ungatedToolCommands(toolsSource: string, attendedOnly: string[]): string[] {
  const file = ts.createSourceFile('tools.ts', toolsSource, ts.ScriptTarget.Latest, true);
  const ungated: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'server.registerTool') {
      const handler = node.arguments[2];
      const gated =
        handler !== undefined && ts.isCallExpression(handler) && handler.expression.getText(file) === 'requireApproval';
      if (!gated) {
        const words = new Set(node.getText(file).match(/\w+/g));
        ungated.push(...attendedOnly.filter((name) => words.has(name)));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return ungated;
}

const ATTENDED_ONLY = ['core/src/commands', 'core/src/core']
  .flatMap(sourceFiles)
  .flatMap(({ raw }) => attendedOnlyFunctions(raw));
const MCP_EXEMPT_NAMES = new Set(Object.keys(MCP_APPROVAL_EXEMPT));
const UNGATED_TOOL_COMMANDS = ungatedToolCommands(
  fs.readFileSync(path.join(PACKAGES_DIR, 'mcp-server/src/tools.ts'), 'utf8'),
  ATTENDED_ONLY,
);

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

  it('every GitHub write calls assertAttended first or is allowlisted with its exact count', () => {
    expect(
      allowlistViolations(UNGUARDED, ALLOWED),
      'GitHub write without assertAttended() as a direct statement of the top-level function before it, ' +
        'or an ALLOWED entry whose count no longer matches the file. ' +
        'The guard must be in the function that contains the call, not in its caller. ' +
        'Add the guard; or, when the call may run unattended, add or update the ALLOWED entry with its count and the reason; ' +
        'remove an entry that matches nothing. If this call only reads, add its verb to READ_CALL.',
    ).toEqual([]);
  });

  it('fails an allowlisted call that appears more or fewer times than allowed', () => {
    const write = 'await client.gists.update({});';
    const allowed = { 'x.ts gists.update': { count: 1 } };
    const findings = (calls: number) => scanSource('x.ts', inFunction(Array(calls).fill(write).join('\n')));
    expect(allowlistViolations(findings(1), allowed)).toEqual([]);
    expect(allowlistViolations(findings(2), allowed)).toEqual(['x.ts gists.update: 2 unguarded, 1 allowed (lines 2, 3)']);
    expect(allowlistViolations(findings(0), allowed)).toEqual(['x.ts gists.update: 0 unguarded, 1 allowed']);
    expect(allowlistViolations(findings(1), {})).toEqual(['x.ts gists.update: 1 unguarded, 0 allowed (lines 2)']);
  });

  describe('MCP approval gate (#1936)', () => {
    it('finds the commands that refuse unattended', () => {
      expect(ATTENDED_ONLY).toEqual(
        expect.arrayContaining(['runPost', 'runClaim', 'runGuidelinesStore', 'runGuidelinesReset', 'runCleanup']),
      );
    });

    it.each([
      ['an async function', "export async function runX() {\n  assertAttended('x');\n}\n"],
      ['an arrow function', "export const runX = async (a: A): Promise<void> => {\n  assertAttended('x');\n};\n"],
      ['a plain arrow function', "export const runX = (a: A) => {\n  assertAttended('x');\n};\n"],
      ['a function expression', "export const runX = function () {\n  assertAttended('x');\n};\n"],
      ['a conditional guard', "export function runX(o: O) {\n  if (o.apply) assertAttended('x');\n}\n"],
    ])('finds the guard in %s', (_label, source) => {
      expect(attendedOnlyFunctions(source)).toEqual(['runX']);
    });

    it.each([
      ['nested deeper', "export function runX() {\n  if (a) {\n    assertAttended('x');\n  }\n}\n"],
      ['in the next function', "export function runX() {\n  go();\n}\nfunction y() {\n  assertAttended('x');\n}\n"],
      ['in a non-function export', "export const runX = {\n  assertAttended('x');\n};\n"],
    ])('does not count a guard %s', (_label, source) => {
      expect(attendedOnlyFunctions(source)).toEqual([]);
    });

    it('every MCP tool that reaches one asks the user through requireApproval or is exempt', () => {
      const violations = UNGATED_TOOL_COMMANDS.filter((name) => !MCP_EXEMPT_NAMES.has(name));
      expect(
        violations,
        'An MCP tool calls a command that refuses unattended, without requireApproval(...) in its registerTool call. ' +
          'Wrap the handler (see the post tool), or add the command to MCP_APPROVAL_EXEMPT with the reason.',
      ).toEqual([]);
    });

    it('has no stale exemptions', () => {
      const stale = [...MCP_EXEMPT_NAMES].filter((name) => !UNGATED_TOOL_COMMANDS.includes(name));
      expect(stale, 'MCP_APPROVAL_EXEMPT entry no longer matches an ungated tool; remove it.').toEqual([]);
    });

    it('flags a tool registered without the gate and accepts one with it', () => {
      const bare = "server.registerTool('merge', {}, wrapTool(runMerge));";
      const gated = "server.registerTool('merge', {}, requireApproval(server, 'merge', preview, wrapTool(runMerge)));";
      const source = "export async function runMerge() {\n  assertAttended('merge');\n  await x();\n}\n";
      expect(attendedOnlyFunctions(source)).toEqual(['runMerge']);
      expect(ungatedToolCommands(bare, ['runMerge'])).toEqual(['runMerge']);
      expect(ungatedToolCommands(gated, ['runMerge'])).toEqual([]);
    });

    it.each([
      ['named only in a comment', "server.registerTool('merge', {}, /* requireApproval( */ wrapTool(runMerge));"],
      [
        'wrapped inside another call',
        "server.registerTool('merge', {}, wrapTool(requireApproval(server, 'merge', p, runMerge)));",
      ],
      [
        'in the options instead of the handler',
        "server.registerTool('merge', { x: requireApproval(a) }, wrapTool(runMerge));",
      ],
    ])('does not count the gate %s', (_label, source) => {
      expect(ungatedToolCommands(source, ['runMerge'])).toEqual(['runMerge']);
    });
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
      ["await fetch('https://api.github.com/user/starred/a/b', { method: 'PUT' });", 'x.ts fetch PUT'],
      ["const res = await fetch(`${api}/repos/${repo}/issues`, {\n  method: 'post',\n  body,\n});", 'x.ts fetch POST'],
      ['await client.activity.starRepoForAuthenticatedUser({ owner, repo });', 'x.ts activity.starRepoForAuthenticatedUser'],
      ['await client.repos.transfer({ owner, repo, new_owner });', 'x.ts repos.transfer'],
      ['await client.repos.renameBranch({ owner, repo, branch, new_name });', 'x.ts repos.renameBranch'],
      ['await client.actions.reRunWorkflow({ owner, repo, run_id });', 'x.ts actions.reRunWorkflow'],
      ['await client.actions.cancelWorkflowRun({ owner, repo, run_id });', 'x.ts actions.cancelWorkflowRun'],
      ['await client.repos.uploadReleaseAsset({ owner, repo, release_id, data });', 'x.ts repos.uploadReleaseAsset'],
      ["git(dir, ['push', 'origin', branch]);", 'x.ts git push'],
      ["execFileSync('gh', ['pr', 'comment', url, '--body', body]);", 'x.ts gh pr comment url --body body'],
    ])('flags an unguarded %s', (body, key) => {
      expect(unguardedCalls(inFunction(body))).toEqual([key]);
    });

    it('keys a method literal outside a fetch call as a request, not a fetch', () => {
      const body = "await fetch(url);\nawait client.request({ method: 'POST', url });";
      expect(unguardedCalls(inFunction(body))).toEqual(['x.ts method POST']);
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
        "await fetch(url, { method: 'GET', signal });",
        "client.activity.startTimer();",
        '// await octokit.pulls.create({ owner, repo });',
      ].join('\n');
      expect(unguardedCalls(inFunction(body))).toEqual([]);
    });
  });
});
