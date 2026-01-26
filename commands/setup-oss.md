---
name: setup-oss
description: Configure OSS autopilot preferences
allowed-tools: Bash, Write, Read, Glob, AskUserQuestion, mcp__*
---

# OSS Autopilot Setup

Guide the user through configuring their OSS autopilot preferences.

## Step 0: Check CLI Availability

First, check if the TypeScript CLI is available:

```bash
cd ~/.oss-autopilot/cli && npm run start -- checkSetup --json 2>/dev/null
```

**If CLI returns valid JSON:**
- Use CLI commands for all setup (Steps 1-CLI through 6-CLI below)
- State is stored in `data/state.json`

**If CLI is NOT available:**
- Fall back to markdown-based setup (Steps 1 through 9 below)
- State is stored in `.claude/oss-autopilot/` directory

---

# CLI-Based Setup (Preferred)

## Step 1-CLI: Check Current Status

Run the setup command to see current configuration:

```bash
cd ~/.oss-autopilot/cli && npm run start -- setup --json 2>/dev/null
```

If `setupComplete: true`, ask:
> "Setup is already complete. Would you like to reconfigure your settings?"

Options: "Yes, reconfigure" or "No, keep current settings"

If they choose to keep current settings, show current config and exit.

## Step 2-CLI: Get GitHub Username

Get the username from gh CLI:
```bash
gh api user --jq '.login'
```

Confirm with user:
> "I detected your GitHub username as **@USERNAME**. Is this correct?"

If confirmed, set it:
```bash
cd ~/.oss-autopilot/cli && npm run start -- setup --set username=USERNAME --json
```

## Step 3-CLI: Gather Preferences

Use AskUserQuestion to collect preferences, then set each via CLI:

**Question 1: Max Active PRs**
- "How many PRs do you want to work on at once?"
- Options: "5 (light)", "10 (moderate)", "15 (active)", "20 (heavy)"

```bash
npm run start -- setup --set maxActivePRs=NUMBER --json
```

**Question 2: Dormant Threshold**
- "After how many days of inactivity should a PR be flagged as dormant?"
- Options: "14 days", "21 days", "30 days (default)", "45 days"

```bash
npm run start -- setup --set dormantDays=NUMBER --json
```

**Question 3: Warning Threshold**
- "When should I warn you about approaching dormancy?"
- Options: "5 days before", "7 days before", "10 days before"

```bash
npm run start -- setup --set approachingDays=NUMBER --json
```

**Question 4: Languages** (multi-select)
- "What programming languages do you want to contribute to?"
- Options: "TypeScript", "JavaScript", "Python", "Go", "Rust"

```bash
npm run start -- setup --set languages=typescript,javascript,python --json
```

**Question 5: Issue Labels** (multi-select)
- "What types of issues should I search for?"
- Options: "good first issue", "help wanted", "bug", "enhancement", "documentation"

```bash
npm run start -- setup --set labels="good first issue,help wanted" --json
```

## Step 4-CLI: Mark Setup Complete

```bash
cd ~/.oss-autopilot/cli && npm run start -- setup --set complete=true --json
```

## Step 5-CLI: Import Existing PRs

Ask user:
> "Would you like me to import your existing open PRs?"

If yes:
```bash
cd ~/.oss-autopilot/cli && GITHUB_TOKEN=$(gh auth token) npm run start -- init USERNAME --json
```

This fetches all open PRs from GitHub and adds them to tracking.

## Step 6-CLI: Confirmation

Show summary:
```markdown
## Setup Complete!

### Your Configuration
- **Username**: @USERNAME
- **Max PRs**: NUMBER
- **Dormant**: NUMBER days
- **Languages**: list
- **Labels**: list

### Imported PRs
- X open PRs imported

### Next Steps
Run `/oss` to check your PRs and find new contribution opportunities.
```

---

# Markdown-Based Setup (Fallback)

Use this section only if the CLI is not available.

## Step 1: Check Current Status

Check if `.claude/oss-autopilot/config.md` exists.

If it exists and has `setupComplete: true`, ask:
> "Setup is already complete. Would you like to reconfigure your settings?"

Options: "Yes, reconfigure" or "No, keep current settings"

If they choose to keep current settings, show current config and exit.

## Step 2: Detect GitHub Access

Determine how to access GitHub. Check in this order:

### Option 1: MCP Server
Check if a GitHub MCP server is available by looking for tools like:
- `mcp__github__*` (official GitHub MCP)
- `mcp__*github*` (other GitHub MCP servers)

If found, note this for later use and try to get the authenticated user.

### Option 2: GitHub CLI (`gh`)
Check if `gh` CLI is authenticated:
```bash
gh auth status
```

If authenticated, use `gh` for setup.

### Option 3: No GitHub Access
If neither is available, explain options:
> "I need access to GitHub to set up OSS Autopilot. You have two options:
>
> **Option 1: GitHub CLI (Recommended)**
> - Install: https://cli.github.com/
> - Authenticate: `gh auth login`
>
> **Option 2: GitHub MCP Server**
> - Add a GitHub MCP server to your Claude Code configuration
> - This provides richer API access and avoids rate limits
>
> After setting up access, run `/setup-oss` again."

