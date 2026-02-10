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
# Rebuild if bundle missing OR package.json is newer (post-upgrade)
if [ ! -f "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" ] || [ "${CLAUDE_PLUGIN_ROOT}/package.json" -nt "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" ]; then
  BUILD_LOG=$(cd "${CLAUDE_PLUGIN_ROOT}" && npm install --silent 2>&1 && npm run bundle --silent 2>&1)
  BUILD_EXIT=$?
  if [ $BUILD_EXIT -ne 0 ]; then
    echo "Warning: CLI build failed (exit code $BUILD_EXIT). You may need to run manually:" >&2
    echo "  cd ${CLAUDE_PLUGIN_ROOT} && npm install && npm run bundle" >&2
    echo "$BUILD_LOG" | tail -5 >&2
  fi
fi
```

If the build fails, tell the user what happened and how to fix it. Then fall back to the gh CLI workflow (Step 1b).

## Step 0.6: Check Setup Completeness

Before running the daily check, verify setup is complete:

```bash
GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" checkSetup --json
```

If the JSON response's `data.setupComplete` field is false, tell the user:

> "It looks like setup isn't complete yet. Run `/setup-oss` to configure your preferences, or I can continue with defaults."

Use AskUserQuestion to let the user choose:
- "Run setup first (Recommended)" — launch `/setup-oss`
- "Continue with defaults" — proceed with the daily check

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
    "actionMenu": {
      "items": [
        { "key": "address_all", "label": "Address all 3 issues in parallel (Recommended)", "description": "Launch agents simultaneously..." },
        { "key": "search", "label": "Search for new issues", "description": "Look for new contribution opportunities" },
        { "key": "done", "label": "Done for now", "description": "End session with summary" }
      ],
      "context": { "hasActionableIssues": true, "actionableCount": 3, "hasCapacity": true }
    },
    "capacity": { "hasCapacity": true, ... },
    "digest": { ... },
    "updates": [...]
  }
}
```

**Display the `briefSummary` field with the plugin version appended:**

Get the current version:
```bash
node -e "console.log(require('${CLAUDE_PLUGIN_ROOT}/package.json').version)" 2>/dev/null
```

Then display:
```
data.briefSummary + " | v{version}"
```

Example output:
> 16 Active PRs | 3 need attention | Dashboard opened in browser | v0.6.1

Then proceed to Step 3 (Present Action Choices).

---

## Step 3: Present Action Choices

The CLI pre-computes the action menu in `data.actionMenu`. Use these items directly in AskUserQuestion instead of manually deriving options.

**Fallback:** If `data.actionMenu` is missing (e.g., older CLI version), tell the user: "Action menu not found in CLI output — you may need to rebuild the CLI: `cd ${CLAUDE_PLUGIN_ROOT} && npm run bundle`". Then derive options manually: always include "Done for now"; add "Address all N issues in parallel (Recommended)" if `data.actionableIssues.length > 0`; add "Search for new issues" if `data.capacity.hasCapacity`; add "View healthy PRs" if not `data.capacity.hasCapacity` and `data.actionableIssues.length > 0`; otherwise add "View PR status details".

### If No Actionable Issues

When `data.actionMenu` is present and `data.actionMenu.context.hasActionableIssues` is `false` (or when `data.actionMenu` is absent and `data.actionableIssues` is empty), display:
```
All PRs are healthy! No issues need attention.
```

If `hasIssueList && availableCount === 0`:
```
Your curated issue list is depleted ({completedCount} done). Time to find new issues!
```

### Display All PRs First (Information Before Prompt)

When there are actionable issues, display them **before asking the user anything**:

```
{count} PRs Need Attention:

1. {issue.label} {issue.pr.repo}#{issue.pr.number}
   {issue.pr.title} ({issue.pr.daysSinceActivity}d inactive)

2. {issue.label} {issue.pr.repo}#{issue.pr.number}
   {issue.pr.title} ({issue.pr.daysSinceActivity}d inactive)

... (list ALL actionable issues, no limit)

---
```

Use `issue.pr.daysSinceActivity` from the CLI output (already computed).

### Ask for Action (Using Pre-Computed Menu)

Use `data.actionMenu.items` directly as AskUserQuestion options. Each item has `key`, `label`, and `description` fields ready for display.

**Issue list integration:** If the user has a curated issue list (detected in Step 0.7), insert an issue-list option **after `address_all`** (index 1) or **at the start** (index 0) when no actionable issues exist — i.e., always before the `search`/`view_details`/`view_healthy` item:

| Condition | Insert Item |
|-----------|-------------|
| `hasIssueList && availableCount > 0 && context.hasCapacity` | Key: `pick_from_list`, Label: `"Pick from your issue list ({availableCount} available)"`, Description: `"Choose from your curated list of vetted issues"` |
| `hasIssueList && availableCount === 0 && context.hasCapacity` | Key: `replenish_list`, Label: `"Replenish your issue list"`, Description: `"All {completedCount} issues done — search for fresh ones"`. Also **remove** the `search` item (replenish replaces it). |

When inserting issue-list items, keep within the 4-option limit (the 5th is the auto "Other").

