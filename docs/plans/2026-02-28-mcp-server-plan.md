# MCP Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose all CLI commands as MCP tools, resources, and prompts for Codex CLI, Cursor, and Claude Desktop.

**Architecture:** New `packages/mcp-server/` package imports domain functions from `@oss-autopilot/core`. Commands refactored to return data; CLI handles presentation at the boundary. MCP SDK v2 with `registerTool`, `registerResource`, `registerPrompt`.

**Tech Stack:** `@modelcontextprotocol/server` (SDK v2), `zod/v4`, `@modelcontextprotocol/node` (Streamable HTTP transport), esbuild (bundling)

---

### Task 1: Scaffold `packages/mcp-server/` package

**Files:**
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/src/index.ts` (placeholder)
- Modify: `pnpm-workspace.yaml` (already includes `packages/*`, so no change needed — verify only)

**Step 1: Create package.json**

```json
{
  "name": "@oss-autopilot/mcp",
  "version": "0.0.0",
  "description": "MCP server for OSS Autopilot — exposes PR tracking, issue discovery, and contribution management as MCP tools",
  "type": "module",
  "bin": {
    "oss-autopilot-mcp": "./dist/mcp-server.bundle.cjs"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist/"
  ],
  "scripts": {
    "build": "tsc",
    "bundle": "esbuild src/index.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/mcp-server.bundle.cjs --banner:js='#!/usr/bin/env node'",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "@modelcontextprotocol/node": "^2.0.0",
    "@oss-autopilot/core": "workspace:*",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "engines": {
    "node": ">=20"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/costajohnt/oss-autopilot.git",
    "directory": "packages/mcp-server"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "jsx": "react-jsx",
    "jsxImportSource": "preact"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

Note: Remove the `jsx` and `jsxImportSource` lines — those are only for the dashboard package. This is a pure Node.js server package.

**Step 3: Create placeholder src/index.ts**

```typescript
#!/usr/bin/env node
/**
 * OSS Autopilot MCP Server
 * Exposes CLI commands as MCP tools, resources, and prompts
 */

console.log('MCP server placeholder — not yet implemented');
```

**Step 4: Install dependencies**

Run: `pnpm install`
Expected: Clean install, new packages resolved in pnpm-lock.yaml

**Step 5: Verify workspace resolution**

Run: `cd packages/mcp-server && pnpm run typecheck`
Expected: Pass (placeholder has no imports yet)

**Step 6: Commit**

```bash
git add packages/mcp-server/ pnpm-lock.yaml
git commit -m "chore: scaffold packages/mcp-server with package.json and tsconfig"
```

---

### Task 2: Refactor light commands to return data

These commands have simple output patterns — inline JSON objects, no complex formatting. Refactor each to return data and move presentation to cli.ts.

**Files:**
- Modify: `packages/core/src/commands/shelve.ts`
- Modify: `packages/core/src/commands/dismiss.ts`
- Modify: `packages/core/src/commands/snooze.ts`
- Modify: `packages/core/src/commands/track.ts`
- Modify: `packages/core/src/commands/read.ts`
- Modify: `packages/core/src/commands/init.ts`
- Modify: `packages/core/src/cli.ts` (update action handlers)
- Test: `packages/core/src/commands/shelve.test.ts` (and others — existing tests)

**Pattern for each command:**

Before (e.g., shelve.ts):
```typescript
export async function runShelve(options: { prUrl: string; json?: boolean }) {
  const sm = getStateManager();
  sm.shelvePR(options.prUrl);
  if (options.json) {
    outputJson({ shelved: true, url: options.prUrl });
  } else {
    console.log(`Shelved: ${options.prUrl}`);
  }
}
```

After (shelve.ts):
```typescript
export interface ShelveOutput {
  shelved: boolean;
  url: string;
}

