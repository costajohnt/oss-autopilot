---
name: oss
description: "Daily OSS contribution check - uses CLI with --json for structured data"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, Task, mcp__*
---

# OSS Autopilot Daily Check

This command checks your open source PRs and provides a summary of what needs attention.

## Step 0.5: Ensure CLI is Built

Before running any CLI commands, ensure the bundle exists (auto-builds on first run):

```bash
[ -f "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" ] || (cd "${CLAUDE_PLUGIN_ROOT}" && npm install --silent 2>&1 && npm run bundle --silent 2>&1) >/dev/null
```

If this fails, fall back to the gh CLI workflow (Step 1b).

## Step 0.7: Detect Curated Issue List

Before running the daily check, determine if the user has a curated issue list.

### 1. Check config for `issueListPath`

Read `.claude/oss-autopilot/config.md` and look for the `issueListPath` field in YAML frontmatter.

### 2. If `issueListPath` is set, read and parse the file

Use the Read tool to load the file at the configured path. Parse the markdown to identify:
- **Available issues**: Lines with `- [#NUMBER](URL)` that are NOT wrapped in `~~strikethrough~~` and do NOT contain "**Done**"
- **Completed issues**: Lines wrapped in `~~strikethrough~~` or containing "**Done**"
- **Priority tiers**: Section headings (e.g., `## Pursue — Ready to Contribute`, `## Maybe — Viable with Caveats`)

Count available and completed issues.

### 3. If `issueListPath` is NOT set, probe common locations

Check these paths in order (using Read tool, accept first that exists):
- `open-source/potential-issue-list.md`
- `oss/issue-list.md`
- `issues.md`

If found, treat as an auto-detected list. Note the path for later.

### 4. Set session context variables

Store these for use in later steps:
- `hasIssueList`: boolean — whether a list was found
- `issueListPath`: string — path to the list file
- `availableCount`: number — issues not marked done
- `completedCount`: number — issues marked done
- `issueListSource`: "configured" | "auto-detected" — how the list was found

**Do NOT display anything yet** — this data is used in Step 3 to offer the right action choices.

## Step 1: Run Daily Check and Open Dashboard

Run the daily check, generate dashboard, and open it in the background:

```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" daily --json 2>/dev/null && \
  node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" dashboard 2>/dev/null && \
  open ~/.oss-autopilot/dashboard.html
```

**If CLI returns valid JSON** (with `success: true`):
- Display the brief summary (Step 2)
- Present action choices (Step 3)

**If CLI fails or no JSON output**:
- Fall back to gh CLI workflow (Step 1b)

## Step 2: Display Brief Summary

The CLI returns structured data with new fields for the action-first flow:

```json
{
  "success": true,
  "data": {
    "briefSummary": "16 Active PRs | 3 need attention | Dashboard opened in browser",
    "actionableIssues": [
      {
        "type": "ci_failing",
        "label": "[CI Failing]",
        "pr": { "repo": "owner/repo", "number": 123, "title": "...", "url": "..." }
      }
    ],
    "capacity": { "hasCapacity": true, ... },
    "digest": { ... },
    "updates": [...]
  }
}
```

**Display ONLY the `briefSummary` field:**
```
data.briefSummary
```

Example output:
> 16 Active PRs | 3 need attention | Dashboard opened in browser

Then proceed to Step 3 (Present Action Choices).

---

## Step 3: Present Action Choices

### If No Actionable Issues

When `data.actionableIssues` is empty, display:
```
All PRs are healthy! No issues need attention.
```

Then use AskUserQuestion with:
- "Pick an issue from your list" (if `hasIssueList` and `availableCount > 0` and `hasCapacity`) — "{availableCount} vetted issues available"
- "Search for new issues" (if `hasCapacity`)
- "View PR status details"
- "Done for now"

### Display All PRs First (Information Before Prompt)

**Before asking the user anything**, display all actionable issues as formatted text:

```
{count} PRs Need Attention:

1. {issue.label} {issue.pr.repo}#{issue.pr.number}
   {issue.pr.title} ({daysSinceActivity}d inactive)

2. {issue.label} {issue.pr.repo}#{issue.pr.number}
   {issue.pr.title} ({daysSinceActivity}d inactive)

... (list ALL actionable issues, no limit)

---
```

Calculate `daysSinceActivity` from the PR's `updatedAt` field.

