# OSS Autopilot

Discover issues worth contributing to, track your PRs across repos, and draft responses to maintainer feedback. An AI copilot for your open source journey.

![Version](https://img.shields.io/badge/version-0.13.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-blueviolet)
![Node Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

![OSS Autopilot Dashboard](docs/images/dashboard.png)

> **OSS Autopilot is a [Claude Code](https://claude.ai/claude-code) plugin.** It runs inside the Claude Code editor and uses Claude to help you manage your open source contributions.

## Quick Start

**You'll need:**
- [Claude Code](https://claude.ai/claude-code) (the editor)
- Node.js 18+ (for the CLI backend)
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login`

**Install in Claude Code:**

```
/plugin marketplace add costajohnt/oss-autopilot
/plugin install oss-autopilot
```

Then run `/setup-oss` to configure your preferences. That's it.

---

## What It Does

Contributing to open source is rewarding but hard to sustain. PRs get lost, maintainer comments go unnoticed, and promising issues slip away.

**The problem:**
- You forget to check on PRs you submitted weeks ago
- Maintainer comments sit unanswered, PRs go stale
- You want to contribute more but don't know where to start
- Tracking multiple contributions across repos is tedious

**How OSS Autopilot helps:**
- **PR monitoring**: Checks all your open PRs for new comments, CI failures, merge conflicts, incomplete checklists, and maintainer requests
- **Smart response drafting**: Claude reads maintainer feedback and drafts responses for your approval
- **Adaptive issue discovery**: Finds issues matching your skills and learns from your contribution history
- **Curated issue lists**: Maintain a markdown file of issues you're interested in — `/oss` auto-detects and integrates it into your workflow
- **Repository scoring**: Tracks repo responsiveness and analyzes health before you contribute
- **Human-in-the-loop**: Claude never posts anything without your explicit approval

## Why OSS Autopilot?

Existing tools cover pieces of the contribution workflow — but none handle the full lifecycle. Here's how OSS Autopilot compares:

| Capability | OSS Autopilot | Issue Finders | PR Dashboards | AI Agents |
|---|:---:|:---:|:---:|:---:|
| Find matching issues | Yes | Yes | — | Some |
| Monitor PR health | Yes | — | Yes | — |
| Diagnose CI failures | Yes | — | — | Some |
| Draft review responses | Yes | — | — | Yes |
| Auto-rebase detection | Yes | — | — | — |
| Repository scoring | Yes | — | — | — |
| Human-in-the-loop | Yes | n/a | n/a | Rarely |

OSS Autopilot is the only tool that covers discovery, monitoring, diagnosis, and response — all in one workflow with human approval at every step.

## Usage

Once installed, just run:

```
/oss
```

Claude checks all your open PRs across GitHub, opens an HTML dashboard in your browser, and presents a summary:

```
15 Active PRs | 2 need attention | Dashboard opened in browser | v0.7.0

2 PRs Need Attention:

1. [Needs Response] vadimdemedes/ink#855
   feat: Add kitty keyboard protocol support (0d inactive)

2. [Incomplete Checklist (4/5)] rubyforgood/human-essentials#5492
   Add item filter to donations index page (0d inactive)
```

Then you choose what to do:

- **Address all issues in parallel** — launches agents to investigate, rebase, and draft responses simultaneously
- **Search for new issues** — find contribution opportunities matching your skills
- **Done for now** — end with a session summary

The session continues until you're done — after every action, Claude asks what's next.

### Dashboard

The dashboard (`~/.oss-autopilot/dashboard.html`) auto-opens each time you run `/oss`. It shows your active PRs, merge rate, contribution history, and which PRs need attention — all at a glance.

**Charts and visualizations:**

- **Status Overview** — Doughnut chart of PR states (active, merged, closed, dormant)
- **Repository Breakdown** — Top 10 repos by total PRs (with "Other" bucket), stacked bars with percentage tooltips
- **Contribution Timeline** — Grouped bar chart showing PRs opened, merged, and closed per month

### Available Commands

| Command | Description |
|---------|-------------|
| `/oss` | Check your PRs, see what needs attention, take action |
| `/setup-oss` | Configure preferences and import existing PRs |

### Curated Issue Lists

You can maintain a markdown file with issues you're interested in. `/oss` will auto-detect it and offer "Pick from issue list" as an action. As you complete issues, they're marked done in the file.

Configure the path in `/setup-oss`, or place a file at one of the default locations:
- `open-source/potential-issue-list.md`
- `oss/issue-list.md`
- `issues.md`

### Specialized Agents

Claude automatically uses these agents based on context:

| Agent | Purpose |
|-------|---------|
| **pr-responder** | Drafts responses to maintainer feedback |
| **pr-health-checker** | Diagnoses CI failures, merge conflicts, stale reviews |
| **pr-compliance-checker** | Validates PRs against [opensource.guide](https://opensource.guide) best practices |
| **pre-commit-reviewer** | Reviews code changes before committing (quality gate) |
| **issue-scout** | Finds and vets new issues to work on |
| **repo-evaluator** | Analyzes repository health before contributing |
| **contribution-strategist** | Strategic advice for your OSS journey |

---

## Updating

OSS Autopilot notifies you when a newer version is available on GitHub. To update:

```
/plugin update oss-autopilot
```

Your configuration is preserved across updates. The CLI bundle auto-rebuilds after upgrades.

See the [Changelog](CHANGELOG.md) for what's new in each release.

---

## How It Works

OSS Autopilot uses a hybrid architecture for reliability and speed:

```
┌─────────────────────────────────────────────────┐
│  Claude Code Plugin Layer                       │
│  - /oss and /setup-oss commands                 │
│  - 7 specialized agents for different tasks     │
│  - Pre-commit hooks enforcing workflow rules    │
│  - Contribution best-practice skills            │
├─────────────────────────────────────────────────┤
│  TypeScript CLI (deterministic, fast)           │
│  - Fetches all open PRs from GitHub Search API  │
│  - Outputs structured JSON for Claude to parse  │
│  - Generates HTML dashboard                     │
├─────────────────────────────────────────────────┤
│  Core Logic (tested, type-safe)                 │
│  - State management with auto-backups           │
│  - PR health monitoring and status detection    │
│  - Capacity assessment                          │
└─────────────────────────────────────────────────┘
```

**Why this architecture?**
- **Reliability**: Deterministic TypeScript code handles GitHub API calls and state management
- **Speed**: CLI operations complete in seconds, not minutes
- **Testability**: Core logic has unit tests, plugin layer focuses on UX
- **Transparency**: JSON output means you can see exactly what data Claude receives

### CLI

The TypeScript CLI supports `--json` on every command for structured output:

```bash
# Run via the plugin (normal usage)
/oss

# Run CLI directly (scripting / debugging)
GITHUB_TOKEN=$(gh auth token) node dist/cli.bundle.cjs daily --json
GITHUB_TOKEN=$(gh auth token) node dist/cli.bundle.cjs search 10 --json
node dist/cli.bundle.cjs status --json
node dist/cli.bundle.cjs dashboard
```

All commands return `{ success, data, error, timestamp }` — useful if you want to build your own tooling on top.

---

## Configuration

Settings are stored in `.claude/oss-autopilot/config.md` (YAML frontmatter). Run `/setup-oss` to configure interactively, or edit the file directly:

| Setting | Default | Description |
|---------|---------|-------------|
| `githubUsername` | (detected) | Your GitHub username |
| `maxActivePRs` | 20 | Capacity limit before suggesting focus |
| `dormantDays` | 30 | Days until PR marked dormant |
| `approachingDormantDays` | 7 | Days until dormancy warning |
| `languages` | (chosen at setup) | Languages to filter issue search |
| `labels` | (chosen at setup) | Issue labels to look for (e.g., `good first issue`, `help wanted`) |
| `showHealthCheck` | `true` | Show PR health notification on session start |

PR tracking state is stored separately in `~/.oss-autopilot/state.json`.

---

## Development

To work on OSS Autopilot itself:

```bash
git clone https://github.com/costajohnt/oss-autopilot.git
cd oss-autopilot
npm install
npm test                    # Run all tests (vitest)
npm start -- daily --json   # Run CLI via tsx (no bundle needed)
```

To test with Claude Code as a local plugin:

```bash
claude --plugin-dir ./oss-autopilot
```

### Pre-commit Hooks

The repo includes Claude Code hooks (`.claude/hooks/`) that enforce workflow rules:

| Hook | What it blocks |
|------|----------------|
| `check-versions.sh` | Commits when `package.json`, `plugin.json`, and README badge versions don't match |
| `no-ai-attribution.sh` | Commits containing AI attribution phrases |
| `no-commit-on-main.sh` | Direct commits to `main` or `master` |
| `conventional-commits.sh` | Commit messages without `feat:`/`fix:`/`chore:` prefix |

These fire automatically as `PreToolUse` hooks when Claude Code runs `git commit`.

---

## Requirements

- [Claude Code](https://claude.ai/claude-code) (latest version)
- Node.js 18+ (for running the bundled CLI)
- GitHub CLI (`gh`): for GitHub API access

---

## Example Workflows

### Daily Standup (5 min)

1. Run `/oss` to check all open PRs
2. Address critical issues (CI failures, merge conflicts, maintainer comments)
3. Done for now

### Finding Your Next Contribution (15 min)

1. Run `/oss` to confirm you have capacity
2. Search for new issues matching your skills
3. Vet a promising issue with the repo-evaluator
4. Claim it and get started

### Responding to Maintainer Feedback (10 min)

1. Run `/oss` — identifies PRs with new comments
2. Select a PR that needs a response
3. Claude reads the feedback and drafts a response for your review
4. Post it after reviewing

---

## Tips for Effective Use

**Start small:** Set `maxActivePRs` to 3-5 when starting out. Better to maintain fewer PRs actively than let many go stale.

**Check in regularly:** Run `/oss` every few days. Stale PRs are hard to revive.

**Trust but verify:** Claude's draft responses are good starting points, but review them: you know the technical context.

**Use dormant warnings:** When a PR approaches your threshold, send a polite follow-up. Maintainers are busy.

**Evaluate repos first:** Before claiming an issue, let the repo-evaluator check if the project is actively maintained.

---

## Troubleshooting

### GitHub CLI authentication errors

```
Error: gh: command not found
```

Install [GitHub CLI](https://cli.github.com/) and authenticate:

```bash
brew install gh    # macOS
gh auth login
```

### Build fails on first run

The CLI bundles automatically on first use. If it fails:

```bash
cd ~/.claude/plugins/oss-autopilot   # or your plugin directory
npm install
npm run bundle
```

### Dashboard doesn't open

The dashboard is generated at `~/.oss-autopilot/dashboard.html`. If it doesn't open automatically, open the file manually in your browser.

### PRs not showing up

- Run `/setup-oss` to ensure your GitHub username is configured
- Check that `gh auth status` shows you're authenticated
- The plugin only tracks PRs you authored — it won't show PRs from other users

---

## FAQ

**Does Claude post comments or push code automatically?**
No. OSS Autopilot is fully human-in-the-loop. Claude drafts responses and suggests actions, but nothing is posted to GitHub without your explicit approval.

**Where is my data stored?**
Configuration lives in `.claude/oss-autopilot/config.md`. PR tracking state and dashboard are in `~/.oss-autopilot/`. Nothing is sent to external servers beyond the GitHub API calls needed to fetch your PR data.

**Does it work with private repositories?**
Yes, as long as your GitHub CLI (`gh`) has access to those repos. The plugin uses your existing `gh` authentication.

**Can I use this without the Claude Code plugin system?**
The CLI can run standalone (`node dist/cli.bundle.cjs daily --json`), but it's designed to work with Claude Code for the best experience.

**Does this work with GitLab, Gitea, or other platforms?**
Not currently — it's GitHub-focused. Contributions welcome to add support for other platforms.

**What if I'm offline?**
Commands that check GitHub (like `/oss`) require internet access. The dashboard can be viewed offline if you've generated it previously.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a detailed history of changes.

---

## Contributing

Contributions welcome — bug fixes, new agents, CLI improvements, and documentation. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

---

## License

MIT
