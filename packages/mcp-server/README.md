# @oss-autopilot/mcp

MCP server for [OSS Autopilot](https://github.com/costajohnt/oss-autopilot) — exposes PR tracking, issue discovery, and contribution management as MCP tools for any MCP-compatible client.

[![npm](https://img.shields.io/npm/v/@oss-autopilot/mcp)](https://www.npmjs.com/package/@oss-autopilot/mcp)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

## What It Provides

| Feature | Count | Description |
|---------|-------|-------------|
| **Tools** | 30 | `daily`, `status`, `search`, `features`, `vet`, `vet-list`, `verify-issue`, `track`, `compliance-score`, `repo-vet`, `strategy`, `comments`, `post`, `claim`, `config`, `init`, `setup`, `check-setup`, `startup`, `dismiss`, `undismiss`, `move`, `state-show`, `state-sync`, `state-unlink`, `guidelines-list`, `guidelines-get`, `guidelines-store`, `guidelines-reset`, `guidelines-fetch-corpus` |
| **Resources** | 6 | `oss://status`, `oss://config`, `oss://prs`, `oss://prs/shelved`, `oss://pr/{owner}/{repo}/{number}`, `oss://repo/{owner}/{repo}/guidelines` |
| **Prompts** | 4 | `triage` (PR prioritization), `respond-to-pr` (draft response), `find-issues` (discover issues), `extract-learnings` (distill per-repo guidance from past PR feedback) |

Supports **stdio** (default) and **Streamable HTTP** transports.

## Prerequisites

- Node.js 22+
- [GitHub CLI](https://cli.github.com/) authenticated (`gh auth login`)

## Quick Start

```bash
# 1. Add the server to your MCP client (see config examples below)

# 2. From your MCP client, call the `init` tool once with your GitHub username
#    (this writes ~/.oss-autopilot/state.json).

# 3. Use the other tools — e.g. `daily` to check your PRs, `search` to find issues.
```

## Client Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oss-autopilot": {
      "command": "npx",
      "args": ["@oss-autopilot/mcp@latest"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project or global config:

```json
{
  "mcpServers": {
    "oss-autopilot": {
      "command": "npx",
      "args": ["@oss-autopilot/mcp@latest"]
    }
  }
}
```

### Codex CLI

```bash
codex mcp add oss -- npx @oss-autopilot/mcp@latest
```

### Windsurf

Add to your Windsurf MCP config:

```json
{
  "mcpServers": {
    "oss-autopilot": {
      "command": "npx",
      "args": ["@oss-autopilot/mcp@latest"]
    }
  }
}
```

### Streamable HTTP (any client)

Run the server in HTTP mode instead of stdio:

```bash
npx @oss-autopilot/mcp@latest --http --port 3001
```

The server listens at `http://127.0.0.1:3001/mcp` and accepts POST requests.

#### Authentication

HTTP mode requires a bearer token on every request (stdio mode does not — it inherits the parent process identity). On first `--http` startup, the server generates a random 32-byte token and writes it to `~/.oss-autopilot/mcp.token` with `0600` permissions. The path and "newly generated" marker are logged to stderr at startup.

Every HTTP client must send:

```
Authorization: Bearer <contents of ~/.oss-autopilot/mcp.token>
```

Requests without a valid `Authorization` header return `401`. The `Bearer` scheme is case-insensitive per RFC 7235; the token value itself is compared byte-for-byte in constant time. Requests with a non-loopback `Host` header return `403` (DNS-rebinding defense). Requests must declare a numeric `Content-Length` ≤ 1 MiB — missing, non-numeric, or oversize Content-Length values return `413`.

The token persists across restarts. To rotate, delete the file and restart — a new token will be generated. To relocate the token (e.g. for multi-user or CI setups), set `OSS_AUTOPILOT_MCP_TOKEN_PATH` to the desired absolute path before starting the server.

## Tools Reference

| Tool | Description | Read-only |
|------|-------------|-----------|
| `daily` | Run daily PR monitoring check with prioritized summary | No |
| `status` | Show current PR tracking status | Yes |
| `search` | Search GitHub for contributable issues | Yes |
| `features` | Find feature-scoped opportunities in repos with 3+ merged PRs (relationship-anchored) | Yes |
| `vet` | Analyze an issue for contribution suitability | Yes |
| `verify-issue` | Deterministically verify issue state and linked-PR claims before vetting | Yes |
| `vet-list` | Re-vet all available issues in the curated issue list | No |
| `track` | Inspect a PR: read-only metadata lookup (nothing is tracked or persisted) | Yes |
| `compliance-score` | Score a PR against opensource.guide best practices (#1245) | Yes |
| `repo-vet` | Compute the repo health rubric (1–10 + verdict) for `owner/repo` (#1271) | Yes |
| `strategy` | On-demand contribution strategy snapshot via `computeStrategy()` (#1243) | Yes |
| `comments` | Fetch and display PR comments | Yes |
| `post` | Post a comment on an issue or PR | No |
| `claim` | Claim an issue by posting a comment | No |
| `config` | Get or set configuration values | No |
| `init` | Initialize with a GitHub username | No |
| `setup` | Configure preferences (languages, interests) | No |
| `check-setup` | Check if setup is complete | Yes |
| `startup` | Run startup checks (auth, state, config) | No |
| `dismiss` | Dismiss an issue from notifications | No |
| `undismiss` | Re-enable notifications for a dismissed issue | No |
| `move` | Move a PR between states (attention, waiting, shelved, auto) | No |
| `state-show` | Show current state persistence mode (local or Gist) and sync status | Yes |
| `state-sync` | Force push current state to the backing Gist | No |
| `state-unlink` | Disconnect from Gist persistence and switch to local-only mode | No |
| `guidelines-list` | List repos that have stored guidelines (always empty in local mode) | Yes |
| `guidelines-get` | Read per-repo learning guidelines extracted from past PR feedback | Yes |
| `guidelines-store` | Persist per-repo guidelines (8 KB cap; requires Gist mode) | No |
| `guidelines-reset` | Tombstone the guidelines file for a repo | No |
| `guidelines-fetch-corpus` | Fetch raw PR comment bundles for the host's `extract-learnings` prompt to consume | No |

## Resources Reference

| Resource URI | Description |
|-------------|-------------|
| `oss://status` | PR tracking status (cached local state) |
| `oss://config` | Current configuration |
| `oss://prs` | Active open PRs from last daily digest |
| `oss://prs/shelved` | Shelved PRs |
| `oss://pr/{owner}/{repo}/{number}` | Detail for a specific PR |
| `oss://repo/{owner}/{repo}/guidelines` | Per-repo learning guidelines (markdown) |

## Prompts Reference

| Prompt | Args | Description |
|--------|------|-------------|
| `triage` | none | Fetches daily digest and builds a prioritized triage list |
| `respond-to-pr` | `prUrl` | Fetches PR comments and context for drafting a response |
| `find-issues` | `maxResults?` | Searches for issues ranked by viability score |
| `extract-learnings` | `repo`, `corpus`, `existingGuidelines?` | Distills durable per-repo guidance from raw PR comment bundles (#867) |

## Programmatic Usage

The server can also be imported and used as a library:

```typescript
import { createServer } from '@oss-autopilot/mcp';

const server = createServer();
// Connect to your own transport
```

## More Information

See the [main repository README](https://github.com/costajohnt/oss-autopilot) for the full documentation, including the Claude Code plugin, CLI usage, dashboard, and contributing guide.

## License

MIT