Example output:
```
7 PRs Need Attention:

1. [Needs Rebase] shadcn-ui/ui#9263 (160 behind)
   fix(docs): use yarn dlx for npx command (35d inactive)

2. [Needs Rebase] shadcn-ui/ui#9262 (160 behind)
   fix(cli): use 'bun x' instead of 'bunx' (35d inactive)

3. [Needs Rebase] oven-sh/bun#25791 (233 behind)
   fix(console): route console.trace() to stderr (14d inactive)

4. [CI Blocked] oven-sh/bun#25791
   CI needs maintainer to trigger Buildkite

5. [Changes Requested] ghostfolio/ghostfolio#6223
   feat(api): add groupBy=year support (2d inactive)

6. [Merge Conflict] cline/cline#8362
   fix: update button text after deleting history item (10d inactive)

7. [Needs Response] vadimdemedes/ink#858
   Remove create-ink-app from README (10d inactive)

---
```

### Ask for Action (4-Option Limit)

Use AskUserQuestion with **action-focused options**, not PR-specific options.

**Options to present:**

| Option | Condition | Label | Description |
|--------|-----------|-------|-------------|
| 1 | Always (if actionable issues exist) | "Address all {count} issues in parallel (Recommended)" | "Launch agents simultaneously to check status, rebase, fix CI, and respond" |
| 2 | If `hasIssueList` and `availableCount > 0` and `hasCapacity` | "Pick from your issue list ({availableCount} available)" | "Choose from your curated list of vetted issues" |
| 2/3 | If `capacity.hasCapacity === true` | "Search for new issues" | "Look for new contribution opportunities" |
| 2/3 | If `capacity.hasCapacity === false` | "View healthy PRs" | "See status of PRs not needing attention" |
| 3/4 | Always | "Done for now" | "End session with summary" |

**Note:** Option numbers shift based on whether the issue list option is shown. Keep within the 4-option limit (the 4th is auto "Other").

**Note:** The 4th option is the automatic "Other" - user can type specific PR selections.

### Example AskUserQuestion

```
Question: "What would you like to do?"
Header: "Action"

Options:
1. Label: "Address all 7 issues in parallel (Recommended)"
   Description: "Launch agents simultaneously to check status, rebase, fix CI, and respond"

2. Label: "Search for new issues"
   Description: "Look for new contribution opportunities"

3. Label: "Done for now"
   Description: "End session with summary"

(Other is auto-added - user can type "#1", "fix ink#861", "just 3 and 5", etc.)
```

### Parsing "Other" Input

When user provides custom input via "Other", parse for:

| Input Format | Examples | Action |
|--------------|----------|--------|
| PR numbers | "1", "#1", "fix 1", "address #1" | Address that specific PR from the list |
| Multiple PRs | "1 and 3", "1,3,5", "#1 #3 #5", "1-3" | Address those PRs in parallel |
| Repo references | "ink#861", "shadcn-ui/ui#9263" | Find and address that PR |
| URLs | "https://github.com/..." | Address that PR directly |
| Keywords | "all", "none", "skip" | Map to corresponding action |

**If input is unclear**, ask for clarification:
> "I didn't understand '{input}'. Please enter PR numbers (e.g., '1 and 3'), a repo reference (e.g., 'ink#861'), or select an option above."

---

## Step 1b: Fallback to gh CLI

If the TypeScript CLI is not available, use gh CLI directly.

### Detect GitHub Access

Check in this order:

**Option 1: MCP Server (if available)**
Check if a GitHub MCP server is available by looking for tools like:
- `mcp__github__*` (official GitHub MCP)
- `mcp__*github*` (other GitHub MCP servers)

If available, prefer MCP tools for richer data access.

**Option 2: GitHub CLI (`gh`)**
```bash
gh auth status
```

If not authenticated:
> "I need GitHub access. Please run `gh auth login` first."

### Load Configuration

Read the config file:
```
Read(.claude/oss-autopilot/config.md)
```

If missing or `setupComplete: false`:
> "OSS Autopilot needs configuration. Run `/setup-oss` first."

### Fetch and Check PRs

```bash
# Search ALL open PRs across GitHub (not just current repo)
gh search prs --author USERNAME --state open --json repository,number,title,url,updatedAt --limit 100
```

For each PR, get detailed status:
```bash
gh pr view NUMBER --repo OWNER/REPO --json state,title,updatedAt,reviews,comments,statusCheckRollup,mergeable,reviewDecision,headRefName
```

