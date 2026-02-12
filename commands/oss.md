---
name: oss
description: "Daily OSS contribution check - uses CLI with --json for structured data"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, Task, mcp__*
---

# OSS Autopilot Daily Check

This command checks your open source PRs and provides a summary of what needs attention.

## Output Style — Loading Screen Pattern

**CRITICAL: Follow this pattern exactly.**

### 1. Display Loading Message FIRST

Before running ANY tool calls, output this text immediately (the user sees it while commands run):

```
Checking your PRs across GitHub...
```

That's it. One line. No narration, no "Let me...", no step-by-step commentary. Just the loading message, then proceed to run commands.

### 2. Run ALL Setup + Daily in a Single Bash Call

After the loading message, execute Steps 0.5 through 1 in **one combined bash command** (below). Do NOT run them as separate tool calls — that creates visual noise in the UI.

### 3. Only Show Results

After the bash call completes, jump straight to displaying the brief summary (Step 2) and action menu (Step 3). Do NOT echo the raw JSON. Do NOT narrate what happened during setup.

**If something fails**, then and only then explain the error.

## Steps 0.5–1: Build, Setup Check, Daily Check, and Dashboard (Combined)

Run everything in a single bash call to minimize UI noise:

```bash
# Step 0.5: Rebuild CLI if needed
if [ ! -f "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" ] || [ "${CLAUDE_PLUGIN_ROOT}/package.json" -nt "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" ]; then
  BUILD_LOG=$(cd "${CLAUDE_PLUGIN_ROOT}" && npm install --silent 2>&1 && npm run bundle --silent 2>&1)
  BUILD_EXIT=$?
  if [ $BUILD_EXIT -ne 0 ]; then
    echo "BUILD_FAILED"
    echo "$BUILD_LOG" | tail -5
    exit 1
  fi
fi

# Step 0.6: Check setup completeness
GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN")
export GITHUB_TOKEN
SETUP_JSON=$(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" checkSetup --json 2>/dev/null)
SETUP_COMPLETE=$(echo "$SETUP_JSON" | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.data?.setupComplete||false)}catch{console.log(false)}")

if [ "$SETUP_COMPLETE" = "false" ]; then
  echo "SETUP_NEEDED"
  exit 0
fi

# Step 1: Run daily check + dashboard
DAILY_JSON=$(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" daily --json 2>/dev/null)
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" dashboard 2>/dev/null
open ~/.oss-autopilot/dashboard.html 2>/dev/null

# Output only the daily JSON (the only thing Claude needs to parse)
echo "$DAILY_JSON"
```

**Parse the output:**

- If output starts with `BUILD_FAILED`: Tell the user the CLI build failed and show the error lines. Suggest running `cd ${CLAUDE_PLUGIN_ROOT} && npm install && npm run bundle`. Then fall back to the gh CLI workflow (Step 1b).
- If output is `SETUP_NEEDED`: Tell the user: "It looks like setup isn't complete yet." Use AskUserQuestion to let them choose "Run setup first (Recommended)" (launch `/setup-oss`) or "Continue with defaults" (re-run the daily check portion only).
- If output contains valid JSON with `"success": true`: Parse it and proceed to Step 0.7 (issue list detection) then Step 2 (display results).
- If output contains JSON with `"success": false`: Show the error from `data.error`.

## Step 0.7: Detect Curated Issue List

Before displaying results, silently determine if the user has a curated issue list. Do NOT display anything during this step.

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
- `searchRoundScores`: number[] = [] — average vetting score per search round (appended in "Handle Find New Issues")
- `searchedRepos`: string[] = [] — repos surfaced in previous search rounds, auto-excluded from subsequent rounds

**Do NOT display anything yet** — this data is used in Step 3 to offer the right action choices.

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
        { "key": "address_all", "label": "Work through all 3 issues (Recommended)", "description": "Run maintenance in parallel, then address code changes one at a time" },
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

Then proceed to Step 2.5 (check for first-run) or Step 3 (Present Action Choices).

---

## Step 2.5: First-Run Welcome (Empty State)