**"Replenish your issue list"** routes to **Handle "Find New Issues"** (same as search), but agents should be told to suggest issues suitable for adding to the curated list.

### Example AskUserQuestion

```
Question: "What would you like to do?"
Header: "Action"

Options (from data.actionMenu.items):
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
- **Changes Addressed**: maintainer commented but contributor pushed newer commits (awaiting re-review)
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

**After Tier 2 code changes are complete, ALWAYS proceed to Step 5.5 (Pre-Commit Code Review) before committing or pushing.** Step 5.5 routes differently based on whether this is a new contribution (`isNewContribution`) or an update to an existing PR — see Step 5.5 for details.

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
| Changes Addressed | Info | Note that changes were pushed after maintainer review — no contributor action needed, awaiting re-review. |
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

### Auto-Exclude Prompt for Rejected PRs

When the daily digest includes `[Recently Closed]` entries (PRs closed without merge), offer to exclude those repos from future searches:

For each recently closed PR where the repo is NOT already excluded and the user has no merged PRs in that repo:

```
Your PR in {repo} was closed without merge. Exclude this repo from future issue searches?
```

Use AskUserQuestion with multiSelect:
- "{repo} — exclude from searches" (for each qualifying repo)
- "Keep all repos" — "Don't exclude any"

If the user selects repos to exclude, update config:
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" config --exclude-repo {repo} --json
```

Or update the config file directly to add repos to `excludeRepos`.

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

#### Pre-Commit Gate (MANDATORY)

**STOP. Before presenting commit/push options to the user, you MUST complete Step 5.5 (Pre-Commit Code Review).** Do not skip this step. Do not offer to commit first. Run the review agents, present findings, THEN offer commit options. The only exception is if `git status --porcelain` confirms there are no uncommitted changes (e.g., only a comment was posted, or the action was investigation-only). Always verify with git status — do not assume based on which actions were dispatched.

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

**When the user claims any issue found through search and starts implementing**, set:
- `isNewContribution = true`
- `issueContext = { title, url, description }` — for scope-aware review in Step 5.6

This activates the same draft-first workflow as the curated list path (see "Handle Pick Issue From List" section 6 for the full sequence: Steps 5.5 through 6).

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

#### 6. After claiming → implementation → draft PR → review → ready → Step 6.5

When the user claims an issue and starts implementing, set:
- `isNewContribution = true`
- `issueContext = { title, url, description }` — the issue being addressed (used for scope-aware review in Step 5.6)

After implementation, the flow proceeds through the **draft-first workflow**:
1. Step 5.5 detects `isNewContribution` → commits, pushes, creates draft PR
2. Step 5.6 runs iterative review cycle (scope-aware, tied to `issueContext`)
3. Step 5.6b checks new files are properly integrated (imports, registrations)
4. Step 5.7b offers manual testing prompt (build/run the project locally)
5. Step 5.7 squashes commits and rewords message
6. Step 5.8 marks PR ready for review after user confirmation
7. Step 6 runs compliance check
8. Step 6.5 offers list updates (if issue came from curated list)

**CRITICAL: Track that the current issue came from the curated list** so Step 6.5 knows to offer list updates.

### After Each Action

1. **If ANY Tier 1 actions were taken** (rebases, force pushes), regardless of whether Tier 2 actions also occurred:
   - Re-run the daily check to refresh state
   - Return to Step 3 with updated action choices
2. **If ONLY Tier 2 actions were taken** (comment responses, code fixes, missing file additions) with no Tier 1 actions in this round:
   - Skip the daily re-run — the existing data is still valid
   - Remove completed items from the current action list
   - Inform the user: "Skipping full refresh — showing locally updated action list. Select 'Check for more PR updates' for a fresh check."
   - Return to Step 3 with current action choices
   - **Exception:** If any completed action involved merge conflict resolution (issue type `merge_conflict` from the actionableIssues list), treat the entire batch as Tier 1 and re-run the daily check
3. If `hasIssueList`, re-read the list file to get updated available/completed counts
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

## Step 5.5: Pre-Commit Code Review

**Trigger:** After ANY Tier 2 code changes are made (code modified but not yet committed/pushed). This includes CI fixes, conflict resolution, addressing review feedback, adding missing files, or any other code modification.

This is a quality gate that catches issues before they reach the maintainer.

### 0. Routing: New Contribution vs Existing PR Update

**Check `isNewContribution`** (set in Step 4 when the user claims an issue and starts implementing).

- **If `isNewContribution === true`:** Follow the **Draft-First Path** (sub-steps 0a–0d below), then route to Step 5.6 for iterative review.
- **If `isNewContribution === false` (or not set):** Follow the **Standard Path** (sub-step 1 onward) — review before committing, same as before.

#### Draft-First Path (new contributions only)

##### 0a. Pre-flight: Verify Changes Exist

```bash
git status --porcelain
```

**If output is empty:** Report no changes and return to Step 4.

##### 0b. Stage and Commit

- Stage the specific changed files (not `git add -A`)
- If staging fails for any file, report which file(s) failed and why
- Commit following the repo's conventional commit format
- If commit fails (e.g., pre-commit hook failure, empty commit):
  - Report the specific error to the user
  - If pre-commit hook failed, show the hook output and offer to fix the issues
  - Do NOT proceed to push
