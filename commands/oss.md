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
          "prUrl": "https://github.com/owner/repo/pull/123"
        }
      ],
      "actionMenu": {
        "items": [
          { "key": "address_all", "label": "Work through all 3 issues (Recommended)", "description": "Run maintenance in parallel, then address code changes one at a time" },
          { "key": "search", "label": "Search for new issues", "description": "Look for new contribution opportunities" },
          { "key": "done", "label": "Done for now", "description": "End session with summary" }
        ],
        "context": { "hasActionableIssues": true, "actionableCount": 3, "hasCapacity": true, "hasIssueResponses": false, "issueResponseCount": 0 }
      },
      "capacity": { "hasCapacity": true, ... },
      "digest": {
        "openPRs": [ { "url": "https://github.com/owner/repo/pull/123", "repo": "owner/repo", "number": 123, "title": "...", ... } ],
        "healthyPRs": ["https://github.com/owner/repo/pull/123"],
        "ciFailingPRs": ["https://github.com/owner/repo/pull/456"],
        ...
      }
    },
    "dashboardPath": "/Users/.../.oss-autopilot/dashboard.html",
    "issueList": { "path": "open-source/potential-issue-list.md", "source": "auto-detected", "availableCount": 5, "completedCount": 3 }
  }
}
```

**Important: Compact JSON format (#287)**

The JSON output uses a deduplicated format to reduce payload size:
- Full PR objects live **only** in `digest.openPRs`.
- Category arrays (`healthyPRs`, `ciFailingPRs`, etc.) contain **PR URL strings**, not full objects. Look up full PR details via: `data.daily.digest.openPRs.find(pr => pr.url === url)`.
- `actionableIssues[].prUrl` is a URL string. Look up the full PR via: `data.daily.digest.openPRs.find(pr => pr.url === issue.prUrl)`.
- `repoGroups[].prUrls` are URL string arrays. Look up each PR from `digest.openPRs`.

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

For each issue, look up the full PR from `digest.openPRs` using the issue's `prUrl`:

```javascript
// For each actionable issue, resolve the full PR object:
const pr = data.daily.digest.openPRs.find(p => p.url === issue.prUrl);
```

Then show the enriched format using the resolved PR's fields:

```
{count} PRs Need Attention (in priority order):

1. {issue.label} {pr.repo}#{pr.number} — {pr.title} ({pr.daysSinceActivity}d)
   └─ @{pr.lastMaintainerComment.author}: {formatted maintainerActionHints}
   └─ Effort: {effort} — {action summary}

2. {issue.label} {pr.repo}#{pr.number} — {pr.title} ({pr.daysSinceActivity}d)
   └─ @{pr.lastMaintainerComment.author}: {formatted maintainerActionHints}
   └─ Effort: {effort} — {action summary}

... (list ALL actionable issues, no limit)

---
```

**Maintainer hints line**: Only show if `pr.lastMaintainerComment` exists. Format each hint from `pr.maintainerActionHints` using these labels: `demo_requested` → "demo/screenshot requested", `tests_requested` → "tests requested", `changes_requested` → "code changes requested", `docs_requested` → "documentation requested", `rebase_requested` → "rebase requested". If no hints, show just the maintainer name.

**Effort estimate**: Compute at display time from issue type + hint count:

| Effort | Condition |
|--------|-----------|
| **Small** | `needs_response` with 0-1 hints (just a reply), `incomplete_checklist`, `approaching_dormant` |
| **Medium** | `needs_response` with 2+ hints (reply + code changes), `needs_changes` with 0-2 hints, `ci_failing` |
| **Large** | `merge_conflict`, `needs_changes` with 3+ hints |

If an issue type doesn't match any row above, default to **Medium**.

**Action summary**: Brief description based on type (e.g., "respond + code changes", "rebase + push", "investigate CI logs").

Use `pr.daysSinceActivity` from the resolved PR (already computed).

### Recently Closed PRs (Informational)

If `data.daily.digest.recentlyClosedPRs` has entries, display them **after** the actionable issues list (or after "All PRs are healthy" if none) as a separate informational section. These are NOT counted in the "Need Attention" total and do NOT receive priority numbers:

```
Recently closed (informational):
- {repo}#{number} — {title} (closed without merge on {closedAt date})
```

These do not require any action. They exist so the user knows what was closed. The Auto-Exclude prompt (in the work-through-issues workflow) may offer to exclude these repos from future searches.

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

### Handling Informational Questions

When the user types a simple question via "Other" input (or at any point during the session), determine whether it's **informational** or **actionable**:

| Type | Examples | Behavior |
|------|----------|----------|
| **Informational** | "show me a link to issue #1", "what's the URL for PR #123", "how many PRs do I have open?", "list my healthy PRs", "what did the maintainer say on ink#855?" | Respond with the requested information as **text only**. Do NOT follow up with AskUserQuestion. Let the user read the answer and send their next message. |
| **Actionable** | "fix #1", "address all issues", "search for new issues", "rebase ink#855" | Execute the action, then prompt with AskUserQuestion as usual. |

**Why:** In Claude Code, AskUserQuestion renders as an interactive picker that replaces preceding text output. If informational text is immediately followed by a prompt, the user sees the answer for a brief moment before it's hidden behind the picker.

**Rule of thumb:** If the user's input is purely asking for information (starts with "what", "how many", "which", "where") or uses display verbs ("show", "list") without an accompanying action verb ("fix", "address", "rebase", "search"), treat it as informational. If the input contains both an informational request and an action (e.g., "show me the CI logs and fix #3"), treat it as actionable. This heuristic applies equally when the user sends a free-form message outside of an AskUserQuestion picker.

**After an informational response:** When the user sends their next message, route it through the same informational-vs-actionable classification. If their follow-up is actionable or selects a menu item, return to normal Step 3 flow.

---

## Step 1b: CLI Error Recovery

Show any captured error output (from `$BUILD_LOG`, stderr, or the `error` field). Then troubleshoot based on the error type:

- **Build failure** (BUILD_FAILED sentinel): `cd ${CLAUDE_PLUGIN_ROOT} && npm install && npm run bundle`. Common causes: missing Node.js 20+, stale `node_modules` (delete and reinstall), npm permission issues.
- **Auth/network error** (`success: false` with valid JSON): Check `gh auth status` and network connectivity. The CLI built fine — the daily check itself failed.
- **Invalid output** (empty or non-JSON): Try running manually: `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" startup --json`. Check `node --version` (need 20+).

