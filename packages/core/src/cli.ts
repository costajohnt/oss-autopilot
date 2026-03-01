#!/usr/bin/env node
/**
 * OSS Autopilot CLI
 * Entry point with commander for argument parsing
 *
 * Supports --json flag for structured output (used by Claude Code plugin)
 *
 * Performance: Command modules are lazy-loaded via dynamic import() so that
 * only the invoked command's code is evaluated. The preAction hook uses an
 * async token fetch to avoid blocking the event loop on `gh auth token`.
 */

import { Command } from 'commander';
import { getGitHubTokenAsync, enableDebug, debug } from './core/index.js';

const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    const pkgPath = path.join(path.dirname(process.argv[1]), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch (_err) {
    // package.json may not be readable in all bundle/install configurations — fall back to safe default
    return '0.0.0';
  }
})();

// Commands that skip the preAction GitHub token check.
// startup handles auth internally (returns authError in JSON instead of process.exit).
const LOCAL_ONLY_COMMANDS = [
  'help',
  'status',
  'config',
  'read',
  'untrack',
  'version',
  'setup',
  'checkSetup',
  'dashboard',
  'serve',
  'parse-issue-list',
  'check-integration',
  'local-repos',
  'startup',
  'shelve',
  'unshelve',
  'dismiss',
  'undismiss',
  'snooze',
  'unsnooze',
];

const program = new Command();

program
  .name('oss-autopilot')
  .description('AI-powered autopilot for managing open source contributions')
  .version(VERSION)
  .option('--debug', 'Enable debug logging');

// Daily check command
program
  .command('daily')
  .description('Run daily check on all tracked PRs')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { runDaily } = await import('./commands/daily.js');
    await runDaily({ json: options.json });
  });

// Status command
program
  .command('status')
  .description('Show current status and stats')
  .option('--json', 'Output as JSON')
  .option('--offline', 'Use cached data only (no GitHub API calls)')
  .action(async (options) => {
    const { runStatus } = await import('./commands/status.js');
    await runStatus({ json: options.json, offline: options.offline });
  });

// Search command
program
  .command('search [count]')
  .description('Search for new issues to work on')
  .option('--json', 'Output as JSON')
  .action(async (count, options) => {
    const { runSearch } = await import('./commands/search.js');
    await runSearch({ maxResults: parseInt(count) || 5, json: options.json });
  });

// Vet command
program
  .command('vet <issue-url>')
  .description('Vet a specific issue before working on it')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, options) => {
    const { runVet } = await import('./commands/vet.js');
    await runVet({ issueUrl, json: options.json });
  });

// Track command
program
  .command('track <pr-url>')
  .description('Add a PR to track')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    const { runTrack } = await import('./commands/track.js');
    await runTrack({ prUrl, json: options.json });
  });

// Untrack command
program
  .command('untrack <pr-url>')
  .description('Stop tracking a PR')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    const { runUntrack } = await import('./commands/track.js');
    await runUntrack({ prUrl, json: options.json });
  });

// Read command (mark as read)
program
  .command('read [pr-url]')
  .description('Mark PR comments as read')
  .option('--all', 'Mark all PRs as read')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    const { runRead } = await import('./commands/read.js');
    await runRead({ prUrl, all: options.all, json: options.json });
  });

// Comments command
program
  .command('comments <pr-url>')
  .description('Show all comments on a PR')
  .option('--bots', 'Include bot comments')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    const { runComments } = await import('./commands/comments.js');
    await runComments({ prUrl, showBots: options.bots, json: options.json });
  });

// Post command
program
  .command('post <url> [message...]')
  .description('Post a comment to a PR or issue')
  .option('--stdin', 'Read message from stdin')
  .option('--json', 'Output as JSON')
  .action(async (url, messageParts, options) => {
    const { runPost } = await import('./commands/comments.js');
    const message = options.stdin ? undefined : messageParts.join(' ');
    await runPost({ url, message, stdin: options.stdin, json: options.json });
  });

// Claim command
program
  .command('claim <issue-url> [message...]')
  .description('Claim an issue by posting a comment')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, messageParts, options) => {
    const { runClaim } = await import('./commands/comments.js');
    const message = messageParts.length > 0 ? messageParts.join(' ') : undefined;
    await runClaim({ issueUrl, message, json: options.json });
  });

// Config command
program
  .command('config [key] [value]')
  .description('Show or update configuration')
  .option('--json', 'Output as JSON')
  .action(async (key, value, options) => {
    const { runConfig } = await import('./commands/config.js');
    await runConfig({ key, value, json: options.json });
  });

// Init command
program
  .command('init <username>')
  .description('Initialize with your GitHub username and import open PRs')
  .option('--json', 'Output as JSON')
  .action(async (username, options) => {
    const { runInit } = await import('./commands/init.js');
    await runInit({ username, json: options.json });
  });

