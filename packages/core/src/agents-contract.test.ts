/**
 * CI gate: every MCP tool name and CLI invocation referenced in the plugin's
 * prompt markdown must exist in the registry (#1245, #1376).
 *
 * The pr-compliance-checker agent shipped two consecutive bugs where its
 * frontmatter referenced `mcp__plugin_oss-autopilot_oss-autopilot__read`
 * (a tool that has never existed) and its prompt body invoked
 * `cli.bundle.cjs read <pr-url>` (a command that has never existed).
 * Later, #1376 found six more references that error as written
 * (`guidelines list`, `config --set`, `--show-bots`, …) because the original
 * test only validated the FIRST token after `cli.bundle.cjs` and only
 * scanned `agents/*.md`. This test now:
 *
 *   - Scans `agents/*.md`, `commands/*.md`, `skills/` (recursively), and
 *     `workflows/*.md` (excluding README.md files).
 *   - Asserts frontmatter/prose MCP tool names
 *     (`mcp__plugin_oss-autopilot_oss-autopilot__<name>`) against the live
 *     MCP tool list.
 *   - Builds the REAL Commander program from `cli-registry.ts` (the same
 *     register() loop `cli.ts` runs), walks it recursively, and validates
 *     every `cli.bundle.cjs …` invocation found in fenced code blocks and
 *     inline code spans: the command + subcommand path must resolve, and
 *     every `--flag` must be a registered option of that command.
 *     Positional arguments are NOT validated (placeholders like `<repo>`,
 *     `{path}`, `$VAR`, and free-form values make counts too brittle).
 *
 * `<prefix>` is treated as an invocation marker too: `workflows/reference.md`
 * defines it as shorthand for the full `node ".../cli.bundle.cjs"` prefix and
 * uses it throughout its command listings.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, type Option } from 'commander';
import { commands } from './cli-registry.js';
import { parseRegisteredTools } from './test-lib/registered-mcp-tools.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Directories whose top-level *.md files carry CLI/MCP references. */
const FLAT_PROMPT_DIRS = ['agents', 'commands', 'workflows'];
/** Directory scanned recursively (skills/<name>/SKILL.md + supporting md). */
const SKILLS_DIR = 'skills';

const MCP_TOOL_PATTERN = /mcp__plugin_oss-autopilot_oss-autopilot__([a-z][a-z0-9-]*)/g;

/**
 * Mirror of `EXPECTED_TOOLS` in
 * `packages/mcp-server/src/tools.test.ts`. Duplicated here (rather than
 * imported) so this test stays inside `@oss-autopilot/core` and does
 * not introduce a cross-package import that breaks the workspace's
 * module-resolution graph.
 */
const REGISTERED_MCP_TOOLS = new Set([
  'daily',
  'status',
  'search',
  'features',
  'vet',
  'vet-list',
  'verify-issue',
  'track',
  'compliance-score',
  'repo-vet',
  'strategy',
  'comments',
  'post',
  'claim',
  'config',
  'init',
  'setup',
  'check-setup',
  'startup',
  'shelve',
  'unshelve',
  'dismiss',
  'undismiss',
  'move',
  'state-show',
  'state-sync',
  'state-unlink',
  'guidelines-list',
  'guidelines-get',
  'guidelines-store',
  'guidelines-reset',
  'guidelines-fetch-corpus',
]);

// Shared with docs-contract.test.ts via test-lib so the two parsers cannot
// drift apart (#1374 mirror-drift class).

// ── Markdown corpus ──────────────────────────────────────────────────────

function listMarkdownFiles(): string[] {
  const files: string[] = [];
  for (const dir of FLAT_PROMPT_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.md') && name !== 'README.md') files.push(path.join(abs, name));
    }
  }
  const skillsAbs = path.join(REPO_ROOT, SKILLS_DIR);
  if (fs.existsSync(skillsAbs)) {
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md') && entry.name !== 'README.md') files.push(full);
      }
    };
    walk(skillsAbs);
  }
  return files;
}

// ── Commander program introspection ──────────────────────────────────────