export async function runShelve(options: { prUrl: string }): Promise<ShelveOutput> {
  const sm = getStateManager();
  sm.shelvePR(options.prUrl);
  return { shelved: true, url: options.prUrl };
}
```

After (cli.ts action handler):
```typescript
.action(async (prUrl, options) => {
  const { runShelve } = await import('./commands/shelve.js');
  const data = await runShelve({ prUrl });
  if (options.json) {
    outputJson(data);
  } else {
    console.log(`Shelved: ${prUrl}`);
  }
})
```

**Step 1: Refactor shelve.ts and unshelve.ts**

Apply the pattern above. Export `ShelveOutput` and `UnshelveOutput` types. Remove `json` from options interface. Return data instead of printing.

**Step 2: Refactor dismiss.ts and undismiss.ts**

Same pattern. Export `DismissOutput` and `UndismissOutput` types.

**Step 3: Refactor snooze.ts and unsnooze.ts**

Same pattern. Export `SnoozeOutput` and `UnsnoozeOutput` types. Note: snooze has early validation errors (missing reason, invalid URL) — these should throw instead of calling `outputJsonError` + `process.exit(1)`. The CLI action handler catches and formats.

**Step 4: Refactor track.ts and untrack.ts**

Same pattern. Export `TrackOutput` (already exists in json.ts) and `UntrackOutput`.

**Step 5: Refactor read.ts**

Same pattern. Export `ReadOutput` type.

**Step 6: Refactor init.ts**

Same pattern. Export `InitOutput` type.

**Step 7: Update cli.ts action handlers**

For each refactored command, move the `if (options.json) outputJson(data) else console.log(...)` logic into the CLI action handler. The human-readable text that was in the command file gets moved here.

**Step 8: Run tests**

Run: `pnpm test`
Expected: All 1288+ tests pass. Some tests may need adjustments if they mock `outputJson` — update them to check return values instead.

**Step 9: Commit**

```bash
git add packages/core/src/commands/shelve.ts packages/core/src/commands/dismiss.ts \
  packages/core/src/commands/snooze.ts packages/core/src/commands/track.ts \
  packages/core/src/commands/read.ts packages/core/src/commands/init.ts \
  packages/core/src/cli.ts packages/core/src/commands/*.test.ts
git commit -m "refactor: light commands return data instead of printing"
```

---

### Task 3: Refactor medium commands to return data

These commands have moderate output logic — config, setup, status, local-repos, parse-list, check-integration.

**Files:**
- Modify: `packages/core/src/commands/config.ts`
- Modify: `packages/core/src/commands/setup.ts`
- Modify: `packages/core/src/commands/status.ts`
- Modify: `packages/core/src/commands/local-repos.ts`
- Modify: `packages/core/src/commands/parse-list.ts`
- Modify: `packages/core/src/commands/check-integration.ts`
- Modify: `packages/core/src/cli.ts` (update action handlers)
- Test: existing test files

**Step 1: Refactor status.ts**

`runStatus` already builds a `StatusOutput` object. Remove the `json` option, return `StatusOutput` directly. Move the human-readable formatting (emoji stats) to cli.ts.

**Step 2: Refactor config.ts**

`runConfig` has two modes: read (no key) and write (key+value). Split into:
- `getConfig(): Promise<ConfigOutput>` — returns full config
- `setConfig(key: string, value: string): Promise<{ success: true; key: string; value: string }>` — sets a value

Or keep as single function returning a union type. The CLI handler does the output branching.

**Step 3: Refactor setup.ts**

`runSetup` has three paths: `--set` (batch set), interactive prompts, already complete. Return a union type covering all three. `runCheckSetup` returns `{ setupComplete: boolean; username: string }`.

**Step 4: Refactor local-repos.ts**

`runLocalRepos` already builds a `LocalReposOutput`. Remove `json` option, return it directly. Move `printRepos()` call to cli.ts.

**Step 5: Refactor parse-list.ts**

`runParseList` already builds `ParseIssueListOutput`. Remove `json` option, return it. Move human-readable formatting to cli.ts.

**Step 6: Refactor check-integration.ts**

`runCheckIntegration` already builds `CheckIntegrationOutput`. Same pattern.

**Step 7: Update cli.ts action handlers**

Move all human-readable output into CLI action handlers.

**Step 8: Run tests**

Run: `pnpm test`
Expected: All tests pass

**Step 9: Commit**

```bash
git add packages/core/src/commands/config.ts packages/core/src/commands/setup.ts \
  packages/core/src/commands/status.ts packages/core/src/commands/local-repos.ts \
  packages/core/src/commands/parse-list.ts packages/core/src/commands/check-integration.ts \
  packages/core/src/cli.ts packages/core/src/commands/*.test.ts
git commit -m "refactor: medium commands return data instead of printing"
```

---

### Task 4: Refactor heavy commands to return data

These are the core workflow commands with complex output and multiple error paths.

**Files:**
- Modify: `packages/core/src/commands/daily.ts`
- Modify: `packages/core/src/commands/startup.ts`
- Modify: `packages/core/src/commands/search.ts`
- Modify: `packages/core/src/commands/vet.ts`
- Modify: `packages/core/src/commands/comments.ts`
- Modify: `packages/core/src/cli.ts` (update action handlers)
- Test: existing test files

**Step 1: Refactor daily.ts**

`executeDailyCheck` already returns `DailyOutput`. The `runDaily` wrapper just adds the json/text branching. Remove `json` from `DailyOptions`, have `runDaily` return `DailyOutput` directly. Move `printDigest()` call to cli.ts. Note: `runDaily` also calls `executeDailyCheck` which is already the data-returning function — so `runDaily` may just become a thin wrapper or can be collapsed with `executeDailyCheck`.

**Step 2: Refactor startup.ts**

`runStartup` builds `StartupOutput` progressively. Remove `json` option, return `StartupOutput`. The three shapes (setup incomplete, auth failure, success) should all be returned, not printed. Error exits (`process.exit(1)`) should become thrown errors.

**Step 3: Refactor search.ts**

`runSearch` already builds `SearchOutput`. Remove `json` option, return it. Move `discovery.formatCandidate()` formatting to cli.ts.

**Step 4: Refactor vet.ts**

`runVet` builds an inline object. Define a `VetOutput` type, return it. Move human formatting to cli.ts.

**Step 5: Refactor comments.ts (3 functions)**

`runComments`, `runPost`, `runClaim` each have their own output. Define output types for each. The biggest change: `runPost` reads from stdin when `--stdin` is set — this stays as a CLI concern. The core function takes `{ url, message }` and returns the result.

**Step 6: Update cli.ts action handlers**

Move all human-readable output into CLI action handlers. For comments.ts, the stdin reading stays in the CLI action handler:
```typescript
.action(async (url, messageParts, options) => {
  let message: string;
  if (options.stdin) {
    message = await readStdin();
  } else {
    message = messageParts.join(' ');
  }
  const { runPost } = await import('./commands/comments.js');
  const data = await runPost({ url, message });
  if (options.json) outputJson(data);
  else console.log(`Comment posted: ${data.commentUrl}`);
})
```

**Step 7: Export all output types from core package**

Add new output types to `packages/core/src/formatters/json.ts` or to the respective command files. Ensure they're exported via `packages/core/src/core/index.ts` or a new `packages/core/src/commands/index.ts` barrel file.

**Step 8: Run tests**

Run: `pnpm test`
Expected: All tests pass

**Step 9: Commit**

```bash
git add packages/core/src/commands/daily.ts packages/core/src/commands/startup.ts \
  packages/core/src/commands/search.ts packages/core/src/commands/vet.ts \
  packages/core/src/commands/comments.ts packages/core/src/cli.ts \
  packages/core/src/commands/*.test.ts packages/core/src/formatters/json.ts
git commit -m "refactor: heavy commands return data instead of printing"
```

---

### Task 5: Export command functions from @oss-autopilot/core

Create a barrel export so the MCP server can import all command functions from a single entry point.

**Files:**
- Create: `packages/core/src/commands/index.ts`
- Modify: `packages/core/package.json` (add `./commands` export)
- Modify: `packages/core/tsconfig.json` (if needed)

**Step 1: Create commands barrel export**

```typescript
// packages/core/src/commands/index.ts
export { runDaily, executeDailyCheck } from './daily.js';
export { runStatus } from './status.js';
export { runSearch } from './search.js';
export { runVet } from './vet.js';
export { runTrack, runUntrack } from './track.js';
export { runRead } from './read.js';
export { runComments, runPost, runClaim } from './comments.js';
export { runConfig } from './config.js';
export { runInit } from './init.js';
export { runSetup, runCheckSetup } from './setup.js';
export { runShelve, runUnshelve } from './shelve.js';
export { runDismiss, runUndismiss } from './dismiss.js';
export { runSnooze, runUnsnooze } from './snooze.js';
export { runStartup } from './startup.js';
export { runParseList } from './parse-list.js';
export { runCheckIntegration } from './check-integration.js';
export { runLocalRepos } from './local-repos.js';

// Re-export output types
export type { ShelveOutput, UnshelveOutput } from './shelve.js';
export type { DismissOutput, UndismissOutput } from './dismiss.js';
export type { SnoozeOutput, UnsnoozeOutput } from './snooze.js';
export type { TrackOutput } from '../formatters/json.js';
// ... etc. for all output types
```

**Step 2: Add package.json export**

Add to `packages/core/package.json` exports:
```json
"./commands": {
  "import": "./dist/commands/index.js",
  "types": "./dist/commands/index.d.ts"
}
```

**Step 3: Rebuild and verify**

Run: `cd packages/core && pnpm run build`
Run: `pnpm test`
Expected: Build succeeds, all tests pass

**Step 4: Commit**

```bash
git add packages/core/src/commands/index.ts packages/core/package.json
git commit -m "feat: export command functions from @oss-autopilot/core"
```

---

### Task 6: Register MCP tools

Create the MCP server with all 20 tools registered using Zod schemas.

**Files:**
- Create: `packages/mcp-server/src/server.ts` (McpServer setup)
- Create: `packages/mcp-server/src/tools.ts` (tool registrations)
- Modify: `packages/mcp-server/src/index.ts` (wire up)
- Test: `packages/mcp-server/src/tools.test.ts`

**Step 1: Write failing tests for tool registration**

```typescript
// packages/mcp-server/src/tools.test.ts
import { describe, it, expect } from 'vitest';
import { createServer } from './server.js';

describe('MCP tools', () => {
  it('registers all 20 tools', async () => {
    const server = createServer();
    // Use the MCP SDK's internal method or list_tools protocol
    const tools = await server.server.listTools();
    expect(tools.tools.length).toBe(20);
  });

  it('each tool has a description and input schema', async () => {
    const server = createServer();
    const { tools } = await server.server.listTools();
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/mcp-server && npx vitest run src/tools.test.ts`
Expected: FAIL — createServer doesn't exist yet

**Step 3: Create server.ts**

```typescript
// packages/mcp-server/src/server.ts
import { McpServer } from '@modelcontextprotocol/server';

const VERSION = '0.0.0'; // Replaced at build time or read from package.json

export function createServer() {
  const server = new McpServer({
    name: 'oss-autopilot',
    version: VERSION,
  });

  return server;
}
```

**Step 4: Create tools.ts with all 20 tool registrations**

Each tool follows this pattern:
```typescript
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export function registerTools(server: McpServer) {
  // Read-only tools
  server.registerTool(
    'daily',
    {
      description: 'Run daily check on all tracked PRs — fetches fresh data from GitHub',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { runDaily } = await import('@oss-autopilot/core/commands');
      const data = await runDaily({});
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    'status',
    {
      description: 'Show current status and stats (merged/closed/active PRs, merge rate)',
      inputSchema: z.object({
        offline: z.boolean().optional().describe('Use cached data only (no GitHub API calls)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ offline }) => {
      const { runStatus } = await import('@oss-autopilot/core/commands');
      const data = await runStatus({ offline });
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ... register all 20 tools following this pattern ...

  // Mutating tools example:
  server.registerTool(
    'shelve',
    {
      description: 'Shelve a PR (exclude from capacity and actionable issues)',
      inputSchema: z.object({
        prUrl: z.string().describe('GitHub PR URL to shelve'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ prUrl }) => {
      const { runShelve } = await import('@oss-autopilot/core/commands');
      const data = await runShelve({ prUrl });
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
```

Complete list of all 20 tools to register:
1. `daily` — `{}` — readOnly
2. `status` — `{ offline?: boolean }` — readOnly
3. `search` — `{ maxResults?: number }` — readOnly
4. `vet` — `{ issueUrl: string }` — readOnly
5. `track` — `{ prUrl: string }` — mutating
6. `untrack` — `{ prUrl: string }` — mutating
7. `read` — `{ prUrl?: string, all?: boolean }` — mutating
8. `comments` — `{ prUrl: string, showBots?: boolean }` — readOnly
9. `post` — `{ url: string, message: string }` — mutating
10. `claim` — `{ issueUrl: string, message?: string }` — mutating
11. `config` — `{ key?: string, value?: string }` — depends on args
12. `init` — `{ username: string }` — mutating
13. `setup` — `{ reset?: boolean, set?: string[] }` — mutating
14. `check-setup` — `{}` — readOnly
15. `startup` — `{}` — readOnly
16. `shelve` — `{ prUrl: string }` — mutating
17. `unshelve` — `{ prUrl: string }` — mutating
18. `dismiss` — `{ issueUrl: string }` — mutating
19. `undismiss` — `{ issueUrl: string }` — mutating
20. `snooze` — `{ prUrl: string, reason: string, days?: number }` — mutating
21. `unsnooze` — `{ prUrl: string }` — mutating

(Note: 21 tools because snooze/unsnooze are separate. Adjust count accordingly.)

Each tool handler wraps the core function call in try/catch:
```typescript
async (args) => {
  try {
    const data = await coreFunction(args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    return {
      content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
      isError: true,
    };
  }
}
```

**Step 5: Wire up in server.ts**

```typescript
import { registerTools } from './tools.js';

export function createServer() {
  const server = new McpServer({ name: 'oss-autopilot', version: VERSION });
  registerTools(server);
  return server;
}
```

**Step 6: Run tests**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tool registration tests pass

**Step 7: Commit**

```bash
git add packages/mcp-server/src/
git commit -m "feat: register all CLI commands as MCP tools"
```

---

### Task 7: Register MCP resources

**Files:**
- Create: `packages/mcp-server/src/resources.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Test: `packages/mcp-server/src/resources.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { createServer } from './server.js';

describe('MCP resources', () => {
  it('registers 5 resources', async () => {
    const server = createServer();
    const { resources } = await server.server.listResources();
    expect(resources.length).toBeGreaterThanOrEqual(3); // static resources
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/mcp-server && npx vitest run src/resources.test.ts`
Expected: FAIL

**Step 3: Create resources.ts**

```typescript
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import type { ReadResourceResult } from '@modelcontextprotocol/server';

export function registerResources(server: McpServer) {
  // Static: status overview
  server.registerResource(
    'status',
    'oss://status',
    {
      title: 'OSS Autopilot Status',
      description: 'Current stats: merged/closed/active PRs, merge rate, last run time',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      const { runStatus } = await import('@oss-autopilot/core/commands');
      const data = await runStatus({ offline: true });
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // Static: config
  server.registerResource(
    'config',
    'oss://config',
    {
      title: 'OSS Autopilot Configuration',
      description: 'Current user configuration (username, excluded repos, preferences)',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      const { runConfig } = await import('@oss-autopilot/core/commands');
      const data = await runConfig({});
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // Static: active PRs list
  server.registerResource(
    'active-prs',
    'oss://prs',
    {
      title: 'Active Pull Requests',
      description: 'All currently tracked open PRs',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      const { getStateManager } = await import('@oss-autopilot/core');
      const sm = getStateManager();
      const state = sm.getState();
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(state, null, 2) }],
      };
    }
  );

  // Static: shelved PRs
  server.registerResource(
    'shelved-prs',
    'oss://prs/shelved',
    {
      title: 'Shelved Pull Requests',
      description: 'PRs excluded from capacity and actionable issues',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      const { getStateManager } = await import('@oss-autopilot/core');
      const sm = getStateManager();
      const shelved = sm.getState().shelvedPRs ?? [];
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(shelved, null, 2) }],
      };
    }
  );

  // Dynamic: PR detail by owner/repo/number
  server.registerResource(
    'pr-detail',
    new ResourceTemplate('oss://pr/{owner}/{repo}/{number}', {
      list: async () => {
        // List known PRs from cached state
        const { getStateManager } = await import('@oss-autopilot/core');
        const sm = getStateManager();
        const state = sm.getState();
        const resources = (state.lastDailyDigest?.openPRs ?? []).map((pr) => {
          const [owner, repo] = pr.repo.split('/');
          return {
            uri: `oss://pr/${owner}/${repo}/${pr.number}`,
            name: `${pr.repo}#${pr.number}: ${pr.title}`,
          };
        });
        return { resources };
      },
    }),
    {
      title: 'Pull Request Detail',
      description: 'Detailed info for a single PR from cached state',
      mimeType: 'application/json',
    },
    async (uri, { owner, repo, number }): Promise<ReadResourceResult> => {
      const { getStateManager } = await import('@oss-autopilot/core');
      const sm = getStateManager();
      const state = sm.getState();
      const pr = (state.lastDailyDigest?.openPRs ?? []).find(
        (p) => p.repo === `${owner}/${repo}` && p.number === parseInt(number as string, 10)
      );
      if (!pr) {
        return {
          contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: 'PR not found in cached state' }) }],
        };
      }
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(pr, null, 2) }],
      };
    }
  );
}
```

**Step 4: Wire up in server.ts**

```typescript
import { registerResources } from './resources.js';

export function createServer() {
  const server = new McpServer({ name: 'oss-autopilot', version: VERSION });
  registerTools(server);
  registerResources(server);
  return server;
}
```

**Step 5: Run tests**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/mcp-server/src/resources.ts packages/mcp-server/src/resources.test.ts \
  packages/mcp-server/src/server.ts
git commit -m "feat: register MCP resources for status, config, and PR data"
```

---

### Task 8: Register MCP prompts

**Files:**
- Create: `packages/mcp-server/src/prompts.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Test: `packages/mcp-server/src/prompts.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { createServer } from './server.js';

describe('MCP prompts', () => {
  it('registers 3 prompts', async () => {
    const server = createServer();
    const { prompts } = await server.server.listPrompts();
    expect(prompts.length).toBe(3);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/mcp-server && npx vitest run src/prompts.test.ts`
Expected: FAIL

**Step 3: Create prompts.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/server';
import type { GetPromptResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'triage',
    {
      title: 'Triage PRs',
      description: 'Get a prioritized list of PRs that need attention, with recommended actions',
    },
    async (): Promise<GetPromptResult> => {
      const { runDaily } = await import('@oss-autopilot/core/commands');
      const data = await runDaily({});
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Here is my current OSS contribution status. Help me triage and prioritize what to work on:\n\n${data.summary}\n\nActionable issues:\n${JSON.stringify(data.actionableIssues, null, 2)}\n\nFull data:\n${JSON.stringify(data.digest, null, 2)}`,
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    'respond-to-pr',
    {
      title: 'Respond to PR',
      description: 'Get context for a PR to help draft a response to maintainer feedback',
      argsSchema: z.object({
        prUrl: z.string().describe('GitHub PR URL to respond to'),
      }),
    },
    async ({ prUrl }): Promise<GetPromptResult> => {
      const { runComments } = await import('@oss-autopilot/core/commands');
      const data = await runComments({ prUrl });
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Help me respond to this pull request. Here are the details and comments:\n\nPR: ${data.pr.title} (${data.pr.url})\nState: ${data.pr.state}\n\nReviews:\n${JSON.stringify(data.reviews, null, 2)}\n\nInline comments:\n${JSON.stringify(data.reviewComments, null, 2)}\n\nDiscussion:\n${JSON.stringify(data.issueComments, null, 2)}\n\nPlease help me draft a thoughtful response addressing the feedback.`,
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    'find-issues',
    {
      title: 'Find Issues to Work On',
      description: 'Search for good issues to contribute to, ranked by viability',
      argsSchema: z.object({
        maxResults: z.number().optional().describe('Maximum number of issues to return (default: 5)'),
      }),
    },
    async ({ maxResults }): Promise<GetPromptResult> => {
      const { runSearch } = await import('@oss-autopilot/core/commands');
      const data = await runSearch({ maxResults: maxResults ?? 5 });
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Here are potential issues I could work on. Help me pick the best one:\n\n${data.candidates
                .map(
                  (c, i) =>
                    `${i + 1}. [${c.recommendation.toUpperCase()}] ${c.issue.repo}#${c.issue.number}: ${c.issue.title}\n   URL: ${c.issue.url}\n   Score: ${c.viabilityScore}/100\n   Approve: ${c.reasonsToApprove.join(', ')}\n   Skip: ${c.reasonsToSkip.join(', ')}`
                )
                .join('\n\n')}${data.rateLimitWarning ? `\n\nNote: ${data.rateLimitWarning}` : ''}`,
            },
          },
        ],
      };
    }
  );
}
```

**Step 4: Wire up in server.ts**

```typescript
import { registerPrompts } from './prompts.js';

export function createServer() {
  const server = new McpServer({ name: 'oss-autopilot', version: VERSION });
  registerTools(server);
  registerResources(server);
  registerPrompts(server);
  return server;
}
```

**Step 5: Run tests**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/mcp-server/src/prompts.ts packages/mcp-server/src/prompts.test.ts \
  packages/mcp-server/src/server.ts
git commit -m "feat: register MCP prompts for triage, respond-to-pr, and find-issues"
```

---

### Task 9: Add stdio and Streamable HTTP transports

**Files:**
- Modify: `packages/mcp-server/src/index.ts` (entry point with transport selection)
- Test: `packages/mcp-server/src/index.test.ts`

**Step 1: Write the entry point**

```typescript
#!/usr/bin/env node
/**
 * OSS Autopilot MCP Server
 * Entry point supporting stdio (default) and Streamable HTTP transports
 */