// Setup command
program
  .command('setup')
  .description('Interactive setup / configuration')
  .option('--reset', 'Re-run setup even if already complete')
  .option('--set <settings...>', 'Set specific values (key=value)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { runSetup } = await import('./commands/setup.js');
    await runSetup({ reset: options.reset, set: options.set, json: options.json });
  });

// Check setup command
program
  .command('checkSetup')
  .description('Check if setup is complete')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { runCheckSetup } = await import('./commands/setup.js');
    await runCheckSetup({ json: options.json });
  });

// Dashboard commands
const dashboardCmd = program.command('dashboard').description('Dashboard commands');

dashboardCmd
  .command('serve')
  .description('Start interactive dashboard server')
  .option('--port <port>', 'Port to listen on', '3000')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port number: "${options.port}". Must be an integer between 1 and 65535.`);
      process.exit(1);
    }
    const { serveDashboard } = await import('./commands/dashboard.js');
    await serveDashboard({ port, open: options.open });
  });

// Keep bare `dashboard` (no subcommand) for backward compat — generates static HTML
dashboardCmd
  .option('--open', 'Open in browser')
  .option('--json', 'Output as JSON')
  .option('--offline', 'Use cached data only (no GitHub API calls)')
  .action(async (options) => {
    const { runDashboard } = await import('./commands/dashboard.js');
    await runDashboard({ open: options.open, json: options.json, offline: options.offline });
  });

// Parse issue list command (#82)
program
  .command('parse-issue-list <path>')
  .description('Parse a markdown issue list into structured JSON')
  .option('--json', 'Output as JSON')
  .action(async (filePath, options) => {
    const { runParseList } = await import('./commands/parse-list.js');
    await runParseList({ filePath, json: options.json });
  });

// Check integration command (#83)
program
  .command('check-integration')
  .description('Detect new files not referenced by the codebase')
  .option('--base <branch>', 'Base branch to compare against', 'main')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { runCheckIntegration } = await import('./commands/check-integration.js');
    await runCheckIntegration({ base: options.base, json: options.json });
  });

// Local repos command (#84)
program
  .command('local-repos')
  .description('Scan filesystem for local git clones')
  .option('--scan', 'Force re-scan (ignores cache)')
  .option('--paths <dirs...>', 'Directories to scan')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { runLocalRepos } = await import('./commands/local-repos.js');
    await runLocalRepos({ scan: options.scan, paths: options.paths, json: options.json });
  });

// Startup command (combines auth, setup, daily, dashboard, issue list)
program
  .command('startup')
  .description('Run all pre-flight checks and daily fetch in one call')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { runStartup } = await import('./commands/startup.js');
    await runStartup({ json: options.json });
  });

// Shelve command
program
  .command('shelve <pr-url>')
  .description('Shelve a PR (exclude from capacity and actionable issues)')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    const { runShelve } = await import('./commands/shelve.js');
    await runShelve({ prUrl, json: options.json });
  });

// Unshelve command
program
  .command('unshelve <pr-url>')
  .description('Unshelve a PR (include in capacity and actionable issues again)')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    const { runUnshelve } = await import('./commands/shelve.js');
    await runUnshelve({ prUrl, json: options.json });
  });

// Dismiss command
program
  .command('dismiss <issue-url>')
  .description('Dismiss issue reply notifications (resurfaces on new activity)')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, options) => {
    const { runDismiss } = await import('./commands/dismiss.js');
    await runDismiss({ issueUrl, json: options.json });
  });

// Undismiss command
program
  .command('undismiss <issue-url>')
  .description('Undismiss an issue (re-enable reply notifications)')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, options) => {
    const { runUndismiss } = await import('./commands/dismiss.js');
    await runUndismiss({ issueUrl, json: options.json });
  });

// Snooze command
program
  .command('snooze <pr-url>')
  .description('Snooze CI failure notifications for a PR')
  .requiredOption('--reason <reason>', 'Reason for snoozing (e.g., "upstream infrastructure issue")')
  .option('--days <days>', 'Number of days to snooze (default: 7)', '7')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    const { runSnooze } = await import('./commands/snooze.js');
    await runSnooze({ prUrl, reason: options.reason, days: parseInt(options.days, 10), json: options.json });
  });

// Unsnooze command
program
  .command('unsnooze <pr-url>')
  .description('Unsnooze a PR (re-enable CI failure notifications)')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    const { runUnsnooze } = await import('./commands/snooze.js');
    await runUnsnooze({ prUrl, json: options.json });
  });

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

  if (!LOCAL_ONLY_COMMANDS.includes(commandName)) {
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

// Parse and execute
program.parse();