- **Do NOT add AI attribution** (no Co-Authored-By, no "Generated with" mentions)

##### 0c. Push

```bash
git push -u origin HEAD
```

**If push fails**, report the error and offer to retry or cancel.

##### 0d. Create Draft PR

```bash
gh pr create --draft --title "{conventional title}" --body "{PR body}" --repo {upstream-repo}
```

Generate the PR title and body following the target repo's conventions (check `CONTRIBUTING.md`, existing PR formats). Include:
- Reference to the issue being fixed (e.g., "Fixes #123")
- Brief description of the approach

**If `gh pr create --draft` succeeds**, store in session context:
- `draftPRNumber` — the PR number returned
- `draftPRUrl` — the PR URL returned
- `baseBranch` — the base branch name (from the PR creation output or `gh repo view --json defaultBranchRef`)

> "Draft PR created: {draftPRUrl}. It's marked as a draft — maintainers can see it but won't be asked to review yet. Starting review cycle..."

**CRITICAL: Do NOT call `gh pr ready` or skip to Step 5.8. You MUST complete Step 5.6 (review cycle), Step 5.6b (integration check), Step 5.7b (manual testing), and Step 5.7 (squash) first. The draft-first workflow exists to catch issues before maintainers see the PR.**

**→ Proceed to Step 5.6 (Draft PR Review Cycle)**

**If `gh pr create --draft` fails:**
- Report the specific error (include stderr output)
- Offer options:
  1. "Retry" — re-run the command
  2. "Create as regular PR instead" — fall back to `gh pr create` without `--draft`. Only offer this if the error indicates draft PRs are not supported (e.g., GitHub Enterprise). For auth/network errors, this option won't help.
  3. "Done for now" — leave changes pushed, create PR manually later

**If non-draft fallback succeeds:**
- Store `draftPRNumber` and `draftPRUrl` from the created PR
- Warn: "Note: This PR is immediately visible to maintainers. The review cycle will still run, but maintainers may see the PR before review is complete."
- Proceed to Step 5.6 (review cycle still runs). Step 5.8 (Mark Ready) will be skipped since the PR is already public.

- **Do NOT proceed to Step 5.6 without a valid `draftPRNumber` and `draftPRUrl`**

---

### Standard Path (existing PR updates)

**This path is triggered automatically by the Pre-Commit Gate in Step 4 whenever Tier 2 code changes have been made to an existing PR.** You should already be here before any commit/push options are presented.

#### 1. Pre-flight: Verify Changes Exist

```bash
git status --porcelain
```

**If output is empty:** There are no pending changes to review. Report:
> "No uncommitted changes detected. Changes may have already been committed, or you may be on the wrong branch."

Then skip the rest of Step 5.5 and return to Step 4's action handler loop.

#### 2. Gather Change Context

```bash
git diff
git diff --cached
git status --porcelain
```

Save the `git diff` output — it will be passed to each review agent in sub-step 3.

Identify changed files and their types (TypeScript, Python, etc.). Count files changed.

Read the target repo's conventions if not already loaded:
- `CONTRIBUTING.md`
- Lint/format configs (`.eslintrc*`, `.prettierrc*`, `biome.json`, etc.)
- Test directory structure (`test/`, `tests/`, `__tests__/`, `spec/`)

#### 3. Dispatch Review Agents in Parallel

**CRITICAL: Dispatch ALL agents in a SINGLE message for true parallelism.**

Capture the `git diff` output and pass it as context to each agent.

**Always dispatch these 4 agents (include the full `git diff` output in each prompt):**

**IMPORTANT: Always include `Working directory: {local repo path}` in every agent prompt so agents can find and read files in the correct location. Without this, agents inherit the parent session's working directory and file lookups will fail.**

```
Task(pr-review-toolkit:code-reviewer,
  "Review the following code changes for bugs, logic errors, security vulnerabilities,
   and adherence to project conventions.
   Repository: {repo name}
   Working directory: {local repo path}
   Convention notes: {any CONTRIBUTING.md or lint config findings}
   Changed files: {changed files list}

   Diff:
   {git diff output}")

Task(pr-review-toolkit:silent-failure-hunter,
  "Review the following code changes for silent failures, inadequate error handling,
   and inappropriate fallback behavior.
   Working directory: {local repo path}
   Changed files: {changed files list}

   Diff:
   {git diff output}")

Task(pr-review-toolkit:code-simplifier,
  "Review the following code changes for dead code, unnecessary complexity, and
   simplification opportunities. Do NOT modify files — report findings only.
   Working directory: {local repo path}
   Changed files: {changed files list}

   Diff:
   {git diff output}")

Task(pr-review-toolkit:pr-test-analyzer,
  "Analyze test coverage for the following code changes. Check if modified code paths
   have tests, identify gaps, and recommend what tests should be added.
   Working directory: {local repo path}
   Test directory: {test dir path}
   Changed files: {changed files list}

   Diff:
   {git diff output}")
```

**Conditional agents (dispatch in the SAME message if applicable):**

