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

### 2. Run EVERYTHING in a Single Bash Call

After the loading message, execute the **one combined bash command** below. This single call handles build, auth, setup check, daily fetch, dashboard, version, and issue list detection. Do NOT run ANY other tool calls (no Read, no additional Bash) between the loading message and displaying results.

### 3. Only Show Results

After the bash call completes, jump straight to displaying the brief summary and action menu. Do NOT echo the raw JSON. Do NOT narrate what happened. No "Now let me...", no "Let me check...", no intermediate commentary.

**If something fails**, then and only then explain the error.

## Combined Bash Script

Run **everything** in a single bash call. The CLI's `startup` command handles auth, setup, daily fetch, dashboard generation, version detection, and issue list detection internally. The output is a single JSON envelope.

```bash
# Rebuild CLI if needed
if [ ! -f "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" ] || [ "${CLAUDE_PLUGIN_ROOT}/package.json" -nt "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" ]; then
  BUILD_LOG=$(cd "${CLAUDE_PLUGIN_ROOT}" && npm install --silent 2>&1 && npm run bundle --silent 2>&1)
  if [ $? -ne 0 ]; then echo "BUILD_FAILED"; echo "$BUILD_LOG" | tail -5; exit 1; fi
fi
GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN")
export GITHUB_TOKEN
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" startup --json 2>/tmp/oss-startup-stderr.log
```

**Parse the output:**

The output is a single JSON object with the standard envelope: `{ success: boolean, data?: StartupOutput, error?: string, timestamp: string }`.

**Error sentinel check** (before JSON appears — only possible if the build step fails):
- If output starts with `BUILD_FAILED`: Tell the user the CLI build failed and show the error lines. Then show error recovery steps (Step 1b).

**JSON parsing** — parse the entire output as JSON:

- If `success` is `false`: Show `error` field to the user. This means the daily check failed. Show error recovery steps (Step 1b).
- If `success` is `true`, extract `data` as `StartupOutput`:

| Field | Meaning | Session Variable |
|-------|---------|-----------------|
| `data.version` | CLI version (e.g., "0.26.0") | `version` |
| `data.setupComplete` | Whether setup is done | If `false`, prompt setup |
| `data.authError` | Set when no GitHub token | If present, show auth instructions |
| `data.daily` | DailyOutput (same shape as before) | Extract `briefSummary`, `actionableIssues`, `actionMenu`, etc. |
| `data.dashboardPath` | Path to generated dashboard HTML | Mention dashboard opened |
| `data.issueList` | Issue list info (if detected) | `hasIssueList` = present; extract `path`, `source`, `availableCount`, `completedCount` |

**Routing based on parsed data:**
- `data.authError` is present → Tell the user: show `data.authError` message.
- `data.setupComplete === false` → Tell the user: "It looks like setup isn't complete yet." Use AskUserQuestion to let them choose "Run setup first (Recommended)" (launch `/setup-oss`) or "Continue with defaults". If they choose "Continue with defaults", re-run the daily check directly (`GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" daily --json 2>/tmp/oss-startup-stderr.log`), use `data.version` from the startup output already received, and continue to Step 2 with the daily result as `data.daily`.
- `data.daily` is present → Continue to Step 2 (display brief summary and action menu).

**If output is empty or not valid JSON**: Tell the user "Something went wrong running the startup check." Suggest running manually: `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" startup --json`. Then show error recovery steps (Step 1b).

## Step 2: Display Brief Summary

The CLI returns structured data with new fields for the action-first flow:

```json
{
  "success": true,
  "data": {
    "version": "0.26.0",
    "setupComplete": true,
    "daily": {
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
      "digest": { ... }
    },
    "dashboardPath": "/Users/.../.oss-autopilot/dashboard.html",
    "issueList": { "path": "open-source/potential-issue-list.md", "source": "auto-detected", "availableCount": 5, "completedCount": 3 }
  }
}
```

