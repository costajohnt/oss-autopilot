# oss-autopilot

An AI-powered assistant for managing open source contributions, designed to work with Claude Code.

## What It Does

Contributing to open source is rewarding but hard to sustain. PRs get lost, maintainer comments go unnoticed, and promising issues slip away. oss-autopilot solves this by giving Claude Code the tools to be your OSS contribution manager.

**The problem it solves:**
- You forget to check on PRs you submitted weeks ago
- Maintainer comments sit unanswered, PRs go stale
- You want to contribute more but don't know where to start
- Tracking multiple contributions across repos is tedious

**How it helps:**
- **Daily PR monitoring** - Checks all your open PRs for new comments, flags ones approaching dormancy
- **Smart response drafting** - Claude reads maintainer feedback, understands the context, and drafts responses for your approval
- **Issue discovery** - Finds issues matching your skills and interests, vets them for viability before you invest time
- **Human-in-the-loop** - Claude never posts anything without your explicit approval

## How It Works

oss-autopilot is a CLI tool that Claude Code orchestrates through slash commands. When you run `/oss`, Claude:

1. Runs `npm start -- daily` to sync your PR status with GitHub
2. Identifies PRs with new comments or approaching dormancy
3. Fetches the full comment thread for PRs needing response
4. Reads relevant code files to understand the context
5. Drafts a response addressing the maintainer's feedback
6. Presents the draft for your approval before posting

State is persisted in `data/state.json`, tracking:
- Active PRs you're working on
- Comment counts (to detect new activity)
- Last activity timestamps (to detect dormancy)
- Merged/closed history (for stats)
- Your configuration preferences

## Installation

```bash
git clone https://github.com/costajohnt/oss-autopilot
cd oss-autopilot
npm install
npm run build
```

Create a `.env` file with your GitHub token:
```bash
cp .env.example .env
# Edit .env and add: GITHUB_TOKEN=your_token_here
```

The token needs `repo` scope to read PR comments and search issues.

### Install Slash Commands

```bash
cp examples/oss.md ~/.claude/commands/
cp examples/setup-oss.md ~/.claude/commands/
```

Restart Claude Code to load the commands.

## Usage

### First-Time Setup

Run `/setup-oss` in Claude Code. It guides you through configuring:

- **GitHub username** - So it can find your open PRs
- **Max active PRs** - Capacity limit (default: 10)
- **Dormant threshold** - Days before flagging stale PRs (default: 30)
- **Languages** - What you want to contribute to (TypeScript, Python, Go, etc.)
- **Issue labels** - What to search for (good first issue, help wanted, bug, etc.)

### Daily Workflow

Run `/oss` once a day (or whenever you have time for OSS work). Claude will:

1. **Report PR status** - Which PRs have new comments, which are going stale
2. **Draft responses** - For PRs with maintainer feedback, Claude reads the comments, understands what's being asked, and drafts a response
3. **Flag dormant PRs** - PRs with no activity for 25+ days get a warning; 30+ days and you're prompted to follow up or close
4. **Celebrate merges** - Tracks your merged PRs and success rate
5. **Find opportunities** - If you have capacity, searches for issues matching your criteria

### Effective Usage Tips

**Start small:** Set `maxActivePRs` to 3-5 when starting out. It's better to have fewer PRs you actively maintain than many that go dormant.

**Run it regularly:** The tool works best when you check in every few days. Stale PRs are hard to revive.

**Trust but verify:** Claude's draft responses are good starting points but review them. You know the technical context better.

**Use the dormant warnings:** When a PR hits 25 days, send a polite follow-up. Maintainers are busy and PRs get lost.

**Vet before you commit:** Before claiming an issue, run the vetting process. It checks for existing PRs, claimed status, and project activity.

### Example Session

```
You: /oss

Claude: ## OSS Daily Report

### PRs Needing Response (1)
**eslint-plugin-react#2847** - Comment from @ljharb (2 hours ago)
> "This looks good overall, but can you add a test for the case
> where the prop is undefined?"

I've reviewed the PR and the test file. Here's a draft response:

> Thanks for the review! I've added a test case for the undefined
> prop scenario in `tests/rules/no-unused-prop-types.js`. The test
> verifies that the rule correctly handles components where props
> may be undefined.

[Approve] [Edit] [Skip]

### Approaching Dormant (1)
**typescript#51234** - 27 days since last activity
> Awaiting review from @RyanCavanaugh

Want me to draft a polite follow-up comment?

### Merged This Week (1)
**vite#9182** - Merged 2 days ago

### Capacity: 4/10 PRs active
Found 3 issues matching your criteria. Want me to vet them?
```

## Configuration

Settings are stored in `data/state.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `maxActivePRs` | 10 | Capacity limit for active PRs |
| `dormantThresholdDays` | 30 | Days until PR marked dormant |
| `approachingDormantDays` | 25 | Days until dormancy warning |
| `languages` | typescript, javascript | Languages to search |
| `labels` | good first issue, help wanted | Issue labels to match |

Reconfigure anytime with `/setup-oss`.

## CLI Reference

The slash commands use these commands internally:

```bash
npm start -- setup          # Configure settings
npm start -- daily          # Run daily PR check
npm start -- status         # Portfolio overview
npm start -- init <user>    # Import your open PRs
npm start -- search [n]     # Find matching issues
npm start -- vet <url>      # Vet an issue
npm start -- comments <url> # Fetch PR comments
npm start -- track <url>    # Track a PR
npm start -- untrack <url>  # Stop tracking
```

## License

MIT
