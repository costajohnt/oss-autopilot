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
import { commands, handleCommandError } from './cli-registry.js';

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

  // actionCommand is the command being executed (e.g., 'status', 'daily').
  // For subcommand groups (e.g. `guidelines view`), Commander returns the
  // leaf name `view` — but the registry sets `localOnly` on the parent
  // entry `guidelines`. Walk the parent chain so a `localOnly` ancestor
  // covers all its leaves (#1208 M2). Without this, `guidelines view` —
  // which works fine in local mode (returns storageMode: 'local-unavailable')
  // — would still hit the auth gate and fail.
  let cmd: typeof actionCommand | null = actionCommand;
  let isLocalOnly = false;
  while (cmd) {
    if (localOnlySet.has(cmd.name())) {
      isLocalOnly = true;
      break;
    }
    cmd = cmd.parent;
  }

  if (!isLocalOnly) {
    const token = await getGitHubTokenAsync();
    if (!token) {
      // Honor --json at the CLI boundary so machine consumers (plugins, MCP
      // stdio harnesses, scripts) get a parseable envelope instead of a
      // stderr blob followed by a non-zero exit. Commander has already parsed
      // the action's own options, so we check both the action command and the
      // raw argv as a fallback (#1056 M20).
      const wantsJson = Boolean(actionCommand.opts().json) || process.argv.includes('--json');
      if (wantsJson) {
        const { outputJsonError } = await import('./formatters/json.js');
        outputJsonError(
          'GitHub authentication required. Install gh CLI and run `gh auth login`, or set GITHUB_TOKEN.',
          'AUTH_REQUIRED',
        );
      } else {
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
      }
      process.exit(1);
    }

    // Activate Gist persistence if configured, before any command runs.
    // Shared helper peeks at the state file and only pre-sets the singleton
    // when Gist mode is the configured persistence (#1000). Hard errors
    // still throw (#1202); the resolving degraded modes are surfaced in the
    // JSON envelope so --json consumers see them too (#1433).
    const { ensureGistPersistence } = await import('./core/index.js');
    const status = await ensureGistPersistence(token);
    if (status === 'degraded' || status === 'state-unreadable') {
      const { setEnvelopeGistWarning } = await import('./formatters/json.js');
      setEnvelopeGistWarning(
        'Gist persistence is configured but this run is LOCAL-ONLY (' +
          (status === 'degraded' ? 'transient network failure during init' : 'state file could not be read') +
          '); changes may be overwritten by the next successful Gist sync.',
      );
    }
  } else {
    // #1431: localOnly skips the AUTH GATE, not gist persistence. Mutating
    // localOnly commands (shelve/move/dismiss/override/...) already call
    // maybeCheckpoint, which silently no-ops when the singleton never
    // bootstrapped — so a gist-configured user's CLI mutations were written
    // local-only with no warning and never reached the Gist. Best-effort
    // bootstrap; the warning semantics live (and are unit-tested) in
    // bootstrapGistBestEffort.
    const { bootstrapGistBestEffort } = await import('./core/index.js');
    const localOnlyWarning = await bootstrapGistBestEffort(getGitHubTokenAsync);
    if (localOnlyWarning) {
      console.error(`Warning: ${localOnlyWarning}`);
      // Also thread it into the JSON envelope: shelve/move/dismiss --json
      // consumers (the agent harness) must see the mutation will not sync —
      // stderr alone is invisible to them (#1433).
      const { setEnvelopeGistWarning } = await import('./formatters/json.js');
      setEnvelopeGistWarning(localOnlyWarning);
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