- **`pr-review-toolkit:type-design-analyzer`** — dispatch only if changed files include TypeScript (`.ts`, `.tsx`) or other typed languages
  ```
  Task(pr-review-toolkit:type-design-analyzer,
    "Review type design in the following TypeScript changes. Check for proper
     encapsulation, invariant expression, and type safety.
     Working directory: {local repo path}
     Changed files: {changed .ts/.tsx files}

     Diff:
     {git diff output for .ts/.tsx files}")
  ```

- **`pr-review-toolkit:comment-analyzer`** — dispatch only if 5+ files were changed (smaller changes rarely warrant dedicated comment review)
  ```
  Task(pr-review-toolkit:comment-analyzer,
    "Review comments in the following code changes for accuracy, completeness,
     and long-term maintainability.
     Working directory: {local repo path}
     Changed files: {changed files list}

     Diff:
     {git diff output}")
  ```

**Fallback:** If the PR review toolkit agents are unavailable (Task tool returns an error for those agent types), inform the user and dispatch the local `pre-commit-reviewer` agent instead:

> "PR review toolkit agents are not available. Falling back to the built-in pre-commit reviewer. This provides a general code review but does not include specialized checks for silent failures, type design, or test coverage."

```
Task(pre-commit-reviewer,
  "Review my pending code changes before committing.
   Repository: {repo name}
   Working directory: {path}")
```

**Partial failure:** If some toolkit agents succeed and others fail, consolidate the successful results and note which reviews were skipped:
> "Note: The following specialized reviews could not be completed: {list}."

#### 4. Consolidate Findings

After all agents complete, merge their outputs into a unified report. Deduplicate findings that multiple agents flagged.

**If any agent did not complete or returned an error**, note it in the report:
> "Warning: {agent-name} did not complete. Its findings are not included."

```
## Pre-Commit Review Summary

### Critical ({count}) — Must fix before pushing
- **{file}:{line}** — {description} (found by: {agent})
  Suggestion: {fix}

### Recommended ({count}) — Should fix
- **{file}:{line}** — {description} (found by: {agent})
  Suggestion: {fix}

### Minor ({count}) — Nice to have
- **{file}:{line}** — {description}

### Test Coverage
- {assessment from pr-test-analyzer}

### Convention Alignment
- {any style/convention mismatches}
```

If NO issues found across all agents:
```
## Pre-Commit Review Summary

All agents passed. No issues found — changes are clean and ready to commit.
```

#### 5. User Decision Point

Use AskUserQuestion based on findings:

**If Critical or Recommended issues exist:**
```
Question: "How would you like to proceed?"
Header: "Review"

Options:
1. "Address findings" — "Fix issues, then re-review"
2. "Show full diff" — "Display complete diff for manual review"
3. "Commit and push anyway" — "Skip fixes and push current changes"
```

**If only Minor issues or no issues:**
```
Question: "Changes look clean. Ready to commit?"
Header: "Review"

Options:
1. "Show full diff first" — "Review the complete diff before committing"
2. "Commit and push (Recommended)" — "Stage, commit, and push changes"
3. "Done for now" — "Cancel, return to main flow"
```

#### 6. Handle User Choice

**"Address findings":**
- User makes fixes (with assistance as needed)
- After fixes, loop back to "Gather Change Context" (sub-step 2 of Step 5.5) to re-gather changes and re-dispatch agents
- Continue until user is satisfied or selects a different option

**"Show full diff" / "Show full diff first":**
- Display the full `git diff` output
- Then ask:
  ```
  Question: "Diff reviewed. Ready to proceed?"
  Header: "Diff"

  Options:
  1. "Commit and push (Recommended)" — "Stage and push these changes"
  2. "Fix something first" — "Make additional changes before committing"
  3. "Done for now" — "Cancel"
  ```

**"Commit and push anyway" / "Commit and push (Recommended)":**
- Stage the specific changed files (not `git add -A`)
- Commit following the repo's conventional commit format
- **Do NOT add AI attribution** (no Co-Authored-By, no "Generated with" mentions)
- Push to the PR branch
- **If any git operation fails** (staging, commit, or push), report the specific error to the user and offer to retry or cancel
- **Only proceed to Step 6 after confirming the push succeeded**

**"Done for now":**
- Return to Step 4's action handler loop without committing

---

## Step 5.6: Draft PR Review Cycle

**Trigger:** After a draft PR is created in Step 5.5 (Draft-First Path). Only runs for new contributions (`isNewContribution === true`).

This step runs iterative, scope-aware code review against the draft PR before it becomes visible to maintainers.

Initialize `roundNumber = 1` at the start of the review cycle.

### 1. Gather Change Context

Determine the base branch dynamically (do NOT hardcode `main`):

1. Try: `gh pr view --json baseRefName --jq '.baseRefName'` — most reliable, uses actual PR target
2. Fallback: `git remote show origin | grep 'HEAD branch' | awk '{print $NF}'` — uses repo default
3. Last resort: `echo "main"` — warn user: "Could not detect base branch automatically. Defaulting to 'main'. Please confirm this is correct."

If method 2 or 3 is used, ask the user to confirm the base branch before proceeding with diffs.

