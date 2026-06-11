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
 *     `agents-contract.test.ts`).
 *   - ARCHITECTURE's command table must have a row for every
 *     `commands/*.md` file, and reference no file that does not exist.
 *
 * Parsers are tolerant of formatting (whitespace, surrounding prose) but
 * strict on content (exact name sets, exact counts).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseRegisteredTools } from './test-lib/registered-mcp-tools.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const README = path.join(REPO_ROOT, 'README.md');
const ARCHITECTURE = path.join(REPO_ROOT, 'ARCHITECTURE.md');
const COMMANDS_DIR = path.join(REPO_ROOT, 'commands');

/** Slash-command files shipped by the plugin (the source of truth). */
function listCommandNames(): string[] {
  return fs
    .readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
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
