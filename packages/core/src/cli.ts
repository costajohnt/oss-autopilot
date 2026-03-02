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
import { getGitHubTokenAsync, enableDebug, debug, formatRelativeTime } from './core/index.js';
import { errorMessage } from './core/errors.js';
import { outputJson, outputJsonError } from './formatters/json.js';

/** Print local repos in human-readable format */
function printRepos(repos: Record<string, { path: string; currentBranch: string | null }>): void {
  const entries = Object.entries(repos).sort(([a], [b]) => a.localeCompare(b));
  for (const [remote, info] of entries) {
    const branch = info.currentBranch ? ` (${info.currentBranch})` : '';
    console.log(`  ${remote}${branch}`);
    console.log(`    ${info.path}`);
  }
}

/** Shared error handler for CLI action catch blocks. */
function handleCommandError(err: unknown, json?: boolean): never {
  const msg = errorMessage(err);
  if (json) {
    outputJsonError(msg);
  } else {
    console.error(`Error: ${msg}`);
  }
  process.exit(1);
}

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
    try {
      if (options.json) {
        const { runDaily } = await import('./commands/daily.js');
        const data = await runDaily();
        outputJson(data);
      } else {
        const { runDailyForDisplay, printDigest } = await import('./commands/daily.js');
        const result = await runDailyForDisplay();
        printDigest(result.digest, result.capacity, result.commentedIssues);
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Status command
program
  .command('status')
  .description('Show current status and stats')
  .option('--json', 'Output as JSON')
  .option('--offline', 'Use cached data only (no GitHub API calls)')
  .action(async (options) => {
    try {
      const { runStatus } = await import('./commands/status.js');
      const data = await runStatus({ offline: options.offline });
      if (options.json) {
        outputJson(data);
      } else {
        console.log('\n\ud83d\udcca OSS Status\n');
        console.log(`Merged PRs: ${data.stats.mergedPRs}`);
        console.log(`Closed PRs: ${data.stats.closedPRs}`);
        console.log(`Merge Rate: ${data.stats.mergeRate}`);
        console.log(`Needs Response: ${data.stats.needsResponse}`);
        if (data.offline) {
          console.log(`\nLast Updated: ${data.lastUpdated || 'Never'}`);
          console.log('(Offline mode: showing cached data)');
        } else {
          console.log(`\nLast Run: ${data.lastRunAt || 'Never'}`);
        }
        console.log('\nRun with --json for structured output');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Search command
program
  .command('search [count]')
  .description('Search for new issues to work on')
  .option('--json', 'Output as JSON')
  .action(async (count, options) => {
    try {
      const { runSearch } = await import('./commands/search.js');
      if (!options.json) {
        console.log(`\nSearching for issues (max ${parseInt(count) || 5})...\n`);
      }
      const data = await runSearch({ maxResults: parseInt(count) || 5 });
      if (options.json) {
        outputJson(data);
      } else {
        if (data.candidates.length === 0) {
          if (data.rateLimitWarning) {
            console.warn(`\n${data.rateLimitWarning}\n`);
          } else {
            console.log('No matching issues found.');
          }
          return;
        }

        if (data.rateLimitWarning) {
          console.warn(`\n${data.rateLimitWarning}\n`);
        }

        console.log(`Found ${data.candidates.length} candidates:\n`);

        for (const candidate of data.candidates) {
          // Simple text format for candidates
          const { issue, recommendation, reasonsToApprove, reasonsToSkip, viabilityScore } = candidate;
          console.log(`[${recommendation.toUpperCase()}] ${issue.repo}#${issue.number}: ${issue.title}`);
          console.log(`  URL: ${issue.url}`);
          console.log(`  Viability: ${viabilityScore}/100`);
          if (reasonsToApprove.length > 0) console.log(`  Approve: ${reasonsToApprove.join(', ')}`);
          if (reasonsToSkip.length > 0) console.log(`  Skip: ${reasonsToSkip.join(', ')}`);
          console.log('---');
        }
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Vet command
program
  .command('vet <issue-url>')
  .description('Vet a specific issue before working on it')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, options) => {
    try {
      const { runVet } = await import('./commands/vet.js');
      const data = await runVet({ issueUrl });
      if (options.json) {
        outputJson(data);
      } else {
        const { issue, recommendation, reasonsToApprove, reasonsToSkip } = data;
        console.log(`\nVetting issue: ${issueUrl}\n`);
        console.log(`[${recommendation.toUpperCase()}] ${issue.repo}#${issue.number}: ${issue.title}`);
        console.log(`  URL: ${issue.url}`);
        if (reasonsToApprove.length > 0) console.log(`  Approve: ${reasonsToApprove.join(', ')}`);
        if (reasonsToSkip.length > 0) console.log(`  Skip: ${reasonsToSkip.join(', ')}`);
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Track command
program
  .command('track <pr-url>')
  .description('Add a PR to track')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    try {
      const { runTrack } = await import('./commands/track.js');
      const data = await runTrack({ prUrl });
      if (options.json) {
        outputJson(data);
      } else {
        console.log(`\nPR: ${data.pr.repo}#${data.pr.number} - ${data.pr.title}`);
        console.log('Note: In v2, PRs are tracked automatically via the daily run.');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Untrack command
program
  .command('untrack <pr-url>')
  .description('Stop tracking a PR')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    try {
      const { runUntrack } = await import('./commands/track.js');
      const data = await runUntrack({ prUrl });
      if (options.json) {
        outputJson(data);
      } else {
        console.log(
          'Note: In v2, PRs are fetched fresh on each daily run \u2014 there is no local tracking list to remove from.',
        );
        console.log('Use `shelve` to temporarily hide a PR from the daily summary.');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Read command (mark as read)
program
  .command('read [pr-url]')
  .description('Mark PR comments as read')
  .option('--all', 'Mark all PRs as read')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    try {
      const { runRead } = await import('./commands/read.js');
      const data = await runRead({ prUrl, all: options.all });
      if (options.json) {
        outputJson(data);
      } else {
        console.log('Note: In v2, PR read state is not tracked locally. PRs are fetched fresh on each daily run.');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Comments command
program
  .command('comments <pr-url>')
  .description('Show all comments on a PR')
  .option('--bots', 'Include bot comments')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    try {
      const { runComments } = await import('./commands/comments.js');
      const data = await runComments({ prUrl, showBots: options.bots });
      if (options.json) {
        outputJson(data);
      } else {
        // Text output
        console.log(`\nFetching comments for: ${prUrl}\n`);
        console.log(`## ${data.pr.title}\n`);
        console.log(`**Status:** ${data.pr.state} | **Mergeable:** ${data.pr.mergeable ?? 'checking...'}`);
        console.log(`**Branch:** ${data.pr.head} -> ${data.pr.base}`);
        console.log(`**URL:** ${data.pr.url}\n`);

        const REVIEW_STATE_LABELS: Record<string, string> = {
          APPROVED: '[Approved]',
          CHANGES_REQUESTED: '[Changes]',
        };
        if (data.reviews.length > 0) {
          console.log('### Reviews (newest first)\n');
          for (const review of data.reviews) {
            const state = REVIEW_STATE_LABELS[review.state] ?? '[Comment]';
            const time = review.submittedAt ? formatRelativeTime(review.submittedAt) : '';
            console.log(`${state} **@${review.user}** (${review.state}) - ${time}`);
            if (review.body) {
              console.log(`> ${review.body.split('\n').join('\n> ')}\n`);
            }
          }
        }

        if (data.reviewComments.length > 0) {
          console.log('### Inline Comments (newest first)\n');
          for (const comment of data.reviewComments) {
            const time = formatRelativeTime(comment.createdAt);
            console.log(`**@${comment.user}** on \`${comment.path}\` - ${time}`);
            console.log(`> ${comment.body.split('\n').join('\n> ')}`);
            console.log('');
          }
        }

        if (data.issueComments.length > 0) {
          console.log('### Discussion (newest first)\n');
          for (const comment of data.issueComments) {
            const time = formatRelativeTime(comment.createdAt);
            console.log(`**@${comment.user}** - ${time}`);
            console.log(`> ${comment.body?.split('\n').join('\n> ')}\n`);
          }
        }

        if (data.reviewComments.length === 0 && data.issueComments.length === 0 && data.reviews.length === 0) {
          console.log('No comments from other users.\n');
        }

        console.log('---');
        console.log(
          `**Summary:** ${data.summary.reviewCount} reviews, ${data.summary.inlineCommentCount} inline comments, ${data.summary.discussionCommentCount} discussion comments`,
        );
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Post command
program
  .command('post <url> [message...]')
  .description('Post a comment to a PR or issue')
  .option('--stdin', 'Read message from stdin')
  .option('--json', 'Output as JSON')
  .action(async (url, messageParts, options) => {
    try {
      let message: string;
      if (options.stdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        message = Buffer.concat(chunks).toString('utf-8').trim();
      } else {
        message = messageParts.join(' ');
      }
      const { runPost } = await import('./commands/comments.js');
      const data = await runPost({ url, message });
      if (options.json) {
        outputJson(data);
      } else {
        console.log(`Comment posted: ${data.commentUrl}`);
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Claim command
program
  .command('claim <issue-url> [message...]')
  .description('Claim an issue by posting a comment')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, messageParts, options) => {
    try {
      const { runClaim } = await import('./commands/comments.js');
      const message = messageParts.length > 0 ? messageParts.join(' ') : undefined;
      const data = await runClaim({ issueUrl, message });
      if (options.json) {
        outputJson(data);
      } else {
        console.log(`Issue claimed: ${data.commentUrl}`);
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Config command
program
  .command('config [key] [value]')
  .description('Show or update configuration')
  .option('--json', 'Output as JSON')
  .action(async (key, value, options) => {
    try {
      const { runConfig } = await import('./commands/config.js');
      const data = await runConfig({ key, value });
      if (options.json) {
        outputJson(data);
      } else if ('config' in data) {
        console.log('\n\u2699\ufe0f Current Configuration:\n');
        console.log(JSON.stringify(data.config, null, 2));
      } else {
        console.log(`Set ${data.key} to: ${data.value}`);
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Init command
program
  .command('init <username>')
  .description('Initialize with your GitHub username and import open PRs')
  .option('--json', 'Output as JSON')
  .action(async (username, options) => {
    try {
      const { runInit } = await import('./commands/init.js');
      const data = await runInit({ username });
      if (options.json) {
        outputJson(data);
      } else {
        console.log(`\nUsername set to @${data.username}.`);
        console.log('Run `oss-autopilot daily` to fetch your open PRs from GitHub.');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Setup command
program
  .command('setup')
  .description('Interactive setup / configuration')
  .option('--reset', 'Re-run setup even if already complete')
  .option('--set <settings...>', 'Set specific values (key=value)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { runSetup } = await import('./commands/setup.js');
      const data = await runSetup({ reset: options.reset, set: options.set });
      if (options.json) {
        outputJson(data);
      } else if ('success' in data) {
        // --set mode
        for (const [key, value] of Object.entries(data.settings)) {
          console.log(`\u2713 ${key}: ${value}`);
        }
        if (data.warnings) {
          for (const w of data.warnings) {
            console.warn(w);
          }
        }
      } else if ('setupComplete' in data && data.setupComplete) {
        // Already complete
        console.log('\n\u2699\ufe0f  OSS Autopilot Setup\n');
        console.log('\u2713 Setup already complete!\n');
        console.log('Current settings:');
        console.log(`  GitHub username:    ${data.config.githubUsername || '(not set)'}`);
        console.log(`  Max active PRs:     ${data.config.maxActivePRs}`);
        console.log(`  Dormant threshold:  ${data.config.dormantThresholdDays} days`);
        console.log(`  Approaching dormant: ${data.config.approachingDormantDays} days`);
        console.log(`  Languages:          ${data.config.languages.join(', ')}`);
        console.log(`  Labels:             ${data.config.labels.join(', ')}`);
        console.log(`\nRun 'setup --reset' to reconfigure.`);
      } else if ('setupRequired' in data) {
        // Needs setup
        console.log('\n\u2699\ufe0f  OSS Autopilot Setup\n');
        console.log('SETUP_REQUIRED');
        console.log('---');
        console.log('Please configure the following settings:\n');
        for (const prompt of data.prompts) {
          console.log(`SETTING: ${prompt.setting}`);
          console.log(`PROMPT: ${prompt.prompt}`);
          const currentVal = Array.isArray(prompt.current) ? prompt.current.join(', ') : prompt.current;
          console.log(`CURRENT: ${currentVal ?? '(not set)'}`);
          if (prompt.required) console.log('REQUIRED: true');
          if (prompt.default !== undefined) {
            const defaultVal = Array.isArray(prompt.default) ? prompt.default.join(', ') : prompt.default;
            console.log(`DEFAULT: ${defaultVal}`);
          }
          if (prompt.type) console.log(`TYPE: ${prompt.type}`);
          console.log('');
        }
        console.log('---');
        console.log('END_SETUP_PROMPTS');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Check setup command
program
  .command('checkSetup')
  .description('Check if setup is complete')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { runCheckSetup } = await import('./commands/setup.js');
      const data = await runCheckSetup();
      if (options.json) {
        outputJson(data);
      } else if (data.setupComplete) {
        console.log('SETUP_COMPLETE');
        console.log(`username=${data.username}`);
      } else {
        console.log('SETUP_INCOMPLETE');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
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
    try {
      const { runParseList } = await import('./commands/parse-list.js');
      const data = await runParseList({ filePath });
      if (options.json) {
        outputJson(data);
      } else {
        const path = await import('path');
        const resolvedPath = path.resolve(filePath);
        console.log(`\n\ud83d\udccb Issue List: ${resolvedPath}\n`);
        console.log(`Available: ${data.availableCount} | Completed: ${data.completedCount}\n`);
        if (data.available.length > 0) {
          console.log('--- Available ---');
          for (const item of data.available) {
            console.log(`  [${item.tier}] ${item.repo}#${item.number}: ${item.title}`);
          }
        }
        if (data.completed.length > 0) {
          console.log('\n--- Completed ---');
          for (const item of data.completed) {
            console.log(`  [${item.tier}] ${item.repo}#${item.number}: ${item.title}`);
          }
        }
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Check integration command (#83)
program
  .command('check-integration')
  .description('Detect new files not referenced by the codebase')
  .option('--base <branch>', 'Base branch to compare against', 'main')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { runCheckIntegration } = await import('./commands/check-integration.js');
      const data = await runCheckIntegration({ base: options.base });
      if (options.json) {
        outputJson(data);
      } else if (data.newFiles.length === 0) {
        console.log('\nNo new code files to check.');
      } else {
        console.log(`\n\ud83d\udd0d Integration Check (base: ${options.base})\n`);
        console.log(`New files: ${data.newFiles.length} | Unreferenced: ${data.unreferencedCount}\n`);
        for (const file of data.newFiles) {
          const status = file.isIntegrated ? '\u2705' : '\u26a0\ufe0f';
          console.log(`${status} ${file.path}`);
          if (file.isIntegrated) {
            console.log(`   Referenced by: ${file.referencedBy.join(', ')}`);
          } else {
            console.log('   Not referenced by any file');
            if (file.suggestedEntryPoints && file.suggestedEntryPoints.length > 0) {
              console.log(`   Suggested entry points: ${file.suggestedEntryPoints.join(', ')}`);
            }
          }
        }
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Local repos command (#84)
program
  .command('local-repos')
  .description('Scan filesystem for local git clones')
  .option('--scan', 'Force re-scan (ignores cache)')
  .option('--paths <dirs...>', 'Directories to scan')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { runLocalRepos } = await import('./commands/local-repos.js');
      const data = await runLocalRepos({ scan: options.scan, paths: options.paths });
      if (options.json) {
        outputJson(data);
      } else if (data.fromCache) {
        console.log(`\n\ud83d\udcc1 Local Repos (cached ${data.cachedAt})\n`);
        printRepos(data.repos);
      } else {
        console.log(`Found ${Object.keys(data.repos).length} repos:\n`);
        printRepos(data.repos);
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Startup command (combines auth, setup, daily, dashboard, issue list)
program
  .command('startup')
  .description('Run all pre-flight checks and daily fetch in one call')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { runStartup } = await import('./commands/startup.js');
      const data = await runStartup();
      if (options.json) {
        outputJson(data);
      } else {
        if (!data.setupComplete) {
          console.log('Setup incomplete. Run /setup-oss first.');
        } else if (data.authError) {
          console.error(`Error: ${data.authError}`);
        } else {
          console.log(`OSS Autopilot v${data.version}`);
          console.log(data.daily?.briefSummary ?? '');
          if (data.dashboardPath) console.log(`Dashboard: ${data.dashboardPath}`);
        }
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Shelve command
program
  .command('shelve <pr-url>')
  .description('Shelve a PR (exclude from capacity and actionable issues)')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    try {
      const { runShelve } = await import('./commands/shelve.js');
      const data = await runShelve({ prUrl });
      if (options.json) {
        outputJson(data);
      } else if (data.shelved) {
        console.log(`Shelved: ${prUrl}`);
        console.log('This PR is now excluded from capacity and actionable issues.');
        console.log('It will auto-unshelve if a maintainer engages.');
      } else {
        console.log('PR is already shelved.');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Unshelve command
program
  .command('unshelve <pr-url>')
  .description('Unshelve a PR (include in capacity and actionable issues again)')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    try {
      const { runUnshelve } = await import('./commands/shelve.js');
      const data = await runUnshelve({ prUrl });
      if (options.json) {
        outputJson(data);
      } else if (data.unshelved) {
        console.log(`Unshelved: ${prUrl}`);
        console.log('This PR is now active again.');
      } else {
        console.log('PR was not shelved.');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Dismiss command
program
  .command('dismiss <issue-url>')
  .description('Dismiss issue reply notifications (resurfaces on new activity)')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, options) => {
    try {
      const { runDismiss } = await import('./commands/dismiss.js');
      const data = await runDismiss({ issueUrl });
      if (options.json) {
        outputJson(data);
      } else if (data.dismissed) {
        console.log(`Dismissed: ${issueUrl}`);
        console.log('Issue reply notifications are now muted.');
        console.log('New responses after this point will resurface automatically.');
      } else {
        console.log('Issue is already dismissed.');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Undismiss command
program
  .command('undismiss <issue-url>')
  .description('Undismiss an issue (re-enable reply notifications)')
  .option('--json', 'Output as JSON')
  .action(async (issueUrl, options) => {
    try {
      const { runUndismiss } = await import('./commands/dismiss.js');
      const data = await runUndismiss({ issueUrl });
      if (options.json) {
        outputJson(data);
      } else if (data.undismissed) {
        console.log(`Undismissed: ${issueUrl}`);
        console.log('Issue reply notifications are active again.');
      } else {
        console.log('Issue was not dismissed.');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Snooze command
program
  .command('snooze <pr-url>')
  .description('Snooze CI failure notifications for a PR')
  .requiredOption('--reason <reason>', 'Reason for snoozing (e.g., "upstream infrastructure issue")')
  .option('--days <days>', 'Number of days to snooze (default: 7)', '7')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    try {
      const { runSnooze } = await import('./commands/snooze.js');
      const data = await runSnooze({ prUrl, reason: options.reason, days: parseInt(options.days, 10) });
      if (options.json) {
        outputJson(data);
      } else if (data.snoozed) {
        console.log(`Snoozed: ${prUrl}`);
        console.log(`Reason: ${data.reason}`);
        console.log(`Duration: ${data.days} day${data.days === 1 ? '' : 's'}`);
        console.log(`Expires: ${data.expiresAt ? new Date(data.expiresAt).toLocaleString() : 'unknown'}`);
        console.log('CI failure notifications are now muted for this PR.');
      } else {
        console.log('PR is already snoozed.');
        if (data.expiresAt) {
          console.log(`Expires: ${new Date(data.expiresAt).toLocaleString()}`);
        }
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
  });

// Unsnooze command
program
  .command('unsnooze <pr-url>')
  .description('Unsnooze a PR (re-enable CI failure notifications)')
  .option('--json', 'Output as JSON')
  .action(async (prUrl, options) => {
    try {
      const { runUnsnooze } = await import('./commands/snooze.js');
      const data = await runUnsnooze({ prUrl });
      if (options.json) {
        outputJson(data);
      } else if (data.unsnoozed) {
        console.log(`Unsnoozed: ${prUrl}`);
        console.log('CI failure notifications are active again for this PR.');
      } else {
        console.log('PR was not snoozed.');
      }
    } catch (err) {
      handleCommandError(err, options.json);
    }
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
