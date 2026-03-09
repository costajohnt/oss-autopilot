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
import { getGitHubTokenAsync, enableDebug, debug, getCLIVersion, stateFileExists } from './core/index.js';
import { commands } from './cli-registry.js';

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

// Validate GitHub token before running commands that need it
program.hook('preAction', async (thisCommand, actionCommand) => {
  // Enable debug logging if --debug flag is set
  const globalOpts = thisCommand.opts();
  if (globalOpts.debug) {
    enableDebug();
    debug('cli', `Running command: ${actionCommand.name()}`);
  }

  // actionCommand is the command being executed (e.g., 'status', 'daily')
  const commandName = actionCommand.name();

  if (!localOnlySet.has(commandName)) {
    const token = await getGitHubTokenAsync();
    if (!token) {
      console.error('Error: GitHub authentication required.');
      console.error('');
      console.error('Option 1 (Recommended): Install and authenticate GitHub CLI');
      console.error('  Install: https://cli.github.com/');
      console.error('  Then run: gh auth login');
      console.error('');
      console.error('Option 2: Set GITHUB_TOKEN environment variable');
      console.error('  export GITHUB_TOKEN="your-github-token-here"');
      console.error('');
      console.error('Then run your command again.');
      process.exit(1);
    }
  }
});

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

// Parse and execute
program.parse();