---

## Step 4: Action Handlers

### Action Tiers

| Tier | Scope | Examples | Agent Behavior |
|------|-------|----------|---------------|
| **Tier 1** — Routine Maintenance | Non-destructive, no code logic changes | Rebase, clone, fetch upstream | Execute directly (with user consent). Report result. |
| **Tier 2** — Code Changes | Changes code or posts public content | CI fixes, conflict resolution, review responses, missing files | Investigate and recommend. All writes require explicit user approval. |

**After Tier 2 code changes, ALWAYS proceed to Step 5.5 (Pre-Commit Code Review) before committing or pushing.**

### Phase Routing Table

When the user selects an action from the menu above, **read the relevant workflow file** using the Read tool:

| User Action | Workflow File | Entry Point |
|-------------|---------------|-------------|
| "Work through all issues" | `${CLAUDE_PLUGIN_ROOT}/workflows/work-through-issues.md` | "Handle Work Through All Issues" |
| "Pick from your issue list" | `${CLAUDE_PLUGIN_ROOT}/workflows/work-through-issues.md` | "Handle Pick Issue From List" |
| Specific PR selection (via "Other") | `${CLAUDE_PLUGIN_ROOT}/workflows/work-through-issues.md` | "Handle Specific PR Selection" |
| "Review issue replies" | Handled in core (below) | "Handle Review Issue Replies" |
| "Search for new issues" | Handled in core (below) | "Handle Find New Issues" |
| "Done for now" | Handled in core (below) | "Step 5: Session End" |

**After completing any workflow**, return here for "After Each Action" and "Session End" logic.

**If a workflow file fails to load** (Read tool returns error): Tell the user which file could not be loaded and the error. Suggest reinstalling the plugin (`/plugin install oss-autopilot@oss-autopilot`). Do NOT attempt to reconstruct the workflow from memory.

For CLI command syntax and agent names, read: `${CLAUDE_PLUGIN_ROOT}/workflows/reference.md`

### Handle "Review Issue Replies"

When the user selects "Review issue replies", display each commented issue with a maintainer response from `data.daily.commentedIssues` (filtered to `status === 'new_response'`):

```
## Issue Replies

Maintainers responded to your comments on these issues:

1. **owner/repo#123** — Issue title
   └─ @maintainer: "Go for it! Feel free to submit a PR..."
   └─ Your comment: 5 days ago

2. **owner/repo#456** — Another issue title
   └─ @maintainer: "Thanks for the interest. Here's what..."
   └─ Your comment: 2 days ago
```

For each issue, use AskUserQuestion to offer actions:
- "Claim this issue" — Run `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" claim ISSUE_URL --json` to add it to the tracked pipeline. Also auto-dismiss by running `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" dismiss ISSUE_URL --json`. Then proceed to work on it.
- "Mark as reviewed" — The user has seen the reply but doesn't want to claim the issue right now. Dismiss it so it won't reappear next session: run `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" dismiss ISSUE_URL --json`. If a genuinely new response arrives later (after the dismiss timestamp), the auto-undismiss logic will resurface it.
- "View full thread" — Display the issue URL for the user to open in browser. After viewing, re-prompt with the same options for this issue (do not advance to the next issue).
- "Skip" — Leave the reply undismissed. It will reappear next session. Use this when the user wants to defer action to a future session.

After processing all issue replies (or user chooses to stop), return to Step 3 to present action choices again.

### Handle "View Healthy PRs"

Show when `capacity.hasCapacity === false` (user has critical issues to address first).

