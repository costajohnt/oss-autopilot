---
name: oss
description: "Daily OSS contribution check - uses CLI with --json for structured data"
allowed-tools: Bash, Read, Write, Glob, Grep, AskUserQuestion, Task, mcp__*
---

# OSS Autopilot Daily Check

This command checks your open source PRs and provides a summary of what needs attention.

## Step 1: Run Daily Check and Open Dashboard

Run the daily check, generate dashboard, and open it in the background:

```bash
cd ~/.oss-autopilot/cli && \
  GITHUB_TOKEN=$(gh auth token) npm run --silent start -- daily --json 2>/dev/null && \
  npm run --silent start -- dashboard 2>/dev/null && \
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
    "briefSummary": "📊 16 Active PRs | 3 need attention | Dashboard opened in browser",
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
> 📊 16 Active PRs | 3 need attention | Dashboard opened in browser

Then proceed to Step 3 (Present Action Choices).

---

## Step 3: Present Action Choices

### If No Actionable Issues

When `data.actionableIssues` is empty, display:
```
✅ All PRs are healthy! No issues need attention.
```

Then use AskUserQuestion with:
- "Search for new issues" (if `hasCapacity`)
- "View PR status details"
- "Done for now"

### Display All PRs First (Information Before Prompt)

**Before asking the user anything**, display all actionable issues as formatted text:

```
📋 {count} PRs Need Attention:

1. {issue.label} {issue.pr.repo}#{issue.pr.number}
   {issue.pr.title} ({daysSinceActivity}d inactive)

2. {issue.label} {issue.pr.repo}#{issue.pr.number}
   {issue.pr.title} ({daysSinceActivity}d inactive)

... (list ALL actionable issues, no limit)

───────────────────────────────────────────────────
```

Calculate `daysSinceActivity` from the PR's `updatedAt` field.

Example output:
```
📋 5 PRs Need Attention:

1. [CI Failing] shadcn-ui/ui#9263
   fix(docs): use yarn dlx for npx command (23d inactive)

2. [CI Failing] shadcn-ui/ui#9262
   fix(cli): use 'bun x' instead of 'bunx' (23d inactive)

3. [Merge Conflict] vadimdemedes/ink#861
   Fix emoji box border alignment issue (5d inactive)

4. [Merge Conflict] cline/cline#8362
   fix: update button text after deleting history item (2d inactive)

5. [Needs Response] vadimdemedes/ink#858
   Remove create-ink-app from README (10d inactive)

───────────────────────────────────────────────────
```

### Ask for Action (4-Option Limit)

Use AskUserQuestion with **action-focused options**, not PR-specific options.

**Options to present:**

| Option | Condition | Label | Description |
|--------|-----------|-------|-------------|
| 1 | Always (if actionable issues exist) | "Address all {count} issues in parallel (Recommended)" | "Launch agents simultaneously to fix CI, conflicts, and respond" |
| 2 | If `capacity.hasCapacity === true` | "Search for new issues" | "Look for new contribution opportunities" |
| 2 | If `capacity.hasCapacity === false` | "View healthy PRs" | "See status of PRs not needing attention" |
| 3 | Always | "Done for now" | "End session with summary" |

**Note:** The 4th option is the automatic "Other" - user can type specific PR selections.

### Example AskUserQuestion

```
Question: "What would you like to do?"
Header: "Action"

