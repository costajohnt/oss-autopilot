---
description: "NO NPM COMMANDS - First action: Read(.claude/oss-autopilot/config.md) - then use gh CLI for GitHub"
allowed-tools: Bash, Read, Write, Glob, Grep, AskUserQuestion, mcp__*
---

# YOUR FIRST ACTION

**Read the config file NOW. Do not run any other command first.**

```
Read(.claude/oss-autopilot/config.md)
```

After reading the config, proceed to check GitHub PRs using `gh` CLI commands.

---

**THERE IS NO NPM CLI IN THIS PROJECT.** This is a markdown-based plugin. The `npm start` command does not exist. Do not attempt to run npm commands.

---

You are managing open source contributions. This workflow monitors PRs and finds new opportunities.

## Step 0: Detect GitHub Access

First, determine how to access GitHub. Check in this order:

### Option 1: MCP Server (Preferred if available)
Check if a GitHub MCP server is available by looking for tools like:
- `mcp__github__*` (official GitHub MCP)
- `mcp__*github*` (other GitHub MCP servers)

If available, use MCP tools for all GitHub operations. MCP servers often have richer data access.

### Option 2: GitHub CLI (`gh`)
Check if `gh` CLI is authenticated:
```bash
gh auth status
```

If authenticated, use `gh` commands for GitHub operations.

### Option 3: No GitHub Access
If neither is available, tell the user:
> "I need access to GitHub to run the OSS autopilot. You have two options:
> 1. **Recommended**: Install and authenticate the GitHub CLI: `gh auth login`
> 2. **Alternative**: Configure a GitHub MCP server in your Claude Code settings
>
> Run `/setup-oss` after setting up GitHub access."

Then STOP.

## Step 1: Load Configuration

**⛔ NO NPM COMMANDS - USE THE READ TOOL ⛔**

Your FIRST action must be:
```
Read(.claude/oss-autopilot/config.md)
```

Do NOT run `npm start`, `npm run`, or any bash command to check setup. There is no CLI. Just read the file.

If the file doesn't exist or `setupComplete: false` in frontmatter, tell the user:
> "OSS Autopilot needs to be configured first. Run `/setup-oss` to set your preferences."

Then STOP - do not proceed until setup is complete.

### Config Validation

After loading config, validate required fields exist and have correct types:
- `githubUsername` - must be a non-empty string
- `maxActivePRs` - must be a positive integer
- `dormantDays` - must be a positive integer

If validation fails:
> "Your config file is missing or has invalid fields: [list fields]. Run `/setup-oss` to reconfigure."

## Step 2: Load State

Read tracked PRs from:
```
.claude/oss-autopilot/tracked-prs.md
```

Parse the markdown table to get list of tracked PRs with their repo, number, and last known status.

### State File Validation

If the file is missing or the markdown table is malformed (missing headers, corrupted rows):
> "Your tracked-prs.md file appears corrupted or malformed. Would you like me to rebuild it from your open PRs on GitHub?"

If user agrees, fetch open PRs and recreate the file. If user declines, create an empty state file and continue.

## Step 2.5: Sync All Open PRs

Before checking tracked PRs, fetch ALL open PRs by the user across GitHub:

**Using gh CLI:**
```bash
# Search ALL open PRs by user across all of GitHub (not just current repo)
gh search prs --author USERNAME --state open --json repository,number,title,url,updatedAt,state --limit 100
```

**Using MCP (if available):**
Use `mcp__github__search_issues` with query `is:pr is:open author:USERNAME`

Compare with tracked-prs.md:
- Add any new PRs not already tracked
- Remove any PRs that are no longer open (merged/closed)
- Update the tracked-prs.md file

### Error Handling for GitHub API

If the `gh` command fails, check the error type:

**Rate limit exceeded** (HTTP 403 with "rate limit" in message):
> "GitHub API rate limit hit. Try again in [X] minutes, or authenticate with `gh auth login` for higher limits."

**Network/connection error**:
> "Unable to reach GitHub. Please check your internet connection and try again."

**Authentication failure** (HTTP 401):
> "GitHub authentication failed. Run `gh auth login` to re-authenticate."

If fetching PRs fails entirely, continue with cached state from tracked-prs.md and warn:
> "Could not sync with GitHub. Showing cached PR data (may be outdated)."

## Step 3: Check Each PR

For each tracked PR, fetch current status.

**Using gh CLI:**
```bash
gh pr view OWNER/REPO#NUMBER --json state,title,updatedAt,reviews,comments,statusCheckRollup,mergeable,reviewDecision
```

**Using MCP (if available):**
Use the appropriate MCP tool to fetch PR details (e.g., `mcp__github__get_pull_request`).

### Error Handling for Individual PRs

