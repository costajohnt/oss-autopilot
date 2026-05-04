# Architecture

OSS Autopilot is a Claude Code plugin with a TypeScript CLI backend for managing open source contributions. It has a three-layer design: a **Plugin Layer** of markdown components that Claude Code executes, a **CLI Layer** that provides structured data via `--json`, and a **Core Domain Layer** of TypeScript modules that fetch GitHub data and manage state.

## Layer Diagram

```
┌─────────────────────────────────────────────────────────┐
│  Plugin Layer (Claude Code)                             │
│  commands/*.md  agents/*.md  skills/  workflows/  hooks │
├─────────────────────────────────────────────────────────┤
│  CLI Layer (Node.js)                                    │
│  packages/core/src/cli.ts → subcommands → --json stdout │
├─────────────────────────────────────────────────────────┤
│  Core Domain Layer (TypeScript)                         │
│  packages/core/src/core/ — fetchers + state management  │
└─────────────────────────────────────────────────────────┘
```

## Plugin Layer

The plugin layer consists of markdown files that Claude Code discovers and executes. These are not code — they are structured prompts with YAML frontmatter that define behavior.

### Commands (`commands/`)

| File | Slash Command | Purpose |
|------|--------------|---------|
| `oss.md` | `/oss` | Core router — startup, summary, action menu, execution |
| `setup-oss.md` | `/setup-oss` | First-run configuration wizard |
| `oss-search.md` | `/oss-search` | Issue discovery with multi-strategy search |
| `oss-help.md` | `/oss-help` | Quick reference card for commands, agents, and workflows |
| `oss-dashboard.md` | `/oss-dashboard` | Open the interactive SPA dashboard in the browser |
| `pr-ready.md` | `/pr-ready` | Run the pre-commit review loop and signal when the branch is ready to push |

Commands invoke the CLI via bash (`node packages/core/dist/cli.bundle.cjs <subcommand> --json`), parse the JSON response, and present results to the user through Claude Code's conversational interface.

### Workflows (`workflows/`)

Workflows contain delegated logic that commands read on demand. They are not standalone commands — they are loaded by `oss.md` when needed.

