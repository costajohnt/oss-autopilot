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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROMPT_DIRS = ['agents', 'commands', 'workflows', 'skills'];
// Up to whitespace, a quote, a backtick, a closing bracket, a placeholder
// (`<name>`) or a shell line continuation.
const PLUGIN_PATH = /\$\{?CLAUDE_PLUGIN_ROOT\}?\/([^\s"'`)\]<>\\]+)/g;
// A command name right after the bundle (or `<prefix>`). Shell `\`
// continuations are joined first. Flags and placeholders do not start with
// `[a-z]`; some names are camelCase (`checkSetup`).
const INVOCATION = /(?:cli\.bundle\.cjs["']?|<prefix>)[\t ]+([a-z][\dA-Za-z-]*)/g;
const TRAILING_PUNCTUATION = new Set(['.', ',', ':', ';']);

function markdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.md'))
    .map((rel) => path.join(dir, rel));
}

function trimPunctuation(text) {
  let end = text.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(text[end - 1])) end--;
  return text.slice(0, end);
}

/** First referencing file for each plugin path and each CLI command. */
function collectReferences(root, files) {
  const paths = new Map();
  const commands = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8').replaceAll('\\\n', ' ');
    const where = path.relative(root, file);
    for (const match of text.matchAll(PLUGIN_PATH)) {
      const rel = trimPunctuation(match[1]);
      if (rel && !paths.has(rel)) paths.set(rel, where);
    }
    for (const match of text.matchAll(INVOCATION)) {
      if (!commands.has(match[1])) commands.set(match[1], where);
    }
  }
  return { paths, commands };
}

function makeRunner(bundle, home) {
  const env = { ...process.env, HOME: home };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  return (args) => {
    try {
      return { ok: true, out: execFileSync(process.execPath, [bundle, ...args], { env, encoding: 'utf8', timeout: 30_000 }) };
    } catch (error) {
      return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || String(error.message) };
    }
  };
}

function namesCommand(helpText, command) {
  const usage = /^Usage: \S+ (\S+)/m.exec(helpText);
  return Boolean(usage) && usage[1].split('|').includes(command);
}

function checkBundle(runCli, commands) {
  const problems = [];
  const version = runCli(['--version']);
  if (!version.ok || !/^\d+\.\d+\.\d+/.test(version.out.trim())) {
    problems.push(`cli.bundle.cjs --version failed or printed no version: ${version.out}`);
  }
  if (!runCli(['--help']).ok) problems.push('cli.bundle.cjs --help failed');
  if (commands.size === 0) problems.push('found no CLI invocations in the prompts');
  for (const [command, where] of commands) {
    const help = runCli([command, '--help']);
    if (!help.ok || !namesCommand(help.out, command)) {
      problems.push(`${where}: cli.bundle.cjs ${command} --help does not describe a ${command} command`);
    }
  }
  return problems;
}

function checkTree(root) {
  const files = PROMPT_DIRS.flatMap((dir) => markdownFiles(path.join(root, dir)));
  if (files.length === 0) return { problems: [`No prompt markdown under ${root}`] };
  const { paths, commands } = collectReferences(root, files);
  const problems = [...paths]
    .filter(([rel]) => !fs.existsSync(path.join(root, rel)))
    .map(([rel, where]) => `${where}: \${CLAUDE_PLUGIN_ROOT}/${rel} is not in the tree`);

  const bundle = path.join(root, 'packages/core/dist/cli.bundle.cjs');
  if (fs.existsSync(bundle)) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plugin-tree-home-'));
    try {
      problems.push(...checkBundle(makeRunner(bundle, home), commands));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } else {
    problems.push(`${path.relative(root, bundle)} is not in the tree`);
  }
  return { problems, paths, commands };
}

function main(tree) {
  if (!tree || !fs.statSync(tree, { throwIfNoEntry: false })?.isDirectory()) {
    console.error('usage: node scripts/check-plugin-tree.mjs <tree>');
    return 2;
  }
  const root = path.resolve(tree);
  const { problems, paths, commands } = checkTree(root);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    return 1;
  }
  console.log(
    `Plugin tree ${root}: ${paths.size} \${CLAUDE_PLUGIN_ROOT} paths present, ${commands.size} CLI commands answer --help`,
  );
  return 0;
}

process.exitCode = main(process.argv[2]);
