# @oss-autopilot/mcp

MCP server for [OSS Autopilot](https://github.com/costajohnt/oss-autopilot) — exposes PR tracking, issue discovery, and contribution management as MCP tools for any MCP-compatible client.

[![npm](https://img.shields.io/npm/v/@oss-autopilot/mcp)](https://www.npmjs.com/package/@oss-autopilot/mcp)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

## What It Provides

| Feature | Count | Description |
|---------|-------|-------------|
| **Tools** | 37 | `daily`, `status`, `search`, `features`, `vet`, `vet-list`, `verify-issue`, `issue-thread`, `track`, `compliance-score`, `repo-vet`, `strategy`, `eval`, `comments`, `post`, `claim`, `config`, `init`, `setup`, `check-setup`, `startup`, `dismiss`, `undismiss`, `work-claim`, `work-finish`, `work-release`, `work-list`, `move`, `state-show`, `state-sync`, `state-unlink`, `guidelines-list`, `guidelines-get`, `guidelines-store`, `guidelines-reset`, `guidelines-fetch-corpus`, `policy-get` |
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

The HTTP transport is stateless, so it cannot show the user an approval form: `post`, `claim` and `guidelines-store` refuse there unless the server is started with `OSS_AUTOPILOT_MCP_ALLOW_UNCONFIRMED_WRITES=1` (see [below](#what-the-tools-will-not-do-on-the-models-word)).

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
| `search` | Search GitHub for contributable issues; records the issues it showed in state | No |
| `features` | Find feature-scoped opportunities in repos with 3+ merged PRs (relationship-anchored) | Yes |
| `vet` | Analyze an issue for contribution suitability; records the vet-time prediction and issue traits (labels, author association, competing PRs, first PR in the repo) for calibration | No |
| `verify-issue` | Deterministically verify issue state and linked-PR claims before vetting; also returns the issue author, author association and comment count | Yes |
| `issue-thread` | Read an issue's title, body and comments, each fenced as untrusted content with author and author association | Yes |
| `vet-list` | Re-vet all available issues in the curated issue list | No |
| `track` | Inspect a PR: read-only metadata lookup (nothing is tracked or persisted) | Yes |
| `compliance-score` | Score a PR against opensource.guide best practices (#1245) | Yes |
| `repo-vet` | Compute the repo health rubric (1–10 + verdict) for `owner/repo` (#1271) | Yes |
| `strategy` | On-demand contribution strategy snapshot via `computeStrategy()` (#1243) | Yes |
| `eval` | Calibration and outcome report from the outcome ledger (#1825) | Yes |
| `comments` | Fetch and display PR comments | Yes |
| `post` | Post a comment on an issue or PR; asks the user to approve first (see below) | No |
| `claim` | Claim an issue by posting a comment; asks the user to approve first (see below) | No |
| `config` | Get or set configuration values (not `diffToolCustomCommand` or `diffTool=custom`, see below) | No |
| `init` | Initialize with a GitHub username | No |
| `setup` | Configure preferences (languages, interests); same two settings refused | No |
| `check-setup` | Check if setup is complete | Yes |
| `startup` | Run startup checks (auth, state, config) | No |
| `dismiss` | Dismiss an issue from notifications | No |
| `undismiss` | Re-enable notifications for a dismissed issue | No |
| `work-claim` | Claim an issue (`implementation`, while a fix is built in the background) or a PR (`pr`, while a session works it) so other sessions and machines see it; a claim another session holds needs `takeover` (#1856, #1852) | No |
| `work-finish` | Mark an implementation claim finished: its branch is ready to collect for a week (`session` refuses a claim held elsewhere) | No |
| `work-release` | Drop the claim on a URL, or every claim a session holds | No |
| `work-list` | List live work claims across sessions and machines | Yes |
| `move` | Move a PR between states (attention, waiting, shelved, auto) | No |
| `state-show` | Show current state persistence mode (local or Gist) and sync status | Yes |
| `state-sync` | Force push current state to the backing Gist | No |
| `state-unlink` | Disconnect from Gist persistence and switch to local-only mode | No |
| `guidelines-list` | List repos that have stored guidelines (always empty in local mode) | Yes |
| `guidelines-get` | Read per-repo learning guidelines extracted from past PR feedback | Yes |
| `guidelines-store` | Persist per-repo guidelines the user has reviewed (`reviewed: true` required; asks the user to approve first, see below; refused when unattended; 8 KB cap; requires Gist mode) | No |
| `guidelines-reset` | Tombstone the guidelines file for a repo | No |
| `guidelines-fetch-corpus` | Fetch raw PR comment bundles for the host's `extract-learnings` prompt to consume | No |
| `policy-get` | Read a repo's contribution policy (AI policy, CLA, commit rules, PR gate); quoted repo text fenced. Setting one is CLI-only (`policy set`) | Yes |


### What the tools will not do on the model's word

Tool arguments come from a model that also reads text written by strangers, so two rules are enforced in the server rather than in the tool descriptions.

- **`post`, `claim` and `guidelines-store` ask the user.** `post` and `claim` write a public comment under your GitHub account and carry `destructiveHint` and `openWorldHint`; `guidelines-store` overwrites a repo's stored guidelines and carries `destructiveHint`. When the host can show an MCP elicitation form, the server sends it the target and the exact text with its length, and writes only if you tick the box and accept; declining, cancelling, leaving the box empty or not answering within two minutes refuses the call. The answer travels host to server, so the model cannot supply it, and it covers only the exact arguments the form showed: a follow-up call with different arguments, without the signed state the form was sent with, or re-sending an approval already used, is refused. Text containing invisible formatting or control characters (bidi controls, zero-width characters, variation selectors other than one after an emoji, and the like) is refused, because the form could not show it faithfully. A host that cannot show a form (no elicitation, URL-only elicitation, or the stateless HTTP transport, which never knows the client's capabilities) is refused, and the refusal names the CLI command to run instead, unless the server was started with `OSS_AUTOPILOT_MCP_ALLOW_UNCONFIRMED_WRITES=1`. With that set, such a host runs the tools on its own permission prompt alone: do not auto-approve them there. All three refuse outright while `OSS_AUTOPILOT_UNATTENDED` is set.
- **Settings that become commands are terminal-only.** `diffToolCustomCommand` is a command line the pre-commit review runs, and `diffTool=custom` switches it on. `config` and `setup` refuse both; set them yourself with `oss-autopilot setup --set diffTool=custom --set diffToolCustomCommand="<command>"`. The review workflow also shows the stored command and asks before its first run in a session.

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

## Multiple Machines

With Gist persistence, every client that runs oss-autopilot (the plugin on each machine, and every MCP server process) reads and writes the same state. Since core 3.35.0, a client keeps state fields it does not recognise instead of dropping them, and warns when the state was written by a different release. Clients on older releases still drop newer fields when they save, so update every machine after a release and restart running MCP servers, which keep the version they started with.

## Programmatic Usage

The server can also be imported and used as a library:

```typescript
import { createServer } from '@oss-autopilot/mcp';

const server = createServer();
// Connect to your own transport
```

The package installs no dependencies: the bin and this entry point are one self-contained bundle. The type declarations refer to `@modelcontextprotocol/server`; install it as a dev dependency if you need full types. Those types come from the SDK version you install, which may not exactly match the version bundled into the server.

## More Information

See the [main repository README](https://github.com/costajohnt/oss-autopilot) for the full documentation, including the Claude Code plugin, CLI usage, dashboard, and contributing guide.

## License

MIT