**Display the `briefSummary` field with the version from `data.version`:**

```
data.daily.briefSummary + " | v" + data.version
```

Example output:
> 📊 16 Active PRs | 3 need attention | Dashboard opened in browser | v0.26.0

Then proceed to Step 2.5 (check for first-run) or Step 3 (Present Action Choices).

---

## Step 2.5: First-Run Welcome (Empty State)

If `data.daily.digest.summary.totalActivePRs === 0` AND setup is complete, this is likely the user's first run or they have no open PRs. Instead of showing an empty dashboard and action menu, show a welcome message:

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
- **Import existing PRs** → Run the import command: `GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" init "$(gh api user --jq '.login')" --json`. If it succeeds, re-run `startup --json` (`GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" startup --json 2>/tmp/oss-startup-stderr.log`) and parse the result from the top (same routing as the initial startup call). If it fails, show the error and suggest checking `gh auth status`.
- **Just exploring** → Show a brief tip: "Run `/oss` whenever you want to check on your contributions. It works best when you have a few open PRs to track." Then end.

**Skip this step** if `totalActivePRs > 0` — go directly to Step 3.

---

## Step 3: Present Action Choices

The CLI pre-computes the action menu in `data.daily.actionMenu`. Use these items directly in AskUserQuestion instead of manually deriving options.

**Fallback:** If `data.daily.actionMenu` is missing (e.g., older CLI version), tell the user: "Action menu not found in CLI output — you may need to rebuild the CLI: `cd ${CLAUDE_PLUGIN_ROOT} && npm run bundle`". Then derive options manually: always include "Done for now"; add "Work through all N issues (Recommended)" if `data.daily.actionableIssues.length > 0`; always add "Search for new issues".

### If No Actionable Issues

When `data.daily.actionMenu` is present and `data.daily.actionMenu.context.hasActionableIssues` is `false` (or when `data.daily.actionMenu` is absent and `data.daily.actionableIssues` is empty), display:
```
All PRs are healthy — nothing needs your attention right now.
```

If `hasIssueList && availableCount === 0`:
```
Your curated issue list is depleted ({completedCount} done). Time to find new issues!
```

### Display All PRs First (Information Before Prompt)

When there are actionable issues, display them **before asking the user anything**.

Issues are listed in priority order: `needs_response` → `needs_changes` → `ci_failing` → `merge_conflict` → `incomplete_checklist` → `approaching_dormant`. This matches the ordering from `collectActionableIssues()` in the CLI. Recently closed PRs are NOT included here — they appear in a separate informational section below (see "Recently Closed PRs").

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
| **Small** | `needs_response` with 0-1 hints (just a reply), `incomplete_checklist`, `approaching_dormant` |
| **Medium** | `needs_response` with 2+ hints (reply + code changes), `needs_changes` with 0-2 hints, `ci_failing` |
| **Large** | `merge_conflict`, `needs_changes` with 3+ hints |

If an issue type doesn't match any row above, default to **Medium**.

**Action summary**: Brief description based on type (e.g., "respond + code changes", "rebase + push", "investigate CI logs").

Use `issue.pr.daysSinceActivity` from the CLI output (already computed).

### Recently Closed PRs (Informational)

If `data.daily.digest.recentlyClosedPRs` has entries, display them **after** the actionable issues list (or after "All PRs are healthy" if none) as a separate informational section. These are NOT counted in the "Need Attention" total and do NOT receive priority numbers:

```
Recently closed (informational):
- {repo}#{number} — {title} (closed without merge on {closedAt date})
```

These do not require any action. They exist so the user knows what was closed. The Auto-Exclude prompt (Step 6) may offer to exclude these repos from future searches.

### Ask for Action (Using Pre-Computed Menu)

Use `data.daily.actionMenu.items` directly as AskUserQuestion options. Each item has `key`, `label`, and `description` fields ready for display.