If fetching a single PR fails:
- **Do NOT abort the entire check** - continue checking other PRs
- Mark the failed PR with status "Unknown (fetch failed)"
- Include it in the report with a note: "Could not fetch status - repo may be private or deleted"
- After all PRs are checked, summarize any failures at the end of the report

This ensures one problematic PR doesn't prevent checking the others.

Determine status for each PR:
- **Merged**: state is "MERGED"
- **Closed**: state is "CLOSED" (without merge)
- **Needs Response**: has new comments from maintainers since last check
- **CI Failing**: statusCheckRollup shows failures
- **Merge Conflict**: mergeable is false
- **Approaching Dormant**: no activity past the configured `approachingDormantDays` threshold
- **Dormant**: no activity past the configured `dormantDays` threshold
- **Healthy**: everything looks good

## Step 4: Generate Report

Output a simple text summary. The browser dashboard has the rich experience.

### CLI Summary Template

```
OSS Dashboard: X PRs (Y need response, Z health issues)

Needs Response:
• repo#123, #456 - @maintainer commented
• repo#789 - @reviewer requested changes

Health Issues:
• repo#123 - merge conflict
• repo#456 - CI failing

Approaching Dormant:
• repo#789 - 25 days (dormant at 30)

Healthy: N PRs all good

Say "open dashboard" for full details with clickable links.
```

### Formatting Rules

- Keep it brief and scannable
- Group PRs by repo when multiple from same repo need attention
- Show maintainer names so user knows who to respond to
- No fancy formatting - plain text only
- Always mention the browser dashboard option at the end

## Step 5: Enter Action Loop

After presenting the CLI dashboard, immediately enter the action loop (Step 8).

**Do NOT just present the report and wait.** Use AskUserQuestion to prompt the user with actionable options based on what the report shows.

This is where the interactive conversation begins - see Step 8 for the full action loop specification.

## Step 6: Update State (Background)

State updates happen automatically as you work - don't block the user for this.

**When to update state:**
- After fetching PRs: Update tracked-prs.md with current status
- After posting a comment: Mark PR as "responded"
- After user ends session: Final state save

**Files to update:**
- `tracked-prs.md` - Current PR statuses
- `pr-history.md` - Merged/closed PRs

**Error handling:** If a write fails, warn the user but don't block:
> "Note: Couldn't save state. Your changes may not persist."

## Step 7: Browser Dashboard (When User Says "dashboard", "open", "browser", "visual")

**⛔ DO NOT open existing files. DO NOT print text. GENERATE a fresh dashboard.**

When user wants a dashboard, do these 3 things IN ORDER:

**1. Spawn background task (REQUIRED):**
```
Task(
  description: "Generate HTML dashboard",
  prompt: "Generate /tmp/oss-dashboard-[timestamp].html with the following EXACT structure:

REQUIREMENTS:
- Dark theme: background #0d1117, text #c9d1d9, borders #30363d
- Header: 'OSS Dashboard' with summary stats (X Active PRs, Y Needs Response, etc.)
- Separate sections for each status category with colored headers:
  - Needs Response: orange (#f0883e)
  - Health Issues: red (#f85149)
  - Approaching Dormant: yellow (#d29922)
  - Healthy: green (#3fb950)
  - Recently Merged: purple (#a371f7)

FOR EACH PR, INCLUDE A TABLE ROW WITH:
- Repository: owner/repo (linked to repo)
- PR#: number (linked to PR)
- Title: full PR title
- Status: specific issue (e.g., 'CI failing: 2 checks', '@maintainer commented', 'Merge conflict')
- Last Activity: 'X days ago' or 'today'
- Action: clickable 'View PR' button

TABLE FORMAT:
| Repository | PR | Title | Status | Last Activity | Action |
Use proper HTML table with alternating row colors (#161b22 / #0d1117).

After generating, run: open /tmp/oss-dashboard-[timestamp].html",
  subagent_type: "general-purpose",
  run_in_background: true
)
```

**2. Immediately say:** "Dashboard is generating in the background. It will open in your browser shortly."

**3. Immediately ask next question (DO NOT WAIT):**
```
AskUserQuestion: "What would you like to do next?"
Options: ["Work on a PR", "Find new issues", "I'm done for now"]
```

**WRONG:** Opening existing .html files, printing tables, or waiting for dashboard to complete
**RIGHT:** Task tool with run_in_background:true, then IMMEDIATELY prompt for next action

## Step 8: Action Loop (REQUIRED)

**IMPORTANT:** The tool must drive the conversation. After EVERY action, prompt the user for what to do next. Do NOT end the conversation without explicit user confirmation.

### Action Loop Flow