Look up healthy PRs by resolving each URL in `data.daily.digest.healthyPRs` against `data.daily.digest.openPRs`:

```javascript
const healthyPRs = data.daily.digest.healthyPRs.map(url =>
  data.daily.digest.openPRs.find(pr => pr.url === url)
);
```

```
Healthy PRs (no action needed):

- owner/repo#123 - Title here (approved, CI passing)
- owner/repo#456 - Title here (waiting for review)
...

These PRs are progressing normally. Focus on the {count} issues that need attention.
```

Then return to Step 3 to present action choices again.

### Handle "Find New Issues"

The full search workflow is in the `/oss-search` command. Tell the user:
> "Starting issue search — this uses the `/oss-search` workflow."

Then invoke `/oss-search`, passing session state (`hasIssueList`, `availableCount`, `completedCount`, `issueListPath`).

When the user claims any issue found through search and starts implementing, set `isNewContribution = true` and `issueContext = { title, url, description }`. This activates the draft-first workflow (see Step 5.5 routing below).

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

### Routing

**Check `isNewContribution`** (set in Step 4 when the user claims an issue and starts implementing):

- **If `isNewContribution === true`:** Read `${CLAUDE_PLUGIN_ROOT}/workflows/draft-first-workflow.md` and follow the Draft-First Path. This covers Steps 5.5 (draft creation) → 5.6 (review cycle) → 5.6b (integration check) → 5.7b (manual testing) → 5.7 (squash) → 5.8 (mark ready) → 6 (compliance) → 6.5 (list updates).
- **If `isNewContribution === false` (or not set):** Read `${CLAUDE_PLUGIN_ROOT}/workflows/pre-commit-review.md` and follow the Standard Path for existing PR updates.

---

## Important Rules

### Human-in-the-Loop
1. **Tier 1 (maintenance)**: Rebase + force push is allowed after user selects "Work through all issues" or explicitly approves
2. **Tier 2 (code/comments)**: NEVER push code or post comments without explicit per-action approval
3. **Agents report results** for Tier 1, **investigate and recommend** for Tier 2
4. In Phase C, present Tier 2 items one at a time for sequential approval and execution

### Workflow Control (CRITICAL)
5. **After workflow actions, always ask what's next** - after completing a workflow action (addressing a PR, running maintenance, searching for issues), prompt the user for the next step. **Exception:** If the user asked a simple informational question (e.g., "show me a link to issue #1", "what's the status of PR #5"), respond with text only — no AskUserQuestion. See "Handling Informational Questions" in Step 3.
6. **Drive the conversation** - Claude controls the flow, user responds to prompts
7. **Session ends ONLY when user selects "Done for now"** - never assume user is finished
8. **ALWAYS include "Done for now"** in every AskUserQuestion (when one is used — see rule 14 for the informational exception)
9. **Draft-first workflow is mandatory** — after Step 5.5, complete all steps (5.6 → 5.6b → 5.7b → 5.7) in order before reaching Step 5.8. The `gh pr ready` call belongs exclusively in Step 5.8. Never skip to it directly.

### UX Guidelines
10. Keep responses professional and concise
11. **NEVER add AI attribution** to commits, comments, or PRs — no `Co-Authored-By` trailers, no "Generated with Claude Code", no robot emoji, no mentions of AI assistance
12. **Display information before prompting** - show all PRs as text FIRST, then ask for action
13. **Parse "Other" input flexibly** - accept PR numbers, URLs, repo refs like "ink#861"
14. **Don't prompt after informational responses** - see "Handling Informational Questions" in Step 3 for details

### Failure Protocol
15. **When a task or approach fails, STOP and report back to the user.** Do not silently switch to a fallback strategy, skip the failed step, or improvise a workaround. Explain what failed, why it failed, and what the options are — then let the user decide how to proceed. This applies to tool failures, automation failures, file operations, CI issues, agent failures, or any other task that does not succeed as intended. **Exception:** Fallbacks that are explicitly documented in the workflow or agent instructions (e.g., gh CLI fallback when the TypeScript CLI fails) are permitted, but ONLY if the user is informed before the fallback executes. Undocumented or improvised fallbacks are never permitted.

### Issue List Continuity
16. **After completing a PR from the issue list**, always offer to: (a) update the issue list to mark the item as done, (b) return to the remaining items on the list, or (c) find new issues. Never end the flow without offering to continue through the issue list. If the issue list file cannot be read or written, report the error and file path to the user — do NOT attempt to reconstruct the list from memory or other sources. Then offer: (a) specify a new path, (b) switch to search-based discovery, or (c) done for now.
17. **Context retention** — when working through the issue list, track which items have been addressed this session and which remain. Use this to avoid re-presenting completed items and to provide accurate remaining counts.

### Parallel Execution
18. **Group PRs by repository** - one agent per repo, not per PR, to avoid branch checkout conflicts
19. **Parallel execution** - when addressing multiple repos, launch ALL agents in a SINGLE message, then present consolidated results table
