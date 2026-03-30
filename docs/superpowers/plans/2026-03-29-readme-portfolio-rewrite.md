# README Portfolio Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the README from a product page to a portfolio showcase that demonstrates engineering depth and real-world results, while keeping it functional for actual users.

**Architecture:** Single-file rewrite of `README.md`. The current content is reorganized — credentials and engineering highlights move up, install/config/FAQ collapse into `<details>` blocks. No code changes, no new files beyond the README itself.

**Tech Stack:** Markdown, GitHub-flavored markdown (`<details>`/`<summary>`), oss-widgets embeds (responsive `<picture>` tags)

---

### Task 1: Section 1 — Hero + Credentials

**Files:**
- Modify: `README.md:1-18`

Replace the current hero (SVG + CI badges + "Sound familiar?" pitch) with the portfolio-oriented opening.

- [ ] **Step 1: Write the new hero section**

Replace lines 1-18 of `README.md` with:

```markdown
<p align="center">
  <img src="assets/hero-light.svg" alt="OSS Autopilot" width="600">
</p>

<p align="center">
  <em>An AI-powered workflow engine for managing open source contributions at scale — built as a Claude Code plugin, MCP server, and standalone CLI.</em>
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
```

- [ ] **Step 2: Verify rendering**

Run: `open https://github.com/costajohnt/oss-autopilot` (after push) or preview locally with a markdown renderer. Check that:
- Hero SVG displays
- One-liner is italic and centered
- Credentials paragraph renders with working links
- oss-widgets cards load with responsive dark/light theme

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: replace hero with credentials and oss-widgets"
```

---

### Task 2: Section 2 — What This Project Is

**Files:**
- Modify: `README.md` (insert after Section 1)

Replace the lengthy "What It Does" feature tour with a brief summary + demo GIF.

- [ ] **Step 1: Write the summary section**

Insert after the oss-widgets block:

```markdown
---

## What It Does

OSS Autopilot monitors all your open PRs across GitHub, alerts you when maintainers leave feedback, helps you draft responses, diagnoses CI failures, and finds new issues matched to your contribution history. It's the workflow engine behind the stats above.

![OSS Autopilot Demo](docs/images/demo.gif)
```

That's it — 2 sentences and the demo GIF. The engineering section (next) is where the depth lives.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: replace feature tour with brief summary"
```

---

### Task 3: Section 3 — Engineering Highlights

**Files:**
- Modify: `README.md` (insert after Section 2)

This is the centerpiece of the portfolio rewrite.

- [ ] **Step 1: Write the engineering highlights section**

Insert after the demo GIF:

```markdown
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

**Monorepo with three npm packages** — pnpm workspaces with each package independently publishable to npm. Core library, MCP server, and interactive Preact dashboard with shared types.

**Three deployment models** — Claude Code plugin with 7 specialized agents, MCP server for Cursor/Claude Desktop/Codex/Windsurf, and a standalone CLI with `--json` structured output. Same core, different interfaces.

**Deterministic core, AI orchestration layer** — Critical logic (PR status classification, CI failure analysis, state management) lives in tested TypeScript, not in prompts. The CLI returns structured JSON that agents consume. CI failures are categorized into a deterministic taxonomy — actionable vs. fork limitation vs. auth gate vs. infrastructure — rather than asking an LLM each time. 1,762 tests validate the core independently of any LLM.

**Production-grade GitHub API integration** — ETag-based HTTP caching, automatic rate limit backoff with retries, bounded concurrency pools, and paginated fetching. Handles the full complexity of fork-based contribution workflows: correct diff ranges, squash commit counting, and `--head` flag handling for cross-fork PRs. Designed to run daily without hitting API limits.

**Human-in-the-loop guardrails** — Nothing is posted to GitHub without explicit approval. AI drafts responses but the contributor always reviews before sending. Pre-commit review gates catch issues before they reach maintainers. Factual claims in draft comments are verified against the actual diff before presenting to the user.

**Modular extraction** — Issue discovery and vetting grew complex enough to extract into its own npm package ([oss-scout](https://github.com/costajohnt/oss-scout)). Connected via a bridge pattern that maps state between the two systems, following the same approach used by the broader ecosystem of extraction-and-reconnect patterns.

**Fresh-fetch architecture** — PRs aren't stored locally. Every run fetches live data from GitHub's Search API and enriches each PR with CI status, review decisions, merge conflict detection, maintainer comment classification, and checklist completion. No stale data, no sync bugs.

**Security discipline** — State files written with `0o600` permissions, data directory created with `0o700`. Concurrent state write protection prevents corruption from parallel runs. Runtime schema validation via Zod on every state file read. Input validation hardened across CLI arguments and API responses.

**Automated release pipeline** — Conventional commits feed into release-please for automatic versioning and changelogs, with CI/CD publishing to npm on merge. 72 releases from v0.1.0 to v1.11.0 in under 3 months of active development.

Every feature in the list above was driven by real usage — capacity warnings came from overcommitting, "skip comment when code speaks for itself" came from over-commenting, diminishing returns detection came from spending too long searching. The tool is shaped by the contributions it manages.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add engineering highlights section"
```

