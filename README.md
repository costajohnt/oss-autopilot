# OSS Autopilot

You have 12 open PRs across GitHub. A maintainer asked a question 5 days ago. Two PRs have failing CI you haven't noticed. And you're about to open another one.

**Sound familiar?**

OSS Autopilot is an AI copilot that tracks all your open source PRs, alerts you when something needs attention, and helps you respond to maintainer feedback so your contributions actually get merged.

![CI](https://github.com/costajohnt/oss-autopilot/actions/workflows/ci.yml/badge.svg)
![Tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/costajohnt/oss-autopilot/badges/.github/badges/tests.json)
![License](https://img.shields.io/badge/license-MIT-green)
[![npm @oss-autopilot/core](https://img.shields.io/npm/v/@oss-autopilot/core)](https://www.npmjs.com/package/@oss-autopilot/core)
[![npm @oss-autopilot/mcp](https://img.shields.io/npm/v/@oss-autopilot/mcp)](https://www.npmjs.com/package/@oss-autopilot/mcp)
![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-blueviolet)

![OSS Autopilot Demo](docs/images/demo.gif)

## Install in 60 Seconds

### Claude Code Plugin (recommended)

**Prerequisites:** [Claude Code](https://claude.ai/claude-code), Node.js 20+, [GitHub CLI](https://cli.github.com/) (`gh auth login`)

```
/plugin marketplace add costajohnt/oss-autopilot
/plugin install oss-autopilot@oss-autopilot
```

Restart Claude Code, then run `/setup-oss`. Done.

### MCP Server (Cursor, Claude Desktop, Codex, Windsurf)

```bash
npx @oss-autopilot/mcp@latest --init <your-github-username>
```

Then add to your MCP client config:

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

The MCP server exposes 21 tools, 5 resources, and 3 prompts — the full OSS Autopilot feature set.

### npm Package (programmatic use)

```bash
npm install @oss-autopilot/core
```

```typescript
import { runDaily, runSearch, runStatus } from '@oss-autopilot/core/commands';

const digest = await runDaily();
const issues = await runSearch({ maxResults: 10 });
```

## What Happens When You Run `/oss`

Claude checks every open PR you have across all of GitHub and tells you what needs your attention:

```
📊 15 Active PRs | 2 need attention | Dashboard opened in browser | v0.42.6

2 PRs Need Attention (in priority order):

1. [Needs Response] vadimdemedes/ink#855 - Add kitty keyboard support (3d)
   └─ @sindresorhus: tests requested
   └─ Effort: Medium - respond + add tests

2. [CI Failing] rubyforgood/human-essentials#5492 - Add item filter (1d)
   └─ Failing: rspec, lint
   └─ Effort: Medium - investigate CI logs

What would you like to do?
  > Work through all 2 issues (Recommended)
  > Search for new issues
  > Done for now
```

Then Claude walks you through each issue: drafting responses, diagnosing CI failures, resolving conflicts, until everything is handled.

An interactive dashboard also opens in your browser at `http://localhost:3000` with charts showing your contribution timeline, merge rate, and PR health at a glance.

### When You Search for Issues

Select "Search for new issues" and the issue scout finds opportunities matched to your history — not just random "good first issue" results:

```
🔍 Found 8 candidates across 6 repos

From repos where you've merged PRs ⭐
─────────────────────────────────────
1. ✅ expressjs/express#6012 — Add timeout option to res.download()
   Labels: feature, good first issue
   Score: 92/100 — You merged 2 PRs here, clear requirements, active repo
   ✓ unclaimed · ✓ no linked PRs · ✓ last commit 2 days ago

2. ✅ chalk/chalk#642 — Support NO_COLOR in browser builds
   Labels: enhancement
   Score: 85/100 — You merged 1 PR here, repo has 7-day merge time
   ✓ unclaimed · ✓ no linked PRs · ✓ CONTRIBUTING.md found

From your starred repos
─────────────────────────────────────
3. ✅ sindresorhus/execa#831 — Add encoding option to execaNode
   Labels: good first issue, help wanted
   Score: 78/100 — High-quality repo, clear requirements, recent activity
   ✓ unclaimed · ✓ no linked PRs · ✓ last commit 5 days ago

Skipped (not worth your time)
─────────────────────────────────────
⚠ fake-oss/calculator — Label farming detected (6 beginner labels)
⚠ inactive/legacy-app — No commits in 90+ days
⚠ contested/router#44 — Already claimed by @other-dev 2 days ago
```

Each issue gets a **viability score (0-100)** based on your relationship with the repo, issue clarity, project health, and whether someone else has already claimed it. Repos where your PRs got merged are prioritized first — that's where you have the highest chance of getting another PR accepted.

## The Problem

Contributing to open source is rewarding but hard to sustain:

- **PRs go stale** - You forget to check on submissions from weeks ago
- **Comments get missed** - Maintainer feedback sits unanswered, PRs rot
- **No good starting point** - You want to contribute but don't know where
- **Tracking is tedious** - Multiple contributions across repos, each with different status

## How OSS Autopilot Helps

| What it does | How |
|---|---|
| **Monitors all your PRs** | Checks for new comments, CI failures, merge conflicts, incomplete checklists, and maintainer requests |
| **Drafts responses** | Claude reads maintainer feedback and writes a response for your review |
| **Finds issues matched to you** | 3-phase priority search: repos where you've merged PRs first, then starred repos, then general discovery. Scores every issue 0-100 on viability. Filters spam repos, claimed issues, and inactive projects |
| **Scores repositories** | Evaluates merge rate, PR review speed, maintainer responsiveness, and community health. Caches scores and tracks your relationship with each repo |
| **Keeps you honest** | Flags approaching-dormant PRs and capacity limits so nothing slips |
| **Never acts without you** | Human-in-the-loop: nothing is posted to GitHub without your explicit approval |

## Why Not Just Use...?

Existing tools cover pieces of the workflow. None handle the full contribution lifecycle.

| Capability | OSS Autopilot | Issue Finders | PR Dashboards | AI Agents |
|---|:---:|:---:|:---:|:---:|
| Find issues matched to your history | Yes | No | No | No |
| Find issues by label/language | Yes | Yes | No | Some |
| Monitor PR health across repos | Yes | No | Yes | No |
| Diagnose CI failures | Yes | No | No | Some |
| Draft responses to maintainers | Yes | No | No | Yes |
| Learn from your merge history | Yes | No | No | No |
| Repository health scoring | Yes | No | No | No |
| Track issue discussions | Yes | No | No | No |
| Human-in-the-loop | Yes | n/a | n/a | Rarely |
| Free & local | Yes | Some | No | No |

**Issue finders** help you discover projects but show the same results to everyone. They don't know your merge history, can't filter spam repos, and abandon you after the search. **PR dashboards** (Graphite, $24/mo) are built for teams, not individual contributors. **AI agents** can write code but don't manage the social side of OSS. OSS Autopilot covers discovery, monitoring, diagnosis, and response in one workflow — and learns from your history to get better over time.

---

## Usage

### Daily Workflow (5 min)

1. Run `/oss` to see what needs attention
2. Work through critical issues (CI failures, maintainer comments, conflicts)
3. Done for now

### Finding Contributions (15 min)

1. Run `/oss` and select "Search for new issues"
2. The issue scout searches in priority order:
   - **Repos where you've merged PRs** (highest success rate — no "good first issue" filter needed)
   - **Your starred repos** (you already expressed interest)
   - **General GitHub discovery** (language + label filters, minimum star count)
3. Each issue is vetted automatically — existing PRs, claim comments, project activity, contribution guidelines
4. Pick a high-scoring issue, and Claude drafts a professional claim message for your review

Issues from spam repos (label farming, templated mass issues) and inactive projects are filtered before you ever see them.

### Responding to Feedback (10 min)

1. Run `/oss` to see PRs with new comments
2. Select a PR that needs a response
3. Claude reads the feedback and drafts a response for your review
4. Post it after reviewing

### Dashboard

An interactive dashboard auto-opens at `http://localhost:3000` each time you run `/oss`. It includes:

![OSS Autopilot Dashboard](docs/images/dashboard.png)

- **Status Overview** - Doughnut chart of PR states (active, merged, closed, dormant)
- **Repository Breakdown** - Top 10 repos by total PRs with stacked bars
- **Contribution Timeline** - Monthly view of PRs opened, merged, and closed

The dashboard is a Preact SPA served locally. You can also launch it directly with `npx @oss-autopilot/core dashboard serve`.

### Curated Issue Lists

Maintain a markdown file of issues you're interested in. `/oss` detects it and offers "Pick from issue list" as an action. Completed issues get marked done automatically.

Configure the path in `/setup-oss`, or place a file at `open-source/potential-issue-list.md`, `oss/issue-list.md`, or `issues.md`.

### Specialized Agents

Claude automatically dispatches these based on context:

| Agent | Purpose | When it runs |
|-------|---------|-------------|
| **pr-responder** | Drafts responses to maintainer feedback | PR has `needs_addressing` status with `actionReason` of `needs_response` or `needs_changes` |
| **pr-health-checker** | Diagnoses CI failures, merge conflicts, stale reviews | PR has `needs_addressing` status with `actionReason` of `failing_ci` or `merge_conflict` |
| **pr-compliance-checker** | Validates PRs against [opensource.guide](https://opensource.guide) best practices | Before marking a new PR as ready for review |
| **pre-commit-reviewer** | Reviews code changes before committing | After Tier 2 code changes, before commit/push |
| **issue-scout** | Finds and vets new issues to work on | User selects "Search for new issues" from action menu |
| **repo-evaluator** | Analyzes repository health before contributing | Before claiming an issue in an unfamiliar repo |
| **contribution-strategist** | Strategic advice for your OSS journey | User asks for contribution strategy or career advice |

### Available Commands

| Command | Description |
|---------|-------------|
| `/oss` | Check your PRs, see what needs attention, take action |
| `/oss-search` | Search for new open source issues to contribute to |
| `/setup-oss` | Configure preferences and import existing PRs |
| `/oss-help` | Quick reference card for commands, agents, and workflows |

---

## Configuration

Settings live in `.claude/oss-autopilot/config.md` (YAML frontmatter). Run `/setup-oss` to configure interactively, or edit directly:

| Setting | Default | Description |
|---------|---------|-------------|
| `githubUsername` | (detected) | Your GitHub username |
| `maxActivePRs` | 10 | Capacity limit before suggesting focus |
| `dormantDays` | 30 | Days until PR marked dormant |
| `approachingDormantDays` | 25 | Days until dormancy warning |
| `languages` | (chosen at setup) | Languages to filter issue search |
| `labels` | (chosen at setup) | Issue labels to search for |
| `showHealthCheck` | `true` | Show PR health notification on session start |

PR tracking state is stored separately in `~/.oss-autopilot/state.json`.

### Curated Issue List

You can maintain a markdown file of pre-researched issues. Set the path during `/setup-oss` or via `setup --set issueListPath=PATH`. The parser recognizes:

- **GitHub URLs** in list items (issues or PRs)
- **Section headings** (`#`, `##`, `###`) as tier labels
- **Checkboxes** (`[x]`), **strikethrough** (`~~text~~`), or the word **Done** to mark completed items

Example file:

```markdown
## Pursue (High Priority)
- https://github.com/facebook/react/issues/12345 — Fix useEffect cleanup order
- https://github.com/vercel/next.js/issues/67890 — Add streaming support for app router

## Maybe (Worth Investigating)
- https://github.com/expressjs/express/issues/111 — Update error handling docs

## Completed
- [x] https://github.com/nodejs/node/issues/222 — Fix stream backpressure (Done)
- ~~https://github.com/vitejs/vite/issues/333 — HMR race condition~~
```

The `/oss-search` command can add vetted issues to this file automatically. Issues from your curated list get a +2 score bonus during search.

## Tips

**Start small:** Set `maxActivePRs` to 3-5 when starting out. Fewer active PRs with fast responses beats many stale ones.

**Check in regularly:** Run `/oss` every few days. Stale PRs are hard to revive.

**Trust but verify:** Claude's draft responses are good starting points. You know the technical context better.

**Evaluate repos first:** Before claiming an issue, let the repo-evaluator check if the project is actively maintained and responsive to external contributors.

---

## Your First Contribution (Walkthrough)

Here's what a typical end-to-end contribution looks like:

**Day 1 — Find an issue:**

```
You: /oss
OSS Autopilot: No PRs tracked yet. Ready to find your first contribution?
You: Search for new issues
```

`/oss-search` runs parallel searches across GitHub, scores results by repo health, label quality, and your language preferences, then presents vetted candidates:

```
1. vercel/next.js#12345 — Fix streaming support for app router (Score: 87)
   Clear requirements, active maintainer, TypeScript
2. expressjs/express#6789 — Update error handling docs (Score: 72)
   Good first issue, well-scoped
```

**Day 1 — Claim and work:**

You pick issue #1. The **issue-scout** agent drafts a claim comment, you approve it, then start working. Before pushing, **pre-commit-reviewer** catches a missing test — you add it.

```
You: Review my changes before I push
Pre-commit reviewer: Found 1 issue: missing test for error case on line 42.
```

You fix it and submit your PR. The **pr-compliance-checker** validates it against the repo's contribution guidelines.

**Day 2 — Respond to feedback:**

```
You: /oss
OSS Autopilot: 1 active PR — 1 need response (12h ago)
  1. vercel/next.js#99 — maintainer requested changes
```

The **pr-responder** reads the maintainer's comments, fetches relevant code context, and drafts a professional reply. You review, edit, and post it.

**Day 5 — Merged!**

```
You: /oss
OSS Autopilot: PR merged! vercel/next.js#99 🎉
  Your merge rate: 1/1 (100%). Ready for your next contribution?
```

The cycle continues. Each merged PR improves your repo relationship score, surfacing better-matched issues over time.

---

## Updating

**Plugin:**
```
/plugin marketplace update oss-autopilot
```

**MCP server / CLI:** Uses `npx @latest` by default, so you always get the latest version. Or pin a version in your config.

Your configuration is preserved across updates. See the [Changelog](packages/core/CHANGELOG.md) for what's new.

---

## How It Works

OSS Autopilot is a **pnpm monorepo** with three packages, plus a plugin layer:

```
┌──────────────────────────────────────────────────┐
│  Claude Code Plugin Layer                        │
│  /oss and /setup-oss commands                    │
│  7 specialized agents, contribution skills       │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ MCP Server   │  │ Interactive Dashboard     │  │
│  │ @oss-auto-   │  │ @oss-autopilot/dashboard │  │
│  │ pilot/mcp    │  │ Preact + Vite             │  │
│  │              │  │ Charts, PR health view    │  │
│  │ 21 tools     │  │                          │  │
│  │ 5 resources  │  │                          │  │
│  │ 3 prompts    │  │                          │  │
│  └──────┬───────┘  └────────────┬─────────────┘  │
│         │                       │                │
│  ┌──────┴───────────────────────┴─────────────┐  │
│  │ Core Library — @oss-autopilot/core         │  │
│  │ PR monitoring, issue discovery, state mgmt │  │
│  │ GitHub API, CLI, structured JSON output    │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
└──────────────────────────────────────────────────┘
```

| Package | npm | Description |
|---------|-----|-------------|
| `@oss-autopilot/core` | [![npm](https://img.shields.io/npm/v/@oss-autopilot/core)](https://www.npmjs.com/package/@oss-autopilot/core) | Core library + CLI. PR monitoring, issue discovery, state management, GitHub API. |
| `@oss-autopilot/mcp` | [![npm](https://img.shields.io/npm/v/@oss-autopilot/mcp)](https://www.npmjs.com/package/@oss-autopilot/mcp) | MCP server for Cursor, Claude Desktop, Codex, Windsurf, and any MCP client. |
| `@oss-autopilot/dashboard` | — | Interactive Preact SPA dashboard with charts and PR health view. |

### CLI

The CLI supports `--json` on every command for structured output:

```bash
# Run via the plugin (normal usage)
/oss

# Run CLI directly (scripting / debugging)
GITHUB_TOKEN=$(gh auth token) npx @oss-autopilot/core daily --json
GITHUB_TOKEN=$(gh auth token) npx @oss-autopilot/core search 10 --json
npx @oss-autopilot/core status --json
npx @oss-autopilot/core dashboard serve
```

All commands return `{ success, data, error, timestamp }`, useful for building your own tooling on top.

### MCP Server

The MCP server wraps every CLI command as an MCP tool, making OSS Autopilot available to any MCP-compatible client:

| Feature | What's exposed |
|---------|---------------|
| **21 tools** | `daily`, `status`, `search`, `vet`, `track`, `untrack`, `read`, `comments`, `post`, `claim`, `config`, `init`, `setup`, `check-setup`, `startup`, `shelve`, `unshelve`, `dismiss`, `undismiss`, `snooze`, `unsnooze` |
| **5 resources** | `oss://status`, `oss://config`, `oss://prs`, `oss://prs/shelved`, `oss://pr/{owner}/{repo}/{number}` |
| **3 prompts** | `triage` (PR prioritization), `respond-to-pr` (draft response), `find-issues` (discover issues) |

Supports both **stdio** (default) and **HTTP/SSE** (`--http --port 3100`) transports.

---

## Development

```bash
git clone https://github.com/costajohnt/oss-autopilot.git
cd oss-autopilot
pnpm install                 # Install all workspace dependencies
pnpm test                    # Run all tests across all packages
pnpm start -- daily --json   # Run CLI via tsx (no bundle needed)
pnpm run bundle              # Rebuild CLI bundle (esbuild)
```

### Project Structure

```
├── commands/                    # Plugin slash commands (/oss, /setup-oss)
├── agents/                      # 7 specialized agents (PR responder, issue scout, etc.)
├── skills/                      # Contribution best practices
├── packages/
│   ├── core/                    # @oss-autopilot/core — CLI + core library
│   │   ├── src/commands/        # CLI subcommands
│   │   ├── src/core/            # Domain logic + tests
│   │   └── dist/cli.bundle.cjs  # Built bundle (auto-generated)
│   ├── mcp-server/              # @oss-autopilot/mcp — MCP server
│   │   └── src/                 # Tools, resources, prompts, server
│   └── dashboard/               # @oss-autopilot/dashboard — Interactive UI
└── pnpm-workspace.yaml          # Workspace definition
```

Test as a local plugin:

```bash
claude --plugin-dir ./oss-autopilot
```

### Pre-commit Hooks

| Hook | What it blocks |
|------|----------------|
| `check-versions.sh` | Commits when `package.json` and `plugin.json` versions don't match |
| `no-ai-attribution.sh` | Commits containing AI attribution phrases |
| `no-commit-on-main.sh` | Direct commits to `main` or `master` |
| `conventional-commits.sh` | Commit messages without `feat:`/`fix:`/`chore:` prefix |

---

## Troubleshooting

<details>
<summary>GitHub CLI authentication errors</summary>

```
Error: gh: command not found
```

Install [GitHub CLI](https://cli.github.com/) and authenticate:

```bash
brew install gh    # macOS
gh auth login
```
</details>

<details>
<summary>Build fails on first run</summary>

The CLI bundles automatically on first use. If it fails:

```bash
# Find your plugin directory
find ~/.claude/plugins -name "oss-autopilot" -type d

# Rebuild
cd <path-from-find-command>/packages/core
npm install
npm run bundle
```
</details>

<details>
<summary>Dashboard doesn't open</summary>

The interactive dashboard runs at `http://localhost:3000`. If it doesn't open automatically, try launching it manually with `npx @oss-autopilot/core dashboard serve`, then open `http://localhost:3000` in your browser.
</details>

<details>
<summary>PRs not showing up</summary>

- Run `/setup-oss` to ensure your GitHub username is configured
- Check that `gh auth status` shows you're authenticated
- The plugin only tracks PRs you authored
</details>

---

## FAQ

**Does Claude post comments or push code automatically?**
No. Claude drafts responses and suggests actions. Nothing is posted to GitHub without your explicit approval.

**Where is my data stored?**
Config in `.claude/oss-autopilot/config.md`. State in `~/.oss-autopilot/`. The dashboard runs locally at `http://localhost:3000`. Nothing is sent to external servers beyond GitHub API calls to fetch your PR data.

**Does it work with private repos?**
Yes, as long as your GitHub CLI (`gh`) has access.

**Can I use this without Claude Code?**
Yes. The **MCP server** (`npx @oss-autopilot/mcp`) works with Cursor, Claude Desktop, Codex, Windsurf, and any MCP client. The **CLI** (`npx @oss-autopilot/core daily --json`) runs standalone. The **npm package** (`@oss-autopilot/core`) can be imported programmatically. The Claude Code plugin provides the best experience with specialized agents and skills, but all core functionality is available through any path.

**GitLab / Gitea / Bitbucket support?**
Not yet — see [Limitations](#limitations) below.

## Limitations

- **GitHub only** — GitLab, Bitbucket, and other forges are not supported. Contributions welcome.
- **1,000 PR cap** — GitHub's Search API returns at most 1,000 results per query. If you have more than 1,000 open, merged, or closed PRs, the oldest results from each search may be truncated.
- **Rate limiting** — The CLI automatically backs off on GitHub rate limits (with up to 2 retries) and secondary rate limits (1 retry), but sustained heavy use can exhaust these retries. If this happens, wait a few minutes and retry.
- **Individual contributor focus** — Designed for solo contributors managing their own PRs. No team dashboards, shared state, or multi-user workflows.

---

## Contributing

Bug fixes, new agents, CLI improvements, and documentation are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions.

## License

MIT
