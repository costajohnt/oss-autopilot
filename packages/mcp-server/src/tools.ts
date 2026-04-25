/**
 * MCP tool registrations for all OSS Autopilot CLI commands.
 *
 * Each CLI command is registered as an MCP tool with:
 *   - Zod input schema matching the command's options
 *   - Annotations indicating read-only vs mutating behavior
 *   - wrapTool() helper for uniform ok/err handling
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  runDaily,
  runStatus,
  runSearch,
  runVet,
  runVetList,
  runTrack,
  runComments,
  runPost,
  runClaim,
  runConfig,
  runInit,
  runSetup,
  runCheckSetup,
  runStartup,
  runDismiss,
  runUndismiss,
  runMove,
  MAX_SEARCH_RESULTS,
} from '@oss-autopilot/core/commands';
import { errorMessage, getSetupKeys, getConfigKeys } from '@oss-autopilot/core';

// ── GitHub URL validation (#1053) ─────────────────────────────────────
// Previously every `url` / `prUrl` / `issueUrl` was `z.string()` with no
// validation — an LLM could pass nonsense and the error surfaced only at
// `runPost` / `runClaim`. These schemas put the constraint at the MCP
// boundary so invalid URLs fail with `InvalidParams` before any network or
// state mutation runs.

const GITHUB_ISSUE_URL_REGEX = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;
const GITHUB_PR_URL_REGEX = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
const GITHUB_ISSUE_OR_PR_URL_REGEX = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+$/;

const githubIssueUrlSchema = z
  .string()
  .url()
  .regex(GITHUB_ISSUE_URL_REGEX, 'Must be a GitHub issue URL like https://github.com/owner/repo/issues/123');
const githubPrUrlSchema = z
  .string()
  .url()
  .regex(GITHUB_PR_URL_REGEX, 'Must be a GitHub PR URL like https://github.com/owner/repo/pull/123');
const githubIssueOrPrUrlSchema = z
  .string()
  .url()
  .regex(
    GITHUB_ISSUE_OR_PR_URL_REGEX,
    'Must be a GitHub issue or PR URL like https://github.com/owner/repo/issues/123 or /pull/123',
  );

// Known config-key enum (#1053) sourced from @oss-autopilot/core so it stays
// in sync with the CLI surface. Union of setup + config keys — the config
// tool delegates to both `runConfig` and `runSetup` internally.
const KNOWN_CONFIG_KEYS = Array.from(new Set([...getSetupKeys(), ...getConfigKeys()]));
const configKeySchema = KNOWN_CONFIG_KEYS.length > 0 ? z.enum(KNOWN_CONFIG_KEYS as [string, ...string[]]) : z.string(); // defensive: if the registry is empty, fall back to the old shape

/** One-shot Gist persistence activation (checked once per process). */
let gistInitDone = false;
async function ensureGistInit(): Promise<void> {
  if (gistInitDone) return;
  gistInitDone = true;

  // Gist init errors (GistPermissionError, network) propagate to wrapTool's catch.
  // Shared helper in core unifies the "peek at state file, check persistence mode,
  // pre-set singleton" logic that was previously duplicated with cli.ts (#1000).
  const { ensureGistPersistence, getGitHubTokenAsync } = await import('@oss-autopilot/core');
  const token = await getGitHubTokenAsync();
  await ensureGistPersistence(token);
}

/** Standard MCP text content result. */
function ok(data: unknown) {
  // Explicit `undefined` guard (#1059 L5). `JSON.stringify(undefined)` returns
  // the value `undefined` (not `"undefined"`), so the old `?? 'null'` fallback
  // engaged but rendered a misleading "null" string. Tools that legitimately
  // return no data now serialize to the empty-object literal, which is both
  // valid JSON and a truthful representation.
  const text = data === undefined ? '{}' : JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
  };
}

/** Standard MCP error result. */
function err(e: unknown) {
  return {
    content: [{ type: 'text' as const, text: errorMessage(e) }],
    isError: true as const,
  };
}

/** Wrap an async command function with ok/err handling for use as an MCP tool callback. */
function wrapTool<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<ReturnType<typeof ok | typeof err>> {
  return async (args: A) => {
    try {
      await ensureGistInit();
      return ok(await fn(args));
    } catch (e) {
      console.error('[MCP] Tool error:', e);
      return err(e);
    }
  };
}

/**
 * Registers all OSS Autopilot CLI commands as MCP tools on the given server.
 */
