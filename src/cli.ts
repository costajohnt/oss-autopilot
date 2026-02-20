#!/usr/bin/env node
/**
 * OSS Autopilot CLI
 * Entry point with commander for argument parsing
 *
 * Supports --json flag for structured output (used by Claude Code plugin)
 */

import { Command } from 'commander';
import { getGitHubToken } from './core/index.js';
import { runDaily } from './commands/daily.js';
import { runStatus } from './commands/status.js';
import { runSearch } from './commands/search.js';
import { runVet } from './commands/vet.js';
import { runTrack, runUntrack } from './commands/track.js';
import { runConfig } from './commands/config.js';
import { runComments, runPost, runClaim } from './commands/comments.js';
import { runSetup, runCheckSetup } from './commands/setup.js';
import { runInit } from './commands/init.js';
import { runRead } from './commands/read.js';
import { runDashboard } from './commands/dashboard.js';
import { runParseList } from './commands/parse-list.js';
import { runCheckIntegration } from './commands/check-integration.js';
import { runLocalRepos } from './commands/local-repos.js';
import { runStartup } from './commands/startup.js';
import { runShelve, runUnshelve } from './commands/shelve.js';
import { runDismiss, runUndismiss } from './commands/dismiss.js';

const VERSION = (() => {
  try {
    const fs = require('fs');
    const path = require('path');
    const pkgPath = path.join(path.dirname(process.argv[1]), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
})();

// Commands that skip the preAction GitHub token check.
// startup handles auth internally (returns authError in JSON instead of process.exit).
const LOCAL_ONLY_COMMANDS = ['help', 'status', 'config', 'read', 'untrack', 'version', 'setup', 'checkSetup', 'dashboard', 'parse-issue-list', 'check-integration', 'local-repos', 'startup', 'shelve', 'unshelve', 'dismiss', 'undismiss'];

const program = new Command();

program
  .name('oss-autopilot')
  .description('AI-powered autopilot for managing open source contributions')
  .version(VERSION);

// Daily check command
program
  .command('daily')
  .description('Run daily check on all tracked PRs')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await runDaily({ json: options.json });
  });

// Status command
program
  .command('status')
  .description('Show current status and stats')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await runStatus({ json: options.json });
  });

// Search command
program
  .command('search [count]')
  .description('Search for new issues to work on')
  .option('--json', 'Output as JSON')
  .action(async (count, options) => {
    await runSearch({ maxResults: parseInt(count) || 5, json: options.json });
  });

// Vet command
program
  .command('vet <issue-url>')
  .description('Vet a specific issue before working on it')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, options) => {
    await runVet({ issueUrl, json: options.json });
  });

// Track command
program
  .command('track <pr-url>')
  .description('Add a PR to track')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    await runTrack({ prUrl, json: options.json });
  });

// Untrack command
program
  .command('untrack <pr-url>')
  .description('Stop tracking a PR')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    await runUntrack({ prUrl, json: options.json });
  });

// Read command (mark as read)
program
  .command('read [pr-url]')
  .description('Mark PR comments as read')
  .option('--all', 'Mark all PRs as read')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    await runRead({ prUrl, all: options.all, json: options.json });
  });

// Comments command
program
  .command('comments <pr-url>')
  .description('Show all comments on a PR')
  .option('--bots', 'Include bot comments')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    await runComments({ prUrl, showBots: options.bots, json: options.json });
  });

// Post command
program
  .command('post <url> [message...]')
  .description('Post a comment to a PR or issue')
  .option('--stdin', 'Read message from stdin')
  .option('--json', 'Output as JSON')
  .action(async (url, messageParts, options) => {
    const message = options.stdin ? undefined : messageParts.join(' ');
    await runPost({ url, message, stdin: options.stdin, json: options.json });
  });

// Claim command
program
  .command('claim <issue-url> [message...]')
  .description('Claim an issue by posting a comment')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, messageParts, options) => {
    const message = messageParts.length > 0 ? messageParts.join(' ') : undefined;
    await runClaim({ issueUrl, message, json: options.json });
  });

// Config command
program
  .command('config [key] [value]')
  .description('Show or update configuration')
  .option('--json', 'Output as JSON')
  .action(async (key, value, options) => {
    await runConfig({ key, value, json: options.json });
  });

// Init command
program
  .command('init <username>')
  .description('Initialize with your GitHub username and import open PRs')
  .option('--json', 'Output as JSON')
  .action(async (username, options) => {
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
    await runSetup({ reset: options.reset, set: options.set, json: options.json });
  });

// Check setup command
program
  .command('checkSetup')
  .description('Check if setup is complete')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await runCheckSetup({ json: options.json });
  });

// Dashboard command
program
  .command('dashboard')
  .description('Generate HTML stats dashboard')
  .option('--open', 'Open in browser')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await runDashboard({ open: options.open, json: options.json });
  });

// Parse issue list command (#82)
program
  .command('parse-issue-list <path>')
  .description('Parse a markdown issue list into structured JSON')
  .option('--json', 'Output as JSON')
  .action(async (filePath, options) => {
    await runParseList({ filePath, json: options.json });
  });

// Check integration command (#83)
program
  .command('check-integration')
  .description('Detect new files not referenced by the codebase')
  .option('--base <branch>', 'Base branch to compare against', 'main')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
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
    await runLocalRepos({ scan: options.scan, paths: options.paths, json: options.json });
  });

// Startup command (combines auth, setup, daily, dashboard, issue list)
program
  .command('startup')
  .description('Run all pre-flight checks and daily fetch in one call')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await runStartup({ json: options.json });
  });

// Shelve command
program
  .command('shelve <pr-url>')
  .description('Shelve a PR (exclude from capacity and actionable issues)')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    await runShelve({ prUrl, json: options.json });
  });

// Unshelve command
program
  .command('unshelve <pr-url>')
  .description('Unshelve a PR (include in capacity and actionable issues again)')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    await runUnshelve({ prUrl, json: options.json });
  });

// Dismiss command
program
  .command('dismiss <issue-url>')
  .description('Dismiss issue reply notifications (resurfaces on new activity)')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, options) => {
    await runDismiss({ issueUrl, json: options.json });
  });

// Undismiss command
program
  .command('undismiss <issue-url>')
  .description('Undismiss an issue (re-enable reply notifications)')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, options) => {
    await runUndismiss({ issueUrl, json: options.json });
  });

// Validate GitHub token before running commands that need it
program.hook('preAction', async (thisCommand, actionCommand) => {
  // actionCommand is the command being executed (e.g., 'status', 'daily')
  const commandName = actionCommand.name();

  if (!LOCAL_ONLY_COMMANDS.includes(commandName)) {
    const token = getGitHubToken();
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