**Issue list integration:** If the user has a curated issue list (detected from `data.issueList` in the startup output), insert an issue-list option **after `address_all`** (index 1) or **at the start** (index 0) when no actionable issues exist — i.e., always before the `search` item:

| Condition | Insert Item |
|-----------|-------------|
| `hasIssueList && availableCount >= 5` | Key: `pick_from_list`, Label: `"Pick from your issue list ({availableCount} ready)"`, Description: `"You have {availableCount} vetted issues ready to work on — starting one would be higher ROI than searching for more"` |
| `hasIssueList && availableCount > 0 && availableCount < 5` | Key: `pick_from_list`, Label: `"Pick from your issue list ({availableCount} available)"`, Description: `"Choose from your curated list of vetted issues"` |
| `hasIssueList && availableCount === 0` | Key: `replenish_list`, Label: `"Replenish your issue list"`, Description: `"All {completedCount} issues done — search for fresh ones"`. Also **remove** the `search` item (replenish replaces it). |

When inserting issue-list items, keep within the 4-option limit (the 5th is the auto "Other").

**"Replenish your issue list"** routes to **Handle "Find New Issues"** (same as search), but agents should be told to suggest issues suitable for adding to the curated list.

### Example AskUserQuestion

```
Question: "What would you like to do?"
Header: "Action"

Options (from data.daily.actionMenu.items):
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

## Step 1b: CLI Error Recovery

Show any captured error output (from `$BUILD_LOG`, stderr, or the `error` field). Then troubleshoot based on the error type:

- **Build failure** (BUILD_FAILED sentinel): `cd ${CLAUDE_PLUGIN_ROOT} && npm install && npm run bundle`. Common causes: missing Node.js 18+, stale `node_modules` (delete and reinstall), npm permission issues.
- **Auth/network error** (`success: false` with valid JSON): Check `gh auth status` and network connectivity. The CLI built fine — the daily check itself failed.
- **Invalid output** (empty or non-JSON): Try running manually: `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" startup --json`. Check `node --version` (need 18+).

---

## Step 4: Action Handlers

### Action Tiers

| Tier | Scope | Examples | Agent Behavior |
|------|-------|----------|---------------|
| **Tier 1** — Routine Maintenance | Non-destructive, no code logic changes | Rebase, clone, fetch upstream | Execute directly (with user consent). Report result. |
| **Tier 2** — Code Changes | Changes code or posts public content | CI fixes, conflict resolution, review responses, missing files | Investigate and recommend. All writes require explicit user approval. |

**After Tier 2 code changes, ALWAYS proceed to Step 5.5 (Pre-Commit Code Review) before committing or pushing.**

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
| CI Failing | Tier 2 | Investigate CI failures. Analyze logs, identify root cause, recommend fixes. DO NOT push code fixes without approval. If a re-run is needed, attempt `gh run rerun <id> --repo <repo> --failed`. If it fails (permission error, non-rerunnable state, or other error), report the error and suggest alternatives for user approval: push an empty commit to retrigger, ask maintainer to re-run, or wait. |
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

When `data.daily.digest.recentlyClosedPRs` has entries (PRs closed without merge), offer to exclude those repos from future searches:

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
- "Pick from your issue list" (if `hasIssueList` and `availableCount > 0`) — "{availableCount} vetted issues available"
- "Search for new issues"
- "Check for more PR updates" (re-run daily check)
- "Done for now"

**The session only ends when the user explicitly selects "Done for now".**

### Handle Specific PR Selection (from "Other" input)

When user selects specific PRs (e.g., "1 and 3"), dispatch only those agents in parallel.
Still group by repo if selected PRs share a repository.

### Handle "Find New Issues"

If `hasIssueList` and `availableCount > 0`, offer to review the list first before searching.

The full search workflow is in the `/oss-search` command. Tell the user:
> "Starting issue search — this uses the `/oss-search` workflow."

Then invoke `/oss-search`, passing session state (`hasIssueList`, `availableCount`, `completedCount`, `issueListPath`).