interface CommandInfo {
  /** Full command path, e.g. "guidelines view". */
  path: string;
  /** Known option flags (long and short) for this command. */
  flags: Set<string>;
  subcommands: Map<string, CommandInfo>;
  /** True when this command is a pure subcommand group (e.g. `guidelines`,
   * `dashboard`): it has subcommands and declares no positionals of its own,
   * so a following word token MUST be one of its subcommands. */
  isGroup: boolean;
}

/** Flags valid on every command: program-level options + commander built-ins. */
const GLOBAL_FLAGS = new Set(['--debug', '--help', '-h', '--version', '-V']);

/**
 * Build the real CLI program exactly like `cli.ts` does (registry register()
 * loop). Action handlers lazy-import their modules, so registration alone is
 * side-effect free.
 */
function buildProgram(): Command {
  const program = new Command();
  program.name('oss-autopilot').description('test introspection instance').option('--debug', 'Enable debug logging');
  for (const def of commands) def.register(program);
  return program;
}

function describeCommand(cmd: Command, parentPath: string): CommandInfo {
  const cmdPath = parentPath ? `${parentPath} ${cmd.name()}` : cmd.name();
  const flags = new Set<string>(GLOBAL_FLAGS);
  for (const opt of cmd.options as readonly Option[]) {
    if (opt.long) flags.add(opt.long);
    if (opt.short) flags.add(opt.short);
  }
  const subcommands = new Map<string, CommandInfo>();
  for (const sub of cmd.commands as readonly Command[]) {
    const info = describeCommand(sub, cmdPath);
    subcommands.set(sub.name(), info);
    for (const alias of sub.aliases()) subcommands.set(alias, info);
  }
  return {
    path: cmdPath,
    flags,
    subcommands,
    isGroup: subcommands.size > 0 && cmd.registeredArguments.length === 0,
  };
}

/** Top-level command name → info (aliases included as extra keys). */
function buildCommandMap(): Map<string, CommandInfo> {
  const program = buildProgram();
  const map = new Map<string, CommandInfo>();
  for (const cmd of program.commands as readonly Command[]) {
    const info = describeCommand(cmd, '');
    map.set(cmd.name(), info);
    for (const alias of cmd.aliases()) map.set(alias, info);
  }
  return map;
}

// ── Invocation extraction ────────────────────────────────────────────────

interface CliInvocation {
  file: string;
  lineNo: number;
  raw: string;
  argv: string[];
}