### Determine PR Status

For each PR, categorize as (checked in priority order):
- **CI Failing**: statusCheckRollup shows failures (excluding expected fork limitations like Vercel auth)
- **CI Blocked**: CI is pending/blocked and requires maintainer action to trigger (e.g., Buildkite on external PRs)
- **CI Not Running**: No CI checks have been reported at all
- **Merge Conflict**: mergeable is false
- **Needs Response**: has new comments from maintainers (changes_requested or unresponded comments)
- **Needs Rebase**: branch is significantly behind upstream (check via `gh pr view --json baseRefName,headRefName` and compare)
- **Missing Required Files**: changeset bot or CLA bot has flagged missing files
- **Approaching Dormant**: no activity past `approachingDormantDays`
- **Merged**: state is "MERGED"
- **Closed**: state is "CLOSED" (without merge)
- **Healthy**: everything looks good

**Distinguishing CI failures from expected fork limitations:**
Some CI failures are expected for external forks and not actionable by the contributor:
- Vercel deploy previews requiring team authorization
- Internal CI systems that don't run on fork PRs
These should be labeled `[Fork Limitation]` rather than `[CI Failing]` and treated as informational, not actionable.

Then format and present action choices similar to Step 3.

---

## Step 4: Action Handlers

### Action Tiers: Routine Maintenance vs Code Changes

Actions are divided into two tiers based on risk:

**Tier 1: Routine Maintenance (auto-safe with user consent)**
These are non-destructive operations that don't change code logic:
- Rebasing onto upstream (replay existing commits on new base)
- Cloning repos that aren't available locally
- Fetching upstream changes

For Tier 1 actions, agents CAN execute directly (rebase + force push) when the user
selects "Address all issues" or explicitly approves maintenance. No separate investigation
step is needed — just do the rebase and report the result.

**Tier 2: Code Changes (investigate first, then approve)**
These change code or post public content:
- Fixing CI failures (code changes)
- Resolving merge conflicts (code changes)
- Responding to review comments (public communication)
- Adding missing files (changesets, CLA)

For Tier 2 actions, agents INVESTIGATE and RECOMMEND. All write actions require
explicit user approval via AskUserQuestion.

### Same-Repo PR Grouping

**CRITICAL: When multiple PRs exist in the same repository, handle them in a single agent.**

Before dispatching agents, group PRs by repository. For each repo with multiple PRs,
dispatch ONE agent that handles all PRs for that repo sequentially (to avoid branch
checkout conflicts).

Example: If ink has PRs #855, #856, #863:
```
Task(general-purpose, "Check all 3 PRs in vadimdemedes/ink: #855, #856, #863.
  For each PR:
  1. git checkout the branch
  2. Fetch upstream, check commits behind
  3. Rebase if behind, force push if clean
  4. Check CI status and review comments
  Report results for all 3 PRs.")
```

NOT:
```
Task(general-purpose, "Check ink#855...")
Task(general-purpose, "Check ink#856...")  // Will conflict with branch checkout!
Task(general-purpose, "Check ink#863...")
```

### Local Repo Registry

Before dispatching agents, check which repos are available locally:

```bash
# Check common OSS working directories
for dir in ~/Documents/oss ~/dev ~/projects ~/code; do
  ls "$dir" 2>/dev/null
done
```

Build a map of `repo → local_path`. Pass this to agents so they know:
- Which repos they can rebase directly
- Which repos need to be cloned first

If a repo isn't cloned locally and a rebase is needed, the agent should clone it
(to `~/Documents/oss/<repo-name>` by default) as part of the maintenance action.

### Handle "Address All Issues in Parallel"

**CRITICAL: Dispatch ALL agents in a SINGLE message for true parallelism.**
**CRITICAL: Group PRs by repository — one agent per repo, not per PR.**

For each issue in `actionableIssues`, include a Task tool call:

