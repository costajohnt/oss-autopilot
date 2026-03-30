---
name: setup-oss
description: Configure OSS autopilot preferences
allowed-tools: Bash, Write, Read, Glob, mcp__*
---

# OSS Autopilot Setup

Customize your OSS Autopilot preferences. This is **optional** — the tool works out of the box with auto-detected settings. Use this command to fine-tune languages, labels, PR limits, and other preferences.

> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

## Step 0: Ensure CLI is Built and Check Availability

Build the CLI on first run (auto-installs deps):

```bash
if [ ! -f "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ]; then
  if ! BUILD_LOG=$(cd "${CLAUDE_PLUGIN_ROOT}/packages/core" && npm install --silent 2>&1 && npm run bundle --silent 2>&1); then
    echo "BUILD_FAILED"; echo "$BUILD_LOG" | tail -5; exit 1
  fi
fi
```

**If output starts with `BUILD_FAILED`**: Tell the user the CLI build failed and show the error lines. Suggest: `cd ${CLAUDE_PLUGIN_ROOT}/packages/core && npm install && npm run bundle`. Common causes: missing Node.js 20+, stale `node_modules`.

Then check if it's working:

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" checkSetup --json 2>/dev/null
```

**If CLI returns valid JSON:**
- Use CLI commands for all setup (Steps 1-CLI through 7-CLI below)

**If CLI is NOT available (build failed or node unavailable):**
- Fall back to markdown-based setup (Steps 1 through 10 below)

---

# CLI-Based Setup (Preferred)

## Step 1-CLI: Check Current Status

Run the setup command to see current configuration:

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --json 2>/dev/null
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
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set username=USERNAME --json
```

## Step 3-CLI: Gather Preferences

Use AskUserQuestion to collect preferences, then set each via CLI:

**Question 1: Max Active PRs**
- "How many PRs do you want to work on at once?"
- Options: "5 (light)", "10 (moderate)", "15 (active)", "20 (heavy)"

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set maxActivePRs=NUMBER --json
```

**Question 2: Dormant Threshold**
- "After how many days of inactivity should a PR be flagged as dormant?"
- Options: "14 days", "21 days", "30 days (default)", "45 days"

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set dormantDays=NUMBER --json
```

**Question 3: Warning Threshold**
- "When should I warn you about approaching dormancy?"
- Options: "5 days before", "7 days before", "10 days before"

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set approachingDays=NUMBER --json
```

**Question 4: Languages** (multi-select)
- "What programming languages do you want to contribute to?"
- Options: "TypeScript", "JavaScript", "Python", "Go", "Rust"

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set languages=typescript,javascript,python --json
```

**Question 5: Issue Labels** (multi-select)
- "What types of issues should I search for?"
- Options: "good first issue", "help wanted", "bug", "enhancement", "documentation"

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set labels="good first issue,help wanted" --json
```

**Question 6: Issue Scope Tiers** (multi-select)
- "What scope of issues do you want to discover? Scope tiers add extra labels to your search beyond your custom labels above."
- Options: "Beginner (good first issue, help wanted, easy, up-for-grabs)", "Intermediate (enhancement, feature, contributions welcome)", "Advanced (proposal, RFC, accepted, design)", "Skip (use only my custom labels)"

Map selections: "Beginner" → `beginner`, "Intermediate" → `intermediate`, "Advanced" → `advanced`.

If "Skip" is selected, skip. Otherwise:
```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set scope=beginner,intermediate --json
```

**Question 7: Project Categories** (multi-select)
- "What types of projects interest you?"
- Options: "Nonprofit/Social Impact", "Developer Tools", "Infrastructure/Cloud", "Web Frameworks", "Data/ML", "Education", "No preference (skip)"

Map selections: "Nonprofit/Social Impact" → `nonprofit`, "Developer Tools" → `devtools`, "Infrastructure/Cloud" → `infrastructure`, "Web Frameworks" → `web-frameworks`, "Data/ML" → `data-ml`, "Education" → `education`.

If "No preference" is selected, skip. Otherwise:
```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set projectCategories=devtools,infrastructure --json
```

**Question 8: Preferred Organizations** (free text)
- "Any GitHub organizations you'd like to prioritize? (comma-separated, or skip)"

If user provides orgs:
```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set preferredOrgs=vercel,remix-run --json
```

**Question 9: Curated Issue List**
- "Do you maintain a curated list of potential issues to work on?"
- Options: "Yes", "No"

If yes, ask for the file path:
- "What's the path to your issue list file? (relative to your notes/project root)"
- Options: "open-source/potential-issue-list.md (default)", "Enter custom path"

If a path is provided, validate it exists:
```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set issueListPath="PATH" --json
```

If the file doesn't exist at the given path, warn the user but still save the path (they may create it later).

### Skipped Issues File

If the user configured an issue list path, ask:

```
Question: "Where should skipped/rejected issues be tracked? This prevents re-surfacing issues you've already vetted and rejected. Entries auto-expire after 90 days."

