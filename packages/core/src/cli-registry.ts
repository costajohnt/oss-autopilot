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
import { errorMessage, resolveErrorCode } from './core/errors.js';
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
    outputJsonError(msg, resolveErrorCode(err));
  } else {
    console.error(`Error: ${msg}`);
  }
  process.exit(1);
}

/**
 * Shared action wrapper: runs the command, routes to JSON or display output,
 * and uniformly handles errors (#999).
 *
 * Captures the try/catch + `--json` branching boilerplate that was
 * duplicated in every command action. Commands with non-standard output
 * modes (e.g. `--compact`, `--markdown`, `--badge`) inline their own
 * branching rather than squeezing through this helper.
 */
async function executeAction<T>(
  options: { json?: boolean },
  run: () => Promise<T>,
  display: (data: T) => void | Promise<void>,
): Promise<void> {
  try {
    const data = await run();
    if (options.json) {
      outputJson(data);
    } else {
      await display(data);
    }
  } catch (err) {
    handleCommandError(err, options.json);
  }
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
        .option('--compact', 'Reduce JSON payload by omitting summary, repoGroups, and full failure details')
        .action(async (options) => {
          try {
            if (options.json) {
              const { runDaily } = await import('./commands/daily.js');
              const data = await runDaily();
              if (options.compact) {
                const { toCompactDailyOutput } = await import('./formatters/json.js');
                outputJson(toCompactDailyOutput(data));
              } else {
                outputJson(data);
              }
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
        .option(
          '--offline',
          'Show cache-freshness metadata (lastUpdated). Status always reads local state — no GitHub API calls are made either way.',
        )
        .action((options) =>
          executeAction(
            options,
            async () => {
              const { runStatus } = await import('./commands/status.js');
              return runStatus({ offline: options.offline });
            },
            (data) => {
              console.log('\n\ud83d\udcca OSS Status\n');
              console.log(`Merged PRs: ${data.stats.mergedPRs}`);
              console.log(`Closed PRs: ${data.stats.closedPRs}`);
              console.log(`Merge Rate: ${data.stats.mergeRate}`);
              console.log(`Needs Response: ${data.stats.needsResponse}`);
              if (data.offline) {
                console.log(`\nLast Updated: ${data.lastUpdated || 'Never'}`);
                console.log('(Status reads from local state — no GitHub API calls)');
              } else {
                console.log(`\nLast Run: ${data.lastRunAt || 'Never'}`);
              }
              console.log('\nRun with --json for structured output');
            },
          ),
        );
    },
  },

  // ── State ──────────────────────────────────────────────────────────────
  {
    name: 'state',
    register(program) {
      program
        .command('state')
        .description('Manage state persistence (local/gist)')
        .option('--show', 'Display current persistence mode and Gist ID')
        .option('--sync', 'Force push state to Gist (no-op if not in Gist mode)')
        .option('--unlink', 'Switch from Gist back to local persistence')
        .option('--validate', 'When used with --show, also report stored PR entries with unparseable URLs')
        .option('--json', 'Output as JSON')
        .action(async (options) => {
          if (options.unlink) {
            await executeAction(
              options,
              async () => (await import('./commands/state-cmd.js')).runStateUnlink(),
              (data) => {
                console.log(`State written to ${data.localStatePath}`);
                console.log('Persistence switched to local mode.');
                if (data.previousGistId) {
                  console.log(`Previous Gist (${data.previousGistId}) was NOT deleted.`);
                }
                console.log('Restart any running processes (e.g. dashboard server) to pick up the change.');
              },
            );
          } else if (options.sync) {
            await executeAction(
              options,
              async () => (await import('./commands/state-cmd.js')).runStateSync(),
              (data) => {
                if (data.pushed) {
                  console.log(`State pushed to Gist ${data.gistId}`);
                } else {
                  console.log('Not in Gist mode. Nothing to sync.');
                }
              },
            );
          } else {
            // Default: --show
            await executeAction(
              options,
              async () => (await import('./commands/state-cmd.js')).runStateShow({ validate: !!options.validate }),
              (data) => {
                console.log(`\nPersistence: ${data.persistence}`);
                if (data.gistId) console.log(`Gist ID: ${data.gistId}`);
                if (data.gistDegraded) console.log('Status: DEGRADED (using local cache)');
                console.log(`Last run: ${data.lastRunAt ?? 'Never'}`);
                if (data.invalidEntries) {
                  if (data.invalidEntries.length === 0) {
                    console.log('Validation: no invalid PR URLs in stored state.');
                  } else {
                    console.log(`Validation: ${data.invalidEntries.length} stored PR(s) with invalid URLs:`);
                    for (const e of data.invalidEntries) {
                      console.log(`  [${e.kind}] ${e.url}  ${e.title}`);
                    }
                  }
                }
                console.log('');
              },
            );
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
        .action((count, options) =>
          executeAction(
            options,
            async () => {
              const { runSearch, MAX_SEARCH_RESULTS } = await import('./commands/search.js');
              let maxResults = 5;
              if (count !== undefined) {
                const parsed = Number(count);
                if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
                  throw new Error(`Invalid count "${count}". Must be a positive integer.`);
                }
                maxResults = parsed;
              }
              if (maxResults > MAX_SEARCH_RESULTS) {
                console.warn(`Capping search to ${MAX_SEARCH_RESULTS} results (requested: ${maxResults})`);
                maxResults = MAX_SEARCH_RESULTS;
              }
              if (!options.json) {
                console.log(`\nSearching for issues (max ${maxResults})...\n`);
              }
              return runSearch({ maxResults });
            },
            (data) => {
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
            },
          ),
        );
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
        .action((issueUrl, options) =>
          executeAction(
            options,
            async () => (await import('./commands/vet.js')).runVet({ issueUrl }),
            (data) => {
              const { issue, recommendation, reasonsToApprove, reasonsToSkip, grade } = data;
              console.log(`\nVetting issue: ${issueUrl}\n`);
              console.log(`[${recommendation.toUpperCase()}] ${issue.repo}#${issue.number}: ${issue.title}`);
              console.log(`  URL: ${issue.url}`);
              console.log(`  Success grade: ${grade.letter} (${grade.reason})`);
              if (reasonsToApprove.length > 0) console.log(`  Approve: ${reasonsToApprove.join(', ')}`);
              if (reasonsToSkip.length > 0) console.log(`  Skip: ${reasonsToSkip.join(', ')}`);
            },
          ),
        );
    },
  },

  // ── Vet List ──────────────────────────────────────────────────────────
  {
    name: 'vet-list',
    register(program) {
      program
        .command('vet-list')
        .description('Re-vet all available issues in your curated issue list (#764)')
        .option('--path <file>', 'Path to issue list file (auto-detected if not specified)')
        .option('--concurrency <n>', 'Max parallel vet operations (default: 5)')
        .option('--prune', 'After vetting, remove completed/skipped/low-score items from the file')
        .option('--json', 'Output as JSON')
        .action((options) =>
          executeAction(
            options,
            async () => {
              const { runVetList } = await import('./commands/vet-list.js');
              const concurrency = options.concurrency ? parseInt(options.concurrency, 10) : undefined;
              if (concurrency !== undefined && (!Number.isFinite(concurrency) || concurrency < 1)) {
                throw new Error(`Invalid concurrency "${options.concurrency}". Must be a positive integer.`);
              }
              return runVetList({ issueListPath: options.path, concurrency, prune: options.prune });
            },
            (data) => {
              console.log(`\nRe-vetted ${data.summary.total} issues:\n`);
              console.log(`  Still available: ${data.summary.stillAvailable}`);
              console.log(`  Claimed:         ${data.summary.claimed}`);
              console.log(`  Closed:          ${data.summary.closed}`);
              console.log(`  Has PR:          ${data.summary.hasPR}`);
              console.log(`  Errors:          ${data.summary.errors}`);
              console.log('');
              for (const result of data.results) {
                const status =
                  result.listStatus === 'still_available'
                    ? '\u2705'
                    : result.listStatus === 'error'
                      ? '\u274c'
                      : '\u26a0\ufe0f';
                console.log(
                  `${status} [${result.listStatus}] ${result.issue.repo}#${result.issue.number}: ${result.issue.title}`,
                );
                if (result.errorMessage) {
                  console.log(`   Error: ${result.errorMessage}`);
                }
              }
              if (data.pruneResult) {
                console.log(`\nPruned ${data.pruneResult.removedCount} items from issue list.`);
              }
            },
          ),
        );
    },
  },

  // ── Skip Add ───────────────────────────────────────────────────────────
  {
    name: 'skip-add',
    localOnly: true,
    register(program) {
      program
        .command('skip-add <issue-url>')
        .description('Append an issue URL to the skipped-issues file (idempotent)')
        .option('--path <file>', 'Skipped-issues file path (falls back to config.skippedIssuesPath)')
        .option('--json', 'Output as JSON')
        .action((issueUrl, options) =>
          executeAction(
            options,
            async () => (await import('./commands/skip-add.js')).runSkipAdd({ issueUrl, skipFilePath: options.path }),
            (data) => {
              if (data.added) {
                console.log(`Added to skip list: ${data.url} (${data.date})`);
                console.log(`  File: ${data.path}`);
              } else {
                console.log(`Already on skip list: ${data.url}`);
                console.log(`  File: ${data.path}`);
              }
            },
          ),
        );
    },
  },

  // ── Track ──────────────────────────────────────────────────────────────
  {
    name: 'track',
    register(program) {
      program
        .command('track <pr-url>')
        .description('Fetch metadata for a PR (informational — v2 does not maintain a local tracking list)')
        .option('--json', 'Output as JSON')
        .action((prUrl, options) =>
          executeAction(
            options,
            async () => (await import('./commands/track.js')).runTrack({ prUrl }),
            (data) => {
              console.log(`\nPR: ${data.pr.repo}#${data.pr.number} - ${data.pr.title}`);
              console.log('Note: In v2, PRs are discovered automatically on each daily run — this command only');
              console.log('fetches metadata for inspection. Nothing is persisted locally.');
            },
          ),
        );
    },
  },

  // ── Untrack ────────────────────────────────────────────────────────────
  {
    name: 'untrack',
    localOnly: true,
    register(program) {
      program
        .command('untrack <pr-url>')
        .description('[DEPRECATED] No-op in v2. Use `shelve` to hide a PR from the daily digest.')
        .option('--json', 'Output as JSON')
        .action((prUrl, options) =>
          executeAction(
            options,
            async () => (await import('./commands/track.js')).runUntrack({ prUrl }),
            () => {
              // Stderr so scripts piping stdout don't see the deprecation notice.
              console.error('[DEPRECATED] `untrack` is a no-op in v2. PRs are fetched fresh on each daily run —');
              console.error('there is no local tracking list to remove from. Use `shelve` to hide a PR instead.');
            },
          ),
        );
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
        .action((prUrl, options) =>
          executeAction(
            options,
            async () => (await import('./commands/read.js')).runRead({ prUrl, all: options.all }),
            () => {
              console.log(
                'Note: In v2, PR read state is not tracked locally. PRs are fetched fresh on each daily run.',
              );
            },
          ),
        );
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
        .action((prUrl, options) =>
          executeAction(
            options,
            async () => (await import('./commands/comments.js')).runComments({ prUrl, showBots: options.bots }),
            async (data) => {
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
            },
          ),
        );
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
        .action((url, messageParts, options) =>
          executeAction(
            options,
            async () => {
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
              return runPost({ url, message });
            },
            (data) => {
              console.log(`Comment posted: ${data.commentUrl}`);
            },
          ),
        );
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
        .action((issueUrl, messageParts, options) =>
          executeAction(
            options,
            async () => {
              const { runClaim } = await import('./commands/comments.js');
              const message = messageParts.length > 0 ? messageParts.join(' ') : undefined;
              return runClaim({ issueUrl, message });
            },
            (data) => {
              console.log(`Issue claimed: ${data.commentUrl}`);
            },
          ),
        );
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
        .option('--list-keys', 'List every known config key with descriptions')
        .action((key, value, options) =>
          executeAction(
            options,
            async () =>
              (await import('./commands/config.js')).runConfig({
                key,
                value,
                listKeys: options.listKeys,
              }),
            (data) => {
              if ('keys' in data) {
                console.log('\nConfig keys\n');
                for (const def of data.keys) {
                  const flag = def.settableVia === 'auto' ? '(auto)' : `[${def.settableVia}]`;
                  console.log(`  ${def.key.padEnd(28)} ${flag.padEnd(10)} ${def.description}`);
                  console.log(`  ${''.padEnd(28)} ${''.padEnd(10)} value: ${def.valueHint}`);
                }
                console.log('');
              } else if ('config' in data) {
                console.log('\n\u2699\ufe0f Current Configuration:\n');
                console.log(JSON.stringify(data.config, null, 2));
              } else {
                console.log(`Set ${data.key} to: ${data.value}`);
              }
            },
          ),
        );
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
        .action((username, options) =>
          executeAction(
            options,
            async () => (await import('./commands/init.js')).runInit({ username }),
            (data) => {
              console.log(`\nUsername set to @${data.username}.`);
              console.log('Run `oss-autopilot daily` to fetch your open PRs from GitHub.');
            },
          ),
        );
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
        .action((options) =>
          executeAction(
            options,
            async () => (await import('./commands/setup.js')).runSetup({ reset: options.reset, set: options.set }),
            (data) => {
              if ('success' in data) {
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
            },
          ),
        );
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
        .action((options) =>
          executeAction(
            options,
            async () => (await import('./commands/setup.js')).runCheckSetup(),
            (data) => {
              if (data.setupComplete) {
                console.log('SETUP_COMPLETE');
                console.log(`username=${data.username}`);
              } else {
                console.log('SETUP_INCOMPLETE');
              }
            },
          ),
        );
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
        .action((filePath, options) =>
          executeAction(
            options,
            async () => (await import('./commands/parse-list.js')).runParseList({ filePath }),
            async (data) => {
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
            },
          ),
        );
    },
  },

  // ── Check Integration ──────────────────────────────────────────────────
  {
    name: 'orphan-files',
    localOnly: true,
    register(program) {
      program
        .command('orphan-files')
        .alias('check-integration')
        .description('Detect new files on this branch that no other file references')
        .option('--base <branch>', 'Base branch to compare against', 'main')
        .option('--json', 'Output as JSON')
        .action((options) =>
          executeAction(
            options,
            async () => (await import('./commands/check-integration.js')).runCheckIntegration({ base: options.base }),
            (data) => {
              if (data.newFiles.length === 0) {
                console.log('\nNo new code files to check.');
                return;
              }
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
            },
          ),
        );
    },
  },

  // ── Doctor ─────────────────────────────────────────────────────────────
  {
    name: 'doctor',
    localOnly: true,
    register(program) {
      program
        .command('doctor')
        .description('Run a system-health diagnostic (token, bundle, state, scout, rate limit)')
        .option('--json', 'Output as JSON')
        .action((options) =>
          executeAction(
            options,
            async () => (await import('./commands/doctor.js')).runDoctor(),
            (data) => {
              console.log('\nSystem health\n');
              for (const check of data.checks) {
                const icon = check.status === 'ok' ? '[OK]   ' : check.status === 'warning' ? '[WARN] ' : '[ERR]  ';
                console.log(`${icon}${check.name}: ${check.message}`);
                if (check.remediation) {
                  console.log(`       ↳ ${check.remediation}`);
                }
              }
              console.log(
                `\n${data.summary.ok} ok / ${data.summary.warnings} warning / ${data.summary.errors} error\n`,
              );
            },
          ),
        );
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
        .action((options) =>
          executeAction(
            options,
            async () =>
              (await import('./commands/local-repos.js')).runLocalRepos({
                scan: options.scan,
                paths: options.paths,
              }),
            (data) => {
              if (data.fromCache) {
                console.log(`\n\ud83d\udcc1 Local Repos (cached ${data.cachedAt})\n`);
                printRepos(data.repos);
              } else {
                console.log(`Found ${Object.keys(data.repos).length} repos:\n`);
                printRepos(data.repos);
              }
            },
          ),
        );
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
        .option('--compact', 'Reduce JSON payload by omitting summary, repoGroups, and full failure details')
        .action(async (options) => {
          try {
            const { runStartup } = await import('./commands/startup.js');
            const data = await runStartup();
            if (options.json) {
              if (options.compact) {
                const { toCompactStartupOutput } = await import('./formatters/json.js');
                outputJson(toCompactStartupOutput(data));
              } else {
                outputJson(data);
              }
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
  // Delegates to runShelve so the CLI emits the same `ShelveOutput`
  // ({shelved, url}) as the library export + MCP tool. Previously it called
  // runMove and emitted `MoveOutput` ({url, target, description}), which
  // drifted from the pinned contract test and broke plugin consumers
  // reading `data.shelved`. See issue #1037.
  {
    name: 'shelve',
    localOnly: true,
    register(program) {
      program
        .command('shelve <pr-url>')
        .description('Shelve a PR (exclude from capacity and actionable issues)')
        .option('--json', 'Output as JSON')
        .action((prUrl, options) =>
          executeAction(
            options,
            async () => (await import('./commands/shelve.js')).runShelve({ prUrl }),
            (data) => {
              console.log(data.shelved ? `Shelved ${data.url}` : `Already shelved: ${data.url}`);
            },
          ),
        );
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
        .action((prUrl, options) =>
          executeAction(
            options,
            async () => (await import('./commands/shelve.js')).runUnshelve({ prUrl }),
            (data) => {
              console.log(data.unshelved ? `Unshelved ${data.url}` : `Not currently shelved: ${data.url}`);
            },
          ),
        );
    },
  },

  // ── Move ───────────────────────────────────────────────────────────
  {
    name: 'move',
    localOnly: true,
    register(program) {
      program
        .command('move <pr-url> <target>')
        .description('Move a PR between states: attention, waiting, shelved, or auto (reset to computed)')
        .option('--json', 'Output as JSON')
        .action((prUrl, target, options) =>
          executeAction(
            options,
            async () => (await import('./commands/move.js')).runMove({ prUrl, target }),
            (data) => {
              console.log(data.description);
            },
          ),
        );
    },
  },

  // ── Dismiss ────────────────────────────────────────────────────────────
  {
    name: 'dismiss',
    localOnly: true,
    register(program) {
      program
        .command('dismiss <url>')
        .description('Dismiss notifications for an issue (resurfaces on new activity)')
        .option('--json', 'Output as JSON')
        .action((url, options) =>
          executeAction(
            options,
            async () => (await import('./commands/dismiss.js')).runDismiss({ url }),
            (data) => {
              if (data.dismissed) {
                console.log(`Dismissed: ${url}`);
                console.log('Notifications are now muted.');
                console.log('New responses after this point will resurface automatically.');
              } else {
                console.log('Already dismissed.');
              }
            },
          ),
        );
    },
  },

  // ── Undismiss ──────────────────────────────────────────────────────────
  {
    name: 'undismiss',
    localOnly: true,
    register(program) {
      program
        .command('undismiss <url>')
        .description('Undismiss an issue (re-enable notifications)')
        .option('--json', 'Output as JSON')
        .action((url, options) =>
          executeAction(
            options,
            async () => (await import('./commands/dismiss.js')).runUndismiss({ url }),
            (data) => {
              if (data.undismissed) {
                console.log(`Undismissed: ${url}`);
                console.log('Notifications are active again.');
              } else {
                console.log('Was not dismissed.');
              }
            },
          ),
        );
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
        .action((prUrl, status, options) =>
          executeAction(
            options,
            async () => {
              const validStatuses = ['needs_addressing', 'waiting_on_maintainer'];
              if (!validStatuses.includes(status)) {
                throw new Error(`Invalid status "${status}". Must be one of: ${validStatuses.join(', ')}`);
              }
              const target = status === 'needs_addressing' ? 'attention' : 'waiting';
              const { runMove } = await import('./commands/move.js');
              return runMove({ prUrl, target });
            },
            (data) => {
              console.log(data.description);
            },
          ),
        );
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
        .action((prUrl, options) =>
          executeAction(
            options,
            async () => (await import('./commands/move.js')).runMove({ prUrl, target: 'auto' }),
            (data) => {
              console.log(data.description);
            },
          ),
        );
    },
  },

  // ── PR Template ──────────────────────────────────────────────────────
  {
    name: 'pr-template',
    register(program) {
      program
        .command('pr-template <repo>')
        .description("Fetch a repository's PR description template")
        .option('--json', 'Output as JSON')
        .action((repo, options) =>
          executeAction(
            options,
            async () => (await import('./commands/pr-template.js')).runPRTemplate({ repo }),
            (data) => {
              if (data.template) {
                console.log(`\nPR template found at: ${data.source}\n`);
                console.log(data.template);
              } else if (data.error) {
                console.error(`\nWarning: Could not check for PR template: ${data.error}`);
              } else {
                console.log('\nNo PR template found for this repository.');
              }
            },
          ),
        );
    },
  },

  // ── Detect Formatters ────────────────────────────────────────────────
  {
    name: 'detect-formatters',
    localOnly: true,
    register(program) {
      program
        .command('detect-formatters [repo-path]')
        .description('Detect formatters and linters configured in a repository')
        .option('--ci-log <path>', 'Analyze CI log file for formatting failures')
        .option('--json', 'Output as JSON')
        .action((repoPath, options) =>
          executeAction(
            options,
            async () =>
              (await import('./commands/detect-formatters.js')).runDetectFormatters({
                repoPath,
                ciLog: options.ciLog,
              }),
            (data) => {
              if (data.formatters.length === 0) {
                console.log('\nNo formatters detected.');
              } else {
                console.log(`\nDetected ${data.formatters.length} formatter(s):\n`);
                for (const f of data.formatters) {
                  console.log(`  ${f.name} (${f.configPath})`);
                  console.log(`    Fix:   ${f.fixCommand}`);
                  console.log(`    Check: ${f.checkCommand}`);
                }
              }
              if (data.packageJsonScripts.length > 0) {
                console.log('\npackage.json scripts:');
                for (const s of data.packageJsonScripts) {
                  console.log(`  ${s.name}: ${s.command}`);
                }
              }
              if (data.ciDiagnosis) {
                console.log('');
                if (data.ciDiagnosis.isFormattingFailure) {
                  console.log(`CI Diagnosis: Formatting failure detected (${data.ciDiagnosis.formatter})`);
                  console.log(`  Fix: ${data.ciDiagnosis.fixCommand}`);
                  console.log(`  Evidence: ${data.ciDiagnosis.evidence.join(', ')}`);
                } else {
                  console.log('CI Diagnosis: No formatting failure detected.');
                }
              }
            },
          ),
        );
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