```bash
baseBranch=$(gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null || git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}' || echo "main")
git fetch origin "$baseBranch"
git diff "origin/$baseBranch"..HEAD
git log --oneline "origin/$baseBranch"..HEAD
```

Store `baseBranch` in session context — it is reused in Step 5.7.

Save the full diff — it covers ALL changes on this branch (not just the last commit).

Identify changed files and their types. Count files changed.

Read the target repo's conventions if not already loaded:
- `CONTRIBUTING.md`
- Lint/format configs (`.eslintrc*`, `.prettierrc*`, `biome.json`, etc.)
- Test directory structure (`test/`, `tests/`, `__tests__/`, `spec/`)

### 2. Dispatch Scope-Aware Review Agents in Parallel

**CRITICAL: Dispatch ALL agents in a SINGLE message for true parallelism.**

Use the same agent dispatch pattern as Step 5.5 sub-step 3 (same agents, same conditional rules, same fallback logic), including the `Working directory: {local repo path}` line in every prompt. Additionally, **prepend the following SCOPE block** to each agent prompt. The SCOPE block constrains findings to the PR's purpose and prevents scope creep from pre-existing issues:

```
SCOPE: This PR addresses issue '{issueContext.title}' ({issueContext.url}).
Focus findings on changes related to this issue. Flag pre-existing issues only
if they are Critical severity. Do NOT suggest improvements outside the scope of this PR.
```

Each agent should tailor the scope instruction to its specialty:
- **code-reviewer**: "Focus findings on changes related to this issue."
- **silent-failure-hunter**: "Focus only on error handling in the changed code paths. Do NOT flag pre-existing error handling patterns unless they are Critical."
- **code-simplifier**: "Only suggest simplifications for code introduced or modified by this PR. Do NOT suggest refactoring pre-existing code."
- **pr-test-analyzer**: "Focus test recommendations on the new/changed functionality only."

**Additional differences from Step 5.5:**
- Use `git diff origin/$baseBranch..HEAD` (full branch diff) instead of `git diff` (working tree diff)
- Conditional agents and fallback follow the same rules as Step 5.5 sub-step 3, with the SCOPE block added to each prompt

**If ALL agents fail (including fallback):**
> "Review agents are currently unavailable. You can proceed without automated review, but we recommend manual review before marking ready."
- Offer: "Proceed to integration check (skip review)" / "Retry review" / "Done for now"
- **"Proceed to integration check":** → Proceed to Step 5.6b (Integration Check). Even without agent review, the integration check and manual testing steps are still valuable.

### 3. Consolidate Findings

Same consolidation logic as Step 5.5 sub-step 4, but add a scope tag to each finding:

```
## Draft PR Review — Round {roundNumber}

### In-Scope Findings

#### Critical ({count}) — Must fix before marking ready
- **{file}:{line}** — {description} (found by: {agent})
  Suggestion: {fix}

#### Recommended ({count}) — Should fix
- **{file}:{line}** — {description} (found by: {agent})
  Suggestion: {fix}

#### Minor ({count}) — Nice to have
- **{file}:{line}** — {description}

### Out-of-Scope Findings ({count})
These findings relate to pre-existing code, not changes for this issue:
- **{file}:{line}** — {description} (severity: {level})

### Test Coverage
- {assessment from pr-test-analyzer}
```

If NO in-scope issues found:
```
## Draft PR Review — Round {roundNumber}

All review agents passed. No in-scope issues found — PR is clean and ready to finalize.
```

### 4. User Decision Point

Use AskUserQuestion based on findings:

**If in-scope Critical or Recommended issues exist:**
```
Question: "Review found {count} in-scope findings. How would you like to proceed?"
Header: "Review"

Options:
1. "Address in-scope findings" — "Fix issues related to this PR's purpose"
2. "Show full diff" — "Display the complete branch diff"
3. "Finalize anyway" — "Skip remaining fixes, run integration check and testing"
4. "Done for now" — "Leave as draft, come back later"
```

**If only Minor issues or no in-scope issues:**
```
Question: "PR looks clean. Ready to finalize?"
Header: "Review"

Options:
1. "Finalize (Recommended)" — "Run integration check, optional testing, then squash"
2. "Show full diff first" — "Review the complete branch diff"
3. "Done for now" — "Leave as draft, come back later"
```

### 5. Handle User Choice

**"Address in-scope findings":**
- User makes fixes (with assistance as needed)
- Stage and commit the fixes (additional commits on the branch)
- Push to update the draft PR:
  ```bash
  git push
  ```
- **If push fails**, report the error and offer to retry or continue reviewing locally (do NOT increment `roundNumber` if push failed — the remote is out of sync)
- **If push succeeds**, increment `roundNumber`
- Loop back to sub-step 1 (Gather Change Context) to re-review

**Soft limit:** After **3 review rounds**, present a different prompt:
```
Question: "You've completed {roundNumber} review rounds. Remaining findings may be diminishing returns. Ready to finalize?"
Header: "Review"

Options:
1. "Finalize now (Recommended)" — "Run integration check, optional testing, then squash"
2. "One more round" — "Address remaining findings, then re-review"
3. "Done for now" — "Leave as draft, come back later"
```

