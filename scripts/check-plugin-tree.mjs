#!/usr/bin/env node
/**
 * Check an assembled plugin tree (scripts/build-directory-branch.sh output)
 * against the prompts it ships (#2050).
 *
 *   node scripts/check-plugin-tree.mjs <tree>
 *
 * 1. Every `${CLAUDE_PLUGIN_ROOT}/<path>` the markdown under agents/,
 *    commands/, workflows/ and skills/ references exists in the tree.
 * 2. The tree's CLI bundle answers `--version` and `--help`, and
 *    `<command> --help` for every distinct top-level command the prompts
 *    invoke (after `cli.bundle.cjs` or the `<prefix>` shorthand). Commander
 *    prints the program help for an unknown command, so the usage line must
 *    name the command itself.
 *
 * packages/core/src/agents-contract.test.ts validates full command paths and
 * flags against the source registry; this checks the shipped bundle.
 * Reads only the tree. The CLI runs with an empty HOME and no GitHub token.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tree = process.argv[2];
if (!tree || !fs.statSync(tree, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('usage: node scripts/check-plugin-tree.mjs <tree>');
  process.exit(2);
}
const root = path.resolve(tree);
const bundle = path.join(root, 'packages/core/dist/cli.bundle.cjs');

const PROMPT_DIRS = ['agents', 'commands', 'workflows', 'skills'];
// Up to whitespace, a quote, a backtick, a closing bracket, a placeholder
// (`<name>`) or a shell line continuation. Trailing prose punctuation is
// trimmed below.
const PLUGIN_PATH = /\$\{?CLAUDE_PLUGIN_ROOT\}?\/([^\s"'`)\]<>\\]+)/g;
// A command name right after the bundle (or `<prefix>`), on the same line or
// after a `\` continuation. Flags and placeholders do not start with `[a-z]`;
// some names are camelCase (`checkSetup`).
const INVOCATION = /(?:cli\.bundle\.cjs["']?|<prefix>)(?:[ \t]+|[ \t]*\\\n[ \t]*)+([a-z][a-zA-Z0-9-]*)/g;

function markdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.md'))
    .map((rel) => path.join(dir, rel));
}

const files = PROMPT_DIRS.flatMap((dir) => markdownFiles(path.join(root, dir)));
if (files.length === 0) {
  console.error(`::error::No prompt markdown under ${root}`);
  process.exit(1);
}

const problems = [];
const paths = new Map(); // relative path -> first referencing file
const commands = new Map(); // command -> first referencing file
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const where = path.relative(root, file);
  for (const match of text.matchAll(PLUGIN_PATH)) {
    const rel = match[1].replace(/[.,:;]+$/, '');
    if (rel && !paths.has(rel)) paths.set(rel, where);
  }
  for (const match of text.matchAll(INVOCATION)) {
    if (!commands.has(match[1])) commands.set(match[1], where);
  }
}

for (const [rel, where] of paths) {
  if (!fs.existsSync(path.join(root, rel))) problems.push(`${where}: \${CLAUDE_PLUGIN_ROOT}/${rel} is not in the tree`);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plugin-tree-home-'));
const env = { ...process.env, HOME: home };
delete env.GITHUB_TOKEN;
delete env.GH_TOKEN;

function runCli(args) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [bundle, ...args], { env, encoding: 'utf8', timeout: 30_000 }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || String(err.message) };
  }
}

try {
  if (!fs.existsSync(bundle)) {
    problems.push(`${path.relative(root, bundle)} is not in the tree`);
  } else {
    const version = runCli(['--version']);
    if (!version.ok || !/^\d+\.\d+\.\d+\S*$/.test(version.out.trim())) {
      problems.push(`cli.bundle.cjs --version failed or printed no version: ${version.out}`);
    }
    if (!runCli(['--help']).ok) problems.push('cli.bundle.cjs --help failed');
    if (commands.size === 0) problems.push('found no CLI invocations in the prompts');
    for (const [command, where] of commands) {
      const help = runCli([command, '--help']);
      const usage = help.out.match(/^Usage: \S+ (\S+)/m);
      if (!help.ok || !usage || !usage[1].split('|').includes(command)) {
        problems.push(`${where}: cli.bundle.cjs ${command} --help does not describe a ${command} command`);
      }
    }
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(
  `Plugin tree ${root}: ${paths.size} \${CLAUDE_PLUGIN_ROOT} paths present, ${commands.size} CLI commands answer --help`,
);
