# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## IMPORTANT: If User Just Pasted This Repo URL

**Guide them through installation immediately. Don't wait for them to ask.**

Say: "I see you want to install OSS Autopilot! Let me help you set it up."

Then follow the steps below.

### Step 1: Check prerequisites

```bash
node --version  # Need 22+
gh auth status  # Need GitHub CLI authenticated
```

If `gh` is not installed or authenticated:
> "You'll need the GitHub CLI for this plugin. Install it from https://cli.github.com/ and run `gh auth login`."

### Step 2: Install the plugin (marketplace)

```
/plugin marketplace add costajohnt/oss-autopilot
/plugin install oss-autopilot@oss-autopilot
```

### Step 3: Restart and run setup

> "Great! The plugin is installed. Please restart Claude Code to load it, then run `/setup-oss` to configure your preferences."

After restart, `/oss` and `/setup-oss` commands will be available.

The CLI auto-builds on first run (requires Node.js 22+ and npm).

---

## For Developers: Project Overview

oss-autopilot is a **Claude Code plugin with a TypeScript CLI backend** for managing open source contributions. The repo is structured as a **pnpm monorepo**.

### Architecture

The system has three layers:

1. **Plugin Layer** (`commands/`, `agents/`, `skills/`) — Markdown-based Claude Code plugin components. Commands like `/oss` orchestrate the workflow. Agents handle specific tasks (PR response, CI diagnosis, issue scouting). Skills contain contribution best practices.

2. **TypeScript CLI** (`packages/core/src/cli.ts` → `packages/core/dist/cli.bundle.cjs`) — Commander-based CLI that the plugin invokes with `--json` for structured output. Entry point is `packages/core/src/cli.ts`, which registers subcommands from `packages/core/src/commands/`. The CLI is bundled into a single CJS file via esbuild for portability.

3. **Core Logic** (`packages/core/src/core/`) — The domain layer. Key modules:
   - `types.ts` — All type definitions. Key PR type: `FetchedPR` (ephemeral, fetched fresh each run in v2). `TrackedPR` was removed in v2.
   - `state.ts` — `StateManager` singleton. Reads/writes `~/.oss-autopilot/state.json`. Handles v1→v2→v3→v4 migration and auto-backups
   - `pr-monitor.ts` — `PRMonitor` class. Fetches open PRs from GitHub Search API, enriches each with CI status, review decision, merge conflicts, maintainer comments, and computes `FetchedPRStatus`
   - `github.ts` — Shared Octokit instance with `@octokit/plugin-throttling` for rate limit handling
   - `utils.ts` — GitHub URL parsing, date helpers, token detection (tries `$GITHUB_TOKEN` then `gh auth token`)
   - Issue discovery and vetting are delegated to `@oss-scout/core` via `commands/scout-bridge.ts`

### Key Design Decisions

