/**
 * CI gate: the top-level docs (README.md, ARCHITECTURE.md) must not drift
 * from the implementation (#1379).
 *
 * The 2026-06 audit found README claiming 27 MCP tools (actual: 30) and
 * listing 4 slash commands (actual: 8), and ARCHITECTURE's command table
 * missing /plan-ready and /oss-guidelines. These greps are cheap and keep
 * the docs honest:
 *
 *   - README's slash-command list (the `**Commands:**` line) and every
 *     "N slash commands" count must match the files in `commands/`.
 *   - README's "N tools" claims must match the `registerTool()` calls in
 *     `packages/mcp-server/src/tools.ts` (same source-parse approach as
 *     `agents-contract.test.ts`), and so must those in the
 *     `docs/diagrams/*.json` sources and their rendered `*.svg` (#2008, #2052).
 *   - ARCHITECTURE's command table must have a row for every
 *     `commands/*.md` file, and reference no file that does not exist.
 *   - ARCHITECTURE's subcommand table must list every top-level command
 *     registered in `cli-registry.ts` (deprecated ones may be absent) (#2002),
 *     and every subcommand of a command group, naming none that is not
 *     registered (#2052).
 *
 * Parsers are tolerant of formatting (whitespace, surrounding prose) but
 * strict on content (exact name sets, exact counts).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { commands } from './cli-registry.js';
import { parseRegisteredTools } from './test-lib/registered-mcp-tools.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const README = path.join(REPO_ROOT, 'README.md');
const ARCHITECTURE = path.join(REPO_ROOT, 'ARCHITECTURE.md');
const COMMANDS_DIR = path.join(REPO_ROOT, 'commands');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const DIAGRAMS_DIR = path.join(REPO_ROOT, 'docs/diagrams');

/** Slash-command files shipped by the plugin (the source of truth). */
function listCommandNames(): string[] {
  return fs
    .readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => name.replace(/\.md$/, ''))
    .toSorted();
}

/** Agent definition files shipped by the plugin (the source of truth). */
function listAgentNames(): string[] {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''))
    .toSorted();
}

describe('README.md ↔ commands/ parity (#1379)', () => {
  const commandNames = listCommandNames();
  const readme = fs.readFileSync(README, 'utf8');

  it('sanity: the commands directory is non-trivial', () => {
    expect(commandNames.length).toBeGreaterThan(3);
  });

  it('the `**Commands:**` line lists exactly the files in commands/', () => {
    const line = readme.split('\n').find((l) => l.startsWith('**Commands:**'));
    expect(
      line,
      'README.md no longer has a `**Commands:**` line — update this test to parse its replacement',
    ).toBeDefined();
    const listed = [...(line as string).matchAll(/`\/([a-z][\da-z-]*)`/g)].map((m) => m[1]).toSorted();
    expect(listed, 'README `**Commands:**` line drifted from commands/*.md — add/remove the command entries').toEqual(
      commandNames,
    );
  });

  it('every "N slash commands" count in the README matches the number of commands/*.md files', () => {
    const claims = [...readme.matchAll(/(\d+)\s+(?:plugin\s+)?slash commands/gi)].map((m) => Number(m[1]));
    expect(claims.length, 'README no longer claims a slash-command count — update this test').toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim, `README claims ${claim} slash commands but commands/ has ${commandNames.length}`).toBe(
        commandNames.length,
      );
    }
  });
});

describe('README.md / ARCHITECTURE.md ↔ agents/ parity (#1454)', () => {
  const agentNames = listAgentNames();

  it('sanity: the agents directory is non-trivial', () => {
    expect(agentNames.length).toBeGreaterThan(3);
  });

  it('every "N specialized agents" count in README and ARCHITECTURE matches the number of agents/*.md files', () => {
    for (const [label, file] of [
      ['README', README],
      ['ARCHITECTURE', ARCHITECTURE],
    ] as const) {
      const doc = fs.readFileSync(file, 'utf8');
      const claims = [...doc.matchAll(/(\d+)\s+specialized agents/gi)].map((m) => Number(m[1]));
      expect(
        claims.length,
        `${label} no longer claims a specialized-agent count — update this test to parse its replacement`,
      ).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(claim, `${label} claims ${claim} specialized agents but agents/ has ${agentNames.length}`).toBe(
          agentNames.length,
        );
      }
    }
  });
});