---

### Task 4: Section 4 — Install & Usage (compressed)

**Files:**
- Modify: `README.md` (insert after Section 3)

Compress the install instructions into a compact section. Keep all three deployment models but make plugin the default and collapse the others.

- [ ] **Step 1: Write the compressed install section**

Insert after the engineering highlights:

```markdown
## Install & Usage

### Claude Code Plugin (recommended)

**Prerequisites:** [Claude Code](https://claude.ai/claude-code), Node.js 20+, [GitHub CLI](https://cli.github.com/) (`gh auth login`)

```
/plugin marketplace add costajohnt/oss-autopilot
/plugin install oss-autopilot@oss-autopilot
```

Restart Claude Code, run `/setup-oss`, then `/oss` to start.

<details>
<summary><strong>MCP Server</strong> (Cursor, Claude Desktop, Codex, Windsurf)</summary>

```bash
npx @oss-autopilot/core@latest init <your-github-username>
```

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

20 tools, 5 resources, 3 prompts. Supports stdio and HTTP transports.

</details>

<details>
<summary><strong>Standalone CLI / npm package</strong></summary>

```bash
npx @oss-autopilot/core daily --json
npm install -g @oss-autopilot/core
```

```typescript
import { runDaily, runSearch, runStatus } from '@oss-autopilot/core/commands';
```

All 26 commands return `{ success, data, error, timestamp }` with `--json`.

</details>

### Daily Workflow

1. Run `/oss` — see what needs attention across all your open PRs
2. Work through issues — CI failures, maintainer feedback, merge conflicts
3. Done — respond to what matters, skip what doesn't

**Commands:** `/oss` (daily check) · `/oss-search` (find issues) · `/setup-oss` (configure) · `/oss-help` (reference)
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: compress install and usage sections"
```

---

### Task 5: Section 5 — By the Numbers

**Files:**
- Modify: `README.md` (insert after Section 4)

Add the quick-scan stats block.

- [ ] **Step 1: Write the stats section**

Insert after the install section:

```markdown
## By the Numbers

| Metric | Value |
|--------|-------|
| Releases | 72 (v0.1.0 → v1.11.0) |
| Tests | 1,762 across 62 test files |
| Issues + PRs | 912+ |
| Time span | January 2026 → present |
| npm packages | 3 (`@oss-autopilot/core`, `@oss-autopilot/mcp`, `@oss-autopilot/dashboard`) |
| CLI commands | 26, all with `--json` structured output |
| Agents | 7 specialized (PR response, CI diagnosis, issue scouting, code review, compliance, repo evaluation, strategy) |

<img src="https://github.com/costajohnt/oss-autopilot/actions/workflows/ci.yml/badge.svg" alt="CI">
<img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/costajohnt/oss-autopilot/badges/.github/badges/tests.json" alt="Tests">
<img src="https://img.shields.io/badge/license-MIT-green" alt="License">
<a href="https://www.npmjs.com/package/@oss-autopilot/core"><img src="https://img.shields.io/npm/v/@oss-autopilot/core" alt="npm @oss-autopilot/core"></a>
<a href="https://www.npmjs.com/package/@oss-autopilot/mcp"><img src="https://img.shields.io/npm/v/@oss-autopilot/mcp" alt="npm @oss-autopilot/mcp"></a>
```