| Issue Type | Tier | Agent Action |
|------------|------|--------------|
| Needs Rebase | Tier 1 | Clone if needed, fetch upstream, rebase, force push. Report result. |
| CI Failing | Tier 2 | Investigate CI failures. Analyze logs, identify root cause, recommend fixes. DO NOT push. |
| CI Blocked | Info | Report that CI needs maintainer trigger. Suggest commenting to request it. |
| CI Not Running | Info | Investigate why CI isn't running. Check if workflows exist, if fork has actions enabled. |
| Fork Limitation | Info | Note as expected — no action needed. |
| Merge Conflict | Tier 2 | Identify conflicting files, recommend resolution strategy. DO NOT push. |
| Needs Response | Tier 2 | Analyze maintainer feedback, draft a response. DO NOT post — return for approval. |
| Changes Requested | Tier 2 | Analyze requested changes, investigate what needs to change, recommend approach. |
| Missing Required Files | Tier 2 | Identify what's missing (changeset, CLA, etc.), draft the file. DO NOT push. |
| Approaching Dormant | Tier 2 | Assess if still relevant, recommend follow-up action. |

**Agent dispatch prompt template for comprehensive PR check:**

```
Check PR status for {repo}: {list of PR numbers}.
Local repo path: {path or "not cloned"}.

For each PR:
1. If not cloned, clone to ~/Documents/oss/{repo-name}
2. git checkout the PR branch
3. Fetch upstream, check how many commits behind
4. If behind and rebase is clean, rebase and force push (Tier 1 - auto-safe)
5. If rebase has conflicts, abort and report the conflicts (Tier 2 - needs manual resolution)
6. Check CI status: gh pr checks {number} --repo {repo}
7. Check for review comments and changes requested
8. Check for bot comments (changeset-bot, CLA bot, etc.)

Report back:
(a) Commits behind / rebase result
(b) CI status (passing/failing/blocked/not running)
(c) Review comments and their status
(d) Any missing required files
(e) Whether force push was performed
```

### Present Results

After all agents complete, present a consolidated summary table:

```
## PR Status Dashboard

### Routine Maintenance Completed
| PR | Repo | Action | Result |
|---|---|---|---|
| #856 | ink | Rebased (5 behind) | Clean, force pushed |
| #8362 | cline | Rebased (129 behind) | Clean, force pushed |
| #9263 | shadcn-ui/ui | Rebased (160 behind) | Clean, force pushed |

### Needs Attention
| PR | Repo | Issue | Action Needed |
|---|---|---|---|
| #6223 | ghostfolio | Changes requested | Address reviewer feedback |
| #858 | ink | Needs response | Reply to maintainer |

### No Action Needed
| PR | Repo | Status |
|---|---|---|
| #863 | ink | CI green, awaiting review |
| #2857 | eslint-plugin-unicorn | CI green, awaiting review |
```

### Ask User About Remaining Issues

If there are Tier 2 issues remaining after maintenance:

Use AskUserQuestion:

```
Question: "Which issues would you like me to investigate?"
Header: "Investigate"
multiSelect: true

Options:
1. "Address changes requested on ghostfolio#6223"
2. "Draft response for ink#858"
3. "All of the above"
4. "None - I'll handle manually"
```

### Execute Approved Actions Only

Only after user explicitly approves Tier 2 actions:
- Push code changes
- Post comments
- Add missing files

### CRITICAL: Continue the Flow

**After EVERY action completes (investigation, approval, execution), ALWAYS ask what to do next.**

Never end with just a summary. Always prompt:

```
Actions completed:
- Rebased 4 PRs (all clean)
- Pushed fix for #9263
- Posted response to #858

What would you like to do next?
```

Then use AskUserQuestion:
- "Pick from your issue list" (if `hasIssueList` and `availableCount > 0` and `hasCapacity`) — "{availableCount} vetted issues available"
- "Search for new issues" (if `hasCapacity`)
- "Check for more PR updates" (re-run daily check)
- "Done for now"

**The session only ends when the user explicitly selects "Done for now".**

### Handle Specific PR Selection (from "Other" input)

When user selects specific PRs (e.g., "1 and 3"), dispatch only those agents in parallel.
Still group by repo if selected PRs share a repository.

### Handle "View Healthy PRs"

Show when `capacity.hasCapacity === false` (user has critical issues to address first).

Display healthy PRs from `data.digest.healthy`:
```
Healthy PRs (no action needed):

- owner/repo#123 - Title here (approved, CI passing)
- owner/repo#456 - Title here (waiting for review)
...

These PRs are progressing normally. Focus on the {count} issues that need attention.
```

Then return to Step 3 to present action choices again.

### Handle "Find New Issues"

Only available if `capacity.hasCapacity === true`.