describe('README.md ↔ MCP tool registry parity (#1379)', () => {
  it('every "N tools" count in the README matches the registerTool() calls in tools.ts', () => {
    const registered = parseRegisteredTools();
    expect(registered.length).toBeGreaterThan(0);

    const readme = fs.readFileSync(README, 'utf8');
    // Anchor to MCP-context lines only: a future prose edit like "added 5
    // tools this release" must not be scooped into this assertion. Both
    // guarded sites (the architecture-diagram cell and the MCP install
    // section) live on lines that say "MCP" or use box-drawing characters.
    const claims = readme
      .split('\n')
      .filter((line) => /MCP/i.test(line) || /[│┌└]/.test(line))
      .flatMap((line) => [...line.matchAll(/(\d+)\s+tools\b/g)].map((m) => Number(m[1])));
    expect(claims.length, 'README no longer claims an MCP tool count — update this test').toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim, `README claims ${claim} MCP tools but tools.ts registers ${registered.length}`).toBe(
        registered.length,
      );
    }
  });

  it('every "N tools" count in the docs/diagrams/*.json sources and rendered *.svg matches tools.ts (#2008, #2052)', () => {
    const registered = parseRegisteredTools();
    const files = fs.readdirSync(DIAGRAMS_DIR).filter((name) => name.endsWith('.json') || name.endsWith('.svg'));
    // The SVG is regenerated from the JSON manually (export-svg.mjs needs a local
    // archify and Chrome), so the rendered file can lag its source.
    expect(files.some((name) => name.endsWith('.svg'))).toBe(true);
    const claims = files
      .flatMap((name) =>
        Array.from(fs.readFileSync(path.join(DIAGRAMS_DIR, name), 'utf8').matchAll(/\b(\d+) tools\b/g), (m) => ({
          name,
          count: Number(m[1]),
        })),
      );
    expect(claims.length, 'no diagram source claims an MCP tool count — update this test').toBeGreaterThan(0);
    for (const { name, count } of claims) {
      expect(count, `${name} claims ${count} MCP tools but tools.ts registers ${registered.length}`).toBe(
        registered.length,
      );
    }
  });
});

