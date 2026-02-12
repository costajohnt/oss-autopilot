# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## IMPORTANT: If User Just Pasted This Repo URL

**Guide them through installation immediately. Don't wait for them to ask.**

Say: "I see you want to install OSS Autopilot! Let me help you set it up."

Then follow the steps below.

### Step 1: Check prerequisites

```bash
node --version  # Need 18+
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

The CLI auto-builds on first run (requires Node.js 18+ and npm).

---

## For Developers: Project Overview

oss-autopilot is a **Claude Code plugin with a TypeScript CLI backend** for managing open source contributions.

### Architecture

The system has three layers:

1. **Plugin Layer** (`commands/`, `agents/`, `skills/`) — Markdown-based Claude Code plugin components. Commands like `/oss` orchestrate the workflow. Agents handle specific tasks (PR response, CI diagnosis, issue scouting). Skills contain contribution best practices.

2. **TypeScript CLI** (`src/cli.ts` → `dist/cli.bundle.cjs`) — Commander-based CLI that the plugin invokes with `--json` for structured output. Entry point is `src/cli.ts`, which registers subcommands from `src/commands/`. The CLI is bundled into a single CJS file via esbuild for portability.

3. **Core Logic** (`src/core/`) — The domain layer. Key modules:
   - `types.ts` — All type definitions. Two key PR types: `TrackedPR` (persisted in state, v1 legacy) and `FetchedPR` (ephemeral, fetched fresh each run in v2)
   - `state.ts` — `StateManager` singleton. Reads/writes `~/.oss-autopilot/state.json`. Handles v1→v2 migration and auto-backups
   - `pr-monitor.ts` — `PRMonitor` class. Fetches open PRs from GitHub Search API, enriches each with CI status, review decision, merge conflicts, maintainer comments, and computes `FetchedPRStatus`
   - `github.ts` — Shared Octokit instance with `@octokit/plugin-throttling` for rate limit handling
   - `issue-discovery.ts` — `IssueDiscovery` class for finding contributable issues
   - `utils.ts` — GitHub URL parsing, date helpers, token detection (tries `gh auth token` then `$GITHUB_TOKEN`)

### Key Design Decisions

- **v2 "Fresh Fetch" architecture**: PRs are NOT stored in local state. On each `daily` run, all open PRs are fetched from GitHub's Search API. The `TrackedPR` arrays in state exist only for backward compatibility with v1 data.
- **`--json` contract**: Every CLI command supports `--json`, outputting `{ success: boolean, data?: T, error?: string, timestamp: string }` (see `src/formatters/json.ts`). The plugin layer parses this structured output.
- **State lives in `~/.oss-autopilot/`**, not in the repo. This separates user data from plugin code.
- **GitHub auth**: The CLI checks for a token via `gh auth token` (preferred) or `$GITHUB_TOKEN` env var. Commands that don't need GitHub access are listed in `LOCAL_ONLY_COMMANDS` in `cli.ts`.

### File Structure

```
Plugin directory:
├── commands/oss.md, setup-oss.md    # Plugin slash commands (markdown with YAML frontmatter)
├── agents/*.md                       # 7 specialized agents (pr-responder, issue-scout, etc.)
├── skills/oss-contribution/SKILL.md  # Contribution best practices skill
├── .claude-plugin/plugin.json        # Plugin manifest (version must match package.json)
├── .claude-plugin/marketplace.json   # Marketplace catalog (required for /plugin marketplace add)
├── src/                              # TypeScript source
│   ├── cli.ts                        # CLI entry point (commander setup)
│   ├── commands/                     # CLI subcommands (daily, search, track, etc.)
│   ├── core/                         # Domain logic + tests
│   └── formatters/json.ts            # JSON output formatter
└── dist/cli.bundle.cjs               # Built bundle (gitignored, auto-generated)

~/.oss-autopilot/                     # User data (separate from plugin code)
├── state.json                        # PR tracking state (AgentState)
├── backups/                          # Auto-backups of state before writes
└── dashboard.html                    # Generated HTML dashboard
```

## Development Commands

```bash
npm install             # Install dependencies
npm test                # Run all tests (vitest run)
npm run test:watch      # Run tests in watch mode (vitest)
npm run bundle          # Rebuild CLI bundle (esbuild → dist/cli.bundle.cjs)
npm start -- daily      # Run CLI via tsx (dev mode, no bundle needed)
npm start -- daily --json  # Test JSON output format
```

### Running a single test

Tests use vitest and are co-located with source (`src/core/*.test.ts`). No separate vitest config file — configuration is inferred from package.json.

```bash
npx vitest run src/core/state.test.ts           # Run one test file
npx vitest run -t "should track a new PR"       # Run by test name
npx vitest src/core/state.test.ts               # Watch mode for one file
```

### Testing the CLI locally

```bash
# Via tsx (development — no bundle needed):
npm start -- status --json
npm start -- daily --json

# Via bundle (production — must run npm run bundle first):
GITHUB_TOKEN=$(gh auth token) node dist/cli.bundle.cjs daily --json
```

## Git Workflow

**Before starting any task that involves writing code**, ALWAYS:
```bash
git checkout main && git pull && git checkout -b <branch-name>
```
This is mandatory. Never skip this step. Never start work on a stale branch or directly on main.

Branch naming: `feature/description`, `fix/description`, `chore/description`.

Then:
1. Make changes and test: `npm test`
2. **Bump version and update changelog** (see Versioning below)
3. Commit with conventional format: `feat:`, `fix:`, `refactor:`
4. Push and open PR

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

**Every PR must include a version bump and changelog entry.**

- Bump the version in **all three** places (they must always match):
  - `package.json`
  - `.claude-plugin/plugin.json`
  - `README.md` badge (`![Version](https://img.shields.io/badge/version-X.Y.Z-blue)`)
- Follow [semver](https://semver.org/): bug fix = patch, new feature = minor
- Add a new section to `CHANGELOG.md` with the bumped version and a description of your changes (use `Added`, `Changed`, `Fixed` headings)
- Add a comparison link at the bottom of `CHANGELOG.md` for the new version

## AI Attribution Rule (CRITICAL)

NEVER add AI attribution to commits, comments, PRs, or any content submitted to external repositories unless explicitly required by that repo's contribution guidelines. This includes:
- No "Co-Authored-By: Claude" in commit messages
- No "Generated with Claude Code" in PR descriptions
- No robot emoji attributions
- No mentions of AI assistance in comments
Contributions should appear as solely from the user.