Then STOP.

## Step 3: Get GitHub Username

**Using gh CLI:**
```bash
gh api user --jq '.login'
```

**Using MCP (if available):**
Use the appropriate MCP tool to get the authenticated user.

Confirm with user:
> "I detected your GitHub username as **@USERNAME**. Is this correct?"

If incorrect, ask them to enter their username.

## Step 4: Gather Preferences

Use AskUserQuestion to collect preferences. Ask these in sequence:

**Question 1: Max Active PRs**
- "How many PRs do you want to work on at once?"
- Options: "5 (light)", "10 (moderate)", "15 (active)", "20 (heavy)"

**Question 2: Dormant Threshold**
- "After how many days of inactivity should a PR be flagged as dormant?"
- Options: "14 days", "21 days", "30 days (default)", "45 days"

**Question 3: Warning Threshold**
- "When should I warn you about approaching dormancy?"
- Options: "5 days before", "7 days before", "10 days before"

**Question 4: Languages** (multi-select)
- "What programming languages do you want to contribute to?"
- Options: "TypeScript", "JavaScript", "Python", "Go", "Rust"
- Allow multiple selections

**Question 5: Issue Labels** (multi-select)
- "What types of issues should I search for?"
- Options: "good first issue", "help wanted", "bug", "enhancement", "documentation"
- Allow multiple selections

## Step 5: Create Directory Structure

```bash
mkdir -p .claude/oss-autopilot
```

### Rollback on Failure

Track which files have been successfully created. If any step fails during file creation (Steps 6-7):
1. **Do NOT set `setupComplete: true`** in the config
2. Inform the user exactly which step failed:
   > "Setup failed at [Step X: description]. Files created before this step are intact. Run `/setup-oss` again to retry."
3. Leave partial files in place so user can inspect or manually fix

The setup is only considered complete when ALL files are written successfully.

## Step 6: Write Configuration

Write the configuration to `.claude/oss-autopilot/config.md`:

```markdown
---
githubUsername: USERNAME
maxActivePRs: NUMBER
dormantDays: NUMBER
approachingDormantDays: NUMBER
languages:
  - typescript
  - javascript
labels:
  - good first issue
  - help wanted
githubAccess: gh|mcp
setupComplete: true
lastUpdated: YYYY-MM-DD
---

# OSS Autopilot Configuration

This file stores your OSS Autopilot preferences. Edit the YAML frontmatter above to change settings, or run `/setup-oss` again.

## Current Settings

- **GitHub Username**: @USERNAME
- **Max Active PRs**: NUMBER
- **Dormant Threshold**: NUMBER days
- **Warning Threshold**: NUMBER days before dormant
- **Languages**: list
- **Issue Labels**: list
- **GitHub Access**: gh CLI / MCP server
```

## Step 7: Initialize State Files

Create empty state files:

**tracked-prs.md:**
```markdown
---
lastUpdated: YYYY-MM-DD
---

# Tracked Pull Requests

| Repo | PR# | Title | Status | Last Activity | Needs Response |
|------|-----|-------|--------|---------------|----------------|
```

**pr-history.md:**
```markdown
---
lastUpdated: YYYY-MM-DD
---

# PR History

## Merged PRs

| Repo | PR# | Title | Merged Date |
|------|-----|-------|-------------|

## Closed PRs

| Repo | PR# | Title | Closed Date | Reason |
|------|-----|-------|-------------|--------|
```

**repo-scores.md:**
```markdown
---
lastUpdated: YYYY-MM-DD
---

# Repository Scores

Cache of repository evaluations for contribution decisions.

| Repo | Score | Response Time | Merge Rate | Last Evaluated |
|------|-------|---------------|------------|----------------|
```

## Step 8: Offer to Import Existing PRs

Ask user:
> "Would you like me to import your existing open PRs?"

If yes, fetch and import:

**Using gh CLI:**
```bash
# IMPORTANT: Use 'gh search prs' to find PRs across ALL of GitHub, not just current repo
gh search prs --author USERNAME --state open --json repository,number,title,url,updatedAt --limit 100
```

Note: `gh pr list` only searches the current repo. Always use `gh search prs` to find PRs across all repositories.

**Using MCP:**
Use `mcp__github__search_issues` with query `is:pr is:open author:USERNAME`

Parse results and add each PR to tracked-prs.md.

## Step 9: Confirmation

Show summary:

```markdown
## Setup Complete!

### Your Configuration
- **Username**: @USERNAME
- **Max PRs**: NUMBER
- **Dormant**: NUMBER days
- **Languages**: list
- **Labels**: list
- **GitHub Access**: via [gh CLI / MCP server]

### Imported PRs
- X open PRs imported

### Next Steps
Run `/oss` to check your PRs and find new contribution opportunities.
```

---

## Important Notes

- **CLI path**: State is stored in `data/state.json`
- **Fallback path**: State is stored in `.claude/oss-autopilot/` directory
- Configuration can be edited manually or by running `/setup-oss` again
- The plugin works with either `gh` CLI or GitHub MCP servers
- **NEVER add AI attribution** to commits, comments, or PRs unless the repository explicitly requires disclosure of AI tool usage. Contributions should appear as solely from the user.
