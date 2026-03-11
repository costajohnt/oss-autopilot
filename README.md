<p align="center">
  <img src="assets/hero-light.svg" alt="OSS Autopilot" width="600">
</p>

<p align="center">
  <img src="https://github.com/costajohnt/oss-autopilot/actions/workflows/ci.yml/badge.svg" alt="CI">
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/costajohnt/oss-autopilot/badges/.github/badges/tests.json" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <a href="https://www.npmjs.com/package/@oss-autopilot/core"><img src="https://img.shields.io/npm/v/@oss-autopilot/core" alt="npm @oss-autopilot/core"></a>
  <a href="https://www.npmjs.com/package/@oss-autopilot/mcp"><img src="https://img.shields.io/npm/v/@oss-autopilot/mcp" alt="npm @oss-autopilot/mcp"></a>
  <img src="https://img.shields.io/badge/Claude_Code-Plugin-blueviolet" alt="Claude Code Plugin">
</p>

You have 12 open PRs across GitHub. A maintainer asked a question 5 days ago. Two PRs have failing CI you haven't noticed. And you're about to open another one.

**Sound familiar?**

OSS Autopilot is an AI copilot that tracks all your open source PRs, alerts you when something needs attention, and helps you respond to maintainer feedback so your contributions actually get merged.

## Quick Start

```
/plugin marketplace add costajohnt/oss-autopilot
/plugin install oss-autopilot@oss-autopilot
```