Options:
1. "Use default ({issueListDir}/skipped-issues.md)" — "Same folder as your issue list"
2. "Custom path" — "Specify a different location"
3. "Don't track skipped issues" — "May see duplicates in search results"
```

Save the chosen path:
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" config --set skippedIssuesPath="{path}" --json
```

If "Don't track", skip — no config change needed (the search flow handles missing skip files gracefully).

**Question 10: Squash Commits Before Review**
- "Should PRs be squashed into a single commit before marking ready for review?"
- Options: "Yes, always squash (Recommended)", "No, keep individual commits", "Ask me each time"

Map the answer to a config value: "Yes" → `true`, "No" → `false`, "Ask me each time" → `"ask"`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set squashByDefault=VALUE --json
```

This sets the global `squashByDefault` setting.

**Question 11: Score Threshold for Vetted Issues**
- "Minimum score threshold for vetted issues? Issues below this score are auto-filtered during `/oss-search` vetting."
- Options: "4 (lenient)", "5 (moderate)", "6 (default)", "7 (selective)", "8 (strict)"

Extract the number from the selected option and apply:
```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set scoreThreshold=NUMBER --json
```

**Question 12: Diff Viewer Preference**
- "How would you like to review diffs before committing?"
- Options: "Inline (default) — print diff in CLI", "SourceTree — open repo in SourceTree", "VS Code — open diff in VS Code", "Custom command"

Apply based on selection:
```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set diffTool=VALUE --json
```

Where VALUE is `inline`, `sourcetree`, `vscode`, or `custom`.

If user selects "Custom command", ask for the command string:
- "What command should I run? (The repo path will be appended as the last argument)"

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set diffToolCustomCommand="COMMAND" --json
```

## Step 4-CLI: Verify GitHub Access

Before marking setup complete, verify that the token actually works by making a lightweight API call:

```bash
gh api user --jq '.login' 2>/dev/null
```

**If this fails** (empty output or error), do NOT proceed. Tell the user:
> "GitHub authentication check failed. Please verify your credentials: run `gh auth status` to check, or re-authenticate with `gh auth login`."

**If this succeeds**, confirm the returned username matches the one from Step 2-CLI and proceed to Step 5-CLI.

## Step 5-CLI: Mark Setup Complete

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set complete=true --json
```

## Step 6-CLI: Import Existing PRs

Ask user:
> "Would you like me to import your existing open PRs?"

If yes:
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" init USERNAME --json
```

This fetches all open PRs from GitHub and adds them to tracking.

## Step 7-CLI: Confirmation

Show summary:
```markdown
## Setup Complete!

### Your Configuration
- **Username**: @USERNAME
- **Max PRs**: NUMBER
- **Dormant**: NUMBER days
- **Languages**: list
- **Labels**: list
- **Scope Tiers**: list or "None (custom labels only)"
- **Project Categories**: list or "No preference"
- **Preferred Orgs**: list or "None"
- **Issue List**: PATH or "Not configured"
- **Squash PRs**: Yes (default) / No / Ask each time
- **Score Threshold**: NUMBER/10

### Imported PRs
- X open PRs imported

### Next Steps
- Run `/oss` to check your PRs and find new contribution opportunities
- Run `/oss-help` for a full reference card of commands and agents

### Optional Enhancement
- **Enhanced code review**: Install the `pr-review-toolkit` plugin for parallel specialized code review (5 agents instead of 1). Search for it in the plugin marketplace. The built-in pre-commit reviewer works without it.
```

**Note:** The `squashByDefault` setting is stored in `~/.oss-autopilot/state.json` config and can be changed via `config squashByDefault VALUE` or `setup --set squashByDefault=VALUE`.

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

