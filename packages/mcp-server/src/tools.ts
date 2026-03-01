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
  runShelve,
  runUnshelve,
  runDismiss,
  runUndismiss,
  runSnooze,
  runUnsnooze,
} from '@oss-autopilot/core/commands';

/** Extract a human-readable message from an unknown error. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
      return ok(await fn(args));
    } catch (e) {
      console.error('[MCP] Tool error:', e);
      return err(e);
    }
  };
}

/**
 * Registers all 21 OSS Autopilot CLI commands as MCP tools on the given server.
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
      description:
        'Show current PR tracking status including open PRs, snoozed PRs, shelved PRs, and dismissed issues.',
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
    wrapTool((args: { maxResults?: number }) => runSearch({ maxResults: args.maxResults ?? 5 })),
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

  // 5. track — Track a PR
  server.registerTool(
    'track',
    {
      description:
        'Start tracking a pull request. Adds the PR to your monitored list so it appears in daily checks and status reports.',
      inputSchema: {
        prUrl: z.string().describe('Full GitHub PR URL to track (e.g. https://github.com/owner/repo/pull/123)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runTrack),
  );

  // 6. untrack — Stop tracking a PR
  server.registerTool(
    'untrack',
    {
      description: 'Stop tracking a pull request. Removes the PR from your monitored list.',
      inputSchema: {
        prUrl: z.string().describe('Full GitHub PR URL to untrack (e.g. https://github.com/owner/repo/pull/123)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
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
    wrapTool(runShelve),
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
    wrapTool(runUnshelve),
  );

  // 18. dismiss — Dismiss an issue
  server.registerTool(
    'dismiss',
    {
      description: 'Dismiss a GitHub issue so it no longer appears in search results.',
      inputSchema: {
        issueUrl: z.string().describe('Full GitHub issue URL to dismiss'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runDismiss),
  );

  // 19. undismiss — Undismiss an issue
  server.registerTool(
    'undismiss',
    {
      description: 'Undismiss a previously dismissed issue, allowing it to appear in search results again.',
      inputSchema: {
        issueUrl: z.string().describe('Full GitHub issue URL to undismiss'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runUndismiss),
  );

  // 20. snooze — Snooze a PR
  server.registerTool(
    'snooze',
    {
      description: 'Snooze a PR to temporarily hide it from daily checks for a specified number of days.',
      inputSchema: {
        prUrl: z.string().describe('Full GitHub PR URL to snooze'),
        reason: z.string().describe('Reason for snoozing (e.g. "waiting for CI fix", "reviewer on vacation")'),
        days: z.number().optional().describe('Number of days to snooze. Defaults to 7 if omitted.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runSnooze),
  );

  // 21. unsnooze — Unsnooze a PR
  server.registerTool(
    'unsnooze',
    {
      description: 'Unsnooze a previously snoozed PR, returning it to active monitoring immediately.',
      inputSchema: {
        prUrl: z.string().describe('Full GitHub PR URL to unsnooze'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(runUnsnooze),
  );
}