export function registerTools(server: McpServer): void {
  // 1. daily — Run daily PR check
  server.registerTool(
    'daily',
    {
      description:
        'Run daily PR monitoring check. Fetches all open PRs, enriches with CI status, reviews, and conflicts, then returns a prioritized summary.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runDaily),
  );

  // 2. status — Show tracking status
  server.registerTool(
    'status',
    {
      description: 'Show current PR tracking status including open PRs, shelved PRs, and dismissed issues.',
      inputSchema: {
        offline: z
          .boolean()
          .optional()
          .describe('If true, show only locally cached state without fetching from GitHub'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(runStatus),
  );

  // 3. search — Search for contributable issues
  server.registerTool(
    'search',
    {
      description:
        'Search GitHub for beginner-friendly open-source issues to contribute to. Returns issues matching configured languages and interests.',
      inputSchema: {
        // Zod schema replaces the prior manual throw inside the handler
        // (#1058 M41). Invalid values now surface as proper schema
        // validation errors via the MCP SDK rather than as generic
        // `Error`-wrapped `isError: true` payloads.
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_RESULTS)
          .optional()
          .describe(
            `Maximum number of issues to return (default: 5, max: ${MAX_SEARCH_RESULTS}). Must be a positive integer.`,
          ),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool((args: { maxResults?: number }) => {
      const maxResults = args.maxResults ?? 5;
      return runSearch({ maxResults });
    }),
  );

  // 4. vet — Vet an issue for contribution suitability
  server.registerTool(
    'vet',
    {
      description:
        'Analyze a GitHub issue to determine if it is a good candidate for contribution. Checks for clarity, scope, existing assignees, and staleness.',
      inputSchema: {
        issueUrl: githubIssueUrlSchema.describe(
          'Full GitHub issue URL to vet (e.g. https://github.com/owner/repo/issues/123)',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(runVet),
  );

  // 4b. vet-list — Re-vet all saved issues
  server.registerTool(
    'vet-list',
    {
      description:
        'Re-vet all available issues in the curated issue list for freshness. Checks if issues are still open, unassigned, and have no linked PRs.',
      inputSchema: {
        issueListPath: z.string().optional().describe('Path to issue list file (auto-detected if not specified)'),
        concurrency: z.number().optional().describe('Max parallel vet operations (default: 5)'),
        prune: z.boolean().optional().describe('After vetting, remove completed/skipped items from the file'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runVetList),
  );

  // 5. track — Fetch PR metadata (informational; v2 does not persist a tracking list)
  server.registerTool(
    'track',
    {
      description:
        'Fetch metadata for a pull request (repo, number, title). Informational only — in v2, PRs are discovered automatically on each daily run and nothing is persisted locally. Use `daily` or `status` for ongoing monitoring.',
      inputSchema: {
        prUrl: githubPrUrlSchema.describe(
          'Full GitHub PR URL to fetch metadata for (e.g. https://github.com/owner/repo/pull/123)',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(runTrack),
  );

  // The v1→v2 `untrack` and `read` stubs were removed in v4 (#1133). Use
  // `shelve`/`unshelve` to hide PRs from the daily digest. MCP clients that
  // hard-coded these tool names will get a "tool not found" error.

  // 6. comments — Show PR comments
  server.registerTool(
    'comments',
    {
      description: 'Fetch and display comments on a pull request, including review comments and issue comments.',
      inputSchema: {
        prUrl: githubPrUrlSchema.describe('Full GitHub PR URL to fetch comments for'),
        showBots: z.boolean().optional().describe('If true, include bot comments in the output'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(runComments),
  );

  // 9. post — Post a comment (#1053: destructive; posts under user's identity)
  server.registerTool(
    'post',
    {
      description:
        "Post a comment on a GitHub issue or pull request. WARNING: posts a public comment under the authenticated user's identity. Irreversible (the comment can only be edited or deleted, not un-posted). Do not call without explicit user confirmation.",
      inputSchema: {
        url: githubIssueOrPrUrlSchema.describe('Full GitHub issue or PR URL to comment on'),
        message: z.string().min(1).describe('The comment text to post'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    wrapTool(runPost),
  );

  // 10. claim — Claim an issue (#1053: destructive; posts under user's identity)
  server.registerTool(
    'claim',
    {
      description:
        "Claim a GitHub issue by posting a comment expressing intent to work on it. WARNING: posts a public comment under the authenticated user's identity. Irreversible. Do not call without explicit user confirmation.",
      inputSchema: {
        issueUrl: githubIssueUrlSchema.describe('Full GitHub issue URL to claim'),
        message: z.string().optional().describe('Custom claim message. If omitted, a default message is used.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    wrapTool(runClaim),
  );

  // 11. config — Get or set configuration
  server.registerTool(
    'config',
    {
      description:
        'Get or set OSS Autopilot configuration values. With no args, shows all config. With key and value, sets the value.',
      inputSchema: {
        key: configKeySchema
          .optional()
          .describe(
            `Configuration key to get or set. Must be one of the known keys (derived from @oss-autopilot/core config-registry). Examples: "username", "languages", "minStars". Run the tool with no args to see all current config.`,
          ),
        value: z.string().optional().describe('Value to set for the given key. Omit to read the current value.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    wrapTool(runConfig),
  );

  // 12. init — Initialize with GitHub username
  server.registerTool(
    'init',
    {
      description:
        'Initialize OSS Autopilot with a GitHub username. Creates the state file and sets up initial configuration.',
      inputSchema: {
        username: z.string().describe('Your GitHub username'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runInit),
  );

  // 13. setup — Interactive setup
  server.registerTool(
    'setup',
    {
      description:
        'Run OSS Autopilot setup to configure preferences like languages, interests, and contribution goals.',
      inputSchema: {
        reset: z.boolean().optional().describe('If true, reset all preferences to defaults before running setup'),
        set: z
          .array(z.string())
          .optional()
          .describe('Set preferences non-interactively as key=value pairs (e.g. ["languages=typescript,rust"])'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runSetup),
  );

  // 14. check-setup — Check if setup is complete
  server.registerTool(
    'check-setup',
    {
      description:
        'Check whether OSS Autopilot is properly set up and configured. Returns setup status and any missing configuration.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrapTool(runCheckSetup),
  );

  // 15. startup — Run startup checks
  server.registerTool(
    'startup',
    {
      description:
        'Run startup checks including GitHub auth verification, state file validation, and configuration status.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runStartup),
  );

  // 16. shelve — Shelve a PR
  server.registerTool(
    'shelve',
    {
      description: 'Shelve a PR to temporarily hide it from daily checks and status reports without untracking it.',
      inputSchema: {
        prUrl: githubPrUrlSchema.describe('Full GitHub PR URL to shelve'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool((args: { prUrl: string }) => runMove({ prUrl: args.prUrl, target: 'shelved' })),
  );

  // 17. unshelve — Unshelve a PR
  server.registerTool(
    'unshelve',
    {
      description: 'Unshelve a previously shelved PR, returning it to active monitoring.',
      inputSchema: {
        prUrl: githubPrUrlSchema.describe('Full GitHub PR URL to unshelve'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool((args: { prUrl: string }) => runMove({ prUrl: args.prUrl, target: 'auto' })),
  );

  // 18. dismiss — Dismiss an issue
  server.registerTool(
    'dismiss',
    {
      description: 'Dismiss a GitHub issue so it no longer appears in notifications.',
      inputSchema: {
        url: githubIssueUrlSchema.describe('Full GitHub issue URL to dismiss'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runDismiss),
  );

  // 19. undismiss — Undismiss an issue
  server.registerTool(
    'undismiss',
    {
      description: 'Undismiss a previously dismissed issue, re-enabling notifications.',
      inputSchema: {
        url: githubIssueUrlSchema.describe('Full GitHub issue URL to undismiss'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runUndismiss),
  );

  // 20. move — Move a PR between states
  server.registerTool(
    'move',
    {
      description:
        'Move a PR between states: attention (need attention), waiting (waiting on maintainer), shelved (hidden), or auto (reset to computed status).',
      inputSchema: {
        prUrl: githubPrUrlSchema.describe('Full GitHub PR URL'),
        target: z.enum(['attention', 'waiting', 'shelved', 'auto']).describe('Target state for the PR'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runMove),
  );

  // 21. state-show — Show persistence mode
  server.registerTool(
    'state-show',
    {
      description: 'Show current state persistence mode (local or gist), Gist ID, and sync status.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrapTool(async () => {
      const { runStateShow } = await import('@oss-autopilot/core/commands');
      return runStateShow();
    }),
  );

  // 22. state-sync — Force push to Gist
  server.registerTool(
    'state-sync',
    {
      description: 'Force push current state to the backing Gist. No-op if not in Gist mode.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(async () => {
      const { runStateSync } = await import('@oss-autopilot/core/commands');
      return runStateSync();
    }),
  );

  // 23. state-unlink — Switch from Gist to local persistence
  server.registerTool(
    'state-unlink',
    {
      description: 'Disconnect from Gist persistence and switch to local-only mode. The remote Gist is preserved.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(async () => {
      const { runStateUnlink } = await import('@oss-autopilot/core/commands');
      return runStateUnlink();
    }),
  );
}
