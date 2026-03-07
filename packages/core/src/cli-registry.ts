/**
 * CLI Command Registry
 *
 * All CLI command definitions live here as a flat array of CLICommandDef objects.
 * Each command declares its name, localOnly flag (skip GitHub token check), and
 * a register function that wires up the Commander command with display logic.
 *
 * Heavy command modules are lazy-loaded via dynamic import() in action handlers
 * so that only the invoked command's dependencies are evaluated.
 */

import type { Command } from 'commander';
import { errorMessage } from './core/errors.js';
import { outputJson, outputJsonError } from './formatters/json.js';

interface CLICommandDef {
  /** Command name (used to build the local-only set for the preAction hook). */
  name: string;
  /** If true, skip the preAction GitHub token check. */
  localOnly?: boolean;
  /** Register this command on the given Commander program. */
  register(program: Command): void;
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

/** Print local repos in human-readable format (used by local-repos command). */
function printRepos(repos: Record<string, { path: string; currentBranch: string | null }>): void {
  const entries = Object.entries(repos).sort(([a], [b]) => a.localeCompare(b));
  for (const [remote, info] of entries) {
    const branch = info.currentBranch ? ` (${info.currentBranch})` : '';
    console.log(`  ${remote}${branch}`);
    console.log(`    ${info.path}`);
  }
}

export const commands: CLICommandDef[] = [
  // ── Daily ──────────────────────────────────────────────────────────────
  {
    name: 'daily',
    register(program) {
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
    },
  },

  // ── Status ─────────────────────────────────────────────────────────────
  {
    name: 'status',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Search ─────────────────────────────────────────────────────────────
  {
    name: 'search',
    register(program) {
      program
        .command('search [count]')
        .description('Search for new issues to work on')
        .option('--json', 'Output as JSON')
        .action(async (count, options) => {
          try {
            const { runSearch } = await import('./commands/search.js');
            let maxResults = 5;
            if (count !== undefined) {
              const parsed = Number(count);
              if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
                throw new Error(`Invalid count "${count}". Must be a positive integer.`);
              }
              maxResults = parsed;
            }
            const MAX_SEARCH_RESULTS = 100;
            if (maxResults > MAX_SEARCH_RESULTS) {
              console.warn(`Capping search to ${MAX_SEARCH_RESULTS} results (requested: ${maxResults})`);
              maxResults = MAX_SEARCH_RESULTS;
            }
            if (!options.json) {
              console.log(`\nSearching for issues (max ${maxResults})...\n`);
            }
            const data = await runSearch({ maxResults });
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
    },
  },

  // ── Vet ────────────────────────────────────────────────────────────────
  {
    name: 'vet',
    register(program) {
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
    },
  },

  // ── Track ──────────────────────────────────────────────────────────────
  {
    name: 'track',
    register(program) {
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
    },
  },

  // ── Untrack ────────────────────────────────────────────────────────────
  {
    name: 'untrack',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Read ───────────────────────────────────────────────────────────────
  {
    name: 'read',
    localOnly: true,
    register(program) {
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
              console.log(
                'Note: In v2, PR read state is not tracked locally. PRs are fetched fresh on each daily run.',
              );
            }
          } catch (err) {
            handleCommandError(err, options.json);
          }
        });
    },
  },

  // ── Comments ───────────────────────────────────────────────────────────
  {
    name: 'comments',
    register(program) {
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
              const { formatRelativeTime } = await import('./core/utils.js');
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
    },
  },

  // ── Post ───────────────────────────────────────────────────────────────
  {
    name: 'post',
    register(program) {
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
    },
  },

  // ── Claim ──────────────────────────────────────────────────────────────
  {
    name: 'claim',
    register(program) {
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
    },
  },

  // ── Config ─────────────────────────────────────────────────────────────
  {
    name: 'config',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Init ───────────────────────────────────────────────────────────────
  {
    name: 'init',
    register(program) {
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
    },
  },

  // ── Setup ──────────────────────────────────────────────────────────────
  {
    name: 'setup',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Check Setup ────────────────────────────────────────────────────────
  {
    name: 'checkSetup',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Dashboard Serve ────────────────────────────────────────────────────
  {
    name: 'serve',
    localOnly: true,
    register(program) {
      const dashboardCmd = program.command('dashboard').description('Dashboard commands');
      dashboardCmd
        .command('serve')
        .description('Start interactive dashboard server')
        .option('--port <port>', 'Port to listen on', '3000')
        .option('--no-open', 'Do not open browser automatically')
        .action(async (options) => {
          try {
            const port = parseInt(options.port, 10);
            if (isNaN(port) || port < 1 || port > 65535) {
              console.error(`Invalid port number: "${options.port}". Must be an integer between 1 and 65535.`);
              process.exit(1);
            }
            const { serveDashboard } = await import('./commands/dashboard.js');
            await serveDashboard({ port, open: options.open });
          } catch (err) {
            handleCommandError(err);
          }
        });
    },
  },

  // ── Parse Issue List ───────────────────────────────────────────────────
  {
    name: 'parse-issue-list',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Check Integration ──────────────────────────────────────────────────
  {
    name: 'check-integration',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Local Repos ────────────────────────────────────────────────────────
  {
    name: 'local-repos',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Startup ────────────────────────────────────────────────────────────
  {
    name: 'startup',
    localOnly: true,
    register(program) {
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
              }
            }
          } catch (err) {
            handleCommandError(err, options.json);
          }
        });
    },
  },

  // ── Shelve ─────────────────────────────────────────────────────────────
  {
    name: 'shelve',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Unshelve ───────────────────────────────────────────────────────────
  {
    name: 'unshelve',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Dismiss ────────────────────────────────────────────────────────────
  {
    name: 'dismiss',
    localOnly: true,
    register(program) {
      program
        .command('dismiss <url>')
        .description('Dismiss notifications for an issue or PR (resurfaces on new activity)')
        .option('--json', 'Output as JSON')
        .action(async (url, options) => {
          try {
            const { runDismiss } = await import('./commands/dismiss.js');
            const data = await runDismiss({ url });
            if (options.json) {
              outputJson(data);
            } else if (data.dismissed) {
              console.log(`Dismissed: ${url}`);
              console.log('Notifications are now muted.');
              console.log('New responses after this point will resurface automatically.');
            } else {
              console.log('Already dismissed.');
            }
          } catch (err) {
            handleCommandError(err, options.json);
          }
        });
    },
  },

  // ── Undismiss ──────────────────────────────────────────────────────────
  {
    name: 'undismiss',
    localOnly: true,
    register(program) {
      program
        .command('undismiss <url>')
        .description('Undismiss an issue or PR (re-enable notifications)')
        .option('--json', 'Output as JSON')
        .action(async (url, options) => {
          try {
            const { runUndismiss } = await import('./commands/dismiss.js');
            const data = await runUndismiss({ url });
            if (options.json) {
              outputJson(data);
            } else if (data.undismissed) {
              console.log(`Undismissed: ${url}`);
              console.log('Notifications are active again.');
            } else {
              console.log('Was not dismissed.');
            }
          } catch (err) {
            handleCommandError(err, options.json);
          }
        });
    },
  },

  // ── Snooze ─────────────────────────────────────────────────────────────
  {
    name: 'snooze',
    localOnly: true,
    register(program) {
      program
        .command('snooze <pr-url>')
        .description('Snooze CI failure notifications for a PR')
        .requiredOption('--reason <reason>', 'Reason for snoozing (e.g., "upstream infrastructure issue")')
        .option('--days <days>', 'Number of days to snooze (default: 7)', '7')
        .option('--json', 'Output as JSON')
        .action(async (prUrl, options) => {
          try {
            const days = parseInt(options.days, 10);
            if (!Number.isFinite(days) || days < 1 || !Number.isInteger(days)) {
              throw new Error(`Invalid days value "${options.days}". Must be a positive integer.`);
            }
            const { runSnooze } = await import('./commands/snooze.js');
            const data = await runSnooze({ prUrl, reason: options.reason, days });
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
    },
  },

  // ── Unsnooze ───────────────────────────────────────────────────────────
  {
    name: 'unsnooze',
    localOnly: true,
    register(program) {
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
    },
  },

  // ── Override Status ────────────────────────────────────────────────────
  {
    name: 'override',
    localOnly: true,
    register(program) {
      program
        .command('override <pr-url> <status>')
        .description('Manually override PR status (needs_addressing or waiting_on_maintainer)')
        .option('--json', 'Output as JSON')
        .action(async (prUrl, status, options) => {
          try {
            const { runOverride } = await import('./commands/override.js');
            const data = await runOverride({ prUrl, status });
            if (options.json) {
              outputJson(data);
            } else {
              console.log(`Override set: ${prUrl} → ${data.status}`);
              console.log('This override will auto-clear when the PR has new activity.');
            }
          } catch (err) {
            handleCommandError(err, options.json);
          }
        });
    },
  },

  // ── Clear Override ────────────────────────────────────────────────────
  {
    name: 'clear-override',
    localOnly: true,
    register(program) {
      program
        .command('clear-override <pr-url>')
        .description('Clear a manual status override for a PR')
        .option('--json', 'Output as JSON')
        .action(async (prUrl, options) => {
          try {
            const { runClearOverride } = await import('./commands/override.js');
            const data = await runClearOverride({ prUrl });
            if (options.json) {
              outputJson(data);
            } else if (data.cleared) {
              console.log(`Override cleared: ${prUrl}`);
            } else {
              console.log('No override was set for this PR.');
            }
          } catch (err) {
            handleCommandError(err, options.json);
          }
        });
    },
  },

  // ── Stats ─────────────────────────────────────────────────────────────
  {
    name: 'stats',
    localOnly: true,
    register(program) {
      program
        .command('stats')
        .description('Show contribution statistics')
        .option('--json', 'Output as JSON')
        .option('--markdown', 'Output as shareable markdown report')
        .option('--badge', 'Output as shields.io endpoint JSON')
        .action(async (options) => {
          try {
            const { runStats, formatStatsMarkdown, formatStatsBadge } = await import('./commands/stats.js');
            const data = await runStats();
            if (options.badge) {
              console.log(JSON.stringify(formatStatsBadge(data), null, 2));
            } else if (options.markdown) {
              console.log(formatStatsMarkdown(data));
            } else if (options.json) {
              outputJson(data);
            } else {
              console.log(`\nOSS Contribution Stats (@${data.username})\n`);
              console.log(`  Merged PRs:        ${data.totalMerged}`);
              console.log(`  Closed PRs:        ${data.totalClosed}`);
              console.log(`  Merge Rate:        ${data.mergeRateFormatted}`);
              console.log(`  Active PRs:        ${data.activePRs}`);
              console.log(`  Repos Contributed: ${data.reposContributed}`);
              if (data.topRepos.length > 0) {
                console.log('\n  Top Repos:');
                for (const repo of data.topRepos.slice(0, 5)) {
                  console.log(`    ${repo.repo}: ${repo.mergedCount} merged`);
                }
              }
              console.log('\n  Use --markdown for a shareable report or --badge for shields.io');
            }
          } catch (err) {
            handleCommandError(err, options.json);
          }
        });
    },
  },
];
