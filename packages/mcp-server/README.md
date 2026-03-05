# @oss-autopilot/mcp

MCP server for [OSS Autopilot](https://github.com/costajohnt/oss-autopilot) — exposes PR tracking, issue discovery, and contribution management as MCP tools for any MCP-compatible client.

[![npm](https://img.shields.io/npm/v/@oss-autopilot/mcp)](https://www.npmjs.com/package/@oss-autopilot/mcp)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

## What It Provides

| Feature | Count | Description |
|---------|-------|-------------|
| **Tools** | 21 | `daily`, `status`, `search`, `vet`, `track`, `untrack`, `read`, `comments`, `post`, `claim`, `config`, `init`, `setup`, `check-setup`, `startup`, `shelve`, `unshelve`, `dismiss`, `undismiss`, `snooze`, `unsnooze` |
| **Resources** | 5 | `oss://status`, `oss://config`, `oss://prs`, `oss://prs/shelved`, `oss://pr/{owner}/{repo}/{number}` |
| **Prompts** | 3 | `triage` (PR prioritization), `respond-to-pr` (draft response), `find-issues` (discover issues) |

Supports **stdio** (default) and **Streamable HTTP** transports.

## Prerequisites

- Node.js 20+
- [GitHub CLI](https://cli.github.com/) authenticated (`gh auth login`)

## Quick Start

```bash
# 1. Initialize with your GitHub username
npx @oss-autopilot/mcp@latest --init <your-github-username>

# 2. Add the server to your MCP client (see config examples below)

# 3. Use the tools — e.g. "daily" to check your PRs, "search" to find issues
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

## Tools Reference

| Tool | Description | Read-only |
|------|-------------|-----------|
| `daily` | Run daily PR monitoring check with prioritized summary | No |
| `status` | Show current PR tracking status | Yes |
| `search` | Search GitHub for contributable issues | Yes |
| `vet` | Analyze an issue for contribution suitability | Yes |
| `track` | Start tracking a pull request | No |
| `untrack` | Stop tracking a pull request | No |
| `read` | Mark PR notifications as read | No |
| `comments` | Fetch and display PR comments | Yes |
| `post` | Post a comment on an issue or PR | No |
| `claim` | Claim an issue by posting a comment | No |
| `config` | Get or set configuration values | No |
| `init` | Initialize with a GitHub username | No |
| `setup` | Configure preferences (languages, interests) | No |
| `check-setup` | Check if setup is complete | Yes |
| `startup` | Run startup checks (auth, state, config) | No |
| `shelve` | Temporarily hide a PR from daily checks | No |
| `unshelve` | Return a shelved PR to active monitoring | No |
| `dismiss` | Dismiss an issue or PR from notifications | No |
| `undismiss` | Re-enable notifications for a dismissed item | No |
| `snooze` | Snooze a PR for a number of days | No |
| `unsnooze` | Unsnooze a PR immediately | No |

## Resources Reference

| Resource URI | Description |
|-------------|-------------|
| `oss://status` | PR tracking status (cached local state) |
| `oss://config` | Current configuration |
| `oss://prs` | Active open PRs from last daily digest |
| `oss://prs/shelved` | Shelved PRs |
| `oss://pr/{owner}/{repo}/{number}` | Detail for a specific PR |

## Prompts Reference

| Prompt | Args | Description |
|--------|------|-------------|
| `triage` | none | Fetches daily digest and builds a prioritized triage list |
| `respond-to-pr` | `prUrl` | Fetches PR comments and context for drafting a response |
| `find-issues` | `maxResults?` | Searches for issues ranked by viability score |

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