const FENCE = /^\s*(?:```|~~~)/;
/** Inline code span (backtick-delimited, may wrap across lines in prose). */
const INLINE_SPAN = /`([^`]+)`/g;
const MARKER = 'cli.bundle.cjs';

function isInvocationMarker(token: string): boolean {
  return token.includes(MARKER) || token === '<prefix>';
}

/**
 * Extract the argv tokens following the cli.bundle.cjs / <prefix> marker.
 * Returns null when the text has no marker or nothing follows it (bare
 * mentions of the bundle path).
 */
function parseArgv(text: string): string[] | null {
  const tokens = text.split(/\s+/).filter(Boolean);
  const idx = tokens.findIndex(isInvocationMarker);
  if (idx === -1) return null;
  const argv: string[] = [];
  let substitutionDepth = 0; // inside `$( … )` used as an argument value
  for (let i = idx + 1; i < tokens.length; i++) {
    let t = tokens[i];
    if (t === '\\') continue; // shell line continuation
    // Tokens inside a `$( … )` command substitution belong to ANOTHER binary
    // (e.g. `init "$(gh api user --jq '.login')"`) — skip them entirely.
    const opens = t.split('$(').length - 1;
    const closes = t.split(')').length - 1;
    if (substitutionDepth > 0 || opens > 0) {
      substitutionDepth = Math.max(0, substitutionDepth + opens - closes);
      continue;
    }
    if (t === '|' || t === '||' || t === '&&' || t === ';' || t === ')') break; // pipeline / compound boundary
    if (t.startsWith('#')) break; // trailing shell comment
    if (/^\d*>>?/.test(t)) continue; // redirects: >out, 2>/dev/null, &>>…
    // Strip optional-syntax brackets, quotes, and trailing prose punctuation:
    // `[--scan]` → `--scan`, `"{path}"` → `{path}`, `--json)` → `--json`.
    t = t.replace(/^[[("'`]+/, '').replace(/[\])"'`,.;:]+$/, '');
    if (!t) continue;
    argv.push(t);
  }
  return argv.length > 0 ? argv : null;
}

/**
 * Collect every cli.bundle.cjs / <prefix> invocation in a markdown file:
 * fenced code block lines (with `\` continuations joined) plus inline code
 * spans in the surrounding prose.
 */
function extractInvocations(file: string): CliInvocation[] {
  const content = fs.readFileSync(file, 'utf8');
  const rel = path.relative(REPO_ROOT, file);
  const lines = content.split('\n');
  const invocations: CliInvocation[] = [];
  const proseLines: string[] = []; // fenced lines blanked, for inline-span scanning

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      proseLines.push('');
      continue;
    }
    if (!inFence) {
      proseLines.push(lines[i]);
      continue;
    }
    proseLines.push('');
    if (lines[i].trimStart().startsWith('#')) continue; // full-line shell comment, not an invocation
    if (!lines[i].split(/\s+/).some(isInvocationMarker)) continue;
    // Join shell `\` continuations into one logical line.
    let logical = lines[i];
    let j = i;
    while (logical.trimEnd().endsWith('\\') && j + 1 < lines.length && !FENCE.test(lines[j + 1])) {
      j++;
      logical = `${logical.trimEnd().replace(/\\$/, '')} ${lines[j].trim()}`;
    }
    const argv = parseArgv(logical);
    if (argv) invocations.push({ file: rel, lineNo: i + 1, raw: lines[i].trim(), argv });
    i = j;
  }

  // Inline code spans (single-backtick, may wrap lines) in prose.
  const prose = proseLines.join('\n');
  for (const match of prose.matchAll(INLINE_SPAN)) {
    const span = match[1];
    if (!span.includes(MARKER)) continue;
    const argv = parseArgv(span.replace(/\s+/g, ' ').trim());
    if (!argv) continue;
    const lineNo = prose.slice(0, match.index).split('\n').length;
    invocations.push({ file: rel, lineNo, raw: span.replace(/\s+/g, ' ').trim(), argv });
  }

  return invocations;
}

// ── Invocation validation ────────────────────────────────────────────────

function isFlag(token: string): boolean {
  return token.startsWith('-') && token !== '-' && token !== '--';
}

/** Placeholder tokens (`<repo>`, `{path}`, `$VAR`) — never validated. */
function isPlaceholder(token: string): boolean {
  return token.startsWith('<') || token.startsWith('{') || token.startsWith('$');
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[i - 1], dp[i]) + 1;
      prev = tmp;
    }
  }
  return dp[a.length];
}

function nearest(input: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDist = 4; // only suggest close matches
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function formatOffender(inv: CliInvocation, problem: string): string {
  return `${inv.file}:${inv.lineNo}: ${problem}\n      ${inv.raw}`;
}

/**
 * Validate one invocation against the introspected program: resolve the
 * command + subcommand path, then check every `--flag` token against that
 * command's registered options. Positionals are intentionally not validated.
 */
function validateInvocation(inv: CliInvocation, topLevel: Map<string, CommandInfo>): string[] {
  const { argv } = inv;
  let i = 0;
  // Allow global flags before the command name (e.g. `--debug daily`).
  while (i < argv.length && isFlag(argv[i]) && GLOBAL_FLAGS.has(argv[i].split('=')[0])) i++;
  if (i >= argv.length) return [];
  if (isPlaceholder(argv[i])) return []; // `<prefix> <command> …` — unresolvable, skip
  const top = argv[i];
  let cur = topLevel.get(top);
  if (!cur) {
    const hint = nearest(top, topLevel.keys());
    return [formatOffender(inv, `unknown command '${top}'${hint ? ` (did you mean '${hint}'?)` : ''}`)];
  }
  i++;
  // Descend through subcommands while the immediately following word matches.
  while (i < argv.length && cur.subcommands.size > 0) {
    const t = argv[i];
    if (isFlag(t) || t === '--') break;
    if (isPlaceholder(t)) return []; // placeholder subcommand — can't resolve the leaf, skip
    const sub = cur.subcommands.get(t);
    if (sub) {
      cur = sub;
      i++;
      continue;
    }
    if (cur.isGroup) {
      const hint = nearest(t, cur.subcommands.keys());
      return [
        formatOffender(
          inv,
          `unknown subcommand '${cur.path} ${t}'${hint ? ` (did you mean '${cur.path} ${hint}'?)` : ''} — ` +
            `registered: ${[...cur.subcommands.keys()].join(', ')}`,
        ),
      ];
    }
    break; // command takes positionals; the word is a positional, not a subcommand
  }
  // Flag validation over the whole remaining invocation.
  const errors: string[] = [];
  for (let k = i; k < argv.length; k++) {
    const t = argv[k];
    if (t === '--') break; // end-of-options marker: everything after is positional
    if (!isFlag(t)) continue;
    const flag = t.split('=')[0];
    if (cur.flags.has(flag)) continue;
    const hint = nearest(flag, cur.flags);
    errors.push(
      formatOffender(inv, `unknown flag '${flag}' for '${cur.path}'${hint ? ` (did you mean '${hint}'?)` : ''}`),
    );
  }
  return errors;
}

// ── Agent frontmatter tool grants ────────────────────────────────────────

interface AgentDoc {
  /** Path relative to the repo root. */
  file: string;
  /** Parsed frontmatter `tools:` allowlist; null when the agent declares no
   * `tools:` key (unrestricted — every tool is implicitly granted). */
  tools: Set<string> | null;
  /** Markdown body (everything after the closing frontmatter fence). */
  body: string;
}

function listAgentFiles(): string[] {
  const abs = path.join(REPO_ROOT, 'agents');
  return fs
    .readdirSync(abs)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => path.join(abs, name));
}

function parseAgentDoc(file: string): AgentDoc {
  const rel = path.relative(REPO_ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines[0] !== '---') throw new Error(`${rel}: expected frontmatter to open on line 1`);
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new Error(`${rel}: unterminated frontmatter`);
  const toolsLine = lines.slice(1, end).find((l) => l.startsWith('tools:'));
  let tools: Set<string> | null = null;
  if (toolsLine) {
    // Every agent declares tools as an inline JSON-style array of strings.
    const parsed: unknown = JSON.parse(toolsLine.slice('tools:'.length).trim());
    if (!Array.isArray(parsed) || !parsed.every((t): t is string => typeof t === 'string')) {
      throw new Error(`${rel}: \`tools:\` frontmatter is not an array of strings`);
    }
    tools = new Set(parsed);
  }
  return { file: rel, tools, body: lines.slice(end + 1).join('\n') };
}

/**
 * Built-in (non-MCP) tools detectable in agent bodies with near-zero
 * false-positive risk (#1377):
 *
 *   - `AskUserQuestion` is a globally unique tool name; a word-boundary match
 *     is always an instruction to use the tool.
 *   - The phrase "Task tool" (name optionally backticked) only appears when
 *     instructing sub-agent dispatch. Note: Claude Code subagents cannot nest
 *     Task dispatch, so the usual fix is rewriting the instruction, not
 *     granting the tool.
 *   - `Edit` / `Write` are matched ONLY backtick-delimited; the bare words are
 *     everyday English in review/drafting prose ("write a comment").
 *
 * If a pattern proves noisy on a future corpus, narrow the pattern — do not
 * add a per-agent allowlist.
 */
const BUILTIN_TOOL_PATTERNS: ReadonlyArray<{ tool: string; pattern: RegExp }> = [
  { tool: 'AskUserQuestion', pattern: /\bAskUserQuestion\b/ },
  { tool: 'Task', pattern: /(?:`Task`|\bTask) tool\b/ },
  { tool: 'Edit', pattern: /`Edit`/ },
  { tool: 'Write', pattern: /`Write`/ },
];

// ── Tests ────────────────────────────────────────────────────────────────

describe('REGISTERED_MCP_TOOLS mirror ↔ tools.ts source parity (#1374)', () => {
  it('the mirror set matches the registerTool() calls in packages/mcp-server/src/tools.ts', () => {
    // The mirror went stale once already: `features` was registered in
    // tools.ts but missing here, so any agent referencing it would have
    // false-failed the parity tests below. Parse the registrations out of
    // the source file (a file read, not a cross-package import) so drift
    // in either direction fails CI.
    const registered = parseRegisteredTools().toSorted();
    expect(registered.length).toBeGreaterThan(0);
    expect([...REGISTERED_MCP_TOOLS].toSorted()).toEqual(registered);
  });
});

describe('prompt markdown ↔ MCP tool registry parity (#1245)', () => {
  it('every referenced MCP tool name exists in the registry', () => {
    const offenders: string[] = [];
    for (const file of listMarkdownFiles()) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(REPO_ROOT, file);
      for (const match of content.matchAll(MCP_TOOL_PATTERN)) {
        if (!REGISTERED_MCP_TOOLS.has(match[1])) {
          offenders.push(`${rel} → mcp__plugin_oss-autopilot_oss-autopilot__${match[1]}`);
        }
      }
    }
    expect(
      offenders,
      `Prompt files reference unregistered MCP tools — register them in ` +
        `packages/mcp-server/src/tools.ts or fix the markdown:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});

describe('prompt markdown ↔ CLI registry parity (#1245, #1376)', () => {
  it('every cli.bundle.cjs invocation resolves to a registered command path with registered flags', () => {
    const topLevel = buildCommandMap();
    // Sanity: introspection actually saw the registry (guards against a
    // commander API change silently emptying the map and passing vacuously).
    expect(topLevel.size).toBeGreaterThan(20);
    expect(topLevel.get('guidelines')?.subcommands.has('view')).toBe(true);
    expect(topLevel.get('dashboard')?.subcommands.get('serve')?.flags.has('--no-open')).toBe(true);

    const files = listMarkdownFiles();
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    let invocationCount = 0;
    for (const file of files) {
      for (const inv of extractInvocations(file)) {
        invocationCount++;
        offenders.push(...validateInvocation(inv, topLevel));
      }
    }
    // Sanity: the extractor found the corpus (agents + commands + workflows
    // all carry invocations today; 0 would mean the parser broke).
    expect(invocationCount).toBeGreaterThan(60);

    expect(
      offenders,
      `Prompt files invoke unregistered CLI commands/subcommands/flags — fix the ` +
        `markdown or register them in packages/core/src/cli-registry.ts:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});

describe('agent body tool references ↔ frontmatter tool grants (#1377)', () => {
  const agents = listAgentFiles().map(parseAgentDoc);

  it('sanity: the agent corpus parsed and carries restricted tool lists', () => {
    expect(agents.length).toBeGreaterThan(5);
    // Agents without a `tools:` key are unrestricted and skipped below by
    // design; today every agent restricts its toolset, so a count of 0 here
    // would mean the frontmatter parser broke.
    expect(agents.filter((a) => a.tools !== null).length).toBeGreaterThan(5);
  });

  it('every MCP tool referenced in an agent body is granted in that agent frontmatter', () => {
    const offenders: string[] = [];
    for (const agent of agents) {
      if (!agent.tools) continue; // unrestricted: everything is granted
      const referenced = new Set([...agent.body.matchAll(MCP_TOOL_PATTERN)].map((m) => m[0]));
      for (const tool of referenced) {
        if (!agent.tools.has(tool)) {
          offenders.push(`${agent.file} → body references ${tool} but frontmatter \`tools:\` does not grant it`);
        }
      }
    }
    expect(
      offenders,
      `Agent bodies instruct workflows with MCP tools their frontmatter never grants — ` +
        `the instruction silently cannot execute. Add the tool to the agent's \`tools:\` ` +
        `list or rewrite the instruction:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('every built-in tool an agent body instructs with is granted in that agent frontmatter', () => {
    const offenders: string[] = [];
    for (const agent of agents) {
      if (!agent.tools) continue; // unrestricted: everything is granted
      for (const { tool, pattern } of BUILTIN_TOOL_PATTERNS) {
        if (pattern.test(agent.body) && !agent.tools.has(tool)) {
          offenders.push(
            `${agent.file} → body instructs with ${tool} (matched ${String(pattern)}) ` +
              `but frontmatter \`tools:\` does not grant it`,
          );
        }
      }
    }
    expect(
      offenders,
      `Agent bodies instruct workflows with built-in tools their frontmatter never grants — ` +
        `grant the tool or rewrite the instruction (for Task: subagents cannot nest Task ` +
        `dispatch, so rewrite to sequential processing instead of granting):\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});

// ── agents/README.md ↔ frontmatter parity (#1419) ─────────────────────────
//
// The README's allowlist bullets and model-tier table are hand-maintained
// prose duplicating each agent's frontmatter. They drifted (issue-scout's
// row omitted verify-issue; repo-evaluator's tier row said haiku while the
// frontmatter says sonnet) because nothing gated README files. This gate
// parses both surfaces and pins set equality.

const MCP_TOOL_PREFIX = 'mcp__plugin_oss-autopilot_oss-autopilot__';

function parseAgentFrontmatterField(file: string, field: string): string | null {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  const line = lines.slice(1, end).find((l) => l.startsWith(`${field}:`));
  return line ? line.slice(field.length + 1).trim() : null;
}

describe('agents/README.md ↔ agent frontmatter parity (#1419)', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'README.md'), 'utf8');
  const agents = listAgentFiles().map((file) => ({
    name: path.basename(file, '.md'),
    file,
    doc: parseAgentDoc(file),
  }));

  it('every allowlist bullet matches the agent frontmatter tools exactly', () => {
    const offenders: string[] = [];
    for (const agent of agents) {
      if (!agent.doc.tools) continue;
      // The bullet form is: - `name` — `Tool`, `Tool`, `mcp__...__x`, ... (prose)
      const bullet = readme.split('\n').find((line) => line.startsWith(`- \`${agent.name}\``));
      if (!bullet) {
        offenders.push(`${agent.name}: no allowlist bullet in agents/README.md`);
        continue;
      }
      const listed = new Set(
        [...bullet.matchAll(/`([^`]+)`/g)]
          .map((m) => m[1])
          .filter((token) => token !== agent.name && !token.includes(' '))
          // README rows abbreviate the MCP prefix as `mcp__...__x`.
          .map((token) => token.replace(/^mcp__\.\.\.__/u, MCP_TOOL_PREFIX))
          // Drop tokens that are prose snippets, not tool names: a CLI
          // example like `config --json` fails the space check above, and
          // hyphenated prose like `draft-review-post` fails the
          // letters-and-underscores regex below.
          .filter((token) => /^[A-Za-z_]+$/u.test(token.replace(MCP_TOOL_PREFIX, '')) || token.startsWith('mcp__')),
      );
      const granted = agent.doc.tools;
      const missing = [...granted].filter((t) => !listed.has(t));
      const extra = [...listed].filter((t) => !granted.has(t) && (t.startsWith('mcp__') || /^[A-Z]/.test(t)));
      if (missing.length > 0 || extra.length > 0) {
        offenders.push(
          `${agent.name}: README bullet drifted from frontmatter` +
            (missing.length > 0 ? ` — missing ${missing.join(', ')}` : '') +
            (extra.length > 0 ? ` — lists ungranted ${extra.join(', ')}` : ''),
        );
      }
    }
    expect(
      offenders,
      `agents/README.md allowlist bullets drifted from frontmatter \`tools:\` — update the README row:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('every model-tier table row matches the agent frontmatter model', () => {
    const offenders: string[] = [];
    for (const agent of agents) {
      const model = parseAgentFrontmatterField(agent.file, 'model');
      if (!model) continue;
      const row = readme.split('\n').find((line) => line.startsWith(`| \`${agent.name}\` |`));
      if (!row) {
        offenders.push(`${agent.name}: no model-tier table row in agents/README.md`);
        continue;
      }
      const cell = row.split('|')[2]?.trim().replace(/`/g, '');
      if (cell !== model) {
        offenders.push(`${agent.name}: README tier table says "${cell}" but frontmatter model is "${model}"`);
      }
    }
    expect(
      offenders,
      `agents/README.md model-tier table drifted from frontmatter \`model:\` — update the table row:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});