import { StdioServerTransport } from '@modelcontextprotocol/server';
import { createServer } from './server.js';

const args = process.argv.slice(2);
const httpMode = args.includes('--http');
const portArg = args.find((a) => a.startsWith('--port='));
const portIdx = args.indexOf('--port');

async function main() {
  const server = createServer();

  if (httpMode) {
    const port = portArg
      ? parseInt(portArg.split('=')[1], 10)
      : portIdx >= 0
        ? parseInt(args[portIdx + 1], 10)
        : 3001;

    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${port}. Must be 1-65535.`);
      process.exit(1);
    }

    const { createServer: createHttpServer } = await import('node:http');
    const { NodeStreamableHTTPServerTransport } = await import('@modelcontextprotocol/node');

    const httpServer = createHttpServer(async (req, res) => {
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });

    httpServer.listen(port, '127.0.0.1', () => {
      console.error(`OSS Autopilot MCP server listening on http://127.0.0.1:${port}/mcp`);
    });
  } else {
    // Default: stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error('MCP server fatal error:', err);
  process.exit(1);
});
```

**Step 2: Write integration test for stdio transport**

```typescript
// packages/mcp-server/src/index.test.ts
import { describe, it, expect } from 'vitest';
import { Client, StdioClientTransport } from '@modelcontextprotocol/client';