Restart Claude Code, run `/oss`. [Full install guide →](#install)

![OSS Autopilot Demo](docs/images/demo.gif)

## Install

### Claude Code Plugin (recommended)

**Prerequisites:** [Claude Code](https://claude.ai/claude-code), Node.js 20+, [GitHub CLI](https://cli.github.com/) (`gh auth login`)

```
/plugin marketplace add costajohnt/oss-autopilot
/plugin install oss-autopilot@oss-autopilot
```

Restart Claude Code, then run `/setup-oss`. Done.

<details>
<summary><strong>Optional:</strong> Enhanced code review with pr-review-toolkit</summary>

The plugin includes a built-in **pre-commit-reviewer** agent that reviews all code changes before pushing. For enhanced parallel review, install the **pr-review-toolkit** plugin (search for it in the Claude Code plugin marketplace) — it adds 5 specialized reviewers that run simultaneously:

| Agent | Focus |
|-------|-------|
| `code-reviewer` | Bugs, logic errors, security, conventions |
| `silent-failure-hunter` | Error handling gaps, swallowed errors |
| `code-simplifier` | Dead code, unnecessary complexity |
| `pr-test-analyzer` | Test coverage and assertion quality |
| `comment-analyzer` | Comment accuracy and maintainability |

**Without pr-review-toolkit:** The built-in pre-commit-reviewer handles all review phases as a single agent with the same fix-and-re-review loop. Everything works — you get one generalist reviewer instead of five specialists.

</details>

<details>
<summary><strong>MCP Server</strong> (Cursor, Claude Desktop, Codex, Windsurf)</summary>

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

The MCP server exposes 20 tools, 5 resources, and 3 prompts — the full OSS Autopilot feature set.

</details>

<details>
<summary><strong>Standalone CLI / npm package</strong></summary>

```bash
# Run any command directly
GITHUB_TOKEN=$(gh auth token) npx @oss-autopilot/core daily --json
npx @oss-autopilot/core dashboard serve

# Or install globally
npm install -g @oss-autopilot/core

# Or import programmatically
npm install @oss-autopilot/core
```

```typescript
import { runDaily, runSearch, runStatus } from '@oss-autopilot/core/commands';

const digest = await runDaily();
const issues = await runSearch({ maxResults: 10 });
```

All commands return `{ success, data, error, timestamp }` with `--json`.

</details>

---

## What It Does

### PR Monitoring

Claude checks every open PR you have across all of GitHub and tells you what needs your attention:

```
15 Active PRs | 2 need attention | Dashboard opened in browser

2 PRs Need Attention (in priority order):

1. [Needs Response] vadimdemedes/ink#855 - Add kitty keyboard support (3d)
   maintainer: tests requested
   Effort: Medium - respond + add tests

2. [CI Failing] rubyforgood/human-essentials#5492 - Add item filter (1d)
   Failing: rspec, lint
   Effort: Medium - investigate CI logs

What would you like to do?
  > Work through all 2 issues (Recommended)
  > Search for new issues
  > Done for now
```

Then Claude walks you through each issue: drafting responses, diagnosing CI failures, resolving conflicts, until everything is handled.

### Issue Discovery

Select "Search for new issues" and the issue scout finds opportunities matched to your history — not just random "good first issue" results:

```
Found 8 candidates across 6 repos

From repos where you've merged PRs
-
1. expressjs/express#6012 — Add timeout option to res.download()
   Labels: feature, good first issue
   Score: 92/100 — You merged 2 PRs here, clear requirements, active repo
   unclaimed · no linked PRs · last commit 2 days ago

2. chalk/chalk#642 — Support NO_COLOR in browser builds
   Labels: enhancement
   Score: 85/100 — You merged 1 PR here, repo has 7-day merge time
   unclaimed · no linked PRs · CONTRIBUTING.md found

From your starred repos
-
3. sindresorhus/execa#831 — Add encoding option to execaNode
   Labels: good first issue, help wanted
   Score: 78/100 — High-quality repo, clear requirements, recent activity
   unclaimed · no linked PRs · last commit 5 days ago

Skipped (not worth your time)
-
fake-oss/calculator — Label farming detected (6 beginner labels)
inactive/legacy-app — No commits in 90+ days
contested/router#44 — Already claimed by @other-dev 2 days ago
```

Each issue gets a **viability score (0-100)** based on your relationship with the repo, issue clarity, project health, and whether someone else has already claimed it. Repos where your PRs got merged are prioritized first — that's where you have the highest chance of getting another PR accepted.

### Interactive Dashboard

![dashboard-demo](https://github.com/user-attachments/assets/680ce6d6-8192-499a-b85e-f2686319b961)

The dashboard auto-opens at `http://localhost:3000` when you run `/oss`. It's a Preact SPA you can also launch standalone with `npx @oss-autopilot/core dashboard serve`.

**At a glance:**
- Stats bar with active, shelved, merged, and closed PR counts plus merge rate
- Status doughnut, repository breakdown, and contribution timeline charts
- Filter and search across all PRs

**Manage your PRs:**
- PRs are grouped into **Need Attention**, **Waiting on Others**, and **Shelved** sections
- Click any PR for a detail panel showing CI status, failing check classification, review decision, maintainer comments, and checklist progress
- **Shelve/Unshelve** — temporarily hide PRs you're not actively working on
- **Move to Waiting / Move to Need Attention** — override the auto-detected status when you know better

All actions persist to `~/.oss-autopilot/state.json`.

### Putting It Together

A typical contribution lifecycle:

**Day 1 — Find and claim.** Search for issues, pick a high-scoring one from a repo where you've merged before. The issue scout drafts a claim comment for your review. Start working. Before you push, the pre-commit reviewer catches a missing test — you add it. The compliance checker validates your PR against the repo's contribution guidelines.

**Day 2 — Respond.** `/oss` shows the maintainer requested changes 12 hours ago. The PR responder reads the feedback, fetches code context, and drafts a reply. You review, edit, and post.

**Day 5 — Merged.** Your repo relationship score improves, and better-matched issues surface next time you search.

---

## Key Capabilities

- **Monitors all your PRs** — comments, CI failures, merge conflicts, incomplete checklists, maintainer requests
- **Drafts responses** — reads maintainer feedback and writes a reply for your review
- **Finds issues matched to you** — prioritizes repos where you've merged PRs, scores every issue 0-100
- **Scores repositories** — evaluates merge rate, review speed, maintainer responsiveness
- **Interactive dashboard** — manage PRs visually, shelve/unshelve, override statuses, track stats over time
- **Never acts without you** — nothing is posted to GitHub without your explicit approval

---

## Usage

### Daily Workflow (5 min)

1. Run `/oss` to see what needs attention
2. Work through critical issues (CI failures, maintainer comments, conflicts)
3. Done for now

### Responding to Feedback (10 min)

1. Run `/oss` to see PRs with new comments
2. Select a PR that needs a response
3. Claude reads the feedback and drafts a response for your review
4. Post it after reviewing

**Commands:** `/oss` (daily check), `/oss-search` (find issues), `/setup-oss` (configure), `/oss-help` (reference)

### Specialized Agents

Claude automatically dispatches these based on context:

| Agent | Purpose | When it runs |
|-------|---------|-------------|
| **pr-responder** | Drafts responses to maintainer feedback | PR needs a response to maintainer feedback |
| **pr-health-checker** | Diagnoses CI failures, merge conflicts, stale reviews | PR has CI failure or merge conflict |
| **pr-compliance-checker** | Validates PRs against [opensource.guide](https://opensource.guide) best practices | Before marking a new PR ready for review |
| **pre-commit-reviewer** | Reviews code changes before committing | After code changes, before commit |
| **issue-scout** | Finds and vets new issues to work on | User searches for new issues |
| **repo-evaluator** | Analyzes repository health before contributing | Before contributing to an unfamiliar repo |
| **contribution-strategist** | Strategic advice for your OSS journey | User asks for contribution strategy |

*Agents are available in the Claude Code plugin. MCP and CLI users access the same capabilities through tools and commands.*

---

## Contribution Stats & Badges

### View Your Stats

```bash
oss-autopilot stats              # Terminal output
oss-autopilot stats --json       # Structured JSON
oss-autopilot stats --markdown   # Shareable markdown report
oss-autopilot stats --badge      # Shields.io endpoint JSON
```

### Add a Badge to Your GitHub Profile

Show off your open source contributions with a live badge on your GitHub profile README:

```markdown
![OSS Contributions](https://img.shields.io/endpoint?url=https://oss-autopilot-stats.vercel.app/api/badge/YOUR_USERNAME)
```

The badge updates hourly and shows your merge rate, total merged PRs, and active PR count. Only counts PRs to external repos (excludes your own) with 50+ stars by default.

Customize the minimum star threshold with `?minStars=100`:

```markdown
![OSS Contributions](https://img.shields.io/endpoint?url=https://oss-autopilot-stats.vercel.app/api/badge/YOUR_USERNAME?minStars=100)
```

---

## Configuration

Settings live in `.claude/oss-autopilot/config.md` (YAML frontmatter). Run `/setup-oss` to configure interactively, or edit directly:

| Setting | Default | Description |
|---------|---------|-------------|
| `githubUsername` | (detected) | Your GitHub username |
| `maxActivePRs` | 10 | Capacity limit before suggesting focus |
| `dormantDays` | 30 | Days until PR marked dormant |
| `approachingDormantDays` | 25 | Days until dormancy warning |
| `minStars` | 50 | Minimum repo stars for inclusion in stats and charts |
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
│  │              │  │ PR management, charts,    │  │
│  │ 20 tools     │  │ actions                   │  │
│  │ 5 resources  │  │                           │  │
│  │ 3 prompts    │  │                           │  │
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
| `@oss-autopilot/dashboard` | — | Interactive Preact SPA — PR management, charts, and contribution stats. |

### MCP Server

The MCP server wraps every CLI command as an MCP tool, making OSS Autopilot available to any MCP-compatible client:

| Feature | What's exposed |
|---------|---------------|
| **20 tools** | `daily`, `status`, `search`, `vet`, `track`, `untrack`, `read`, `comments`, `post`, `claim`, `config`, `init`, `setup`, `check-setup`, `startup`, `shelve`, `unshelve`, `dismiss`, `undismiss`, `move` |
| **5 resources** | `oss://status`, `oss://config`, `oss://prs`, `oss://prs/shelved`, `oss://pr/{owner}/{repo}/{number}` |
| **3 prompts** | `triage` (PR prioritization), `respond-to-pr` (draft response), `find-issues` (discover issues) |

Supports both **stdio** (default) and **HTTP/SSE** (`--http --port 3100`) transports.

---

## Updating

**Plugin:**
```
/plugin update oss-autopilot
```

**MCP server / CLI:** Uses `npx @latest` by default, so you always get the latest version. Or pin a version in your config.

Your configuration is preserved across updates. See the [Changelog](packages/core/CHANGELOG.md) for what's new.

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

<details>
<summary>Pre-commit hooks</summary>

| Hook | What it blocks |
|------|----------------|
| `check-versions.sh` | Commits when `package.json` and `plugin.json` versions don't match |
| `no-ai-attribution.sh` | Commits containing AI attribution phrases |
| `no-commit-on-main.sh` | Direct commits to `main` or `master` |
| `conventional-commits.sh` | Commit messages without `feat:`/`fix:`/`chore:` prefix |

</details>

---

## FAQ & Troubleshooting

**Does Claude post comments or push code automatically?**
No. Claude drafts responses and suggests actions. Nothing is posted to GitHub without your explicit approval.

**Where is my data stored?**
Config in `.claude/oss-autopilot/config.md`. State in `~/.oss-autopilot/`. The dashboard runs locally at `http://localhost:3000`. Nothing is sent to external servers beyond GitHub API calls to fetch your PR data.

**Does it work with private repos?**
Yes, as long as your GitHub CLI (`gh`) has access.

**Can I use this without Claude Code?**
Yes. The **MCP server** (`npx @oss-autopilot/mcp`) works with Cursor, Claude Desktop, Codex, Windsurf, and any MCP client. The **CLI** (`npx @oss-autopilot/core daily --json`) runs standalone. The **npm package** (`@oss-autopilot/core`) can be imported programmatically. The Claude Code plugin provides the best experience with specialized agents and skills, but all core functionality is available through any path.

**Any tips for getting started?**
Set `maxActivePRs` to 3-5 when starting out. Fewer active PRs with fast responses beats many stale ones. Run `/oss` every few days — stale PRs are hard to revive.

**GitLab / Gitea / Bitbucket support?**
Not yet — see [Limitations](#limitations) below.

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

## Limitations

- **GitHub only** — GitLab, Bitbucket, and other forges are not supported. Contributions welcome.
- **1,000 PR cap** — GitHub's Search API returns at most 1,000 results per query. If you have more than 1,000 open, merged, or closed PRs, the oldest results from each search may be truncated.
- **Rate limiting** — The CLI automatically backs off on GitHub rate limits (with up to 2 retries) and secondary rate limits (1 retry), but sustained heavy use can exhaust these retries. If this happens, wait a few minutes and retry.
- **Individual contributor focus** — Designed for solo contributors managing their own PRs. No team dashboards, shared state, or multi-user workflows.

---

## API Documentation

Full API documentation for `@oss-autopilot/core` is available at [costajohnt.github.io/oss-autopilot](https://costajohnt.github.io/oss-autopilot/).

---

## Contributing

Bug fixes, new agents, CLI improvements, and documentation are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions.

## License

MIT