| File | Trigger | Purpose |
|------|---------|---------|
| `startup-and-build.md` | `/oss` start | CLI build check, auth, startup call, session state setup |
| `action-menu.md` | After startup | Present action menu from pre-computed items |
| `work-through-issues.md` | "Work through all issues" action | Parallel investigation → consolidated display → sequential execution |
| `review-issue-replies.md` | "Review issue replies" action | Review and respond to maintainer replies on claimed issues |
| `pre-commit-review.md` | Before any commit/push | Multi-agent code review gate (existing PR updates) |
| `draft-first-workflow.md` | New contributions | Create draft PR → iterative review → squash → mark ready |
| `dispatch-review.md` | On request | Dispatch a multi-specialist review of the current branch |
| `dormant-pr-follow-up.md` | Dormant PR detected | Polite, escalating follow-up cadence with maintainers |
| `extract-learnings.md` | After PR merge | Distill maintainer feedback into per-repo guidelines via `guidelines fetch-corpus` + extract-learnings prompt (#867) |
| `reference.md` | Always loaded | Shared conventions and formatting rules |

### Agents (`agents/`)

Seven specialized agents handle specific tasks autonomously:

| Agent | Role |
|-------|------|
| `pr-responder` | Draft responses to maintainer feedback |
| `pr-health-checker` | Diagnose CI, rebase, conflict status |
| `pr-compliance-checker` | Validate PRs against opensource.guide best practices |
| `issue-scout` | Vet issues for claimability and fit |
| `repo-evaluator` | Score repository health and responsiveness |
| `contribution-strategist` | Plan implementation approach |
| `pre-commit-reviewer` | Fallback code review (when toolkit unavailable) |

### Skills (`skills/`)

- `oss-contribution/SKILL.md` — Index for the contribution skill family. Universal rules: minimal-diff discipline, working on issues, time management, failure protocol.
- `pr-etiquette/SKILL.md` — Review-feedback responses, PR descriptions, dormant-PR follow-up cadence, PR quality checklist, communication style.
- `contribution-ethics/SKILL.md` — AI attribution rules, AI-tell avoidance in maintainer-visible writing, when to defer to a human contributor.

### Hooks (`hooks/`)

- `hooks.json` — Registers the `SessionStart` event.
- `session-start.sh` — Runs on every Claude Code session start. Auto-pulls marketplace updates, rebuilds stale CLI bundles, checks for version updates, and runs a quick PR health check. Outputs JSON with `systemMessage` for Claude Code to display.

## CLI Layer

### Entry Point (`packages/core/src/cli.ts`)

A Commander program that loads command definitions from `cli-registry.ts`. Each command declares its name, `localOnly` flag, and a `register` function that sets up its Commander options and lazy-loads the implementation module via dynamic `import()`. The `--json` flag on any command switches output to structured JSON.

Key design:
- **Lazy loading** — only the invoked command's module is evaluated (dynamic `import()` inside action handlers).
- **Async token fetch** — the `preAction` hook fetches the GitHub token without blocking.
- **`localOnly` registry flag** — 20 commands that skip the `preAction` GitHub token check. Note: some (like `startup`) still make GitHub API calls but handle auth internally, returning structured errors instead of calling `process.exit`.

### JSON Contract

Every command outputs a `JsonOutput<T>` envelope to stdout:

```typescript
interface JsonOutput<T> {
  success: boolean;
  data?: T;          // Command-specific payload
  error?: string;    // Human-readable error message
  timestamp: string; // ISO 8601
}
```

Debug and warning output goes to stderr via the logger, so it never contaminates the JSON contract on stdout.

### Subcommands (`packages/core/src/commands/`)

| Command | Module | Purpose |
|---------|--------|---------|
| `startup` | `startup.ts` | Combined auth + setup + daily + dashboard (single CLI call) |
| `daily` | `daily.ts` | Fetch all open PRs, compute digest, generate dashboard |
| `search` | `search.ts` | Multi-strategy issue discovery |
| `track` | `track.ts` | Fetch PR metadata for inspection (no longer persists; `untrack` removed in v4 / #1133) |
| `status` | `status.ts` | Show contribution stats from local state |
| `config` | `config.ts` | Read/write user configuration |
| `init` | `init.ts` | Initialize with GitHub username and import open PRs |
| `setup` / `checkSetup` | `setup.ts` | First-run setup and setup verification |
| `vet` | `vet.ts` | Vet a single issue for claimability |
| `vet-list` | `vet-list.ts` | Re-vet all issues in a curated issue list |
| `dashboard serve` | `dashboard.ts` | Launch interactive SPA dashboard (with `dashboard-data.ts`, `dashboard-lifecycle.ts`, `dashboard-process.ts`, `dashboard-server.ts`) |
| `move` | `move.ts` | Transition a PR between states: attention, waiting, shelved, auto |
| `shelve` / `unshelve` | `move.ts` (aliases) | Exclude PRs from capacity and actionable items |
| `override` / `clear-override` | `move.ts` (aliases) | Backward-compatible status override commands |
| `dismiss` / `undismiss` | `dismiss.ts` | Dismiss issue reply notifications (auto-resurfaces on new activity) |
| `comments` / `post` / `claim` | `comments.ts` | Track issue conversations, post comments, claim issues |
| `local-repos` | `local-repos.ts` | Scan for locally cloned repos |
| `parse-issue-list` | `parse-list.ts` | Parse a curated issue list file |
| `orphan-files` (alias: `check-integration`) | `check-integration.ts` | Audit new files on this branch for cross-references |
| `doctor` | `doctor.ts` | System-health diagnostic — token, bundle, state, scout, rate limit |
| `stats` | `stats.ts` | Show contribution statistics (merge rate, PR counts) |
| `guidelines view/store/reset/fetch-corpus` | `guidelines.ts` | Per-repo guidelines persistence + raw PR comment corpus for the host's extract-learnings prompt (#867) |
| `manifest` | `cli-registry.ts` | Print the registered command list + version (used by plugin contract tests) |
| `detect-formatters` | `detect-formatters.ts` | Detect formatters and linters configured in a repository |
| `pr-template` | `pr-template.ts` | Fetch a repository's PR description template |

### Build

```
esbuild src/cli.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist/cli.bundle.cjs  # run from packages/core/
```

The bundle is a single CommonJS file (gitignored, auto-generated). The `SessionStart` hook rebuilds it if `package.json` is newer than the bundle.

## Core Domain Layer (`packages/core/src/core/`)

### State Management (`state.ts`)

`StateManager` is a singleton that reads/writes `~/.oss-autopilot/state.json`. Features:
- **Advisory file locking** (`wx` flag) with stale lock detection (30s timeout)
- **Auto-backups** before every write (stored in `~/.oss-autopilot/backups/`)
- **v1 → v2 → v3 → v4 migration chain** built into the load path (v4 added `commentsFetchedAt` for the #867 corpus pipeline)

### PR Monitoring (`pr-monitor.ts`)

`PRMonitor` fetches all open PRs authored by the user from GitHub's Search API. For each PR, it enriches with:
- CI status (check runs + combined status → classified as passing/failing/blocked/not-running)
- Review decision (approved/changes-requested/commented)
- Merge conflict detection
- Maintainer comment analysis (unresponded comments, action hints)
- Checklist completeness
- Dormancy detection (approaching-dormant / dormant based on inactivity)

Enrichment happens inline within `fetchUserOpenPRs()` via a bounded-concurrency worker pool — there is no separate `enrichPR` method.

Decomposed into focused sub-modules:

| Module | Responsibility |
|--------|---------------|
| `ci-analysis.ts` | CI check classification and failure categorization |
| `review-analysis.ts` | Review decisions, comment detection |
| `checklist-analysis.ts` | PR body checklist parsing |
| `maintainer-analysis.ts` | Extract maintainer action hints |
| `display-utils.ts` | Compute display labels for the dashboard |
| `github-stats.ts` | Merged/closed PR counts, star fetching |

### Issue Discovery (delegated to `@oss-scout/core`)

Issue discovery, vetting, and scoring are handled by the `@oss-scout/core` package. The CLI bridges to it via `commands/scout-bridge.ts`, which maps oss-autopilot's state (preferences, repo scores, merged/closed PRs) into the format oss-scout expects. The `search`, `vet`, and `vet-list` commands all delegate through this bridge.

### GitHub Client (`github.ts`)

Shared `Octokit` instance with `@octokit/plugin-throttling`:
- Automatic retry on rate limits (up to 2 retries)
- Token cached per session (singleton pattern)
- `checkRateLimit()` for pre-flight quota checks

### HTTP Cache (`http-cache.ts`)

ETag-based caching for GitHub API responses:
- Stores ETags and response bodies in `~/.oss-autopilot/cache/`
- 304 responses don't count against rate limits
- In-flight request deduplication (concurrent calls for the same URL share one round-trip)

### Other Core Modules

| Module | Purpose |
|--------|---------|
| `utils.ts` | GitHub URL parsing, date helpers, token detection, path helpers |
| `errors.ts` | Error hierarchy: `OssAutopilotError` → `ConfigurationError`, `ValidationError` |
| `logger.ts` | Debug/warn logger. Output goes to stderr. Activated by `--debug` flag |
| `concurrency.ts` | `runWorkerPool<T>()` — bounded-concurrency Promise pool |
| `pagination.ts` | GitHub API pagination helper |
| `types.ts` | All type definitions (`FetchedPR`, `DailyDigest`, `AgentState`, etc.) |
| `daily-logic.ts` | Standalone functions for daily digest business logic (action menu computation, summary formatting) |
| `issue-conversation.ts` | `IssueConversationMonitor` — monitors issues the user has commented on for new maintainer responses |
| `status-determination.ts` | Compute `FetchedPRStatus` from CI, review, conflict, and dormancy signals |
| `state-schema.ts` | Zod schemas for all persisted types (`AgentState`, `AgentConfig`, etc.) |
| `state-persistence.ts` | Low-level file I/O: read/write state.json with locking and backups |
| `repo-score-manager.ts` | Repository score tracking with TTL-based staleness |
| `gist-state-store.ts` | Gist-based persistence layer for cross-machine state sync |
| `stats.ts` | Contribution statistics computation (merge rate, PR counts, timeline) |
| `formatter-detection.ts` | Detect linters and formatters configured in a repository |
| `comment-utils.ts` | Bot detection and acknowledgment comment filtering |
| `pr-template.ts` | Fetch PR description templates from repositories |

## Data Flow

A typical `/oss` invocation flows through all three layers:

```
User runs /oss
       │
       ▼
Plugin Layer (oss.md)
  │  Runs bash: node packages/core/dist/cli.bundle.cjs startup --json
  │
  ▼
CLI Layer (startup.ts)
  │  Calls daily.ts orchestration
  │  │
  │  ▼
  │  Core Layer
  │  ├── PRMonitor.fetchUserOpenPRs()     → GitHub Search API + per-PR enrichment
  │  ├── StateManager.load()              → ~/.oss-autopilot/state.json
  │  └── computeActionMenu()              → Pre-computed menu items (daily-logic.ts)
  │
  │  launchDashboardServer()              → http://localhost:3000 (SPA dashboard)
  │
  │  Returns JsonOutput<StartupOutput> to stdout
  │
  ▼
Plugin Layer (oss.md)
  │  Parses JSON, displays summary
  │  Presents action menu via AskUserQuestion
  │
  ├── "Work through all issues" → reads workflows/work-through-issues.md
  │     Dispatches agents in parallel per repo
  │     Routes to pre-commit-review.md or draft-first-workflow.md
  │
  ├── "Search for new issues" → /oss-search command
  │     Calls: node packages/core/dist/cli.bundle.cjs search --json
  │     Dispatches issue-scout agent to vet candidates
  │
  └── "Done for now" → Session End
```

## State Architecture

### What's Stored Locally (`~/.oss-autopilot/state.json`)

The root `AgentState` interface (see `packages/core/src/core/state-schema.ts` for the canonical Zod schema):

```typescript
interface AgentState {
  version: number;                   // Currently 4 (v4 added commentsFetchedAt for the #867 corpus pipeline)
  gistId?: string;                   // Gist ID for cross-machine state sync
  repoScores: Record<string, RepoScore>;
  config: AgentConfig;              // User preferences + shelved/dismissed state
  lastRunAt: string;
  lastDigestAt?: string;
  lastDigest?: DailyDigest;         // Cached for dashboard rendering
  monthlyMergedCounts?: Record<string, number>;
  monthlyClosedCounts?: Record<string, number>;
  monthlyOpenedCounts?: Record<string, number>;
  localRepoCache?: LocalRepoCache;
  mergedPRs?: StoredMergedPR[];     // Stored merged PR records
  closedPRs?: StoredClosedPR[];     // Stored closed PR records
  analyzedIssueConversations?: AnalyzedIssueConversation[];
  activeIssues: TrackedIssue[];     // Issues user has claimed
}
```

Shelving, overrides, and dismissing state lives inside `config: AgentConfig`:
- `config.shelvedPRUrls: string[]` — PR URLs manually shelved (excluded from capacity and actionable items, auto-unshelved when maintainers engage)
- `config.statusOverrides: Record<string, StatusOverride>` — Manual PR status overrides set via `move` command. Auto-clears when the PR has new activity
- `config.dismissedIssues: Record<string, string>` — Issue URLs mapped to dismiss timestamps

### What's NOT Stored (v2 Design)

PRs are **not** stored in state. On every `daily` run, all open PRs are fetched fresh from GitHub's Search API. This eliminates stale-state bugs — the only source of truth for PR status is GitHub itself.

### File Layout

```
~/.oss-autopilot/
├── state.json            # AgentState (see state-schema.ts for fields)
├── backups/              # Auto-backups before each state write
├── cache/                # ETag-based HTTP response cache
├── gist-id               # Gist ID for cross-machine state sync (opt-in)
├── state-cache.json      # Local cache of gist state for offline access
└── dashboard-server.pid  # Running dashboard server PID + port
```

## Security Model

- **Token resolution**: `$GITHUB_TOKEN` env var is checked first; `gh auth token` is the fallback. Token is cached in-memory per session, never written to disk.
- **File permissions**: Data directory created with mode `0o700` (owner-only access). State file uses advisory locking to prevent concurrent corruption.
- **Output isolation**: Debug/warning logs go to stderr; JSON output goes to stdout. This prevents log noise from corrupting the structured JSON contract.