**If `hasIssueList` is true and `availableCount > 0`**, present a preamble before searching:

Use AskUserQuestion:
- "Review from your curated list ({availableCount} available)" — "Pick from pre-vetted issues you've already researched"
- "Search GitHub" — "Find new issues via CLI search"
- "Both — list first, then search" — "Review your list, then search for more"
- "Done for now"

Route based on choice:
- "Review from list" → go to **Handle "Pick Issue From List"** above
- "Search GitHub" → continue with CLI search below
- "Both" → show list first (Handle "Pick Issue From List"), then after that completes, continue with CLI search

Use the CLI:
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" search 10 --json
```

Or dispatch the `issue-scout` agent with language/label preferences.

If user requests this but `hasCapacity === false`:
> "You currently have [N] critical issues that need attention. Would you like to address those first, or override and search anyway?"

### Handle "Pick Issue From List"

Only available when `hasIssueList` is true and `availableCount > 0`.

#### 1. Read and parse the list file

Re-read the file at `issueListPath` (it may have been updated since Step 0.7). Parse available issues — those NOT struck through and NOT marked "**Done**".

#### 2. Display available issues grouped by priority tier

Present the issues using their section headings from the list file:

```
## Your Curated Issue List ({availableCount} available, {completedCount} done)

### Pursue — Ready to Contribute
1. suitenumerique/meet#804 — Test mic while "muted" (Low complexity)
2. py-pdf/pypdf#2065 — Add PDF annotation /IRT (Low-medium complexity)
3. super-productivity/super-productivity#6365 — Window control buttons overlap (Low complexity)

### Maybe — Viable with Caveats
4. keycloak/keycloak#45868 — Admin UI ClientScope default mismatch (Low complexity)
5. palantir/blueprint#6799 — Blue artifact line in table cell selection (Medium-high complexity)
```

#### 3. Ask user to pick

Use AskUserQuestion with up to 4 options (dynamically chosen from the top of the list):

```
Question: "Which issue would you like to work on?"
Header: "Issue"