describe('MCP server stdio transport', () => {
  it('lists tools via stdio', async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/index.ts'],
      cwd: new URL('..', import.meta.url).pathname,
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.name === 'daily')).toBe(true);
    expect(tools.some((t) => t.name === 'status')).toBe(true);

    await client.close();
  });

  it('lists resources via stdio', async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/index.ts'],
      cwd: new URL('..', import.meta.url).pathname,
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);

    const { resources } = await client.listResources();
    expect(resources.length).toBeGreaterThan(0);

    await client.close();
  });

  it('lists prompts via stdio', async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/index.ts'],
      cwd: new URL('..', import.meta.url).pathname,
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);

    const { prompts } = await client.listPrompts();
    expect(prompts.length).toBe(3);

    await client.close();
  });
});
```

**Step 3: Run tests**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/mcp-server/src/index.ts packages/mcp-server/src/index.test.ts
git commit -m "feat: add stdio and Streamable HTTP transports"
```

---

### Task 10: Bundle, npm publish setup, and client docs

**Files:**
- Modify: `packages/mcp-server/package.json` (verify bin, files, exports)
- Modify: `release-please-config.json` (add mcp-server component)
- Modify: `.release-please-manifest.json` (add mcp-server entry)
- Create: `packages/mcp-server/.gitignore`
- Modify: `package.json` (root — add mcp-server scripts)

