<p align="center">
  <img src="assets/hero-light.svg" alt="OSS Autopilot" width="600">
</p>

<p align="center">
  <em>An AI-powered workflow engine for managing open source contributions at scale — built as a Claude Code plugin, MCP server, and standalone CLI.</em>
</p>

<p align="center">
  <img src="https://github.com/costajohnt/oss-autopilot/actions/workflows/ci.yml/badge.svg" alt="CI">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/node/v/@oss-autopilot/core" alt="Node.js">
  <img src="https://img.shields.io/github/stars/costajohnt/oss-autopilot?style=flat" alt="Stars">
  <img src="https://img.shields.io/github/last-commit/costajohnt/oss-autopilot" alt="Last Commit">
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@oss-autopilot/core"><img src="https://img.shields.io/npm/v/@oss-autopilot/core" alt="npm @oss-autopilot/core"></a>
  <a href="https://www.npmjs.com/package/@oss-autopilot/core"><img src="https://img.shields.io/npm/dw/@oss-autopilot/core" alt="npm downloads core"></a>
  <a href="https://www.npmjs.com/package/@oss-autopilot/mcp"><img src="https://img.shields.io/npm/v/@oss-autopilot/mcp" alt="npm @oss-autopilot/mcp"></a>
  <a href="https://www.npmjs.com/package/@oss-autopilot/mcp"><img src="https://img.shields.io/npm/dw/@oss-autopilot/mcp" alt="npm downloads mcp"></a>
</p>

---

