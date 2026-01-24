# oss-autopilot

A Claude Code plugin for managing open source contributions - track PRs, respond to maintainers, discover issues, and maintain contribution velocity.

## What It Does

Contributing to open source is rewarding but hard to sustain. PRs get lost, maintainer comments go unnoticed, and promising issues slip away. oss-autopilot gives Claude Code the tools to be your OSS contribution manager.

**The problem it solves:**
- You forget to check on PRs you submitted weeks ago
- Maintainer comments sit unanswered, PRs go stale
- You want to contribute more but don't know where to start
- Tracking multiple contributions across repos is tedious

**How it helps:**
- **Daily PR monitoring** - Checks all your open PRs for new comments, flags ones approaching dormancy
- **Smart response drafting** - Claude reads maintainer feedback, understands the context, and drafts responses for your approval
- **Issue discovery** - Finds issues matching your skills and interests, vets them before you invest time
- **Repository evaluation** - Analyzes repo health before you contribute
- **Strategic guidance** - Helps you grow your OSS contributions strategically
- **Human-in-the-loop** - Claude never posts anything without your explicit approval

## Installation

### As a Claude Code Plugin

1. Clone or download this repository to a location of your choice
2. In Claude Code, add the plugin by opening Settings and adding the path to this directory under "Plugins", or by adding it to your project's `.claude/settings.json`:
   ```json
   {
     "plugins": ["/path/to/oss-autopilot"]
   }
   ```

3. Set up GitHub access (one of these options):

   **Option A: GitHub CLI (Recommended)**
   ```bash
   # Install from https://cli.github.com/
   gh auth login
   ```

   **Option B: GitHub MCP Server**
   Configure a GitHub MCP server in your Claude Code settings. This provides richer API access and avoids rate limits.

   The plugin will automatically detect and use whichever is available.

### Requirements

- Claude Code (latest version)
- **One of the following** for GitHub access:
  - GitHub CLI (`gh`) - recommended, simple setup
  - GitHub MCP server - provides richer API access

## Usage

### First-Time Setup

Run `/setup-oss` in Claude Code. It guides you through configuring:

- **GitHub username** - Detected from `gh` auth
- **Max active PRs** - Capacity limit (default: 10)
- **Dormant threshold** - Days before flagging stale PRs (default: 30)
- **Languages** - What you want to contribute to
- **Issue labels** - What to search for

Configuration is stored in `.claude/oss-autopilot/config.md`.

### Daily Workflow

Run `/oss` once a day (or whenever you have time for OSS work). Claude will:

1. **Report PR status** - Which PRs have new comments, CI failures, or are going stale
2. **Offer actions** - Draft responses, investigate issues, or find new opportunities
3. **Let you decide** - Everything requires your approval before acting

### Available Commands

| Command | Description |
|---------|-------------|
| `/oss` | Run daily check - monitor PRs, report status, offer actions |
| `/setup-oss` | Configure preferences and import existing PRs |

### Available Agents

The plugin includes specialized agents that Claude uses automatically based on context:

| Agent | Purpose |
|-------|---------|
| **pr-responder** | Drafts responses to maintainer feedback |
| **pr-health-checker** | Diagnoses CI failures, merge conflicts, stale reviews |
| **pr-compliance-checker** | Validates PRs against [opensource.guide](https://opensource.guide) best practices |
| **issue-scout** | Finds and vets new issues to work on |
| **repo-evaluator** | Analyzes repository health before contributing |
| **contribution-strategist** | Provides strategic advice on your OSS journey |

### Example Session

```
You: /oss

Claude: ## OSS Daily Report

### Action Required (1)
**eslint-plugin-react#2847** - Comment from @ljharb (2 hours ago)
> "This looks good overall, but can you add a test for the case
> where the prop is undefined?"

### Health Issues (1)
**typescript#51234** - CI failing (2 checks)

### Approaching Dormant (1)
**vite#9182** - 27 days since last activity

### Summary
- Active PRs: 4
- Needing response: 1
- Health issues: 1

Would you like me to:
- Draft a response to the eslint-plugin-react comment?
- Investigate the TypeScript CI failure?
- Send a follow-up on the Vite PR?
```

## Data Storage

All state is stored in markdown files for easy reading and editing:

```
.claude/oss-autopilot/
├── config.md           # Your preferences
├── tracked-prs.md      # Active PRs being monitored
├── pr-history.md       # Merged/closed PRs
└── repo-scores.md      # Cached repository evaluations
```

## Configuration Options

Settings in `config.md` frontmatter:

| Setting | Default | Description |
|---------|---------|-------------|
| `githubUsername` | (detected) | Your GitHub username |
| `githubAccess` | (detected) | How GitHub is accessed (`gh` or `mcp`) |
| `maxActivePRs` | 10 | Capacity limit for active PRs |
| `dormantDays` | 30 | Days until PR marked dormant |
| `approachingDormantDays` | 25 | Days until dormancy warning |
| `languages` | typescript, javascript | Languages to search |
| `labels` | good first issue, help wanted | Issue labels to match |
| `setupComplete` | false | (internal) Whether setup has been run |
| `lastUpdated` | - | (internal) Last config update timestamp |

## Tips for Effective Use

**Start small:** Set `maxActivePRs` to 3-5 when starting out. It's better to have fewer PRs you actively maintain than many that go dormant.

**Run it regularly:** The tool works best when you check in every few days. Stale PRs are hard to revive.

**Trust but verify:** Claude's draft responses are good starting points but review them. You know the technical context better.

**Use the dormant warnings:** When a PR approaches your configured threshold, send a polite follow-up. Maintainers are busy and PRs get lost.

**Evaluate repos first:** Before claiming an issue, let the repo-evaluator check if the project is actively maintained.

## Plugin Structure

```
oss-autopilot/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── commands/
│   ├── oss.md               # /oss command
│   └── setup-oss.md         # /setup-oss command
├── agents/
│   ├── pr-responder.md      # Response drafting
│   ├── pr-health-checker.md # CI/conflict diagnosis
│   ├── pr-compliance-checker.md # opensource.guide validation
│   ├── issue-scout.md       # Issue discovery
│   ├── repo-evaluator.md    # Repository analysis
│   └── contribution-strategist.md # Strategic advice
├── skills/
│   └── oss-contribution/
│       └── SKILL.md         # OSS best practices
└── README.md
```

## License

MIT