**Step 1: Create .gitignore**

```
dist/
node_modules/
```

**Step 2: Test the bundle**

Run: `cd packages/mcp-server && pnpm run bundle`
Expected: `dist/mcp-server.bundle.cjs` created

Run: `echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}' | node dist/mcp-server.bundle.cjs`
Expected: JSON-RPC response with server capabilities

**Step 3: Add to release-please-config.json**

Add `packages/mcp-server` component with same settings as `packages/core`.

**Step 4: Add root scripts**

Add to root `package.json` scripts:
```json
"mcp:build": "pnpm --filter @oss-autopilot/mcp run build",
"mcp:bundle": "pnpm --filter @oss-autopilot/mcp run bundle",
"mcp:test": "pnpm --filter @oss-autopilot/mcp run test"
```

**Step 5: Verify end-to-end**

Run: `pnpm test` (all packages)
Run: `pnpm run mcp:bundle`
Expected: All pass, bundle created

**Step 6: Commit**

```bash
git add packages/mcp-server/.gitignore package.json release-please-config.json \
  .release-please-manifest.json
git commit -m "feat: MCP server bundle and npm publish setup"
```

---

### Task 11: Add .mcp.json to Claude Code plugin

**Files:**
- Create: `.mcp.json` (plugin root)

**Step 1: Create .mcp.json**

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

**Step 2: Commit**

```bash
git add .mcp.json
git commit -m "feat: add .mcp.json for Claude Code plugin MCP mode"
```