When the user claims any issue found through search and starts implementing, set `isNewContribution = true` and `issueContext = { title, url, description }`. This activates the draft-first workflow (see "Handle Pick Issue From List" section 6).

### Handle "Pick Issue From List"

Only available when `hasIssueList` is true and `availableCount > 0`.

#### 1. Read and parse the list file

Re-read the file at `issueListPath` (it may have been updated since initial detection). Parse available issues — those NOT struck through and NOT marked "**Done**".

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
- **Choose a consistent change type** based on the issue labels and nature of the change. Use this type for both the branch prefix and the commit message to avoid mismatches flagged by the compliance checker:
  - Issue labeled `bug` or fixes broken behavior → `fix/` branch, `fix:` commit
  - Issue labeled `enhancement`, `feature`, or adds new functionality → `feat/` branch, `feat:` commit
  - Documentation-only changes → `docs/` branch, `docs:` commit
  - If ambiguous, prefer `fix/` for correcting existing behavior and `feat/` for adding new capabilities

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

**Always include `--head`** to handle both fork-based and same-repo workflows. The `--head` flag is harmless for same-repo PRs and required for fork-based PRs:

```bash
forkOwner=$(gh repo view --json owner --jq '.owner.login')
branch=$(git branch --show-current)
```

**If `$forkOwner` is empty** (e.g., `gh` not authenticated, network error): fall back to parsing the remote URL: `forkOwner=$(git remote get-url origin | sed -n 's|.*github.com[:/]\([^/]*\)/.*|\1|p')`. If still empty, ask the user to provide their fork owner name manually. **If `$branch` is empty** (detached HEAD state, e.g., during a rebase or in CI): report "Cannot create a PR from a detached HEAD. Please check out a named branch first." Do NOT run `gh pr create` with an empty `$forkOwner` or `$branch`.

```bash
gh pr create --draft --title "{conventional title}" --body "{PR body}" --repo {upstream-repo} --head "$forkOwner:$branch"
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
- Run `git diff` and **output the full diff as a markdown code block in your text response** so the user can read it
- **If `git diff` fails**, report the error and offer: "Retry" / "Continue without diff" / "Done for now". If the user selects "Continue without diff", skip the diff display and present the follow-up prompt directly (the user has explicitly chosen to proceed without reviewing the raw diff).
- **After** the diff is visible in your response (or user chose to continue without), use AskUserQuestion:
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

1. Draft a brief response comment:
   - Keep it to one or two sentences describing what you changed — avoid bullet-point changelogs
   - Mention anything intentionally left unchanged only if the maintainer will wonder about it
   - Match the thread's tone and length (see `oss-contribution` skill for writing style guidelines)

2. **Output the drafted comment as a blockquote in your text response** so the user can read it.

3. **After** the draft is visible in your response, use AskUserQuestion:
   ```
   Question: "Post this response to the maintainer?"
   Header: "PR Comment"

   Options:
   1. "Post this response (Recommended)" — "Post the comment as drafted"
   2. "Edit before posting" — "Modify the draft first"
   3. "Skip — don't post a comment" — "Push is enough, no comment needed"
   ```

4. Handle choice:
   - **"Post this response":** Write comment to `/tmp/pr-comment-{pr_number}.md` and post via `gh pr comment {pr_number} --repo {upstream_repo} --body-file /tmp/pr-comment-{pr_number}.md` (avoids shell escaping issues with inline `--body`). Verify exit code 0, then delete the temp file.
   - **"Edit before posting":** Let the user modify the draft, re-present for approval, then post using the same method.
   - **"Skip":** No comment posted.

5. **If `gh pr comment` fails (for either "Post" or "Edit" path):** Report the error, display the drafted comment so the user can copy it, and offer: "Retry" / "Copy and post manually" / "Skip". Do NOT silently proceed without the comment.

**After this sub-step completes (or is skipped):** If currently in Phase C's sequential loop, return to Phase C to process the next item. Otherwise, proceed to Step 6.

---

## Step 5.6: Draft PR Review Cycle

**Trigger:** After draft PR created in Step 5.5. Only for new contributions (`isNewContribution === true`).

Initialize `roundNumber = 1`.

### 1. Gather Change Context

Compute `baseBranch` and `mergeBase` (store in session — reused in 5.6b and 5.7):

```bash
baseBranch=$(gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null || git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}' || echo "main")
if ! git fetch origin "$baseBranch" 2>/dev/null; then
  echo "Warning: git fetch failed — diffs may be based on stale data."