Options:
1. Label: "Address all 5 issues in parallel (Recommended)"
   Description: "Launch agents simultaneously to fix CI, conflicts, and respond"

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
gh pr view NUMBER --repo OWNER/REPO --json state,title,updatedAt,reviews,comments,statusCheckRollup,mergeable,reviewDecision
```

### Determine PR Status

For each PR, categorize as:
- **CI Failing**: statusCheckRollup shows failures
- **Merge Conflict**: mergeable is false
- **Needs Response**: has new comments from maintainers
- **Approaching Dormant**: no activity past `approachingDormantDays`
- **Merged**: state is "MERGED"
- **Closed**: state is "CLOSED" (without merge)
- **Healthy**: everything looks good

Then format and present action choices similar to Step 3.

---

## Step 4: Action Handlers

### CRITICAL: Human-in-the-Loop for ALL Write Actions

**Agents INVESTIGATE and RECOMMEND only. They NEVER:**
- Push code changes
- Post comments or responses
- Create commits
- Modify remote repositories

**All write actions require explicit user approval via AskUserQuestion.**

### Handle "Address All Issues in Parallel"

**CRITICAL: Dispatch ALL agents in a SINGLE message for true parallelism.**

For each issue in `actionableIssues`, include a Task tool call. Agents **investigate and return recommendations**:

| Issue Type | Agent | Prompt Template |
|------------|-------|-----------------|
| CI Failing | `pr-health-checker` | "Investigate CI failures on {repo}#{number}. Analyze logs, identify root cause, and recommend fixes. DO NOT push any changes." |
| Merge Conflict | `pr-health-checker` | "Investigate merge conflict on {repo}#{number}. Identify conflicting files and recommend resolution strategy. DO NOT push any changes." |
| Needs Response | `pr-responder` | "Analyze maintainer feedback on {repo}#{number} and draft a response. DO NOT post the response - return it for user approval." |
| Approaching Dormant | `pr-health-checker` | "Assess dormant PR {repo}#{number}. Check if it's still relevant and recommend follow-up action." |

**Example: 5 PRs needing attention**

In ONE message, dispatch:
```
Task(pr-health-checker, "Investigate CI failures on shadcn-ui/ui#9263. Analyze logs, identify root cause, recommend fixes. DO NOT push changes.")
Task(pr-health-checker, "Investigate CI failures on shadcn-ui/ui#9262. Analyze logs, identify root cause, recommend fixes. DO NOT push changes.")
Task(pr-health-checker, "Investigate merge conflict on vadimdemedes/ink#861. Identify conflicts, recommend resolution. DO NOT push changes.")
Task(pr-health-checker, "Investigate merge conflict on cline/cline#8362. Identify conflicts, recommend resolution. DO NOT push changes.")
Task(pr-responder, "Analyze feedback on vadimdemedes/ink#858 and draft response. DO NOT post - return for approval.")
```

All 5 agents run simultaneously. Wait for all to complete.

### Present Investigation Results

After all agents complete, present a summary:

```
## Investigation Results

### 1. shadcn-ui/ui#9263 - CI Failing
**Root cause:** ESLint error on line 42 - unused import
**Recommended fix:** Remove unused import of `useState`
**Action needed:** Push 1-line fix

### 2. vadimdemedes/ink#861 - Merge Conflict
**Conflicts:** src/components/Box.tsx (3 conflicts)
**Recommended resolution:** Accept incoming changes, manually merge line 156
**Action needed:** Resolve conflicts and push

### 3. vadimdemedes/ink#858 - Needs Response
**Maintainer asked:** "Can you add a test for this?"
**Draft response:** "Good point! I've added a test case for..."
**Action needed:** Post response (and optionally add test)

───────────────────────────────────────────────────
```

### Ask User to Approve Actions

Use AskUserQuestion:

```
Question: "Which actions would you like me to take?"
Header: "Approve"
multiSelect: true

Options:
1. "Push fix for #9263 (remove unused import)"
2. "Resolve conflicts on #861"
3. "Post response to #858"
4. "All of the above"
5. "None - I'll handle manually"
```

### Execute Approved Actions Only

Only after user explicitly approves:
- Push code changes
- Post comments
- Mark PRs as read

```bash
# Only run after user approval
cd ~/.oss-autopilot/cli && npm run --silent start -- read <pr-url> --json
```

### CRITICAL: Continue the Flow

**After EVERY action completes (investigation, approval, execution), ALWAYS ask what to do next.**

Never end with just a summary. Always prompt:

```
✅ Actions completed:
- Pushed fix for #9263
- Posted response to #858

