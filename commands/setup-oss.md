---
name: setup-oss
description: Configure OSS autopilot preferences
allowed-tools: Bash, Write, Read, Glob, mcp__plugin_oss-autopilot_*
---

# OSS Autopilot Setup

Customize your OSS Autopilot preferences. This is **optional** — the tool works out of the box with auto-detected settings. Use this command to fine-tune languages, labels, PR limits, and other preferences.

> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

## Step 0: Ensure CLI is Built and Available

This flow delegates entirely to the CLI. There is no markdown-only fallback — if the CLI cannot be built, ask the user to install Node 22+ and re-run.

Build the CLI on first run (auto-installs deps). Delegates to `scripts/build-cli-if-stale.sh` (#1292), which detects an existing-but-stale bundle as well as a missing one — the prior existence-only check would happily reuse a bundle from a stale checkout:

```bash
CLI_HELPER_RC=0
"${CLAUDE_PLUGIN_ROOT}/scripts/build-cli-if-stale.sh" "${CLAUDE_PLUGIN_ROOT}" >/tmp/oss-setup-cli-build.log 2>&1 || CLI_HELPER_RC=$?
if [ "$CLI_HELPER_RC" = "2" ]; then
  echo "BUILD_FAILED"; tail -5 /tmp/oss-setup-cli-build.log; exit 1
fi
```

**If the build succeeded but the bundle file still isn't there**, or **if `node` is unavailable**: Stop the flow and tell the user:

> "OSS Autopilot setup needs the CLI. Install Node.js 22+ from <https://nodejs.org>, then re-run `/setup-oss`. (Alternative: build manually with `cd ${CLAUDE_PLUGIN_ROOT}/packages/core && npm install && npm run bundle`.)"

**If output starts with `BUILD_FAILED`**: Show the error lines and the same install/re-run guidance. Common causes: missing Node 22+, stale `node_modules`, no network for `npm install`.

Then verify the CLI is callable:

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" checkSetup --json 2>/dev/null
```

If this also fails, surface the install/re-run guidance and stop.

---

## Step 1: Check Current Status

Run the setup command to see current configuration:

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --json 2>/dev/null
```

If `setupComplete: true`, ask:
> "Setup is already complete. Would you like to reconfigure your settings?"

Options: "Yes, reconfigure" or "No, keep current settings"

If they choose to keep current settings, show current config and exit.

## Step 2: Get GitHub Username

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

## Step 3: Gather Preferences

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

**Question 11: Diff Viewer Preference**
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

## Step 4: Verify GitHub Access

Before marking setup complete, verify that the token actually works by making a lightweight API call:

```bash
gh api user --jq '.login' 2>/dev/null
```

**If this fails** (empty output or error), do NOT proceed. Tell the user:
> "GitHub authentication check failed. Please verify your credentials: run `gh auth status` to check, or re-authenticate with `gh auth login`."

**If this succeeds**, confirm the returned username matches the one from Step 2 and proceed to Step 5.

## Step 5: Mark Setup Complete

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" setup --set complete=true --json
```

## Step 6: Import Existing PRs

Ask user:
> "Would you like me to import your existing open PRs?"

If yes:

```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" init USERNAME --json
```

This fetches all open PRs from GitHub and adds them to tracking.

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

## Important Notes

- State is stored in `~/.oss-autopilot/state.json` (separate from the plugin code)
- Configuration can be edited manually or by running `/setup-oss` again
- The plugin works with either `gh` CLI or GitHub MCP servers
- **NEVER add AI attribution** to commits, comments, or PRs unless the repository explicitly requires disclosure of AI tool usage. Contributions should appear as solely from the user.