fi
mergeBase=$(git merge-base "origin/$baseBranch" HEAD 2>/dev/null) || true
``` Use `git diff $mergeBase..HEAD` for the full branch diff. If `$mergeBase` is empty, fall back to `origin/$baseBranch...HEAD`. If neither works, report error — do NOT dispatch agents without diff context. Read `CONTRIBUTING.md` and lint configs if not already loaded.

### 2. Dispatch Scope-Aware Review Agents

**Dispatch ALL agents in a SINGLE message.** Always use the full Large tier (code-reviewer, silent-failure-hunter, code-simplifier, pr-test-analyzer + conditional agents) regardless of diff size. Include `Working directory: {local repo path}` in every prompt.

**Prepend this SCOPE block to each agent prompt:**
```
SCOPE: This PR addresses issue '{issueContext.title}' ({issueContext.url}).
Focus findings on changes related to this issue. Flag pre-existing issues only
if they are Critical severity. Do NOT suggest improvements outside the scope of this PR.
```

Tailor per agent: code-reviewer focuses on issue-related changes, silent-failure-hunter on changed code paths only, code-simplifier on new/modified code only, pr-test-analyzer on new functionality only.

If ALL agents fail: offer "Proceed to integration check (skip review)" / "Retry" / "Done for now".

### 3. Consolidate and Present

Same as Step 5.5 sub-step 4, but separate findings into **In-Scope** (Critical/Recommended/Minor) and **Out-of-Scope** (pre-existing issues). Include test coverage assessment.

### 4. User Decision

**If Critical/Recommended findings:** "Address findings" / "Show full diff" / "Finalize anyway" / "Done for now"
**If clean:** "Finalize (Recommended)" / "Show full diff" / "Done for now"

### 5. Handle Choice

**"Address findings":** Fix → commit → push → increment `roundNumber` → loop to sub-step 1. Only increment `roundNumber` if push succeeds. On push failure, report error and offer retry/done. **Soft limit after 3 rounds:** suggest finalizing (diminishing returns).

**"Show diff":** Output `git diff $mergeBase..HEAD` as code block. If the diff command fails, recompute `$mergeBase` and retry. If still failing, offer "Continue without diff" / "Retry" / "Done for now". Then offer: "Finalize" / "Fix something" / "Done for now".

**"Finalize":** → Step 5.6b (Integration Check)

**"Done for now":** Report draft saved, return to Step 4.

---

## Step 5.6b: Integration Check for New Files

**Trigger:** After Step 5.6 finalized. Only for new contributions.

Review agents see diff contents but can't detect whether new files are wired into the codebase. This catches "dead code" PRs.

### Flow

1. **Find new files:** `git diff --name-only --diff-filter=A "$mergeBase"..HEAD`. If `$mergeBase` is invalid, recompute it. If no new files → skip to Step 5.7b.

2. **Check references:** For each new file, search for its name stem in the source tree (grep for imports/registrations, excluding the file itself). Adjust file extensions to match the repo's language.

3. **Flag unreferenced files:** If any new file has zero references, warn the user and offer:
   - "Investigate and fix" — find entry points, add missing imports, commit + push. If git operations fail, report error and offer retry/skip/done. Do NOT proceed unless push succeeds or user explicitly skips.
   - "Skip — files are referenced differently" — e.g., dynamically loaded, auto-discovered
   - "Done for now" — leave as draft

**If all files referenced or user resolves:** → Step 5.7b (Manual Testing Prompt)

---

## Step 5.7b: Manual Testing Prompt

**Trigger:** After Step 5.6b (Integration Check) completes or is skipped. Only runs for new contributions (`isNewContribution === true`).

Automated review catches code patterns, but cannot verify runtime behavior (UI rendering, keyboard shortcuts, browser behavior, CLI output, etc.). This step gives the user a chance to manually verify the feature works before finalizing.

**Auto-skip when ALL of the following are true:**
- The change is a utility function, library code, or backend logic (no visual/UI component)
- All relevant automated test suites pass
- Manual testing would require non-trivial environment setup (e.g., CSP headers, specific server config, browser extension loading)

When auto-skipping, note: "Skipping manual testing — non-visual change, all automated tests pass, and manual testing would require non-trivial environment setup." Then proceed directly to Step 5.7.

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

**Trigger:** After Step 5.7b completes or is skipped. Only for new contributions.

### Flow

1. **Count commits:** Validate `$mergeBase` (recompute if invalid), then `git rev-list --count "$mergeBase"..HEAD`. If only 1 commit → skip to Step 5.8.

2. **Check config:** Read squash setting from `.claude/oss-autopilot/config.md` (check `repoOverrides.{repo}.squash`, then `squashByDefault`, default `true`). If `false` → Step 5.8. If `"ask"` → prompt user.

3. **Generate message:** Create a commit message covering all work (implementation + tests + fixes). Follow repo's commit format, include issue reference. **Present to user for approval BEFORE squashing:**
   - "Approve and squash (Recommended)" / "Edit message" / "Skip squash" / "Done for now"

4. **Squash (after user approval):** Run each command individually — check for failure before proceeding:
   ```bash
   git tag -d oss-autopilot-pre-squash 2>/dev/null  # cleanup stale tag
   git tag oss-autopilot-pre-squash                  # safety tag — MUST succeed
   git reset --soft "$mergeBase"
   git commit -m "{approved message}"
   git fetch origin "$(git branch --show-current)"
   git push --force-with-lease
   git tag -d oss-autopilot-pre-squash               # cleanup after success
   ```
   **CRITICAL: If the safety tag creation fails, do NOT proceed with the squash.** Report: "Could not create safety recovery tag. Aborting squash to protect your work." Offer: "Retry" / "Skip squash" / "Done for now".
   On any other failure: recover via `git reset --hard oss-autopilot-pre-squash`, report error, offer retry/undo/done. If `--force-with-lease` fails with stale info, retry once with explicit lease: `git push "--force-with-lease=$branch:$(git rev-parse origin/$branch)" origin $branch`. If force push blocked by branch protection: `git reset --hard oss-autopilot-pre-squash && git push && git tag -d oss-autopilot-pre-squash`. Do NOT proceed to Step 5.8 unless push succeeded.

**→ Step 5.8 after successful push**

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

> **Context tip:** This was a full implementation cycle. Starting a fresh `/oss` session will free up context for more work. You can continue here if needed.

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

> **Context tip:** This was a full implementation cycle. Starting a fresh `/oss` session will free up context for more work. You can continue here if needed.

---

## Step 6: After Creating/Updating PRs

**For PRs that completed the full draft-first workflow** (Steps 5.6 → 5.6b → 5.7b → 5.7 → 5.8, i.e., `isNewContribution === true` and all steps completed): Skip the compliance check. The PR was already reviewed by 5+ agents, integration-checked, manually tested, and squashed. Note:

> "Compliance check skipped — this PR went through the full draft-first review workflow."

**For all other PR updates** (existing PRs, quick fixes, responses to maintainer feedback): Always offer a compliance check:

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
# Startup (preferred entry point — combines auth, setup, daily, dashboard, issue list)
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" startup --json

# Daily check (syncs and checks all PRs — standalone, without dashboard/issue list)
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