**Built and used daily by [costajohnt](https://github.com/costajohnt)** — 3rd biggest contributor to [Ink](https://github.com/vadimdemedes/ink) (the React CLI framework behind Claude Code, Gemini CLI, and Codex — 32k+ stars) and repeat contributor to [Homebrew](https://github.com/Homebrew/homebrew-cask).

<p align="center">
<a href="https://github.com/costajohnt/oss-autopilot">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://oss-widgets.vercel.app/api/card/costajohnt?theme=dark&minStars=50" />
  <source media="(prefers-color-scheme: light)" srcset="https://oss-widgets.vercel.app/api/card/costajohnt?theme=light&minStars=50" />
  <img alt="OSS Stats" src="https://oss-widgets.vercel.app/api/card/costajohnt?theme=dark&minStars=50" width="495" />
</picture>
</a>
</p>

<p align="center">
<a href="https://github.com/costajohnt/oss-widgets">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://oss-widgets.vercel.app/api/top-repos/costajohnt?theme=dark&minStars=50" />
  <source media="(prefers-color-scheme: light)" srcset="https://oss-widgets.vercel.app/api/top-repos/costajohnt?theme=light&minStars=50" />
  <img alt="Top Contributed Repos" src="https://oss-widgets.vercel.app/api/top-repos/costajohnt?theme=dark&minStars=50" width="495" />
</picture>
</a>
</p>

---

## What It Does

OSS Autopilot monitors all your open PRs across GitHub, alerts you when maintainers leave feedback, helps you draft responses, diagnoses CI failures, and finds new issues matched to your contribution history. It's the workflow engine behind the stats above.

![OSS Autopilot Demo](docs/images/demo.gif)

### Interactive Dashboard

![dashboard-demo](https://github.com/user-attachments/assets/680ce6d6-8192-499a-b85e-f2686319b961)

A Preact SPA that auto-opens when you run `/oss` — PR management, charts, contribution stats, and status overrides. Also available standalone: `npx @oss-autopilot/core dashboard serve`.

---

## Engineering Highlights

```
┌──────────────────────────────────────────────────┐
│  Claude Code Plugin Layer                        │
│  /oss, /oss-search, /setup-oss, /oss-help        │
│  7 specialized agents, contribution skills       │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ MCP Server   │  │ Interactive Dashboard     │  │
│  │ @oss-auto-   │  │ @oss-autopilot/dashboard │  │
│  │ pilot/mcp    │  │ Preact + Vite             │  │
│  │              │  │ PR management, charts,    │  │
│  │ 25 tools     │  │ actions                   │  │
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

**Monorepo with three npm packages** — pnpm workspaces with each package independently publishable to npm. Core library, MCP server, and interactive Preact dashboard with shared types.

**Three deployment models** — Claude Code plugin with 7 specialized agents, MCP server for Cursor/Claude Desktop/Codex/Windsurf, and a standalone CLI with `--json` structured output. Same core, different interfaces.

**Deterministic core, AI orchestration layer** — Critical logic (PR status classification, CI failure analysis, state management) lives in tested TypeScript, not in prompts. The CLI returns structured JSON that agents consume. CI failures are categorized into a deterministic taxonomy — actionable vs. fork limitation vs. auth gate vs. infrastructure — rather than asking an LLM each time. 1,762 tests validate the core independently of any LLM.

**Production-grade GitHub API integration** — ETag-based HTTP caching, automatic rate limit backoff with retries, bounded concurrency pools, and paginated fetching. Handles the full complexity of fork-based contribution workflows: correct diff ranges, squash commit counting, and `--head` flag handling for cross-fork PRs. Designed to run daily without hitting API limits.

**Human-in-the-loop guardrails** — Nothing is posted to GitHub without explicit approval. AI drafts responses but the contributor always reviews before sending. Pre-commit review gates catch issues before they reach maintainers. Factual claims in draft comments are verified against the actual diff before presenting to the user.

**Modular extraction** — Issue discovery and vetting grew complex enough to extract into its own npm package ([oss-scout](https://github.com/costajohnt/oss-scout)). Connected via a bridge pattern that maps state between the two systems, following the same approach used by the broader ecosystem of extraction-and-reconnect patterns.

**Fresh-fetch architecture** — PRs aren't stored locally. Every run fetches live data from GitHub's Search API and enriches each PR with CI status, review decisions, merge conflict detection, maintainer comment classification, and checklist completion. No stale data, no sync bugs.

**Security discipline** — State files written with `0o600` permissions, data directory created with `0o700`. Concurrent state write protection prevents corruption from parallel runs. Runtime schema validation via Zod on every state file read. XSS prevention tested. Input validation hardened across CLI arguments and API responses.

**Automated release pipeline** — Conventional commits feed into release-please for automatic versioning and changelogs, with CI/CD publishing to npm on merge. 70+ published releases since March 2026, with 150+ changelog versions spanning the full v0.1.0 → v1.11.0 history.

Every feature in the list above was driven by real usage — capacity warnings came from overcommitting, "skip comment when code speaks for itself" came from over-commenting, diminishing returns detection came from spending too long searching. The tool is shaped by the contributions it manages.

---

## Install & Usage

**Claude Code Plugin (recommended):**

```
/plugin marketplace add costajohnt/oss-autopilot
/plugin install oss-autopilot@oss-autopilot
```

Restart Claude Code, then run `/setup-oss`. Done.

<details>
<summary><strong>MCP Server</strong> (Cursor, Claude Desktop, Codex, Windsurf)</summary>

First initialize your GitHub username (one-time setup):

```bash
npx @oss-autopilot/core@latest init <your-github-username>
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

The MCP server exposes 25 tools, 5 resources, and 3 prompts — the full OSS Autopilot feature set.

</details>

<details>
<summary><strong>Standalone CLI / npm package</strong></summary>

```bash
# Run any command directly (uses gh auth token automatically)
npx @oss-autopilot/core daily --json
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

**Daily workflow (5 min):**

1. Run `/oss` to see what needs attention
2. Work through critical issues (CI failures, maintainer comments, conflicts)
3. Done for now

**Commands:** `/oss` (daily check), `/oss-search` (find issues), `/setup-oss` (configure), `/oss-help` (reference)

---

## By the Numbers

| Metric | Value |
|--------|-------|
| Releases | 70+ published (150+ changelog versions, v0.1.0 → v1.11.0) |
| Tests | 1,762 across 62 files |
| Issues + PRs | 912+ |
| Time span | Jan 2026 → present |
| npm packages | 3 |
| CLI commands | 30+ |
| Agents | 7 |

---

## Everything Else

<details>
<summary><strong>Specialized Agents</strong></summary>

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

</details>

<details>
<summary><strong>Contribution Stats & Badges</strong></summary>

```bash
oss-autopilot stats              # Terminal output
oss-autopilot stats --json       # Structured JSON
oss-autopilot stats --markdown   # Shareable markdown report
oss-autopilot stats --badge      # Shields.io endpoint JSON
```

Add a live badge to your GitHub profile README:

```markdown
![OSS Contributions](https://img.shields.io/endpoint?url=https://oss-widgets.vercel.app/api/badge/YOUR_USERNAME)
```

Embed rich SVG widgets powered by [oss-widgets](https://github.com/costajohnt/oss-widgets) — stats card, recent contributions, and 26-week activity graph. All update hourly and support `?theme=dark`.

</details>

<details>
<summary><strong>Configuration</strong></summary>

Configuration is stored in `~/.oss-autopilot/state.json` (inside the `config` field). Run `/setup-oss` to configure interactively, or use `setup --set key=value` from the CLI:

| Setting | Default | Description |
|---------|---------|-------------|
| `githubUsername` | (detected) | Your GitHub username |
| `maxActivePRs` | 10 | Capacity limit before suggesting focus |
| `dormantDays` | 30 | Days until PR marked dormant |
| `minStars` | 50 | Minimum repo stars for inclusion in stats and charts |
| `languages` | (chosen at setup) | Languages to filter issue search |
| `labels` | (chosen at setup) | Issue labels to search for |
| `squashByDefault` | `true` | Squash commits before merging (`true`, `false`, or `"ask"`) |
| `excludeRepos` | `[]` | Repos to exclude from all tracking |
| `excludeOrgs` | `[]` | Orgs to exclude from all tracking (e.g., private work orgs) |
| `includeDocIssues` | `true` | Include documentation issues in discovery |
| `issueListPath` | (optional) | Path to curated issue list file |
| `projectCategories` | `[]` | Project categories to prioritize (nonprofit, devtools, etc.) |
| `preferredOrgs` | `[]` | GitHub organizations to prioritize |

</details>

<details>
<summary><strong>FAQ & Troubleshooting</strong></summary>

**Does Claude post comments or push code automatically?**
No. Claude drafts responses and suggests actions. Nothing is posted to GitHub without your explicit approval.

**Where is my data stored?**
All data lives in `~/.oss-autopilot/` — configuration, PR tracking state, event history, and HTTP cache. The dashboard runs locally at `http://localhost:3000`. Nothing is sent to external servers beyond GitHub API calls.

**Can I use this without Claude Code?**
Yes. The MCP server (`npx @oss-autopilot/mcp`) works with Cursor, Claude Desktop, Codex, Windsurf, and any MCP client. The CLI (`npx @oss-autopilot/core daily --json`) runs standalone. The Claude Code plugin provides the best experience with specialized agents and skills, but all core functionality is available through any path.

**How do I update?**
Plugin: `/plugin update oss-autopilot`. MCP server / CLI: uses `npx @latest` by default, so you always get the latest. Your configuration is preserved across updates. See the [Changelog](packages/core/CHANGELOG.md) for what's new.

**Any tips for getting started?**
Set `maxActivePRs` to 3-5 when starting out. Fewer active PRs with fast responses beats many stale ones. Run `/oss` every few days — stale PRs are hard to revive.

**GitHub CLI authentication errors:**

```bash
brew install gh    # macOS
gh auth login
```

**Build fails on first run:**

```bash
# Find your plugin directory
find ~/.claude/plugins -name "oss-autopilot" -type d

# Rebuild
cd <path-from-find-command>/packages/core
npm install
npm run bundle
```

**PRs not showing up:**
- Run `/setup-oss` to ensure your GitHub username is configured
- Check that `gh auth status` shows you're authenticated
- The plugin only tracks PRs you authored

</details>

<details>
<summary><strong>Development</strong></summary>

```bash
git clone https://github.com/costajohnt/oss-autopilot.git
cd oss-autopilot
pnpm install                 # Install all workspace dependencies
pnpm test                    # Run all tests across all packages
pnpm start -- daily --json   # Run CLI via tsx (no bundle needed)
pnpm run bundle              # Rebuild CLI bundle (esbuild)
```

**Project structure:**

```
├── commands/                    # Plugin slash commands (/oss, /oss-search, /setup-oss, /oss-help)
├── agents/                      # 7 specialized agents (PR responder, issue scout, etc.)
├── skills/                      # Contribution best practices
├── workflows/                   # Delegated logic loaded by commands on demand
├── hooks/                       # Plugin hooks (session-start)
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

</details>

<details>
<summary><strong>Enhanced Code Review (optional)</strong></summary>

The plugin includes a built-in **pre-commit-reviewer** agent that reviews all code changes before committing. For enhanced parallel review, install the **pr-review-toolkit** plugin (search for it in the Claude Code plugin marketplace) — it adds 5 specialized reviewers that run simultaneously:

| Agent | Focus |
|-------|-------|
| `code-reviewer` | Bugs, logic errors, security, conventions |
| `silent-failure-hunter` | Error handling gaps, swallowed errors |
| `code-simplifier` | Dead code, unnecessary complexity |
| `pr-test-analyzer` | Test coverage and assertion quality |
| `comment-analyzer` | Comment accuracy and maintainability |

Without pr-review-toolkit, the built-in pre-commit-reviewer handles all review phases as a single agent with the same fix-and-re-review loop.

</details>

---

## Limitations

- **GitHub only** — GitLab, Bitbucket, and other forges are not supported. Contributions welcome.
- **1,000 PR cap** — GitHub's Search API returns at most 1,000 results per query. If you have more than 1,000 open, merged, or closed PRs, the oldest results may be truncated.
- **Individual contributor focus** — Designed for solo contributors managing their own PRs. No team dashboards, shared state, or multi-user workflows.

## API Documentation

Full API documentation for `@oss-autopilot/core` is available at [jcosta.tech/oss-autopilot](https://jcosta.tech/oss-autopilot/).

## Contributing

Bug fixes, new agents, CLI improvements, and documentation are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions.

## License

MIT
