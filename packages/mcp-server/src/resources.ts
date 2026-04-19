/**
 * MCP resource registrations for OSS Autopilot.
 *
 * Registers static resources and dynamic resource templates that expose
 * oss-autopilot state data (status, config, PRs) via the MCP resource protocol.
 */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runStatus, runConfig } from '@oss-autopilot/core/commands';
import { getStateManager, splitRepo } from '@oss-autopilot/core';

/** Build a standard MCP resource response with a single JSON content entry. */
function resourceContent(uri: URL, data: unknown) {
  return {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Wrap an async data-fetching function for use as an MCP resource callback.
 *
 * Logs failures and rethrows so the MCP SDK produces a proper JSON-RPC error
 * response. Previously this swallowed errors and returned them as a 200 OK
 * resource payload with `{ error: "..." }` in the body — clients that did not
 * introspect the JSON saw a successful read and treated the error string as
 * resource data (#957).
 */
function wrapResource(fn: () => Promise<unknown>): (uri: URL) => Promise<ReturnType<typeof resourceContent>> {
  return async (uri: URL) => {
    try {
      return resourceContent(uri, await fn());
    } catch (e) {
      console.error('[MCP] Resource error:', e);
      throw e;
    }
  };
}

/**
 * Registers all OSS Autopilot MCP resources on the given server.
 *
 * Static resources:
 *   - oss://status   — Current PR tracking status (offline mode)
 *   - oss://config   — Current configuration
 *   - oss://prs      — Active (open) PRs from last daily digest
 *   - oss://prs/shelved — Shelved PRs from last daily digest
 *
 * Dynamic resource templates:
 *   - oss://pr/{owner}/{repo}/{number} — Detail for a specific PR
 */
export function registerResources(server: McpServer): void {
  // 1. status — Current PR tracking status (offline, no GitHub fetch)
  server.registerResource(
    'status',
    'oss://status',
    {
      title: 'PR Tracking Status',
      description:
        'Current PR tracking status including open PRs, shelved PRs, and dismissed issues. Uses cached local state only (no GitHub fetch).',
      mimeType: 'application/json',
    },
    wrapResource(() => runStatus({ offline: true })),
  );

  // 2. config — Current configuration
  server.registerResource(
    'config',
    'oss://config',
    {
      title: 'Configuration',
      description:
        'Current OSS Autopilot configuration including languages, interests, contribution goals, and preferences.',
      mimeType: 'application/json',
    },
    wrapResource(() => runConfig({})),
  );

  // 3. active-prs — Open PRs from the last daily digest
  server.registerResource(
    'active-prs',
    'oss://prs',
    {
      title: 'Active PRs',
      description:
        'All open pull requests from the last daily digest, including CI status, review state, and priority information.',
      mimeType: 'application/json',
    },
    wrapResource(async () => getStateManager().getState().lastDigest?.openPRs ?? []),
  );

  // 4. shelved-prs — Shelved PRs from the last daily digest
  server.registerResource(
    'shelved-prs',
    'oss://prs/shelved',
    {
      title: 'Shelved PRs',
      description:
        'Pull requests that have been manually shelved, temporarily hidden from daily checks and status reports.',
      mimeType: 'application/json',
    },
    wrapResource(async () => getStateManager().getState().lastDigest?.shelvedPRs ?? []),
  );

  // 5. pr-detail — Dynamic template for a specific PR by owner/repo/number
  server.registerResource(
    'pr-detail',
    new ResourceTemplate('oss://pr/{owner}/{repo}/{number}', {
      list: async () => {
        try {
          const openPRs = getStateManager().getState().lastDigest?.openPRs ?? [];
          return {
            resources: openPRs.map((pr) => {
              const { owner, repo } = splitRepo(pr.repo);
              return {
                uri: `oss://pr/${owner}/${repo}/${pr.number}`,
                name: `${pr.repo}#${pr.number}`,
                description: pr.title,
                mimeType: 'application/json' as const,
              };
            }),
          };
        } catch (e) {
          console.error('[MCP] Failed to list PR resources:', e);
          // Rethrow so the MCP client sees a failed list request rather than
          // an empty list that hides the API / state error (#957).
          throw e;
        }
      },
    }),
    {
      title: 'PR Detail',
      description:
        'Detailed information for a specific pull request, including CI status, review decisions, merge conflicts, and maintainer comments.',
      mimeType: 'application/json',
    },
    async (uri, { owner, repo, number }) => {
      // Validate input before touching state. Any of these throws produces a
      // proper JSON-RPC error response to the MCP client, rather than a 200
      // OK payload with an `{ error: "..." }` body that clients could mistake
      // for valid resource content (#957).
      const prNumber = parseInt(String(number), 10);
      if (Number.isNaN(prNumber)) {
        throw new Error(`Invalid PR number: ${String(number)}`);
      }
      try {
        const openPRs = getStateManager().getState().lastDigest?.openPRs ?? [];
        const fullRepo = `${String(owner)}/${String(repo)}`;
        const pr = openPRs.find((p) => p.repo === fullRepo && p.number === prNumber);
        if (!pr) {
          throw new Error(`PR ${fullRepo}#${prNumber} not found in last daily digest`);
        }
        return resourceContent(uri, pr);
      } catch (e) {
        console.error('[MCP] PR detail error:', e);
        throw e;
      }
    },
  );
}