If `data.digest.summary.totalActivePRs === 0` AND setup is complete, this is likely the user's first run or they have no open PRs. Instead of showing an empty dashboard and action menu, show a welcome message:

```
Welcome to OSS Autopilot! You don't have any open PRs right now.

Let's get started — what would you like to do?
```

Use AskUserQuestion with these options:

| Option | Description |
|--------|-------------|
| "Search for issues to contribute to (Recommended)" | "Find open source issues matching your skills and interests" |
| "Import existing PRs" | "If you have PRs that didn't show up, reimport from GitHub" |
| "Just exploring" | "Take a look around — run /oss again anytime" |

**Routing:**
- **Search for issues** → Jump to "Handle Find New Issues" (same as Step 4's search flow)
- **Import existing PRs** → Run the import command: `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" init $(gh api user --jq '.login') --json`, then re-run Step 1 to show updated results
- **Just exploring** → Show a brief tip: "Run `/oss` whenever you want to check on your contributions. It works best when you have a few open PRs to track." Then end.

**Skip this step** if `totalActivePRs > 0` — go directly to Step 3.

---

## Step 3: Present Action Choices

The CLI pre-computes the action menu in `data.actionMenu`. Use these items directly in AskUserQuestion instead of manually deriving options.

**Fallback:** If `data.actionMenu` is missing (e.g., older CLI version), tell the user: "Action menu not found in CLI output — you may need to rebuild the CLI: `cd ${CLAUDE_PLUGIN_ROOT} && npm run bundle`". Then derive options manually: always include "Done for now"; add "Work through all N issues (Recommended)" if `data.actionableIssues.length > 0`; add "Search for new issues" if `data.capacity.hasCapacity`; add "View healthy PRs" if not `data.capacity.hasCapacity` and `data.actionableIssues.length > 0`; otherwise add "View PR status details".

### If No Actionable Issues

When `data.actionMenu` is present and `data.actionMenu.context.hasActionableIssues` is `false` (or when `data.actionMenu` is absent and `data.actionableIssues` is empty), display:
```
All PRs are healthy — nothing needs your attention right now.
```

If `hasIssueList && availableCount === 0`:
```
Your curated issue list is depleted ({completedCount} done). Time to find new issues!
```

### Display All PRs First (Information Before Prompt)

When there are actionable issues, display them **before asking the user anything**.

Issues are listed in priority order: `needs_response` → `needs_changes` → `ci_failing` → `merge_conflict` → `incomplete_checklist` → `approaching_dormant` → `recently_closed`. This matches the ordering from `collectActionableIssues()` in the CLI.

For each issue, show the enriched format using data already available on `FetchedPR`:

```
{count} PRs Need Attention (in priority order):

1. {issue.label} {issue.pr.repo}#{issue.pr.number} — {issue.pr.title} ({issue.pr.daysSinceActivity}d)
   └─ @{issue.pr.lastMaintainerComment.author}: {formatted maintainerActionHints}
   └─ Effort: {effort} — {action summary}

2. {issue.label} {issue.pr.repo}#{issue.pr.number} — {issue.pr.title} ({issue.pr.daysSinceActivity}d)
   └─ @{issue.pr.lastMaintainerComment.author}: {formatted maintainerActionHints}
   └─ Effort: {effort} — {action summary}

... (list ALL actionable issues, no limit)

---
```

**Maintainer hints line**: Only show if `issue.pr.lastMaintainerComment` exists. Format each hint from `issue.pr.maintainerActionHints` using these labels: `demo_requested` → "demo/screenshot requested", `tests_requested` → "tests requested", `changes_requested` → "code changes requested", `docs_requested` → "documentation requested", `rebase_requested` → "rebase requested". If no hints, show just the maintainer name.

**Effort estimate**: Compute at display time from issue type + hint count:

| Effort | Condition |
|--------|-----------|
| **Small** | `needs_response` with 0-1 hints (just a reply), `incomplete_checklist`, `approaching_dormant`, `recently_closed` (informational only) |
| **Medium** | `needs_response` with 2+ hints (reply + code changes), `needs_changes` with 0-2 hints, `ci_failing` |
| **Large** | `merge_conflict`, `needs_changes` with 3+ hints |

If an issue type doesn't match any row above, default to **Medium**.

**Action summary**: Brief description based on type (e.g., "respond + code changes", "rebase + push", "investigate CI logs").

Use `issue.pr.daysSinceActivity` from the CLI output (already computed).

### Ask for Action (Using Pre-Computed Menu)

Use `data.actionMenu.items` directly as AskUserQuestion options. Each item has `key`, `label`, and `description` fields ready for display.

**Issue list integration:** If the user has a curated issue list (detected in Step 0.7), insert an issue-list option **after `address_all`** (index 1) or **at the start** (index 0) when no actionable issues exist — i.e., always before the `search`/`view_details`/`view_healthy` item:

| Condition | Insert Item |
|-----------|-------------|
| `hasIssueList && availableCount >= 5 && context.hasCapacity` | Key: `pick_from_list`, Label: `"Pick from your issue list ({availableCount} ready)"`, Description: `"You have {availableCount} vetted issues ready to work on — starting one would be higher ROI than searching for more"` |
| `hasIssueList && availableCount > 0 && availableCount < 5 && context.hasCapacity` | Key: `pick_from_list`, Label: `"Pick from your issue list ({availableCount} available)"`, Description: `"Choose from your curated list of vetted issues"` |
| `hasIssueList && availableCount === 0 && context.hasCapacity` | Key: `replenish_list`, Label: `"Replenish your issue list"`, Description: `"All {completedCount} issues done — search for fresh ones"`. Also **remove** the `search` item (replenish replaces it). |

When inserting issue-list items, keep within the 4-option limit (the 5th is the auto "Other").

**"Replenish your issue list"** routes to **Handle "Find New Issues"** (same as search), but agents should be told to suggest issues suitable for adding to the curated list.

### Example AskUserQuestion

```
Question: "What would you like to do?"
Header: "Action"

Options (from data.actionMenu.items):
1. Label: "Work through all 7 issues (Recommended)"
   Description: "Run maintenance in parallel, then address code changes one at a time"

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
selects "Work through all issues" or explicitly approves maintenance. No separate investigation
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

### Handle "Work Through All Issues"

This flow uses a three-phase approach: parallel investigation, consolidated presentation, and sequential execution with user control.

**CRITICAL: Group PRs by repository — one agent per repo, not per PR.**

#### Phase A: Parallel Maintenance + Investigation

**CRITICAL: Dispatch ALL agents in a SINGLE message for true parallelism.**

For each issue in `actionableIssues`, include a Task tool call grouped by repo:

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
| Recently Closed | Info | Note as closed without merge. DO NOT clone, checkout, or rebase — the PR branch may not exist. Report closure for the Auto-Exclude prompt. |

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

**Agent failure handling:**
- If an agent fails or times out, note the failure and the affected PRs
- Never silently omit PRs from the Phase B presentation
- Include failed repos in a separate "Could Not Check" section in Phase B (see below)
- After Phase B, if any items are in "Could Not Check", offer: "Retry failed checks" / "Skip and continue with available results" / "Done for now"
  - **"Retry failed checks"**: Re-dispatch agents ONLY for the failed repos (not all agents). Merge retry results into Phase B display. If retry also fails, keep in "Could Not Check" with updated error and continue to Phase C with available results.
  - **"Skip and continue"**: Proceed to Phase C. Note to user: "{N} PRs were not checked and may need manual attention."

**Phase A completion verification:** After all agents return, cross-reference their results against the input `actionableIssues` list. Any PR that does not appear in any agent's response (either as a result or an explicit failure) should be added to the "Could Not Check" section with the error: "No result received from agent."

**Record `phaseACompletedAt`** when all Phase A agents have returned results. This timestamp is used for the staleness check in Phase C.

#### Phase B: Present Consolidated Results

After all agents complete, present results in two sections (plus a failure section if needed):

**Section 1: Routine Maintenance Results** (existing format)

```
## PR Status Dashboard

### Routine Maintenance Completed
| PR | Repo | Action | Result |
|---|---|---|---|
| #856 | ink | Rebased (5 behind) | Clean, force pushed |
| #8362 | cline | Rebased (129 behind) | Clean, force pushed |
| #9263 | shadcn-ui/ui | Rebased (160 behind) | Clean, force pushed |

### No Action Needed
| PR | Repo | Status |
|---|---|---|
| #863 | ink | CI green, awaiting review |
| #2857 | eslint-plugin-unicorn | CI green, awaiting review |

### Could Not Check (only if agents failed)
| PR | Repo | Error |
|---|---|---|
| #855, #856 | ink | Agent timed out |
```

**Section 2: Tier 2 Findings** (new consolidated view)

Only show this section if there are Tier 2 items remaining after Phase A:

```
### Tier 2 Items — Code Changes Needed

| # | PR | Status | Maintainer Ask | Effort | Recommended Action |
|---|-----|--------|---------------|--------|-------------------|
| 1 | repo#123 | needs_response | Requested shortcut change + tooltip | Small | Code change + respond |
| 2 | repo#456 | needs_changes | Fix trailing newline, sync docs | Medium | Code changes + push |
| 3 | repo#789 | approaching_dormant | No activity in 12 days | Small | Post follow-up comment |

**Key findings:**
- **repo#123**: Maintainer wants X. 2-line fix in `file.ts`.
- **repo#456**: 3 changes requested. Tests need updating.
- **repo#789**: Stale — needs a polite check-in comment.
```

Populate the table using data from the Phase A agent results:
- **PR**: `{repo}#{number}` — short form
- **Status**: From `issue.type` (needs_response, needs_changes, ci_failing, etc.)
- **Maintainer Ask**: 1-line summary of what the maintainer requested (from agent investigation findings)
- **Effort**: Use the same heuristic as Step 3 display (Small/Medium/Large)
- **Recommended Action**: Brief action description from agent findings

**Key findings**: 1-line summary per PR from the agent investigation results. Focus on what the maintainer is asking and what code change is needed.

#### Phase C: Sequential Tier 2 Execution

If no Tier 2 items remain after Phase A:
> "All issues were routine maintenance (rebases, status checks) — handled automatically. No code changes needed."
> Proceed to the "After Each Action" section.

Present the user with a priority-ordered choice:

```
Question: "Which PR would you like to address first?"
Header: "Next PR"

Options (ordered by priority, up to 3 PRs + Done — limited to 4 options for AskUserQuestion; user can type a number via "Other" to select any item from the findings table above):
1. "repo#123 — respond + code change (Small)"
2. "repo#456 — address 3 requested changes (Medium)"
3. "repo#789 — post follow-up (Small)"
4. "Done for now"
```

**Staleness note:** Phase A findings are cached for the session. If more than 30 minutes have elapsed since `phaseACompletedAt`, warn the user before executing:
> "Note: These findings are from {minutes} minutes ago. The PR status may have changed. Would you like to re-check this PR before proceeding?"

The user selects a PR, and you:
1. Use the findings from Phase A (do NOT re-investigate, unless staleness warning triggered and user opts to re-check)
2. Execute the recommended action for that specific PR
3. After completing the action, proceed to Step 5.5 (Pre-Commit Code Review) if code was changed. After Step 5.5 completes (including sub-step 7 if applicable), return here to Phase C's loop — do NOT follow sub-step 7's "proceed to Step 6" path during Phase C.

**Action failure handling:** After executing the action for a PR:
- **If successful**: Show "Completed: repo#123 — response posted + code pushed."
- **If failed**: Show "Failed: repo#123 — {specific error message}. This PR was not addressed."
  - If the error appears transient (network timeout, rate limit, auth token expired): Offer "Retry" / "Skip and move to next" / "Done for now"
  - If the error appears persistent (merge conflict during apply, file not found, branch deleted): Offer "Investigate the error" / "Skip and move to next" / "Done for now" — do NOT offer "Retry" for errors that will deterministically fail again
- Track completed, failed, and remaining counts separately in the progress display
- Failed items remain in the options list for future attempts

After each PR completion, show progress and offer the next choice:

```
Completed: 1 | Failed: 0 | Remaining: 2

Question: "What's next?"
Header: "Next PR"

Options:
1. "repo#456 — address 3 requested changes (Medium)"
2. "repo#789 — post follow-up (Small)"
3. "Done for now"
```

Continue until the user selects "Done for now" or all items are addressed.

**When Phase C ends** (all items addressed OR user selects "Done for now"):
- If all addressed: > "All {count} items addressed. {completed} completed, {failed} failed."
- If early exit: > "{completed} of {count} items addressed ({failed} failed, {remaining} remaining)."

Proceed to the "After Each Action" section.

**Phase C and "After Each Action" interaction:** The "After Each Action" logic runs ONCE after Phase C ends — NOT between individual Phase C actions. During Phase C's sequential loop, track what was done but defer the state refresh. Pass the combined Tier 1 (from Phase A) and Tier 2 (from Phase C) actions to "After Each Action" so it can decide whether a daily re-run is needed.

### Pre-Commit Gate (MANDATORY)

**STOP. Before presenting commit/push options to the user, you MUST complete Step 5.5 (Pre-Commit Code Review).** Do not skip this step. Do not offer to commit first. Run the review agents, present findings, THEN offer commit options. The only exception is if `git status --porcelain` confirms there are no uncommitted changes (e.g., only a comment was posted, or the action was investigation-only). Always verify with git status — do not assume based on which actions were dispatched.

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

### CRITICAL: Continue the Flow

**After the "Work through all issues" flow completes (Phase C ends or user selects "Done for now" during it), and after "After Each Action" runs its state refresh, ALWAYS present the session-level menu. Never end with just a summary.**

Use AskUserQuestion:
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
- "Search GitHub" — "Find new issues via parallel multi-strategy search"
- "Both — list first, then search" — "Review your list, then search for more"
- "Done for now"

Route based on choice:
- "Review from list" → go to **Handle "Pick Issue From List"** above
- "Search GitHub" → continue with **Parallel Multi-Strategy Search** below
- "Both" → show list first (Handle "Pick Issue From List"), then after that completes, continue with **Parallel Multi-Strategy Search**

#### Parallel Multi-Strategy Search

**CRITICAL: Dispatch ALL 3 strategies in a SINGLE message for true parallelism.**

**Strategy A — Established repos (merged-PR + open-PR repos):**
```
Task(issue-scout, "Find recently-opened issues (last 30 days) in repos where the user has merged or open PRs.
  [If searchedRepos is non-empty, insert: "Exclude results from these repos (already searched in prior rounds): {searchedRepos as comma-separated list}."]
  Get merged-PR repos: read ~/.oss-autopilot/state.json, extract repo names from repoScores entries where mergedPRCount > 0 (sorted by mergedPRCount descending).
  Get open-PR repos: run `gh search prs --author @me --state open --json repository --jq '.[].repository.nameWithOwner' | sort -u`.
  Combine both lists (merged-PR repos first), deduplicate.
  For each repo: `gh search issues --repo OWNER/REPO --state open --sort created --limit 5`.
  Exclude issues authored by the user (get username from `gh api user -q .login`).
  Return at most 15 total results (prioritize repos with higher mergedPRCount).
  For each: repo, number, title, URL, labels, source: 'established-repo', and brief assessment.")
```

**Strategy B — Filtered CLI search (language + label + star filters):**
```
Task(general-purpose, "Run the CLI search command and return the raw JSON output verbatim:
  ```bash
  GITHUB_TOKEN=$(gh auth token) node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs\" search 10 --json
  ```")
```

When Strategy B returns, check the JSON `success` field. If `success: false`, treat it as a failed strategy. If `success: true`, tag each candidate in `data.candidates` as source: `'cli-search'`.

**Strategy C — Trending/popular repos in user's language preferences:**
```
Task(issue-scout, "Search for good-first-issue candidates in trending/popular repos the user has NOT contributed to.
  [If searchedRepos is non-empty, insert: "Exclude results from these repos (already searched in prior rounds): {searchedRepos as comma-separated list}."]
  Exclude issues authored by the user (get username from `gh api user -q .login`).
  Read the user's language preferences from .claude/oss-autopilot/config.md.
  Then: gh search issues --label 'good first issue' --language {lang} --state open --sort reactions-+1 --limit 10
  Focus on repos with high star counts and recent activity.
  For each: repo, number, title, URL, labels, star count, source: 'trending-repo', and brief assessment.")
```

#### Combine, Filter, and Deduplicate

After all 3 strategies return:

1. **Normalize** all results to a common shape: `{ repo, number, title, url, labels, source, metadata }`. For Strategy B, flatten `candidate.issue.{repo, number, title, url, labels}` to the top level and place `candidate.{recommendation, viabilityScore, repoScore, reasonsToApprove, reasonsToSkip}` into `metadata`. Strategies A/C return structured text from issue-scout — extract the same fields from their output.
2. **Filter Strategy B** against `searchedRepos` — remove any candidates whose repo appears in `searchedRepos` (the CLI does not receive session-level exclusions, so this must be done post-hoc)
3. **Deduplicate** by issue URL — if the same issue appears in multiple strategies, keep the entry with the richest metadata but assign the **highest-priority source tag** (Established repo > CLI search > Trending repo)
4. **Sort** by source priority: Established repo first, then CLI search, then Trending repo (preserve original ordering within each group)
5. **Update `searchedRepos`** — append all repos from the deduplicated results (dedup against existing entries). This must happen before presenting the batch vet options.

**If ALL strategies failed** (all 3 returned errors, not just empty results), do NOT proceed to batch vet:
> "All 3 search strategies failed. Check: `gh auth status`, CLI build exists, network connectivity."
> Show each strategy's specific error.

Use AskUserQuestion:
- "Retry search" — "Re-dispatch all 3 strategies"
- "Done for now"

Route based on choice:
- "Retry search" → go back to **Parallel Multi-Strategy Search** above (same parameters)
- "Done for now" → return to Step 3

**Stop — do not fall through to the presentation step below.**

**If some strategies failed**, note it and continue with available results:
> "Strategy {name} failed: {error}. Showing results from {N} successful strategies."
> Omit strategies that returned zero results without comment.

**If the total candidate count is zero** (whether some strategies failed or all succeeded but returned empty), do NOT proceed to batch vet:
> "No matching issues found from the successful strategies. This typically means your exclusion list has grown large or filters are too narrow."

Use AskUserQuestion:
- "Retry with broader criteria" — "Re-dispatch with expanded label filters"
- "Done for now"

Route based on choice:
- "Retry with broader criteria" → go back to **Parallel Multi-Strategy Search** above, but broaden Strategy C to search for `'help wanted'` label in addition to `'good first issue'`
- "Done for now" → return to Step 3

**Stop — do not fall through to the presentation step below.**

Present combined results grouped by source (omit empty groups):
```
## Search Results ({totalCount} candidates from {successCount} strategies)

### From Established Repos ({count})
{results with source: 'established-repo'}

### From CLI Search ({count})
{results with source: 'cli-search'}

### From Trending Repos ({count})
{results with source: 'trending-repo'}
```

Proceed to the batch vet flow with the deduplicated results.

#### After Search Results: Batch Vet Flow

When search results come back (from the Parallel Multi-Strategy Search), present the combined, deduplicated candidates and offer a batch workflow. Set `currentRound = searchRoundScores.length + 1`.

Use AskUserQuestion:
- "Add all to list and vet in parallel (Recommended)" — "Add candidates to your issue list as 'Pending vet', then dispatch parallel vet agents"
- "Pick one to vet now" — "Select a single candidate to investigate immediately"
- "Search again with different criteria" — "Run another parallel search round with adjusted parameters (prior repos auto-excluded)"
- "Done for now"

**"Add all to list and vet in parallel":**

1. **Add candidates to the curated list.** For each search result, append an entry under a new `## Pending Vet` section (create section if it doesn't exist):
   ```markdown
   ### {owner}/{repo} ({stars}★) — {repo description}
   - [#{number}]({url}) — {issue title}
     - **Pending vet** — Found in search round {currentRound}, not yet vetted.
   ```

2. **Dispatch parallel vet agents** (up to 5 concurrent). For each candidate:
   ```
   Task(issue-scout, "Vet this issue from the user's search results:
     URL: {issue_url}
     Source: search-round-{currentRound}
     Check: still open, unassigned, no linked PRs, repo health, complexity estimate.
     Return: score (1-10), recommendation (pursue/maybe/skip), red flags if any.")
   ```

3. **After all vet agents return**, update each list entry with vetting findings:
   - Replace `**Pending vet**` with the vetting result: `**Score: {score}/10** — {recommendation}. {brief findings}`
   - Move entries to the appropriate priority tier section based on recommendation:
     - `pursue` → `## Pursue — Ready to Contribute`
     - `maybe` → `## Maybe — Viable with Caveats`
     - `skip` → `## Skip — Not Recommended` (or remove from list, per user preference)

4. **Track round scores.** Calculate the average score for this round and append to `searchRoundScores`:
   ```
   roundAvg = mean of all vetting scores from this round
   searchRoundScores.push(roundAvg)
   ```

5. **Present summary**, then proceed to **Diminishing Returns Check** below.
   ```
   ## Search Round {currentRound} Results

   Vetted {count} candidates (avg score: {roundAvg}/10):
   - {count_pursue} ready to pursue
   - {count_maybe} viable with caveats
   - {count_skip} not recommended

   Your issue list now has {availableCount} available issues.
   ```

**"Pick one to vet now":**
- Display the search results as a numbered list
- Use AskUserQuestion with up to 3 candidates + "Done for now"
- Dispatch a single `issue-scout` agent for the selected candidate (same prompt as step 2 above)
- Present the vetting result and offer: "Claim this issue and start working" / "Pick a different one" / "Done for now"
- Record the single score: `searchRoundScores.push(score)` — then proceed to **Diminishing Returns Check**

**"Search again with different criteria":**
- Route back to **Parallel Multi-Strategy Search** (exclusions carry forward automatically).

#### Diminishing Returns Check

After each batch vet or single vet completes and a score is appended to `searchRoundScores`, check for quality decline:

**If `searchRoundScores.length >= 2` and the previous round's average is > 0**, compare:
```
previousAvg = searchRoundScores[searchRoundScores.length - 2]
currentAvg = searchRoundScores[searchRoundScores.length - 1]
dropPercent = (previousAvg - currentAvg) / previousAvg * 100
```

Display an advisory based on the severity of the drop:
- **If `dropPercent > 50`**: > "Search quality has dropped significantly (avg score {currentAvg} vs {previousAvg}). Further searching is likely to yield diminishing returns. You have {availableCount} vetted issues ready to work on."
- **Otherwise, if `dropPercent > 30`**: > "These candidates are lower quality than the previous round (avg score {currentAvg} vs {previousAvg}). You have {availableCount} vetted issues ready. Consider working on those instead of searching more."

After displaying the round summary (and advisory if applicable), present the next action:

Use AskUserQuestion (if `availableCount >= 5` and an advisory was shown, place the list option first with "(Recommended)"):
- "Pick from your issue list ({availableCount} ready)" (if `hasIssueList && availableCount > 0`) — "Start working on a vetted issue"
- "Search for new issues" — "Run another parallel search round"
- "Done for now"

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

**Classify change size** from the diff and file count:
- Count diff lines from `git diff HEAD --stat` summary (captures both staged and unstaged changes; e.g., "3 files changed, 45 insertions(+), 12 deletions(-)"). Use insertions + deletions as the line count. Note: binary files report 0 lines — if the diff contains binary files, classify based on file count alone.
- Count changed files from `git status --porcelain`.

Evaluate from largest to smallest — **first match wins**:

| Classification | Criteria |
|----------------|----------|
| **Large** | > 200 diff lines OR > 5 files |
| **Medium** | ≥ 50 diff lines OR 3–5 files |
| **Small** | Everything else (< 50 diff lines AND ≤ 2 files) |

Save as `changeSize` for use in sub-step 3. Report: "> Change size: {tier} ({N} diff lines, {M} files) — dispatching {K} agents."

**If classification fails** (command errors, unparseable output, or both counts are zero despite `git status --porcelain` showing changes): default to **Large** to ensure maximum review coverage and warn: "Could not determine change size — defaulting to Large for comprehensive review."

#### 3. Dispatch Review Agents in Parallel

**CRITICAL: Dispatch ALL selected agents in a SINGLE message for true parallelism.**

Capture the `git diff` output and pass it as context to each agent.

**IMPORTANT: Always include `Working directory: {local repo path}` in every agent prompt so agents can find and read files in the correct location. Without this, agents inherit the parent session's working directory and file lookups will fail.**

**Scale dispatch based on `changeSize`** (from sub-step 2):

| Size | Agents to dispatch |
|------|--------------------|
| **Small** | `code-reviewer` + `silent-failure-hunter` |
| **Medium** | Small agents + `code-simplifier` |
| **Large** | Medium agents + `pr-test-analyzer` + conditional agents below |

> **Rationale:** Typical review-response changes (10–50 lines, 1–2 files) don't need 4–6 agents. Scaling reduces latency and token cost for the common case while keeping the full suite for larger contributions.

**Agent prompts** (dispatch only those selected by the tier above; include the full `git diff` output in each):

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

**Conditional agents — Large changes only (dispatch in the SAME message if applicable):**

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
- **After confirming the push succeeded, proceed to sub-step 7 (Post Response Comment)**

**"Done for now":**
- Return to Step 4's action handler loop without committing

#### 7. Post Response Comment (for existing PR updates)

**Skip this step if** the PR's status (from Phase A or Step 4 context) was NOT `needs_response` or `needs_changes` — i.e., no maintainer feedback was being addressed. Maintenance-only actions (rebase, CI fix where status was `ci_failing`) do not need a response comment.

**If the push was in response to maintainer feedback:**

1. Draft a response comment summarizing what was changed:
   - Reference specific review points that were addressed
   - Briefly describe the approach taken for each point
   - Mention any points that were intentionally NOT changed, with a brief explanation why
   - Keep the tone professional and grateful (see `oss-contribution` skill for guidelines)

2. Present the draft to the user:
   ```
   Question: "Post this response to the maintainer?"
   Header: "PR Comment"

   Options:
   1. "Post this response (Recommended)" — "Post the comment as drafted"
   2. "Edit before posting" — "Modify the draft first"
   3. "Skip — don't post a comment" — "Push is enough, no comment needed"
   ```

3. Handle choice:
   - **"Post this response":** Write comment to `/tmp/pr-comment-{pr_number}.md` and post via `gh pr comment {pr_number} --repo {upstream_repo} --body-file /tmp/pr-comment-{pr_number}.md` (avoids shell escaping issues with inline `--body`). Verify exit code 0, then delete the temp file.
   - **"Edit before posting":** Let the user modify the draft, re-present for approval, then post using the same method.
   - **"Skip":** No comment posted.

4. **If `gh pr comment` fails (for either "Post" or "Edit" path):** Report the error, display the drafted comment so the user can copy it, and offer: "Retry" / "Copy and post manually" / "Skip". Do NOT silently proceed without the comment.

**After this sub-step completes (or is skipped):** If currently in Phase C's sequential loop, return to Phase C to process the next item. Otherwise, proceed to Step 6.

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

Use the same agent dispatch pattern as Step 5.5 sub-step 3, **always using the Large tier** (code-reviewer, silent-failure-hunter, code-simplifier, pr-test-analyzer, plus conditional agents), since this reviews the full branch diff for a new contribution. Step 5.5's size-based scaling does not apply here. Include the `Working directory: {local repo path}` line in every prompt. Additionally, **prepend the following SCOPE block** to each agent prompt. The SCOPE block constrains findings to the PR's purpose and prevents scope creep from pre-existing issues:

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
1. **Tier 1 (maintenance)**: Rebase + force push is allowed after user selects "Work through all issues" or explicitly approves
2. **Tier 2 (code/comments)**: NEVER push code or post comments without explicit per-action approval
3. **Agents report results** for Tier 1, **investigate and recommend** for Tier 2
4. In Phase C, present Tier 2 items one at a time for sequential approval and execution

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