Options:
1. "{repo}#{number} — {brief title}" (top priority issue)
2. "{repo}#{number} — {brief title}" (second)
3. "Search GitHub instead"
4. "Done for now"
```

If there are more than 2 issues, the user can type a number via "Other" to pick any displayed issue.

#### 4. Vet the selected issue

Dispatch the `issue-scout` agent to vet the picked issue. Pass the issue URL and note that it came from the curated list:

```
Task(issue-scout, "Vet this issue from the user's curated list:
  URL: {issue_url}
  Source: curated-list (pre-vetted, apply +2 score bonus)
  Verify it's still open, unassigned, and claimable.
  Check for recent claims or linked PRs since the list was last updated.")
```

#### 5. Present vetting results and offer to claim

Show the vetting summary. If claimable, offer:
- "Claim this issue and start working"
- "Pick a different issue from the list"
- "Search GitHub instead"
- "Done for now"

#### 6. After claiming → implementation → PR → Step 6.5

When the user claims an issue from the list and eventually creates a PR, proceed to **Step 6.5** (Post-PR List Continuity) instead of ending.

**CRITICAL: Track that the current issue came from the curated list** so Step 6.5 knows to offer list updates.

### After Each Action

1. Re-run the daily check to refresh state
2. If `hasIssueList`, re-read the list file to get updated available/completed counts
3. Return to Step 3 with updated action choices (including updated list counts)
4. Continue until user selects "Done for now"

---

## Step 5: Session End

When user selects "Done for now":

```markdown
## Session Complete

Today's session:
- Checked X PRs
- Rebased Y PRs
- Capacity: [hasCapacity ? "Ready for new work" : "X critical issues remaining"]
- [List any actions taken: "Rebased 4 PRs", "Posted response to repo#123"]

Your PRs are tracked. Run /oss anytime to check again.
```

---

## Step 6: After Creating/Updating PRs

**IMPORTANT:** After helping create or update a PR, always offer a compliance check:

> "Would you like me to run a compliance check on this PR to ensure it meets opensource.guide best practices?"

Dispatch the `pr-compliance-checker` agent with the PR URL.

### Test Coverage Requirements

**When implementing changes, ALWAYS include tests unless the repo has no test infrastructure.**

Before submitting a PR, check if the repo has a test directory:
- `test/`, `tests/`, `__tests__/`, `spec/`

---

## Step 6.5: Post-PR List Continuity

**Trigger:** After creating a PR for an issue that came from the curated issue list (`issueListPath`).

This step ensures the user's issue list stays current and offers to continue through remaining items.

### 1. Offer to update the list file

Ask the user:

```
Question: "Update your issue list to mark this as done?"
Header: "List update"

Options:
1. "Yes, mark it done with PR link (Recommended)"
2. "No, I'll update it manually"
```

If yes, use the Edit tool to update the list file:
- Wrap the repo heading and issue line in `~~strikethrough~~`
- Change or add the status to: `**Done** — PR [#NUMBER](URL) submitted, {brief status}.`

Example transformation:
```markdown
# Before:
### suitenumerique/meet (1.6k★) — Open-source video conferencing (LiveKit)
- [#804](https://github.com/suitenumerique/meet/issues/804) — Test mic while "muted"
  - **Low complexity** — Help wanted, unassigned, no PRs, active repo.

# After:
### ~~suitenumerique/meet (1.6k★) — Open-source video conferencing (LiveKit)~~
- ~~[#804](https://github.com/suitenumerique/meet/issues/804) — Test mic while "muted"~~
  - **Done** — PR [#42](https://github.com/suitenumerique/meet/pull/42) submitted, CI passing.
```

**Important:** Only strike through the specific repo heading if ALL issues under it are now done. If other issues remain under the same repo heading, only strike through the individual issue lines.

### 2. Show remaining count

After updating (or skipping update):

```
Issue list updated! {remainingCount} issues remaining, {completedCount} done.
```

### 3. Offer next action

Use AskUserQuestion:
- "Pick another from your list" (if `remainingCount > 0`) — "{remainingCount} issues remaining"
- "Search GitHub for new issues" — "Find fresh contribution opportunities"
- "Done for now" — "End session with summary"

If `remainingCount === 0`:
```
All issues from your list have been addressed! Nice work.
```
Then offer:
- "Search GitHub for new issues"
- "Find more issues to add to your list"
- "Done for now"

**Route based on choice:**
- "Pick another" → go to **Handle "Pick Issue From List"** (Step 4 handler)
- "Search GitHub" → go to **Handle "Find New Issues"**
- "Done for now" → go to **Step 5: Session End**

---

## CLI Commands Reference

All commands support `--json` flag for structured output:

```bash
# Daily check (syncs and checks all PRs)
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" daily --json

# Status overview
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" status --json

# Search for issues
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" search 10 --json

# Track a PR
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" track <pr-url> --json

# View comments
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" comments <pr-url> --json

# Post comment
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" post <url> "message" --json
```

---

## Agent Integration

| Agent | Purpose |
|-------|---------|
| `pr-responder` | Draft responses to maintainer feedback |
| `pr-health-checker` | Diagnose CI failures, merge conflicts, rebase status |
| `pr-compliance-checker` | Validate PRs against opensource.guide |
| `issue-scout` | Find and vet new issues |
| `repo-evaluator` | Analyze repository health |
| `contribution-strategist` | Strategic OSS advice |

---

## Important Rules

### Human-in-the-Loop
1. **Tier 1 (maintenance)**: Rebase + force push is allowed after user selects "Address all issues" or explicitly approves
2. **Tier 2 (code/comments)**: NEVER push code or post comments without explicit per-action approval
3. **Agents report results** for Tier 1, **investigate and recommend** for Tier 2
4. Always use AskUserQuestion with multiSelect before executing Tier 2 write actions

### Workflow Control (CRITICAL)
5. **NEVER end without asking what's next** - after ANY action, always prompt user
6. **Drive the conversation** - Claude controls the flow, user responds to prompts
7. **Session ends ONLY when user selects "Done for now"** - never assume user is finished
8. **ALWAYS include "Done for now"** in every AskUserQuestion

### UX Guidelines
9. Keep responses professional and concise
10. **NEVER add AI attribution** to commits, comments, or PRs
11. **Display information before prompting** - show all PRs as text FIRST, then ask for action
12. **Parse "Other" input flexibly** - accept PR numbers, URLs, repo refs like "ink#861"

### Parallel Execution
13. **Group PRs by repository** - one agent per repo, not per PR, to avoid branch checkout conflicts
14. **Parallel execution** - when addressing multiple repos, launch ALL agents in a SINGLE message
15. After parallel execution, present consolidated results table
