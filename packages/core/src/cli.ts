#!/usr/bin/env node
/**
 * OSS Autopilot CLI
 * Entry point with commander for argument parsing.
 *
 * Command definitions live in cli-registry.ts — each declares its name,
 * localOnly flag (skip GitHub token check), and a register function.
 * Heavy command modules are lazy-loaded via dynamic import() in action
 * handlers so only the invoked command's dependencies are evaluated.
 */

import { Command } from 'commander';
import { getCLIVersion, stateFileExists } from './core/index.js';
import { commands, handleCommandError } from './cli-registry.js';
import { installPreAction } from './cli-pre-action.js';

const VERSION = getCLIVersion();

const program = new Command();

program
  .name('oss-autopilot')
  .description('AI-powered autopilot for managing open source contributions')
  .version(VERSION)
  .option('--debug', 'Enable debug logging');

// Build the local-only set from registry metadata (replaces hardcoded LOCAL_ONLY_COMMANDS).
const localOnlySet = new Set(commands.filter((c) => c.localOnly).map((c) => c.name));

// Register all commands from the registry.
for (const cmd of commands) {
  cmd.register(program);
}

// Debug flag, auth gate and Gist bootstrap (see cli-pre-action.ts).
installPreAction(program, localOnlySet);

// First-run detection: if no subcommand was provided and no state file exists,
// show a quick-start guide and exit before Commander displays generic help.
const userArgs = process.argv.slice(2);
const hasSubcommand = userArgs.some((a) => !a.startsWith('-'));
const hasHelpOrVersion = userArgs.some((a) => a === '--help' || a === '-h' || a === '--version' || a === '-V');

if (!hasSubcommand && !hasHelpOrVersion && !stateFileExists()) {
  console.log(`
OSS Autopilot — AI copilot for open source contributions

Looks like this is your first run! Quick start:
  1. Initialize:   oss-autopilot init <github-username>
  2. Find issues:  oss-autopilot search 10
  3. Daily check:  oss-autopilot daily

Run oss-autopilot --help for all commands.
`);
  process.exit(0);
}

// Parse and execute. parseAsync, not parse: the preAction hook is async, so
// with synchronous parse() a rejected hook promise (corrupt Gist, missing
// gist scope, rate limit during bootstrap — all of which ensureGistPersistence
// now propagates) became an UnhandledPromiseRejection and the user saw a raw
// stack instead of the actionable message (#1386). Command actions already
// route their errors through executeAction/handleCommandError, so this catch
// covers exactly the hook path (plus any handler that escapes the wrapper).
program.parseAsync().catch((err: unknown) => {
  handleCommandError(err, process.argv.includes('--json'));
});