describe('ARCHITECTURE.md command table ↔ commands/ parity (#1379)', () => {
  const commandNames = listCommandNames();

  /** Backticked `*.md` filenames in table rows of the "### Commands" section. */
  function tableCommandNames(): string[] {
    const lines = fs.readFileSync(ARCHITECTURE, 'utf8').split('\n');
    const start = lines.findIndex((l) => /^###\s+Commands\b/.test(l));
    expect(start, 'ARCHITECTURE.md no longer has a "### Commands" section — update this test').toBeGreaterThan(-1);
    const names: string[] = [];
    for (let i = start + 1; i < lines.length && !/^#{1,3}\s/.test(lines[i]); i++) {
      if (!lines[i].trimStart().startsWith('|')) continue;
      for (const m of lines[i].matchAll(/`([a-z][\da-z-]*)\.md`/g)) names.push(m[1]);
    }
    return names.toSorted();
  }

  it('the table has a row for every commands/*.md file and references no nonexistent file', () => {
    const inTable = tableCommandNames();
    const missing = commandNames.filter((n) => !inTable.includes(n));
    const stale = inTable.filter((n) => !commandNames.includes(n));
    expect(missing, `ARCHITECTURE.md command table is missing rows for: ${missing.join(', ')}`).toEqual([]);
    expect(stale, `ARCHITECTURE.md command table references nonexistent command files: ${stale.join(', ')}`).toEqual(
      [],
    );
  });
});

/**
 * First-column cells of the "### Subcommands" table, as lists of backticked
 * names. A cell like `work claim` / `finish` names a group then its
 * subcommands; a cell like `comments` / `post` names top-level commands.
 */
function firstColumnCells(): string[][] {
  const lines = fs.readFileSync(ARCHITECTURE, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^###\s+Subcommands\b/.test(l));
  expect(start, 'ARCHITECTURE.md no longer has a "### Subcommands" section — update this test').toBeGreaterThan(-1);
  const cells: string[][] = [];
  for (let i = start + 1; i < lines.length && !/^#{1,3}\s/.test(lines[i]); i++) {
    const cell = lines[i].trimStart().startsWith('|') ? lines[i].split('|', 2)[1] : '';
    const names = Array.from(cell.matchAll(/`([^`]+)`/g), (m) => m[1]);
    if (names.length > 0) cells.push(names);
  }
  return cells;
}

/**
 * The names the subcommand table documents. Every name in a cell counts,
 * the first included (#2052): `work claim` / `finish` documents `work claim`
 * and `work finish`, and a slash-joined name such as
 * `guidelines list/view` documents each part.
 */
function documentedCommands(): { topLevel: Set<string>; subcommands: Map<string, Set<string>> } {
  const topLevel = new Set<string>();
  const subcommands = new Map<string, Set<string>>();
  for (const [first, ...rest] of firstColumnCells()) {
    const space = first.indexOf(' ');
    if (space === -1) {
      for (const name of [first, ...rest]) topLevel.add(name);
      continue;
    }
    const group = first.slice(0, space);
    topLevel.add(group);
    const subs = subcommands.get(group) ?? new Set<string>();
    for (const name of [first.slice(space + 1), ...rest].flatMap((n) => n.split('/'))) subs.add(name.trim());
    subcommands.set(group, subs);
  }
  return { topLevel, subcommands };
}

describe('ARCHITECTURE.md subcommand table ↔ cli-registry parity (#2002)', () => {
  // Deprecated commands may stay out of the table until they are removed.
  const DEPRECATED = new Set(['orphan-files', 'detect-formatters']);

  const program = new Command();
  for (const def of commands) def.register(program);
  const registered = new Map((program.commands as readonly Command[]).map((c) => [c.name(), c]));

  it('the table lists every registered top-level command and no unregistered one', () => {
    const { topLevel } = documentedCommands();
    const missing = [...registered.keys()].filter((n) => !topLevel.has(n) && !DEPRECATED.has(n));
    const stale = [...topLevel].filter((n) => !registered.has(n));
    expect(missing, `ARCHITECTURE.md subcommand table is missing rows for: ${missing.join(', ')}`).toEqual([]);
    expect(stale, `ARCHITECTURE.md subcommand table names unregistered commands: ${stale.join(', ')}`).toEqual([]);
  });

  it('the table names every registered subcommand of each group and no unregistered one (#2052)', () => {
    const { subcommands } = documentedCommands();
    const missing: string[] = [];
    const stale: string[] = [];
    for (const [group, command] of registered) {
      const subs = (command.commands as readonly Command[]).map((c) => c.name());
      const documented = subcommands.get(group) ?? new Set<string>();
      for (const name of subs) if (!documented.has(name)) missing.push(`${group} ${name}`);
      for (const name of documented) if (!subs.includes(name)) stale.push(`${group} ${name}`);
    }
    expect(missing, `ARCHITECTURE.md subcommand table is missing: ${missing.join(', ')}`).toEqual([]);
    expect(stale, `ARCHITECTURE.md subcommand table names unregistered subcommands: ${stale.join(', ')}`).toEqual([]);
  });

  it('the "N commands that skip" localOnly count matches the registry', () => {
    const m = fs.readFileSync(ARCHITECTURE, 'utf8').match(/\*\* — (\d+) commands that skip/);
    expect(m, 'ARCHITECTURE.md no longer states the localOnly count — update this test').not.toBeNull();
    expect(Number(m?.[1])).toBe(commands.filter((c) => c.localOnly).length);
  });
});