CI/npm badges live here now instead of the hero — they matter for credibility but aren't the first thing an employer should see.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add by-the-numbers stats section with badges"
```

---

### Task 6: Section 6 — Everything Else (collapsed)

**Files:**
- Modify: `README.md` (insert after Section 5)

Move all remaining content (dashboard, configuration, agents, stats/badges, FAQ, development, contributing) into collapsible blocks.

- [ ] **Step 1: Write the collapsed reference sections**

Insert after the stats section:

```markdown
---

<details>
<summary><strong>Interactive Dashboard</strong></summary>

![dashboard-demo](https://github.com/user-attachments/assets/680ce6d6-8192-499a-b85e-f2686319b961)

Auto-opens at `http://localhost:3000` when you run `/oss`. Also available standalone: `npx @oss-autopilot/core dashboard serve`.

- Stats bar: active, shelved, merged, closed PR counts + merge rate
- Charts: status doughnut, repository breakdown, contribution timeline
- PR management: shelve/unshelve, override statuses, filter and search
- Detail panels: CI status, failing check classification, review decision, maintainer comments, checklist progress

</details>

<details>
<summary><strong>Specialized Agents</strong></summary>

| Agent | Purpose |
|-------|---------|
| **pr-responder** | Drafts responses to maintainer feedback |
| **pr-health-checker** | Diagnoses CI failures, merge conflicts, stale reviews |
| **pr-compliance-checker** | Validates PRs against opensource.guide best practices |
| **pre-commit-reviewer** | Reviews code changes before committing |
| **issue-scout** | Finds and vets new issues to work on |
| **repo-evaluator** | Analyzes repository health before contributing |
| **contribution-strategist** | Strategic advice for your OSS journey |

Agents are available in the Claude Code plugin. MCP and CLI users access the same capabilities through tools and commands.

</details>

<details>
<summary><strong>Contribution Stats & Badges</strong></summary>

```bash
oss-autopilot stats              # Terminal output
oss-autopilot stats --json       # Structured JSON
oss-autopilot stats --markdown   # Shareable markdown report
```

Add a badge to your GitHub profile:

```markdown
![OSS Contributions](https://img.shields.io/endpoint?url=https://oss-widgets.vercel.app/api/badge/YOUR_USERNAME)
```

Embed SVG widgets (stats card, recent contributions, activity graph) via [oss-widgets](https://github.com/costajohnt/oss-widgets). All widgets update hourly and support `?theme=dark`.

</details>

<details>
<summary><strong>Configuration</strong></summary>

Stored in `~/.oss-autopilot/state.json`. Run `/setup-oss` to configure interactively.

| Setting | Default | Description |
|---------|---------|-------------|
| `githubUsername` | (detected) | Your GitHub username |
| `maxActivePRs` | 10 | Capacity limit before suggesting focus |
| `dormantDays` | 30 | Days until PR marked dormant |
| `languages` | (chosen at setup) | Languages to filter issue search |
| `labels` | (chosen at setup) | Issue labels to search for |
| `minStars` | 50 | Minimum repo stars for inclusion |
| `excludeRepos` | `[]` | Repos to exclude from tracking |
| `excludeOrgs` | `[]` | Orgs to exclude from tracking |
| `preferredOrgs` | `[]` | Orgs to prioritize in search |
| `projectCategories` | `[]` | Categories to prioritize (nonprofit, devtools, etc.) |

</details>

<details>
<summary><strong>FAQ & Troubleshooting</strong></summary>

**Does it post comments or push code automatically?**
No. Nothing is posted to GitHub without your explicit approval.

**Where is my data stored?**
`~/.oss-autopilot/` — configuration, state, cache. The dashboard runs locally. Nothing sent to external servers beyond GitHub API calls.

**Can I use this without Claude Code?**
Yes. MCP server works with Cursor/Claude Desktop/Codex/Windsurf. CLI runs standalone. npm package can be imported programmatically.

**GitHub CLI errors?** Install [GitHub CLI](https://cli.github.com/) and run `gh auth login`.

**Build fails?** Find your plugin dir with `find ~/.claude/plugins -name "oss-autopilot" -type d`, then `cd packages/core && npm install && npm run bundle`.

**Updating?** Plugin: `/plugin update oss-autopilot`. MCP/CLI: uses `npx @latest` by default. Config is preserved across updates. See the [Changelog](packages/core/CHANGELOG.md).

</details>

<details>
<summary><strong>Development</strong></summary>

```bash
git clone https://github.com/costajohnt/oss-autopilot.git
cd oss-autopilot
pnpm install
pnpm test
pnpm start -- daily --json
```

```
├── commands/           # Plugin slash commands
├── agents/             # 7 specialized agents
├── skills/             # Contribution best practices
├── workflows/          # Orchestration logic
├── packages/
│   ├── core/           # @oss-autopilot/core — CLI + library
│   ├── mcp-server/     # @oss-autopilot/mcp — MCP server
│   └── dashboard/      # Interactive Preact SPA
└── pnpm-workspace.yaml
```

Test as a local plugin: `claude --plugin-dir ./oss-autopilot`

</details>

<details>
<summary><strong>Enhanced Code Review (optional)</strong></summary>

The built-in **pre-commit-reviewer** agent handles code review. For enhanced parallel review, install **pr-review-toolkit** from the Claude Code plugin marketplace — 5 specialized reviewers running simultaneously:

| Agent | Focus |
|-------|-------|
| `code-reviewer` | Bugs, logic errors, security, conventions |
| `silent-failure-hunter` | Error handling gaps, swallowed errors |
| `code-simplifier` | Dead code, unnecessary complexity |
| `pr-test-analyzer` | Test coverage and assertion quality |
| `comment-analyzer` | Comment accuracy and maintainability |

</details>

## Limitations

- **GitHub only** — GitLab, Bitbucket, and other forges not supported
- **1,000 PR cap** — GitHub Search API limit per query
- **Individual contributor focus** — Solo contributors, no team dashboards

---

**API Documentation:** [jcosta.tech/oss-autopilot](https://jcosta.tech/oss-autopilot/)

## Contributing

Bug fixes, new agents, CLI improvements, and documentation are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: collapse reference sections into details blocks"
```

---

### Task 7: Final Assembly & Cleanup

**Files:**
- Modify: `README.md` (full file)

Ensure the full README flows correctly end-to-end. Remove any leftover content from the old structure that wasn't included in Tasks 1-6.

- [ ] **Step 1: Read the full README end-to-end**

Verify:
- No duplicate sections (old content that wasn't removed)
- Section ordering matches the spec: Hero+Credentials → What It Does → Engineering Highlights → Install & Usage → By the Numbers → Collapsed sections → Limitations → Contributing → License
- All links work (internal anchors, external URLs)
- No orphaned content from old sections (e.g., the old "Putting It Together" lifecycle section, "Key Capabilities" bullet list, "Curated Issue List" section, "Updating" section)
- The old "How It Works" heading with the architecture diagram is gone (diagram now lives in Engineering Highlights)

- [ ] **Step 2: Fix any issues found**

Remove any leftover old content. Ensure clean section transitions.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: clean up README structure and remove old content"
```

---

### Task 8: Push and Verify

**Files:**
- None (git operations only)

- [ ] **Step 1: Push the branch**

```bash
git push -u origin chore/readme-portfolio-rewrite
```

- [ ] **Step 2: Open GitHub and verify rendering**

Check the branch preview on GitHub:
- Hero SVG renders
- oss-widgets cards load
- Collapsible sections expand/collapse
- Architecture diagram renders correctly in the code block
- Demo GIF loads
- Dashboard screenshot loads
- All links work

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "docs: rewrite README as portfolio showcase" --body "$(cat <<'EOF'
## Summary
- Repositions README from product page to portfolio showcase for employers/clients
- Leads with credentials (Ink, Homebrew) and live oss-widgets stats
- Engineering Highlights section as centerpiece (9 highlights showing architecture decisions)
- Install/config/FAQ compressed into collapsible sections
- By the Numbers stats block with badges

## Context
Design spec: docs/superpowers/specs/2026-03-29-readme-portfolio-rewrite-design.md

No code changes — README content reorganization only.
EOF
)"
```