```
LOOP:
  1. Present current status or action result
  2. Use AskUserQuestion with relevant options
  3. Execute user's choice
  4. GOTO 1 (unless user chose "I'm done")
```

### After Initial Report

Use AskUserQuestion with options based on what needs attention:

**Always include:**
- "I'm done for now" - End session with summary

**Include if applicable:**
- "Draft response to [repo#N]" - If PRs need response
- "Investigate CI failure on [repo#N]" - If health issues exist
- "Find new issues" - If capacity available (active PRs < maxActivePRs)
- "Send follow-up on dormant PRs" - If PRs approaching dormant
- "Open browser dashboard" - Always available

### After Each Action

After user completes any action (drafting response, investigating, etc.), immediately ask:

> "Done! What would you like to do next?"

And present the options again (excluding completed items).

### Session End

Only when user explicitly chooses "I'm done for now", show:

```
## Session Complete ✓

Today's session:
- Checked X PRs
- [List any actions taken: "Posted response to repo#123", "Investigated CI on repo#456"]

Your PRs are tracked. Run /oss anytime to check again.
```

**NEVER end the conversation without this explicit closure.**

## Important Rules

1. **NEVER post comments without explicit user approval**
2. Always use AskUserQuestion before taking any write actions
3. Keep responses professional and concise
4. If unsure about technical details, ask before drafting
5. **NEVER add AI attribution** to commits, comments, or PRs unless the repository explicitly requires disclosure of AI tool usage. This includes:
   - No "Co-Authored-By: Claude" or similar in commit messages
   - No "Generated with Claude" or AI mentions in PR descriptions
   - No AI attribution in comments or responses
   - Contributions should appear as solely from the user

## Agent Integration

When user wants specific actions, use appropriate agents:
- **pr-responder** - Draft responses to maintainer comments
- **pr-health-checker** - Diagnose CI failures, merge conflicts
- **issue-scout** - Find new issues to work on
- **pr-compliance-checker** - Validate PR against opensource.guide

### Parallel Investigation

When investigating multiple PRs (e.g., 3 PRs have CI failures), spawn agents in parallel:

```
User: "Investigate the health issues"
→ If multiple PRs need investigation, launch parallel agents:
  - Agent 1: pr-health-checker for repo#123
  - Agent 2: pr-health-checker for repo#456
  - Agent 3: pr-health-checker for repo#789
→ Collect results and present summary
```

This speeds up deep investigation significantly. The daily status check stays fast (serial), but when the user wants to dig in, parallel agents handle the heavy lifting.

## After Creating PRs

**IMPORTANT:** After helping create or update a PR, always offer to run a compliance check:

> "Would you like me to run a compliance check on this PR to ensure it meets opensource.guide best practices?"

The pr-compliance-checker agent validates:
- Issue reference (Closes #X)
- Description quality (what/why/how)
- Focused changes (file count, line count)
- **Tests included** (key validation criterion - see below)
- Title quality and formatting
- Branch naming conventions

### Test Coverage Requirements

**When implementing changes, ALWAYS include tests unless the repo has no test infrastructure.**

Before submitting a PR, check if the repo has a test directory:
- `test/` - Common in many languages
- `tests/` - Python, Go, and others
- `__tests__/` - JavaScript/Jest convention
- `spec/` - Ruby/RSpec convention

**Best practices for tests:**
- Match the existing test patterns in the repo
- Look at how other tests are structured and follow the same conventions
- If maintainer feedback mentions missing tests, prioritize adding them
- Tests significantly increase the chance of PR acceptance

This helps catch issues before maintainers review, improving the chance of a quick merge.

## GitHub Tool Reference

### Using gh CLI
```bash
# IMPORTANT: Search ALL open PRs across GitHub (not just current repo)
gh search prs --author USERNAME --state open --json repository,number,title,url,updatedAt --limit 100

# View PR details (requires OWNER/REPO format)
gh pr view NUMBER --repo OWNER/REPO --json state,title,updatedAt,reviews,comments,statusCheckRollup,mergeable,reviewDecision

# Post a comment
gh pr comment NUMBER --repo OWNER/REPO --body "message"

# Search issues across GitHub
gh search issues --label "good first issue" --language typescript --state open --limit 50
```

**Common mistake:** `gh pr list --author @me` only searches the CURRENT repository. Always use `gh search prs` to find PRs across all of GitHub.

### Using MCP Servers
If a GitHub MCP server is available, prefer its tools for:
- Richer data access (more fields, less rate limiting)
- Better error handling
- Consistent authentication

Common MCP GitHub tools:
- `get_pull_request` / `list_pull_requests`
- `get_issue` / `list_issues` / `search_issues`
- `create_issue_comment` / `create_pull_request_comment`
- `get_pull_request_reviews` / `get_pull_request_comments`