**Question 6: Issue Scope Tiers** (multi-select)
- "What scope of issues do you want to discover? Scope tiers add extra labels to your search beyond your custom labels above."
- Options: "Beginner (good first issue, help wanted, easy, up-for-grabs)", "Intermediate (enhancement, feature, contributions welcome)", "Advanced (proposal, RFC, accepted, design)", "Skip (use only my custom labels)"

Map selections: "Beginner" → `beginner`, "Intermediate" → `intermediate`, "Advanced" → `advanced`.

If "Skip" is selected, omit the `scope` field from the config (or set it to an empty list).

**Question 7: Project Categories** (multi-select)
- "What types of projects interest you?"
- Options: "Nonprofit/Social Impact", "Developer Tools", "Infrastructure/Cloud", "Web Frameworks", "Data/ML", "Education", "No preference (skip)"

Map selections to values: nonprofit, devtools, infrastructure, web-frameworks, data-ml, education.

**Question 8: Preferred Organizations** (free text)
- "Any GitHub organizations you'd like to prioritize? (comma-separated, or skip)"

**Question 9: Curated Issue List**
- "Do you maintain a curated list of potential issues to work on?"
- Options: "Yes", "No"

If yes, ask for the file path:
- "What's the path to your issue list file? (relative to your notes/project root)"
- Options: "open-source/potential-issue-list.md (default)", "Enter custom path"

If a path is provided, try to read it to verify it exists. If it doesn't exist, warn but continue — the user may create it later.

### Skipped Issues File

If the user configured an issue list path, ask:

```
Question: "Where should skipped/rejected issues be tracked? This prevents re-surfacing issues you've already vetted and rejected. Entries auto-expire after 90 days."

Options:
1. "Use default ({issueListDir}/skipped-issues.md)" — "Same folder as your issue list"
2. "Custom path" — "Specify a different location"
3. "Don't track skipped issues" — "May see duplicates in search results"
```

Save the chosen path:
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" config --set skippedIssuesPath="{path}" --json
```

If "Don't track", skip — no config change needed (the search flow handles missing skip files gracefully).

**Question 10: Squash Commits Before Review**
- "Should PRs be squashed into a single commit before marking ready for review?"
- Options: "Yes, always squash (Recommended)", "No, keep individual commits", "Ask me each time"

This sets the global `squashByDefault` setting.

**Question 11: Score Threshold for Vetted Issues**
- "Minimum score threshold for vetted issues? Issues below this score are auto-filtered during `/oss-search` vetting."
- Options: "4 (lenient)", "5 (moderate)", "6 (default)", "7 (selective)", "8 (strict)"

Store the selected number in config as `scoreThreshold`.

## Step 5: Verify GitHub Access

Before creating config files, verify that the token actually works:

```bash
gh api user --jq '.login'
```

**If this fails**, do NOT proceed. Tell the user:
> "GitHub authentication check failed. Please verify your credentials: run `gh auth status` to check."

**If this succeeds**, confirm the username matches and proceed.

## Step 6: Offer to Import Existing PRs

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

## Step 7: Confirmation

Show summary:

```markdown
## Setup Complete!

### Your Configuration
- **Username**: @USERNAME
- **Max PRs**: NUMBER
- **Dormant**: NUMBER days
- **Languages**: list
- **Labels**: list
- **Scope Tiers**: list or "None (custom labels only)"
- **Project Categories**: list or "No preference"
- **Preferred Orgs**: list or "None"
- **GitHub Access**: via [gh CLI / MCP server]
- **Issue List**: PATH or "Not configured"
- **Squash PRs**: Yes (default) / No / Ask each time
- **Score Threshold**: NUMBER/10

### Imported PRs
- X open PRs imported

### Next Steps
- Run `/oss` to check your PRs and find new contribution opportunities
- Run `/oss-help` for a full reference card of commands and agents

### Optional Enhancement
- **Enhanced code review**: Install the `pr-review-toolkit` plugin for parallel specialized code review (5 agents instead of 1). Search for it in the plugin marketplace. The built-in pre-commit reviewer works without it.
```

---

## Important Notes

- State is stored in `~/.oss-autopilot/state.json` (separate from the plugin code)
- Configuration can be edited manually or by running `/setup-oss` again
- The plugin works with either `gh` CLI or GitHub MCP servers
- **NEVER add AI attribution** to commits, comments, or PRs unless the repository explicitly requires disclosure of AI tool usage. Contributions should appear as solely from the user.