- **v2 "Fresh Fetch" architecture**: PRs are NOT stored in local state. On each `daily` run, all open PRs are fetched from GitHub's Search API. The `TrackedPR` type and legacy PR arrays have been fully removed.
- **`--json` contract**: Every CLI command supports `--json`, outputting `{ success: boolean, data?: T, error?: string, timestamp: string }` (see `packages/core/src/formatters/json.ts`). The plugin layer parses this structured output.
- **State lives in `~/.oss-autopilot/`**, not in the repo. This separates user data from plugin code.
- **GitHub auth**: The CLI checks for a token via `$GITHUB_TOKEN` env var (preferred) or `gh auth token` CLI fallback. Commands that don't need GitHub access are marked `localOnly` in the command registry.
- **pnpm monorepo**: Development uses pnpm workspaces. Plugin auto-build scopes `npm install` to `packages/core/` (end users don't need pnpm).

### File Structure

```
Repo root (also the Claude Code plugin directory):
├── commands/oss.md, setup-oss.md       # Plugin slash commands
├── agents/*.md                          # 7 specialized agents
├── skills/oss-contribution/SKILL.md     # Contribution index (universal rules)
├── skills/pr-etiquette/SKILL.md         # Review responses, PR descriptions, dormant follow-up
├── skills/contribution-ethics/SKILL.md  # AI attribution, AI-tell avoidance, defer-to-human
├── workflows/*.md                       # Workflow orchestration files
├── .claude-plugin/plugin.json           # Plugin manifest
├── .claude-plugin/marketplace.json      # Marketplace catalog
├── packages/
│   ├── core/                            # @oss-autopilot/core (npm package)
│   │   ├── src/
│   │   │   ├── cli.ts                   # CLI entry point (commander setup)
│   │   │   ├── commands/                # CLI subcommands (daily, search, track, etc.)
│   │   │   ├── core/                    # Domain logic + tests
│   │   │   └── formatters/json.ts       # JSON output formatter
│   │   ├── dist/cli.bundle.cjs          # Built bundle (gitignored, auto-generated)
│   │   ├── package.json                 # Published to npm, has bin + exports
│   │   └── tsconfig.json
│   ├── dashboard/                       # @oss-autopilot/dashboard (interactive SPA)
│   │   └── package.json
│   └── mcp-server/                      # @oss-autopilot/mcp (MCP server bin)
│       └── package.json
├── pnpm-workspace.yaml                  # Workspace definition
├── package.json                         # Workspace root (private, not published)
└── CLAUDE.md

~/.oss-autopilot/                        # User data (separate from plugin code)
├── state.json                           # AgentState (see state-schema.ts for fields)
├── backups/                             # Auto-backups of state before writes
├── cache/                               # ETag-based HTTP response cache
├── gist-id                              # Gist ID for cross-machine state sync (opt-in)
├── state-cache.json                     # Local cache of gist state for offline access
└── dashboard-server.pid                 # PID file for interactive SPA dashboard server
```

## Development Commands

This project uses **pnpm** for development. Root scripts delegate to `packages/core`.

```bash
pnpm install              # Install all workspace dependencies
pnpm test                 # Run all tests (vitest run)
pnpm run test:watch       # Run tests in watch mode (vitest)
pnpm run bundle           # Rebuild CLI bundle (esbuild → packages/core/dist/cli.bundle.cjs)
pnpm start -- daily       # Run CLI via tsx (dev mode, no bundle needed)
pnpm start -- daily --json  # Test JSON output format
```

### Running a single test

Tests use vitest and are co-located with source (`packages/core/src/core/*.test.ts`). No separate vitest config file — configuration is inferred from package.json.

```bash
cd packages/core
npx vitest run src/core/state.test.ts           # Run one test file
npx vitest run -t "should track a new PR"       # Run by test name
npx vitest src/core/state.test.ts               # Watch mode for one file
```

### Testing the CLI locally

```bash
# Via tsx (development — no bundle needed):
pnpm start -- status --json
pnpm start -- daily --json

# Via bundle (production — must run pnpm run bundle first):
GITHUB_TOKEN=$(gh auth token) node packages/core/dist/cli.bundle.cjs daily --json
```

## Git Workflow

**Before starting any task that involves writing code**, ALWAYS:
```bash
git checkout main && git pull && git checkout -b <branch-name>
```
This is mandatory. Never skip this step. Never start work on a stale branch or directly on main.

Branch naming: `feature/description`, `fix/description`, `chore/description`.

Then:
1. Make changes and test: `pnpm test`
2. Commit with conventional format: `feat:`, `fix:`, `refactor:`
3. Push and open PR

**Important:**
- Do NOT push directly to main
- Keep PRs focused and atomic
- Do NOT amend commits without explicit permission
- No merge commits. Always rebase (`git pull --rebase`, `git rebase main`)
- Always add new commits on top of current work (never rewrite pushed history)
- When merging PRs, always **squash and merge**

## Code Review

**Before pushing or after significant changes, run the pr-review-toolkit to review code extensively.** Launch multiple review agents in parallel:

- `pr-review-toolkit:code-reviewer` — bugs, logic errors, dead code, consistency
- `pr-review-toolkit:silent-failure-hunter` — error handling gaps, swallowed errors
- `pr-review-toolkit:code-simplifier` — refactoring, simplification, redundancy

Always look for opportunities to refactor, simplify, and remove dead code. Fix actionable findings before pushing.

## Subagent Usage

**Use subagents (Task tool) in parallel whenever possible.** When a task involves multiple independent pieces of work — research, code review, exploration across different files or modules — dispatch them concurrently in a single message rather than sequentially. This dramatically reduces wall-clock time.

## Versioning

**Versioning is automated via [release-please](https://github.com/googleapis/release-please).** Do NOT manually bump versions or edit CHANGELOG.md.

- Use [conventional commits](https://www.conventionalcommits.org/): `feat:` (minor), `fix:` (patch), `chore:` (no release). Releasable commits (`feat:`, `fix:`) become CHANGELOG entries, so write them descriptively
- On push to main, release-please opens or updates a release PR that bumps all version-bearing files (configured in `release-please-config.json`)
- Merge the release-please PR to create a GitHub release, which triggers npm publish
- **release-please force-updates its branch** (`release-please--branches--main`) on every push to main. `git pull --rebase` will print a `forced update` notice for that ref — that's expected, ignore it. The notice never affects your branch.

## AI Attribution Rule (CRITICAL)

NEVER add AI attribution to commits, comments, PRs, or any content submitted to external repositories unless explicitly required by that repo's contribution guidelines. This includes:
- No "Co-Authored-By: Claude" in commit messages
- No "Generated with Claude Code" in PR descriptions
- No robot emoji attributions
- No mentions of AI assistance in comments
Contributions should appear as solely from the user.
