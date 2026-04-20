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
  runUntrack,
  runRead,
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
import { errorMessage } from '@oss-autopilot/core';

/** One-shot Gist persistence activation (checked once per process). */
let gistInitDone = false;
async function ensureGistInit(): Promise<void> {
  if (gistInitDone) return;
  gistInitDone = true;

  // Read config file — may legitimately fail (no state file yet)
  let persistence: string | undefined;
  try {
    const { getStatePath } = await import('@oss-autopilot/core');
    const fs = await import('fs');
    const raw = fs.readFileSync(getStatePath(), 'utf-8');
    persistence = JSON.parse(raw)?.config?.persistence;
  } catch {
    return;
  }

  if (persistence === 'gist') {
    // Gist init errors (GistPermissionError, network) propagate to wrapTool's catch
    const { getStateManagerAsync, getGitHubTokenAsync } = await import('@oss-autopilot/core');
    const token = await getGitHubTokenAsync();
    if (token) await getStateManagerAsync(token);
  }
}

/** Standard MCP text content result. */
function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) ?? 'null' }],
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
        maxResults: z.number().optional().describe('Maximum number of issues to return (default: 5)'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool((args: { maxResults?: number }) => {
      let maxResults = args.maxResults ?? 5;
      if (!Number.isInteger(maxResults) || maxResults < 1) {
        throw new Error(`Invalid maxResults: ${maxResults}. Must be a positive integer.`);
      }
      if (maxResults > MAX_SEARCH_RESULTS) {
        maxResults = MAX_SEARCH_RESULTS;
      }
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
        issueUrl: z.string().describe('Full GitHub issue URL to vet (e.g. https://github.com/owner/repo/issues/123)'),
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
        prUrl: z
          .string()
          .describe('Full GitHub PR URL to fetch metadata for (e.g. https://github.com/owner/repo/pull/123)'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(runTrack),
  );

  // 6. untrack — Deprecated no-op (v2 has no local tracking list)
  server.registerTool(
    'untrack',
    {
      description:
        '[DEPRECATED] No-op in v2. PRs are fetched fresh on each daily run, so there is no local tracking list to remove from. Use `shelve` to hide a PR from the daily digest instead.',
      inputSchema: {
        prUrl: z.string().describe('Full GitHub PR URL (ignored — command is a no-op)'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(runUntrack),
  );

  // 7. read — Mark notifications as read
  server.registerTool(
    'read',
    {
      description: 'Mark PR notifications as read. Requires either prUrl or all to be specified.',
      inputSchema: {
        prUrl: z.string().optional().describe('Full GitHub PR URL to mark as read. Omit to use --all instead.'),
        all: z.boolean().optional().describe('If true, mark all PRs as read'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runRead),
  );

  // 8. comments — Show PR comments
  server.registerTool(
    'comments',
    {
      description: 'Fetch and display comments on a pull request, including review comments and issue comments.',
      inputSchema: {
        prUrl: z.string().describe('Full GitHub PR URL to fetch comments for'),
        showBots: z.boolean().optional().describe('If true, include bot comments in the output'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(runComments),
  );

  // 9. post — Post a comment
  server.registerTool(
    'post',
    {
      description: 'Post a comment on a GitHub issue or pull request.',
      inputSchema: {
        url: z.string().describe('Full GitHub issue or PR URL to comment on'),
        message: z.string().describe('The comment text to post'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runPost),
  );

  // 10. claim — Claim an issue
  server.registerTool(
    'claim',
    {
      description: 'Claim a GitHub issue by posting a comment expressing intent to work on it.',
      inputSchema: {
        issueUrl: z.string().describe('Full GitHub issue URL to claim'),
        message: z.string().optional().describe('Custom claim message. If omitted, a default message is used.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
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
        key: z.string().optional().describe('Configuration key to get or set (e.g. "languages", "username")'),
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
        prUrl: z.string().describe('Full GitHub PR URL to shelve'),
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
        prUrl: z.string().describe('Full GitHub PR URL to unshelve'),
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
        url: z.string().describe('Full GitHub issue URL to dismiss'),
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
        url: z.string().describe('Full GitHub issue URL to undismiss'),
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
        prUrl: z.string().describe('Full GitHub PR URL'),
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
