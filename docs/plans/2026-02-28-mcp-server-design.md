# MCP Server Design — Phase 4

## Goal

Expose the OSS Autopilot CLI as an MCP server so Codex CLI, Cursor, and Claude Desktop can use it as a tool.

## Architecture

The MCP server lives in `packages/mcp-server/` as `@oss-autopilot/mcp`. It imports domain logic directly from `@oss-autopilot/core` — the same functions the CLI commands use internally.

```
┌─────────────────────────────────────────────────┐
│  Clients: Claude Desktop, Codex CLI, Cursor     │
└──────────┬──────────────────────┬───────────────┘
           │ stdio                │ Streamable HTTP
┌──────────▼──────────────────────▼───────────────┐
│  packages/mcp-server/                            │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐          │
│  │  Tools   │ │ Resources│ │ Prompts │          │
│  └────┬─────┘ └────┬─────┘ └────┬────┘          │
│       └─────────────┼────────────┘               │
│              ┌──────▼──────┐                     │
│              │  Core imports│                     │
│              │  (in-process)│                     │
│              └──────┬──────┘                     │
└─────────────────────┼───────────────────────────┘
               ┌──────▼──────┐
               │ @oss-autopilot/core │
               │  commands/  │
               │  core/      │
               └─────────────┘
```

Two entry points:
- `bin/mcp-server.cjs` — stdio mode (default)
- `--http` flag — Streamable HTTP on a configurable port

## Command Refactoring (Prerequisite)

CLI commands currently call `outputJson(data)` which does `console.log(JSON.stringify(...))`. Each command must be refactored to **return** the data object, with the CLI action handler doing the `console.log` at the boundary.

Before:
```typescript
export async function runStatus(opts: { json?: boolean; offline?: boolean }) {
  // ... compute data ...
  if (opts.json) {
    outputJson(data);
  } else {
    printHumanReadable(data);
  }
}
```

After:
```typescript
export async function runStatus(opts: { offline?: boolean }): Promise<StatusOutput> {
  // ... compute data ...
  return data;
}

// CLI action handler handles presentation:
.action(async (options) => {
  const { runStatus } = await import('./commands/status.js');
  const data = await runStatus({ offline: options.offline });
  if (options.json) outputJson(data);
  else printHumanReadable(data);
})
```

All 20 commands get this treatment. Human-readable formatting stays in the CLI layer. The MCP server calls the extracted functions directly and gets typed data back.

## MCP Surface: Tools

All 20 CLI commands become MCP tools with Zod input schemas:

| CLI Command | MCP Tool | Input Schema |
|---|---|---|
| `daily` | `daily` | `{}` |
| `status` | `status` | `{ offline?: boolean }` |
| `search [count]` | `search` | `{ maxResults?: number }` |
| `vet <issue-url>` | `vet` | `{ issueUrl: string }` |
| `track <pr-url>` | `track` | `{ prUrl: string }` |
| `untrack <pr-url>` | `untrack` | `{ prUrl: string }` |
| `read [pr-url]` | `read` | `{ prUrl?: string, all?: boolean }` |
| `comments <pr-url>` | `comments` | `{ prUrl: string, showBots?: boolean }` |
| `post <url> [message]` | `post` | `{ url: string, message: string }` |
| `claim <issue-url>` | `claim` | `{ issueUrl: string, message?: string }` |
| `config [key] [value]` | `config` | `{ key?: string, value?: string }` |
| `init <username>` | `init` | `{ username: string }` |
| `setup` | `setup` | `{ reset?: boolean, set?: string[] }` |
| `checkSetup` | `check-setup` | `{}` |
| `startup` | `startup` | `{}` |
| `shelve <pr-url>` | `shelve` | `{ prUrl: string }` |
| `unshelve <pr-url>` | `unshelve` | `{ prUrl: string }` |
| `dismiss <issue-url>` | `dismiss` | `{ issueUrl: string }` |
| `undismiss <issue-url>` | `undismiss` | `{ issueUrl: string }` |
| `snooze <pr-url>` | `snooze` | `{ prUrl: string, reason: string, days?: number }` |
| `unsnooze <pr-url>` | `unsnooze` | `{ prUrl: string }` |

Tool annotations: read-only tools get `readOnlyHint: true`, mutating tools get `destructiveHint: false`.

## MCP Surface: Resources

Read-only data at stable URIs. No GitHub API calls — cached/local data only.

| Resource | URI | Description |
|---|---|---|
| Status | `oss://status` | Stats: merged/closed/active counts, merge rate |
| Config | `oss://config` | Current user configuration |
| PR detail | `oss://pr/{owner}/{repo}/{number}` | Single PR from cached state |
| Active PRs | `oss://prs` | All currently tracked open PRs |
| Shelved PRs | `oss://prs/shelved` | Shelved PRs |

PR detail uses a `ResourceTemplate` with `{owner}/{repo}/{number}` parameters.

## MCP Surface: Prompts

Guided workflow templates:

| Prompt | Args | Description |
|---|---|---|
| `triage` | none | Prioritized triage list from daily digest |
| `respond-to-pr` | `{ prUrl: string }` | PR context for drafting a response |
| `find-issues` | `{ maxResults?: number }` | Issue search with viability scores |

## Error Handling

Each MCP tool wraps its core function in try/catch. Errors become MCP error responses (`isError: true`). The MCP SDK handles transport-level errors automatically.

GitHub auth is checked at startup. Tools that need auth fail gracefully if no token is available. Local-only tools work without auth.

## Testing

- Unit tests: mock core functions, verify MCP tool/resource/prompt responses
- Integration test: stdio transport with JSON-RPC requests
- Core domain logic covered by existing tests

## Client Configuration

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "oss-autopilot": {
      "command": "npx",
      "args": ["@oss-autopilot/mcp"]
    }
  }
}
```

**Codex CLI:**
```bash
codex mcp add oss -- npx @oss-autopilot/mcp
```

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "oss-autopilot": {
      "command": "npx",
      "args": ["@oss-autopilot/mcp"]
    }
  }
}
```

**Streamable HTTP:**
```bash
npx @oss-autopilot/mcp --http --port 3001
```

## Package

`@oss-autopilot/mcp` published to npm alongside `@oss-autopilot/core`. Same release-please automation.
