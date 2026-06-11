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
import { outputJson, outputJsonError, outputJsonValidated } from './formatters/json.js';
import type { ZodType } from 'zod';

interface CLICommandDef {
  /** Command name (used to build the local-only set for the preAction hook). */
  name: string;
  /** If true, skip the preAction GitHub token check. */
  localOnly?: boolean;
  /** Register this command on the given Commander program. */
  register(program: Command): void;
}

/**
 * Shared error handler for CLI action catch blocks. Exported so cli.ts can
 * route preAction-hook rejections (corrupt Gist, missing gist scope, rate
 * limit during bootstrap) through the same formatting instead of letting
 * them surface as raw unhandled rejections (#1386).
 */
export function handleCommandError(err: unknown, json?: boolean): never {
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
  /** Optional Zod schema. When provided, the JSON output is validated against
   * it (#1105). On mismatch, executeAction throws and the standard error
   * envelope fires — surfacing a contract drift instead of silently shipping
   * a broken shape.
   *
   * Typed as `ZodType<unknown>` because validation is a runtime concern: the
   * schema runs `safeParse(data: unknown)`, and Zod-inferred union types do
   * not always structurally match hand-written TS union interfaces. The test
   * harness still catches drift via `safeParse`. */
  schema?: ZodType<unknown>,
): Promise<void> {
  try {
    const data = await run();
    if (options.json) {
      if (schema) {
        outputJsonValidated(schema, data);
      } else {
        outputJson(data);
      }
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
  // ── Manifest (#1190) ───────────────────────────────────────────────────
  // Lets the plugin's session-start hook verify CLI/plugin contract drift —
  // it diffs the registered commands against `.claude-plugin/expected-cli-contract.json`
  // and warns when the markdown layer references commands the CLI no longer
  // exposes. Local-only: no GitHub access needed.
  {
    name: 'manifest',
    localOnly: true,
    register(program) {
      program
        .command('manifest')
        .description('Print the CLI contract (registered commands + version) for plugin/MCP introspection (#1190)')
        .option('--json', 'Output as JSON')
        .action(async (options) => {
          const { ManifestOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => {
              const { getCLIVersion } = await import('./core/index.js');
              return {
                schemaVersion: 1 as const,
                cliVersion: getCLIVersion(),
                commands: commands
                  .map((c) => ({ name: c.name, localOnly: !!c.localOnly }))
                  .sort((a, b) => a.name.localeCompare(b.name)),
              };
            },
            (data) => {
              console.log(`oss-autopilot v${data.cliVersion} (${data.commands.length} commands)`);
            },
            ManifestOutputSchema,
          );
        });
    },
  },

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
                const { toCompactDailyOutput, outputJsonValidated, CompactDailyOutputSchema } =
                  await import('./formatters/json.js');
                outputJsonValidated(CompactDailyOutputSchema, toCompactDailyOutput(data));
              } else {
                const { outputJsonValidated, DailyOutputSchema } = await import('./formatters/json.js');
                outputJsonValidated(DailyOutputSchema, data);
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
        .action(async (options) => {
          const { StatusOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            StatusOutputSchema,
          );
        });
    },
  },

  // ── Strategy ───────────────────────────────────────────────────────────
  {
    name: 'strategy',
    localOnly: true,
    register(program) {
      program
        .command('strategy')
        .description(
          'On-demand contribution-strategy snapshot via the typed `computeStrategy` function (#1243). ' +
            'Always runs against local state regardless of the auto-display cadence gate; returns ' +
            'null + message when fewer than the minimum tracked PRs are available.',
        )
        .option('--json', 'Output as JSON')
        .action(async (options) => {
          const { StrategyOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => (await import('./commands/strategy.js')).runStrategy(),
            (data) => {
              if (!data.strategy) {
                console.log(`\n${data.message ?? 'Strategy unavailable.'}\n`);
                return;
              }
              const { profile, capacity, patterns, recommendations } = data.strategy;
              const mergeRatePct = Math.round(profile.mergeRate * 100);
              console.log(`\nProfile: ${profile.style}`);
              console.log(
                `${profile.totalPRs} PRs tracked, ${profile.mergedCount} merged (${mergeRatePct}% merge rate).`,
              );
              if (profile.primaryLanguages.length > 0) {
                console.log(`Top languages: ${profile.primaryLanguages.join(', ')}`);
              }
              if (profile.favoriteRepos.length > 0) {
                console.log(`Top repos: ${profile.favoriteRepos.join(', ')}`);
              }
              console.log(
                `\nCapacity: ${capacity.openPRCount} open, ${capacity.dormantPRCount} dormant across ${capacity.dormantRepoCount} repo(s).`,
              );
              if (capacity.overExtended) {
                console.log(`Overextended — suggested action: ${capacity.suggestedAction ?? 'review dormant PRs'}.`);
              }
              console.log(`\nTrajectory: ${patterns.trajectoryDirection}`);
              const dist = patterns.prTypeDistribution;
              const parts: Array<[string, number]> = [];
              for (const [k, v] of Object.entries(dist)) {
                if (typeof v === 'number' && v > 0) parts.push([k, v]);
              }
              if (parts.length > 0) {
                console.log(`PR types (recent): ${parts.map(([k, v]) => `${k}=${v}`).join(', ')}`);
              }
              if (recommendations.avoidPatterns.length > 0) {
                console.log(`\nWatch for: ${recommendations.avoidPatterns.join('; ')}`);
              }
              console.log('\nRun with --json for structured output');
            },
            StrategyOutputSchema,
          );
        });
    },
  },

  // ── State ──────────────────────────────────────────────────────────────
  {
    name: 'state',
    register(program) {
      program
        .command('state')
        .description(
          'Manage state persistence (local/gist). Gist mode uses ETag-based optimistic concurrency: ' +
            'a concurrent push from another machine surfaces as a CONCURRENCY error rather than silently overwriting (#1115).',
        )
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
        .action(async (count, options) => {
          const { SearchOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
              if (data.hiddenOwnPRCount > 0) {
                console.log(`Hidden: ${data.hiddenOwnPRCount} candidate(s) were issues you already have open PRs for.`);
              }
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
            SearchOutputSchema,
          );
        });
    },
  },

  // ── Features ───────────────────────────────────────────────────────────
  // scout 0.9.0 (#97/#98/#99): feature-scoped opportunities in repos with
  // 3+ merged PRs, split into quick-wins / bigger-bets buckets.
  {
    name: 'features',
    register(program) {
      program
        .command('features [count]')
        .description('Find feature-scoped opportunities in repos with 3+ merged PRs')
        .option('--json', 'Output as JSON')
        .option('--anchor-threshold <n>', 'Override featuresAnchorThreshold (1-50)')
        .option('--split-ratio <r>', 'Override featuresSplitRatio (0-1)')
        .action(async (count, options) => {
          const { FeaturesOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => {
              const { runFeatures, MAX_FEATURES_RESULTS } = await import('./commands/features.js');
              let maxResults = 10;
              if (count !== undefined) {
                const parsed = Number(count);
                if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
                  throw new Error(`Invalid count "${count}". Must be a positive integer.`);
                }
                maxResults = parsed;
              }
              if (maxResults > MAX_FEATURES_RESULTS) {
                console.warn(`Capping features to ${MAX_FEATURES_RESULTS} results (requested: ${maxResults})`);
                maxResults = MAX_FEATURES_RESULTS;
              }
              let anchorThreshold: number | undefined;
              if (options.anchorThreshold !== undefined) {
                const parsed = Number(options.anchorThreshold);
                if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
                  throw new Error(
                    `Invalid --anchor-threshold "${options.anchorThreshold}". Must be an integer in [1, 50].`,
                  );
                }
                anchorThreshold = parsed;
              }
              let splitRatio: number | undefined;
              if (options.splitRatio !== undefined) {
                const parsed = Number(options.splitRatio);
                if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
                  throw new Error(`Invalid --split-ratio "${options.splitRatio}". Must be a number in [0, 1].`);
                }
                splitRatio = parsed;
              }
              if (!options.json) {
                console.log(`\nSearching for feature opportunities (max ${maxResults})...\n`);
              }
              return runFeatures({ maxResults, anchorThreshold, splitRatio });
            },
            (data) => {
              if (data.anchorRepos.length > 0) {
                console.log(`Anchor repos (${data.anchorRepos.length}): ${data.anchorRepos.join(', ')}`);
                console.log('');
              }
              if (data.quickWins.length === 0 && data.biggerBets.length === 0) {
                if (data.rateLimitWarning) {
                  console.warn(`\n${data.rateLimitWarning}\n`);
                } else if (data.message) {
                  console.log(data.message);
                } else {
                  console.log('No feature opportunities found.');
                }
                return;
              }
              if (data.rateLimitWarning) {
                console.warn(`\n${data.rateLimitWarning}\n`);
              }
              const printBucket = (heading: string, candidates: typeof data.quickWins) => {
                if (candidates.length === 0) return;
                console.log(`${heading} (${candidates.length}):\n`);
                for (const candidate of candidates) {
                  const { issue, recommendation, reasonsToApprove, reasonsToSkip, viabilityScore } = candidate;
                  console.log(`[${recommendation.toUpperCase()}] ${issue.repo}#${issue.number}: ${issue.title}`);
                  console.log(`  URL: ${issue.url}`);
                  console.log(`  Viability: ${viabilityScore}/100`);
                  if (reasonsToApprove.length > 0) console.log(`  Approve: ${reasonsToApprove.join(', ')}`);
                  if (reasonsToSkip.length > 0) console.log(`  Skip: ${reasonsToSkip.join(', ')}`);
                  console.log('---');
                }
                console.log('');
              };
              printBucket('Quick wins', data.quickWins);
              printBucket('Bigger bets', data.biggerBets);
            },
            FeaturesOutputSchema,
          );
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

  // ── Verify Issue ───────────────────────────────────────────────────────
  {
    name: 'verify-issue',
    register(program) {
      program
        .command('verify-issue <issue-url>')
        .description('Deterministically verify issue state and linked-PR claims before vetting (#1353, #1354)')
        .option('--json', 'Output as JSON')
        .action(async (issueUrl, options) => {
          const { VerifyIssueOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => (await import('./commands/verify-issue.js')).runVerifyIssue({ issueUrl }),
            (data) => {
              console.log(`\n${data.owner}/${data.repo}#${data.number}: ${data.title}`);
              const reasonLabel = data.stateReason ? ` (${data.stateReason})` : '';
              console.log(`  State: ${data.state}${reasonLabel}${data.closedAt ? ` — closed ${data.closedAt}` : ''}`);
              console.log(`  Verdict: ${data.verdict} — ${data.verdictReason}`);
              if (data.assignees.length > 0) console.log(`  Assignees: ${data.assignees.join(', ')}`);
              for (const pr of data.linkedPRs) {
                const own = pr.isOwn ? ' (yours)' : '';
                const draft = pr.isDraft ? ' [draft]' : '';
                console.log(
                  `  PR #${pr.number} [${pr.state}]${draft} ${pr.linkType} by ${pr.author ?? 'ghost'}${own}: ${pr.url}`,
                );
              }
            },
            VerifyIssueOutputSchema,
          );
        });
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
              console.log(`  Stalled PR:      ${data.summary.hasStalledPR}`);
              console.log(`  Errors:          ${data.summary.errors}`);
              console.log('');
              for (const result of data.results) {
                const status =
                  result.listStatus === 'still_available'
                    ? '\u2705'
                    : result.listStatus === 'error'
                      ? '\u274c'
                      : '\u26a0\ufe0f';
                const annotation = result.listStatus === 'has_stalled_pr' ? ' (stalled PR, revive opportunity)' : '';
                console.log(
                  `${status} [${result.listStatus}] ${result.issue.repo}#${result.issue.number}: ${result.issue.title}${annotation}`,
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
        .action(async (issueUrl, options) => {
          const { SkipAddOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            SkipAddOutputSchema,
          );
        });
    },
  },

  // ── List Move Tier ─────────────────────────────────────────────────────
  {
    name: 'list-move-tier',
    localOnly: true,
    register(program) {
      program
        .command('list-move-tier <issue-url>')
        .description('Move an issue between Pursue / Maybe / Skip sections of a curated list (#1107)')
        .requiredOption('--tier <tier>', 'Target tier: pursue, maybe, or skip')
        .requiredOption('--list-path <file>', 'Path to the markdown issue list')
        .option('--json', 'Output as JSON')
        .action(async (issueUrl, options) => {
          const { ListMoveTierOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => {
              const tier = String(options.tier).toLowerCase();
              if (tier !== 'pursue' && tier !== 'maybe' && tier !== 'skip') {
                throw new Error(`Invalid --tier "${options.tier}". Must be one of: pursue, maybe, skip.`);
              }
              return (await import('./commands/list-move-tier.js')).runListMoveTier({
                issueUrl,
                tier,
                listPath: options.listPath,
              });
            },
            (data) => {
              if (data.moved) {
                const fromLabel = data.fromTier ? ` (from ${data.fromTier})` : '';
                const countLabel = data.count > 1 ? ` × ${data.count}` : '';
                console.log(`Moved ${data.url} to ${data.toTier}${fromLabel}${countLabel}`);
                console.log(`  File: ${data.filePath}`);
              } else {
                console.log(`No move: ${data.url} — ${data.reason ?? 'unchanged'}`);
                console.log(`  File: ${data.filePath}`);
              }
            },
            ListMoveTierOutputSchema,
          );
        });
    },
  },

  // ── List Mark Done ─────────────────────────────────────────────────────
  {
    name: 'list-mark-done',
    localOnly: true,
    register(program) {
      program
        .command('list-mark-done <issue-url>')
        .description('Mark an issue line in a curated list as done with strikethrough + Done sub-bullet (#1299)')
        .requiredOption('--pr-url <url>', 'PR URL to record on the Done sub-bullet')
        .requiredOption('--pr-status <text>', 'Trailing status, e.g. "merged" or "CI passing"')
        .requiredOption('--list-path <file>', 'Path to the markdown issue list')
        .option('--json', 'Output as JSON')
        .action(async (issueUrl, options) => {
          const { ListMarkDoneOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => {
              const result = await (
                await import('./commands/list-mark-done.js')
              ).runMarkIssueListItemDone({
                issueUrl,
                prUrl: options.prUrl,
                prStatus: options.prStatus,
                listPath: options.listPath,
              });
              // Not-found now throws ValidationError inside the command (#1406),
              // so library and CLI consumers see the same failure — no CLI-layer
              // re-throw needed (mirrors list-move-tier after #1355).
              return result;
            },
            (data) => {
              if (data.marked) {
                const headingNote = data.repoHeadingStruck ? ' (repo heading also struck)' : '';
                console.log(`Marked ${data.url} done${headingNote}`);
                console.log(`  File: ${data.filePath}`);
                console.log(`  Remaining under repo: ${data.remainingUnderRepo}`);
              } else {
                // Reach here only on the idempotent "already marked done" path.
                console.log(`No mark: ${data.url} — ${data.reason ?? 'unchanged'}`);
                console.log(`  File: ${data.filePath}`);
              }
            },
            ListMarkDoneOutputSchema,
          );
        });
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

  // The v1→v2 `untrack` and `read` stubs were removed in v4 (#1133). Use
  // `shelve`/`unshelve` to hide PRs from the daily digest. Scripts that hard-
  // coded these commands now get an "unknown command" error from commander.

  // ── Compliance Score ───────────────────────────────────────────────────
  {
    name: 'compliance-score',
    register(program) {
      program
        .command('compliance-score <pr-url>')
        .description('Score a PR against opensource.guide best practices (#1245)')
        .option('--json', 'Output as JSON')
        .action(async (prUrl, options) => {
          const { ComplianceScoreOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => (await import('./commands/compliance-score.js')).runComplianceScore({ prUrl }),
            (data) => {
              console.log(`\n${data.emoji} PR ${data.pr.repo}#${data.pr.number}: ${data.pr.title}`);
              console.log(`Score: ${data.score}/100 — ${data.rating.replace(/_/g, ' ')}\n`);
              console.log('Checks:');
              for (const [name, check] of Object.entries(data.checks)) {
                const icon = check.status === 'pass' ? 'OK ' : check.status === 'warn' ? 'WARN' : 'FAIL';
                console.log(`  [${icon}] ${name} (${check.weight}%) — ${check.detail}`);
              }
            },
            ComplianceScoreOutputSchema,
          );
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
        .action((prUrl, options) =>
          executeAction(
            options,
            async () => (await import('./commands/comments.js')).runComments({ prUrl, showBots: options.bots }),
            async (data) => {
              const { formatRelativeTime } = await import('./core/dates.js');
              // Bodies arrive `<github-content>`-fenced for agent consumers
              // (#1372); unwrap for human terminal display.
              const { safeExtractFromFence } = await import('./core/untrusted-content.js');
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
                    console.log(`> ${safeExtractFromFence(review.body).split('\n').join('\n> ')}\n`);
                  }
                }
              }

              if (data.reviewComments.length > 0) {
                console.log('### Inline Comments (newest first)\n');
                for (const comment of data.reviewComments) {
                  const time = formatRelativeTime(comment.createdAt);
                  console.log(`**@${comment.user}** on \`${comment.path}\` - ${time}`);
                  console.log(`> ${safeExtractFromFence(comment.body).split('\n').join('\n> ')}`);
                  console.log('');
                }
              }

              if (data.issueComments.length > 0) {
                console.log('### Discussion (newest first)\n');
                for (const comment of data.issueComments) {
                  const time = formatRelativeTime(comment.createdAt);
                  console.log(`**@${comment.user}** - ${time}`);
                  console.log(
                    `> ${comment.body == null ? '' : safeExtractFromFence(comment.body).split('\n').join('\n> ')}\n`,
                  );
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
        .action(async (url, messageParts, options) => {
          const { PostOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => {
              let message: string;
              if (options.stdin) {
                const chunks: Buffer[] = [];
                for await (const chunk of process.stdin) {
                  chunks.push(chunk);
                }
                message = Buffer.concat(chunks).toString('utf8').trim();
              } else {
                message = messageParts.join(' ');
              }
              const { runPost } = await import('./commands/comments.js');
              return runPost({ url, message });
            },
            (data) => {
              console.log(`Comment posted: ${data.commentUrl}`);
            },
            PostOutputSchema,
          );
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
          const { ClaimOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => {
              const { runClaim } = await import('./commands/comments.js');
              const message = messageParts.length > 0 ? messageParts.join(' ') : undefined;
              return runClaim({ issueUrl, message });
            },
            (data) => {
              console.log(`Issue claimed: ${data.commentUrl}`);
            },
            ClaimOutputSchema,
          );
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
        .option('--list-keys', 'List every known config key with descriptions')
        .action(async (key, value, options) => {
          const { ConfigCommandOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            ConfigCommandOutputSchema,
          );
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
          const { InitOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => (await import('./commands/init.js')).runInit({ username }),
            (data) => {
              console.log(`\nUsername set to @${data.username}.`);
              console.log('Run `oss-autopilot daily` to fetch your open PRs from GitHub.');
            },
            InitOutputSchema,
          );
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
          const { SetupOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            SetupOutputSchema,
          );
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
          const { CheckSetupOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            CheckSetupOutputSchema,
          );
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
            if (isNaN(port) || port < 1 || port > 65_535) {
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
          const { ParseIssueListOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => (await import('./commands/parse-list.js')).runParseList({ filePath }),
            async (data) => {
              const path = await import('node:path');
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
            ParseIssueListOutputSchema,
          );
        });
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
        .action(async (options) => {
          const { CheckIntegrationOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            CheckIntegrationOutputSchema,
          );
        });
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
        .action(async (options) => {
          const { DoctorOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            DoctorOutputSchema,
          );
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
          const { LocalReposOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            LocalReposOutputSchema,
          );
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
        .action(async (prUrl, status, options) => {
          const { MoveOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            MoveOutputSchema,
          );
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
          const { MoveOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => (await import('./commands/move.js')).runMove({ prUrl, target: 'auto' }),
            (data) => {
              console.log(data.description);
            },
            MoveOutputSchema,
          );
        });
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
        .action(async (repo, options) => {
          const { PRTemplateOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            PRTemplateOutputSchema,
          );
        });
    },
  },

  // ── Repo Vet (#1271) ────────────────────────────────────────────────
  {
    name: 'repo-vet',
    register(program) {
      program
        .command('repo-vet <repo>')
        .description('Compute repo health rubric (1–10 score + verdict) for `owner/repo`')
        .option('--json', 'Output as JSON')
        .action(async (repo, options) => {
          const { RepoVetOutputSchema } = await import('./formatters/json.js');
          await executeAction(
            options,
            async () => (await import('./commands/repo-vet.js')).runRepoVet({ repo }),
            (data) => {
              const verdictEmoji =
                data.rubricVerdict === 'recommended'
                  ? '✅'
                  : data.rubricVerdict === 'proceed_with_caution'
                    ? '⚠️'
                    : '❌';
              console.log(
                `\n${verdictEmoji} ${data.repoSlug}: ${data.rubricScore.toFixed(1)}/10 — ${data.rubricVerdict}`,
              );
              console.log(`  Stars: ${data.repoMeta.stars}  Last push: ${data.repoMeta.lastPushed}`);
              if (data.prMergeTime.medianDays !== null) {
                console.log(
                  `  Median merge time (90d): ${data.prMergeTime.medianDays.toFixed(1)} days (${data.prMergeTime.sampleSize} samples)`,
                );
              }
              if (data.mergeRate.percent !== null) {
                console.log(
                  `  Merge rate (90d): ${data.mergeRate.percent.toFixed(0)}% (${data.mergeRate.merged}/${data.mergeRate.opened})`,
                );
              }
            },
            RepoVetOutputSchema,
          );
        });
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
        .action(async (repoPath, options) => {
          const { DetectFormattersOutputSchema } = await import('./formatters/json.js');
          await executeAction(
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
            DetectFormattersOutputSchema,
          );
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

  // ── Guidelines (#867) ──────────────────────────────────────────────────
  {
    name: 'guidelines',
    // Skip the preAction auth gate so `guidelines view` works in local mode
    // (returns storageMode: 'local-unavailable'). Subcommands that DO need
    // GitHub auth — `store`/`reset` (Gist) and `fetch-corpus` (PR comment
    // fetch) — call `requireGitHubToken()` themselves and surface a clear
    // error. Pairs with the parent-chain walk in cli.ts preAction (#1208 M2).
    localOnly: true,
    register(program) {
      const group = program
        .command('guidelines')
        .description('Manage per-repo learning guidelines extracted from PR feedback (#867)');

      group
        .command('list')
        .description('List repos with stored guidelines (always empty in local mode)')
        .option('--json', 'Output as JSON')
        .action(async (options) => {
          await executeAction(
            options,
            async () => (await import('./commands/guidelines.js')).runGuidelinesList(),
            (data) => {
              if (data.count === 0) {
                console.log(`No guidelines stored for any repo (storage: ${data.storageMode}).`);
              } else {
                console.log(`${data.count} repo(s) with stored guidelines:`);
                for (const repo of data.repos) console.log(`  ${repo}`);
              }
            },
          );
        });

      group
        .command('view')
        .description('Read the per-repo guidelines file (returns null when none exists or in local mode)')
        .requiredOption('--repo <owner/repo>', 'Repository identifier')
        .option('--json', 'Output as JSON')
        .action(async (options) => {
          await executeAction(
            options,
            async () => (await import('./commands/guidelines.js')).runGuidelinesView({ repo: options.repo }),
            (data) => {
              if (data.content === null) {
                console.log(`No guidelines stored for ${data.repo} (storage: ${data.storageMode}).`);
              } else {
                console.log(`# Guidelines for ${data.repo} (${data.byteSize} bytes)\n`);
                console.log(data.content);
              }
            },
          );
        });

      group
        .command('store')
        .description('Persist per-repo guidelines (overwrites). Reads markdown content from --content or stdin.')
        .requiredOption('--repo <owner/repo>', 'Repository identifier')
        .option('--content <markdown>', 'Markdown content. If omitted, reads from stdin.')
        .option('--json', 'Output as JSON')
        .action(async (options) => {
          await executeAction(
            options,
            async () => {
              const content = options.content ?? (await readStdin());
              return (await import('./commands/guidelines.js')).runGuidelinesStore({ repo: options.repo, content });
            },
            (data) => {
              console.log(`Stored ${data.byteSize} bytes of guidelines for ${data.repo}.`);
            },
          );
        });

      group
        .command('reset')
        .description('Tombstone the guidelines file for a repo (subsequent reads return null)')
        .requiredOption('--repo <owner/repo>', 'Repository identifier')
        .option('--json', 'Output as JSON')
        .action(async (options) => {
          await executeAction(
            options,
            async () => (await import('./commands/guidelines.js')).runGuidelinesReset({ repo: options.repo }),
            (data) => {
              console.log(
                data.deleted
                  ? `Reset guidelines for ${data.repo}.`
                  : `No guidelines existed for ${data.repo}; nothing to reset.`,
              );
            },
          );
        });

      group
        .command('fetch-corpus')
        .description('Fetch raw PR comment bundles for the host extract-learnings prompt to consume')
        .requiredOption('--repo <owner/repo>', 'Repository identifier')
        .option('--limit <n>', 'Max PRs to process (1-10, default 5)', (v: string) => parseInt(v, 10))
        .option('--force', 'Re-fetch even when commentsFetchedAt is already set')
        .option('--json', 'Output as JSON')
        .action(async (options) => {
          await executeAction(
            options,
            async () =>
              (await import('./commands/guidelines.js')).runFetchCorpus({
                repo: options.repo,
                limit: options.limit,
                forceRefetch: options.force,
              }),
            (data) => {
              console.log(`Fetched ${data.prCount} PR comment bundle(s) for ${data.repo}.`);
              if (data.skipped > 0) {
                console.log(`  Skipped ${data.skipped} PR(s) already processed (use --force to re-fetch).`);
              }
            },
          );
        });
    },
  },
];

/** Read full stdin content. Used when `guidelines store` content isn't passed inline. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('No --content provided and stdin is a TTY. Pipe content or pass --content "...".');
  }
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