What would you like to do next?
```

Then use AskUserQuestion:
- "Search for new issues" (if `hasCapacity`)
- "Check for more PR updates" (re-run daily check)
- "Done for now"

**The session only ends when the user explicitly selects "Done for now".**

### Handle Specific PR Selection (from "Other" input)

When user selects specific PRs (e.g., "1 and 3"), dispatch only those agents in parallel.
Follow the same investigation-first approach: agents analyze and recommend, then present results for user approval.

### Handle "View Healthy PRs"

Show when `capacity.hasCapacity === false` (user has critical issues to address first).

Display healthy PRs from `data.digest.healthy`:
```
✅ Healthy PRs (no action needed):

- owner/repo#123 - Title here (approved, CI passing)
- owner/repo#456 - Title here (waiting for review)
...

These PRs are progressing normally. Focus on the {count} issues that need attention.
```

Then return to Step 3 to present action choices again.

### Handle "Find New Issues"

Only available if `capacity.hasCapacity === true`.

Use the CLI:
```bash
cd ~/.oss-autopilot/cli && GITHUB_TOKEN=$(gh auth token) npm run --silent start -- search 10 --json
```

Or dispatch the `issue-scout` agent with language/label preferences.

If user requests this but `hasCapacity === false`:
> "You currently have [N] critical issues that need attention. Would you like to address those first, or override and search anyway?"

### After Each Action

1. Re-run the daily check to refresh state
2. Return to Step 3 with updated action choices
3. Continue until user selects "Done for now"

---

## Step 5: Session End

When user selects "Done for now":

```markdown
## Session Complete

Today's session:
- Checked X PRs
- Capacity: [hasCapacity ? "Ready for new work" : "X critical issues remaining"]
- [List any actions taken: "Posted response to repo#123", "Investigated CI on repo#456"]

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

## CLI Commands Reference

All commands support `--json` flag for structured output:

```bash
# Daily check (syncs and checks all PRs)
GITHUB_TOKEN=$(gh auth token) npm run --silent start -- daily --json

# Status overview
npm run --silent start -- status --json

# Search for issues
npm run --silent start -- search 10 --json

# Track a PR
npm run --silent start -- track <pr-url> --json

# View comments
npm run --silent start -- comments <pr-url> --json

# Post comment
npm run --silent start -- post <url> "message" --json
```

---

## Agent Integration

| Agent | Purpose |
|-------|---------|
| `pr-responder` | Draft responses to maintainer feedback |
| `pr-health-checker` | Diagnose CI failures, merge conflicts |
| `pr-compliance-checker` | Validate PRs against opensource.guide |
| `issue-scout` | Find and vet new issues |
| `repo-evaluator` | Analyze repository health |
| `contribution-strategist` | Strategic OSS advice |

---

## Important Rules

### Human-in-the-Loop (CRITICAL)
1. **NEVER push code without explicit user approval**
2. **NEVER post comments without explicit user approval**
3. **NEVER modify remote repositories without explicit user approval**
4. **Agents INVESTIGATE and RECOMMEND only** - present findings, let user approve actions
5. Always use AskUserQuestion with multiSelect before executing write actions

### Workflow Control (CRITICAL)
6. **NEVER end without asking what's next** - after ANY action, always prompt user
7. **Drive the conversation** - Claude controls the flow, user responds to prompts
8. **Session ends ONLY when user selects "Done for now"** - never assume user is finished
9. **ALWAYS include "Done for now"** in every AskUserQuestion

### UX Guidelines
10. Keep responses professional and concise
11. **NEVER add AI attribution** to commits, comments, or PRs
12. **Display information before prompting** - show all PRs as text FIRST, then ask for action
13. **Parse "Other" input flexibly** - accept PR numbers, URLs, repo refs like "ink#861"

### Parallel Execution
12. Use parallel agents when investigating multiple PRs
13. **Parallel execution** - when addressing multiple PRs, launch ALL agents in a SINGLE message
14. After parallel investigation, present consolidated results and ask for approval
