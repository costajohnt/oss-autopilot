/**
 * MCP resource registrations for OSS Autopilot.
 *
 * Registers static resources and dynamic resource templates that expose
 * oss-autopilot state data (status, config, PRs) via the MCP resource protocol.
 */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runStatus, runConfig } from '@oss-autopilot/core/commands';
import {
  getStateManager,
  splitRepo,
  fenceFetchedPR,
  fenceFetchedPRTitles,
  labelGuidelinesContent,
} from '@oss-autopilot/core';
import { ensureGistInit, reloadExternalState } from './tools.js';

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
      await resourceGistInit();
      return resourceContent(uri, await fn());
    } catch (e) {
      console.error('[MCP] Resource error:', e);
      throw e;
    }
  };
}

/**
 * Gist init for resource READS (#1431): before the first tool call in a
 * gist-configured process the lazily created LOCAL manager would silently
 * serve stale local state. Reads are non-destructive, so degraded init
 * proceeds, and — unlike the tool path — HARD init errors also proceed on
 * local state (stderr-logged): a broken Gist setup must not make the
 * status/config resources unreadable, they are diagnostic surfaces.
 */
async function resourceGistInit(): Promise<void> {
  try {
    await ensureGistInit();
  } catch (e) {
    console.error('[MCP] Resource read proceeding on local state; gist init failed:', e);
  }
  // #1439: reads have the same staleness problem as tool calls — a long-lived
  // process otherwise serves boot-time state forever after any external CLI
  // write (local mode) or remote push (gist mode). Reload failures degrade to
  // cached state inside the helper; they never fail the read.
  await reloadExternalState();
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
    // lastMaintainerComment.body is attacker-controllable; fence it at this
    // agent-facing boundary (#1420) — the persisted digest keeps raw bodies.
    // Titles and branch-ref names are fenced too (#1455): the MCP host LLM
    // never sees the agents' injection-awareness blocks that cover the raw
    // titles in the CLI --json envelope.
    wrapResource(async () =>
      (getStateManager().getState().lastDigest?.openPRs ?? []).map((pr) => fenceFetchedPRTitles(fenceFetchedPR(pr))),
    ),
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
          await resourceGistInit();
          const openPRs = getStateManager().getState().lastDigest?.openPRs ?? [];
          return {
            resources: openPRs.map((pr) => {
              const { owner, repo } = splitRepo(pr.repo);
              return {
                uri: `oss://pr/${owner}/${repo}/${pr.number}`,
                name: `${pr.repo}#${pr.number}`,
                // The listing description reaches the host LLM as metadata —
                // same untrusted-title surface as the resource body (#1455).
                description: fenceFetchedPRTitles(pr).title,
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
        await resourceGistInit();
        const openPRs = getStateManager().getState().lastDigest?.openPRs ?? [];
        const fullRepo = `${String(owner)}/${String(repo)}`;
        const pr = openPRs.find((p) => p.repo === fullRepo && p.number === prNumber);
        if (!pr) {
          throw new Error(`PR ${fullRepo}#${prNumber} not found in last daily digest`);
        }
        // Same fencing as oss://prs (#1420), including title/refs (#1455).
        return resourceContent(uri, fenceFetchedPRTitles(fenceFetchedPR(pr)));
      } catch (e) {
        console.error('[MCP] PR detail error:', e);
        throw e;
      }
    },
  );

  // 6. repo-guidelines — Per-repo learning guidelines extracted from past
  // PR feedback (#867). Returned as text/markdown so MCP clients can inject
  // the content directly into a context window without re-parsing JSON.
  server.registerResource(
    'repo-guidelines',
    new ResourceTemplate('oss://repo/{owner}/{repo}/guidelines', {
      list: async () => {
        try {
          await resourceGistInit();
          const repos = getStateManager().listGuidelinesRepos();
          return {
            resources: repos.map((fullRepo) => {
              const { owner, repo } = splitRepo(fullRepo);
              return {
                uri: `oss://repo/${owner}/${repo}/guidelines`,
                name: `${fullRepo} guidelines`,
                description: `Per-repo learning guidelines for ${fullRepo}`,
                mimeType: 'text/markdown' as const,
              };
            }),
          };
        } catch (e) {
          console.error('[MCP] Failed to list repo-guidelines resources:', e);
          throw e;
        }
      },
    }),
    {
      title: 'Repo Guidelines',
      description: 'Per-repo learning guidelines extracted from past PR feedback (#867).',
      mimeType: 'text/markdown',
    },
    async (uri, { owner, repo }) => {
      try {
        const fullRepo = `${String(owner)}/${String(repo)}`;
        await resourceGistInit();
        const content = getStateManager().getGuidelines(fullRepo);
        if (!content) {
          throw new Error(`No guidelines stored for ${fullRepo}`);
        }
        // Guidelines are LLM-distilled from public PR comments; label the
        // provenance so the host treats them as guidance, not instructions
        // (#1455). Stored content stays raw.
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: labelGuidelinesContent(content) }] };
      } catch (e) {
        console.error('[MCP] repo-guidelines resource error:', e);
        throw e;
      }
    },
  );
}