**"Show full diff" / "Show full diff first":**
- Display the full `git diff origin/$baseBranch..HEAD` output
- Then ask:
  ```
  Question: "Diff reviewed. Ready to proceed?"
  Header: "Diff"

  Options:
  1. "Finalize (Recommended)"
  2. "Fix something first" — "Make additional changes"
  3. "Done for now"
  ```

**"Finalize" / "Finalize anyway" / "Finalize now":**
- **→ Proceed to Step 5.6b (Integration Check)**

**"Done for now":**
- Report: "Draft PR #{draftPRNumber} is saved. Run `/oss` later to continue."
- Return to Step 4's action handler loop

---

## Step 5.6b: Integration Check for New Files

**Trigger:** After the user finalizes the review cycle in Step 5.6 (or it is skipped). Only runs for new contributions (`isNewContribution === true`).

Review agents only see the diff contents — they cannot detect whether new files are actually wired into the codebase (imported, registered, referenced). This step catches "dead code" PRs where a new file was created but never integrated.

### 1. Identify New Files

```bash
git diff --name-only --diff-filter=A "origin/$baseBranch"..HEAD
```

**If `git diff` fails** (non-zero exit code, e.g., `$baseBranch` is unset or `origin/$baseBranch` does not exist): Report the error and offer "Retry after fetching" (`git fetch origin "$baseBranch"` then retry) / "Skip integration check" (→ proceed to Step 5.7b) / "Done for now". Do NOT silently skip to Step 5.7b on command failure.

**If no new files were added** (command succeeds with empty output): Skip this step entirely. **→ Proceed to Step 5.7b (Manual Testing Prompt)**

### 2. Check References for Each New File

For each new file, check whether it is imported or referenced by any existing file:

```bash
# Extract the filename stem (without extension) for searching
filename=$(basename "{new_file}" | sed 's/\.[^.]*$//')
# Search for references in the source tree (excluding the file itself)
grep -r "$filename" {source_directory}/ --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.go" -l | grep -v "{new_file}"
```

Adjust the file extensions and source directory based on the target repo's language.

### 3. Flag Unreferenced Files

If a new file has zero references from other files, flag it:

```
Warning: {new_file} was created but is not imported or referenced by any other file.
It may need to be registered in an entry point or manifest.
```

**If unreferenced files are found**, present a prompt:

```
Question: "{count} new file(s) appear to have no imports or registrations. This could mean they won't be included in the build."
Header: "Integration"

Options:
1. "Investigate and fix" — "Check entry points and add missing imports"
2. "Skip — files are referenced differently" — "E.g., dynamically loaded, auto-discovered, or config-based"
3. "Done for now" — "Leave as draft, come back later"
```

**"Investigate and fix":**
- Identify likely entry points (e.g., index files, manifests, feature registries)
- If no likely entry point can be identified, inform the user and offer to skip or manually specify the entry point
- Add the missing import/registration
- Stage, commit, and push the fix
- **If any git operation fails** (stage, commit, or push), report the specific error and offer: "Retry" / "Skip integration fix and proceed" / "Done for now". Do NOT proceed to Step 5.7b unless the push succeeds or the user explicitly skips
- **→ Proceed to Step 5.7b (Manual Testing Prompt)**

**"Skip — files are referenced differently":**
- **→ Proceed to Step 5.7b (Manual Testing Prompt)**

**"Done for now":**
- Report: "Draft PR #{draftPRNumber} remains as a draft. Run `/oss` later to continue."
- Return to Step 4's action handler loop

**If all new files are properly referenced:** No prompt needed. **→ Proceed to Step 5.7b (Manual Testing Prompt)**

---

## Step 5.7b: Manual Testing Prompt

**Trigger:** After Step 5.6b (Integration Check) completes or is skipped. Only runs for new contributions (`isNewContribution === true`).

Automated review catches code patterns, but cannot verify runtime behavior (UI rendering, keyboard shortcuts, browser behavior, CLI output, etc.). This step gives the user a chance to manually verify the feature works before finalizing.

### 1. Prompt for Manual Testing

```
Question: "Would you like to manually test the changes before finalizing?"
Header: "Testing"

Options:
1. "Yes — help me set up testing" — "Walk through building/running the project to test locally"
2. "Skip — proceed to squash (Recommended for trivial changes)" — "Go directly to squash and finalize"
3. "Done for now" — "Leave as draft, come back later"
```

### 2. Handle User Choice

**"Yes — help me set up testing":**
1. Check for build/test instructions in the repo:
   - `CONTRIBUTING.md` — look for "Development", "Testing", "Building" sections
   - `README.md` — look for "Getting Started", "Development" sections
   - `package.json` scripts — `build`, `dev`, `start`, `test`
   - `Makefile`, `justfile`, `taskfile.yml` — common build targets
2. Walk the user through building/running the project based on what's found
3. For browser extensions: help with loading the unpacked extension
4. For CLI tools: help with running the tool locally
5. For web apps: help with starting the dev server
6. After the user has tested, re-prompt:
   ```
   Question: "How did testing go?"
   Header: "Testing"

   Options:
   1. "Tests passed — proceed to squash (Recommended)" — "Everything works as expected"
   2. "Found issues — go back to fix" — "Make additional changes before finalizing"
   3. "Done for now" — "Leave as draft, come back later"
   ```

