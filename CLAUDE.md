# OSS Autopilot - Claude Code Plugin

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

### Step 2: Install the plugin

```bash
# Clone to standard location
git clone https://github.com/costajohnt/oss-autopilot.git ~/.oss-autopilot/cli

# Install dependencies and build
cd ~/.oss-autopilot/cli && npm install && npm run build
```

### Step 3: Enable the plugin

The user needs to add this plugin to their Claude Code settings. Guide them:

> "To enable the plugin, add it to your Claude Code settings. You can do this by:
> 1. Opening Claude Code settings
> 2. Adding `~/.oss-autopilot/cli` to the plugins list
>
> Or I can help you edit the settings file directly."

If they want help editing:
```bash
# Check if settings file exists
cat ~/.claude/settings.json 2>/dev/null || echo '{"plugins": []}'
```

Then help them add `"~/.oss-autopilot/cli"` to the plugins array.

### Step 4: Restart and run setup

> "Great! The plugin is installed. Please restart Claude Code to load it, then run `/setup-oss` to configure your preferences."

After restart, `/oss` and `/setup-oss` commands will be available.

---

## For Developers: Project Overview

oss-autopilot is a **Claude Code plugin with a TypeScript CLI backend** for managing open source contributions.

### Architecture

```
┌─────────────────────────────────────────────┐
│  Plugin Layer (commands/, agents/)          │
│  - /oss and /setup-oss commands             │
│  - Specialized agents for PR tasks          │
│  - Claude formats output for users          │
├─────────────────────────────────────────────┤
│  TypeScript CLI (deterministic, fast)       │
│  - Syncs PR state from GitHub API           │
│  - --json flag for structured output        │
│  - Generates HTML dashboard                 │
├─────────────────────────────────────────────┤
│  Core Logic (src/core/)                     │
│  - state.ts, pr-monitor.ts, types.ts        │
│  - Unit tested with vitest                  │
└─────────────────────────────────────────────┘
```

### Why this architecture?

- **Reliability**: Deterministic TypeScript handles GitHub API and state
- **Speed**: CLI operations complete in seconds
- **Testability**: Core logic has unit tests
- **Transparency**: JSON output shows exactly what Claude receives

### File Structure

```
~/.oss-autopilot/
├── cli/                      # This repo (plugin + CLI code)
│   ├── commands/             # Plugin slash commands
│   ├── agents/               # Specialized agents
│   ├── src/                  # TypeScript CLI source
│   └── dist/                 # Built CLI
├── data/
│   └── state.json            # PR tracking state
├── dashboard.html            # Visual dashboard
└── events.jsonl              # Activity log
```

### CLI Usage

The plugin invokes the CLI with `--json` for structured output:

```bash
cd ~/.oss-autopilot/cli

# Daily check
GITHUB_TOKEN=$(gh auth token) npm start -- daily --json

# Status
npm start -- status --json

# Search issues
GITHUB_TOKEN=$(gh auth token) npm start -- search 10 --json

# Track a PR
GITHUB_TOKEN=$(gh auth token) npm start -- track <url> --json
```

### Development

```bash
cd ~/.oss-autopilot/cli
npm install
npm test           # Run tests
npm run build      # Build TypeScript
npm start -- daily # Run CLI directly
```

### Git Workflow (for contributors)

1. Fork and clone
2. Create feature branch: `git checkout -b feature/your-feature`
3. Make changes and test: `npm test`
4. Commit with conventional format: `feat:`, `fix:`, `refactor:`
5. Push and open PR

**Important:**
- Do NOT push directly to main
- Keep PRs focused and atomic
- Run tests before submitting

**AI Attribution Rule (CRITICAL):**
NEVER add AI attribution to commits, comments, PRs, or any content submitted to external repositories unless explicitly required by that repo's contribution guidelines. This includes:
- No "Co-Authored-By: Claude" in commit messages
- No "Generated with Claude Code" in PR descriptions
- No robot emoji attributions
- No mentions of AI assistance in comments
Contributions should appear as solely from the user.