**"Found issues — go back to fix":**
- User makes fixes (with assistance as needed)
- Stage, commit, and push the fixes
- **If any git operation fails** (stage, commit, or push), report the specific error and offer: "Retry" / "Skip push and review locally" / "Done for now". Do NOT loop back to Step 5.6 unless the push succeeds or the user explicitly chooses to review locally
- Loop back to Step 5.6 sub-step 1 (re-review with agents)

**"Tests passed — proceed to squash" / "Skip — proceed to squash":**
- **→ Proceed to Step 5.7 (Squash + Reword)**

**"Done for now":**
- Report: "Draft PR #{draftPRNumber} remains as a draft. Run `/oss` later to continue."
- Return to Step 4's action handler loop

---

## Step 5.7: Squash + Reword

**Trigger:** After Step 5.7b (Manual Testing Prompt) completes or is skipped. Only runs for new contributions.

This step produces a clean, single-commit PR with an accurate commit message.

### 1. Count Commits on Branch

```bash
git rev-list --count "origin/$baseBranch"..HEAD
```

**If only 1 commit:** Skip squash — nothing to squash. Proceed to Step 5.8.

**If multiple commits:** Continue to sub-step 2.

### 2. Check Squash Configuration

Read the squash setting for this repo from `.claude/oss-autopilot/config.md` frontmatter:

```yaml
# Global default
squashByDefault: true

# Per-repo overrides
repoOverrides:
  some-org/some-repo:
    squash: false
```

**Resolution order:**
1. Check `repoOverrides.{owner/repo}.squash` — if set, use it
2. Fall back to `squashByDefault` (defaults to `true` if not set)

**If squash setting is `false`:** Skip to Step 5.8.

**If squash setting is `"ask"` (user selected "Ask me each time" during setup):**
Ask the user:
```
Question: "This branch has {N} commits. Squash into a single commit?"
Header: "Squash"
Options:
1. "Yes, squash (Recommended)" — "Clean single-commit PR"
2. "No, keep individual commits" — "Proceed without squashing"
```
Route based on answer. If "No", skip to Step 5.8.

**If squash setting is `true` (or unset):** Continue with squash.

### 3. Generate Reworded Commit Message (before squashing)

Generate a commit message that reflects ALL work done across the review cycle:
- Initial implementation
- Test additions
- Review fixes
- Any other changes

Follow the target repo's conventional commit format. Include:
- Issue reference (e.g., `Fixes #123`)
- Concise description of what was implemented and why

**Present the reworded message to the user for approval BEFORE performing the squash:**

```
Question: "This branch has {N} commits. Here's the proposed squashed commit message. Approve, edit, or skip?"
Header: "Squash"

Options:
1. "Approve and squash (Recommended)" — "Squash into single commit with this message"
2. "Edit message" — "Modify the commit message before squashing"
3. "Skip squash" — "Keep individual commits, proceed to mark ready"
4. "Done for now" — "Leave as draft, come back later"
```

Display the proposed message above the prompt.

### 4. Handle User Choice

**"Skip squash":**
- No destructive operations were performed — branch is unchanged
- **→ Proceed to Step 5.8**

**"Done for now":**
- No destructive operations were performed — branch is unchanged
- Report: "Draft PR #{draftPRNumber} remains as a draft. Run `/oss` later to continue."
- Return to Step 4's action handler loop

**"Approve and squash" / "Edit message":**
- If "Edit message", accept the user's edited message first (via "Other" input or follow-up)
- Continue to sub-step 5 (Perform Squash and Force Push)

### 5. Perform Squash and Force Push

**This sub-step only runs after the user has explicitly approved the squash.**

**5a. Create a safety recovery tag:**
```bash
git tag -d oss-autopilot-pre-squash 2>/dev/null   # Remove stale tag from a previous interrupted run
git tag oss-autopilot-pre-squash
```

If tag creation fails, do NOT proceed with squash. Report: "Could not create safety recovery tag. Aborting squash to protect your work." Offer: "Retry" / "Skip squash" / "Done for now".

This allows recovery via `git reset --hard oss-autopilot-pre-squash` if anything goes wrong.

**5b. Squash commits:**
```bash
git reset --soft "$(git merge-base "origin/$baseBranch" HEAD)"
git commit -m "{approved or edited message}"
```

**If `git reset --soft` or `git commit` fails:**
- Recover: `git reset --hard oss-autopilot-pre-squash`
- Report the error and offer to retry or skip squash
- Clean up tag: `git tag -d oss-autopilot-pre-squash`

**5c. Force push (with stale-ref handling):**

When a session has pushed multiple times, `--force-with-lease` can fail because the local tracking ref is stale relative to the remote. Always fetch the branch first to update the remote-tracking ref:

```bash
branch=$(git branch --show-current)
git fetch origin "$branch:refs/remotes/origin/$branch"
git push --force-with-lease
```

**If `git fetch` fails** (network error, auth failure), report the error to the user and offer: "Retry fetch" / "Undo squash and keep individual commits" / "Done for now". Do NOT proceed with `git push` if the fetch failed.

**If `--force-with-lease` still fails with "stale info"**, retry once with an explicit lease value:

```bash
git push "--force-with-lease=$branch:$(git rev-parse "origin/$branch")" origin "$branch"
```

**If force push fails (either the initial attempt or the explicit lease retry):**
- Report the specific error to the user
- If force push is blocked by branch protection:
  > "Force push is not allowed on this branch. Restoring original commits."
  - Recover: `git reset --hard oss-autopilot-pre-squash && git push`
  - Clean up: `git tag -d oss-autopilot-pre-squash`
- For other failures, offer:
  1. "Retry force push"
  2. "Undo squash and keep individual commits" — `git reset --hard oss-autopilot-pre-squash` then `git tag -d oss-autopilot-pre-squash`
  3. "Done for now" — `git tag -d oss-autopilot-pre-squash` (clean up tag even when leaving)
- **Do NOT proceed to Step 5.8 unless the push succeeded**

**5d. Clean up recovery tag:**
```bash
git tag -d oss-autopilot-pre-squash
```

**→ Proceed to Step 5.8 after successful push**

---

## Step 5.8: Mark Ready for Review

**Trigger:** After Step 5.7 (Squash + Reword) completes or is skipped. Only runs for new contributions (`isNewContribution === true`).

**CRITICAL: This step must NOT be reached without completing Steps 5.6 (review cycle), 5.6b (integration check), 5.7b (manual testing prompt), and 5.7 (squash). If `gh pr ready` is called before these steps, the draft-first workflow has been bypassed — this is a bug.**

This is the final gate before the PR becomes visible to maintainers.

### 1. Show PR Summary

Display a summary of the draft PR:

```
## Ready to publish?

Draft PR: {draftPRUrl}
Title: {PR title}
Commits: {1 if squashed, N if not}
Files changed: {count}
Issue: {issueContext.url}

This will make the PR visible to maintainers for review.
```

### 2. User Confirmation

```
Question: "Mark this PR as ready for review?"
Header: "Publish"

Options:
1. "Mark ready for review (Recommended)" — "PR is clean and ready for maintainers"
2. "View PR in browser first" — "Open the PR page to inspect it"
3. "Keep as draft" — "Leave as draft, come back later"
```

### 3. Handle User Choice

**"Mark ready for review":**
```bash
gh pr ready {draftPRNumber} --repo {upstream-repo}
```

**If `gh pr ready` succeeds:**
> "PR #{draftPRNumber} is now ready for review: {draftPRUrl}"

Reset session state: `isNewContribution = false`, clear `issueContext`, `draftPRNumber`, `draftPRUrl`, `baseBranch`, `roundNumber`.
**→ Proceed to Step 6 (compliance check)**

**If `gh pr ready` fails:**
- Report the specific error to the user
- Offer options:
  1. "Retry" — re-run the command
  2. "Open PR in browser to mark ready manually" — `gh pr view {draftPRNumber} --repo {upstream-repo} --web`
  3. "Keep as draft for now" — leave as draft, come back later
- **Do NOT report success unless the command exits with code 0**

**"View PR in browser first":**
```bash
gh pr view {draftPRNumber} --repo {upstream-repo} --web
```

After viewing, re-prompt with the same options.

**"Keep as draft":**
- Report: "PR #{draftPRNumber} remains as a draft. Run `/oss` later to mark it ready."
- Reset session state: `isNewContribution = false`, clear `issueContext`, `draftPRNumber`, `draftPRUrl`, `baseBranch`, `roundNumber`.
- Return to Step 4's action handler loop

---

## Step 6: After Creating/Updating PRs

**IMPORTANT:** After helping create or update a PR, always offer a compliance check:

> "Would you like me to run a compliance check on this PR to ensure it meets opensource.guide best practices?"

Dispatch the `pr-compliance-checker` agent with the PR URL.

**Note:** For new contributions that went through the draft-first workflow (Steps 5.6 through 5.8, including 5.6b and 5.7b), the PR has already been reviewed iteratively, integration-checked, and squashed. The compliance check here focuses on PR description quality, licensing, and other opensource.guide standards — not code quality (which was handled in Step 5.6).

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
| `pre-commit-reviewer` | Review code changes before committing (fallback for PR review toolkit) |
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
9. **Draft-first workflow is mandatory** — after Step 5.5, complete all steps (5.6 → 5.6b → 5.7b → 5.7) in order before reaching Step 5.8. The `gh pr ready` call belongs exclusively in Step 5.8. Never skip to it directly.

### UX Guidelines
10. Keep responses professional and concise
11. **NEVER add AI attribution** to commits, comments, or PRs
12. **Display information before prompting** - show all PRs as text FIRST, then ask for action
13. **Parse "Other" input flexibly** - accept PR numbers, URLs, repo refs like "ink#861"

### Parallel Execution
14. **Group PRs by repository** - one agent per repo, not per PR, to avoid branch checkout conflicts
15. **Parallel execution** - when addressing multiple repos, launch ALL agents in a SINGLE message
16. After parallel execution, present consolidated results table
