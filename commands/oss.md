---
name: oss
description: "Daily OSS contribution check - uses CLI with --json for structured data"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, mcp__plugin_oss-autopilot_*
---

# OSS Autopilot Daily Check

This command checks your open source PRs and provides a summary of what needs attention.

## Workflow Architecture

This command (`oss.md`) is the **core router** that orchestrates the entire flow. It delegates complex actions to external workflow files:

```
/oss (this file)
 │
 ├─ Startup ──► workflows/startup-and-build.md
 │   Build CLI, run startup command, parse output, error recovery
 │
 ├─ Summary ─── First-Run Welcome (if no PRs)
 │
 ├─ Action Menu ──► workflows/action-menu.md
 │   Display PRs, present menu, parse input ───┐
 │                                              │
 │   ┌─────────────────────────────────────────┘
 │   │
 │   ├─ "Work through all issues" ──► workflows/work-through-issues.md
 │   │   Parallel investigation → consolidated results → sequential execution
 │   │
 │   ├─ "Pick from your issue list" ──► workflows/work-through-issues.md
 │   │   Display curated list → vet → implement → draft-first workflow
 │   │
 │   ├─ Specific PR (via "Other") ──► workflows/work-through-issues.md
 │   │   Dispatch agents for selected PRs only
 │   │
 │   ├─ "Search for new issues" ──► /oss-search command
 │   │   Parallel multi-strategy search with vetting
 │   │
 │   ├─ "Review issue replies" ──► workflows/review-issue-replies.md
 │   │   Issue reply triage handler
 │   │
 │   ├─ "Follow up on dormant PRs" ──► workflows/dormant-pr-follow-up.md
 │   │   Surface waiting-on-maintainer PRs past the 7/14/30-day cadence and draft
 │   │   a polite follow-up via the draft-review-post skill (user posts themselves)
 │   │
 │   └─ "Done for now" ──► Session End
 │
 ├─ Pre-Commit Review (after any code changes) ──┐
 │   │                                             │
 │   ├─ New contribution? ──► workflows/draft-first-workflow.md
 │   │   Steps 1-10: pre-flight → commit → review → integration check →
 │   │   manual testing → human review → squash → push + create PR → compliance → list update
 │   │
 │   └─ Existing PR update? ──► workflows/pre-commit-review.md
 │       Gather diff → dispatch review agents → consolidate → commit/push → post comment
 │
 └─ Session End
```

| Workflow File | Purpose | When Invoked |
|---------------|---------|-------------|
| `workflows/startup-and-build.md` | CLI build, startup command, output parsing, error recovery | On entry (Startup phase) |
| `workflows/action-menu.md` | PR display, menu rendering, input parsing, informational questions | After Summary, after each action |
| `workflows/review-issue-replies.md` | Issue reply triage and dismiss handler | User selects "Review issue replies" |
| `workflows/dormant-pr-follow-up.md` | Drafts a polite follow-up for PRs waiting on maintainer (7/14/30-day cadence) | User selects "Follow up on dormant PRs" or invokes from action menu |
| `workflows/work-through-issues.md` | Orchestrate actionable PR resolution and issue list browsing | User selects "Work through all issues", "Pick from list", or specific PRs |
| `workflows/draft-first-workflow.md` | Full new contribution pipeline (10 steps) | After selecting an issue and implementing changes |
| `workflows/pre-commit-review.md` | Code review gate for existing PR updates | After Tier 2 code changes to an existing PR |
| `workflows/reference.md` | CLI command syntax, agent name reference, AskUserQuestion Validation Protocol | On demand when command syntax or validation rules are needed |

## Startup

Read `${CLAUDE_PLUGIN_ROOT}/workflows/startup-and-build.md` and follow the instructions. After startup completes, continue to **Summary** below.

---

## Summary

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
        "needsAddressingPRs": ["https://github.com/owner/repo/pull/456"],
        "waitingOnMaintainerPRs": ["https://github.com/owner/repo/pull/123"],
        ...
      }
    },
    "dashboardUrl": "http://localhost:3000",
    "issueList": { "path": "open-source/potential-issue-list.md", "source": "auto-detected", "availableCount": 5, "completedCount": 3 }
  }
}
```

**Important: Compact JSON format (#287)**

The JSON output uses a deduplicated format to reduce payload size:
- Full PR objects live **only** in `digest.openPRs`.
- Category arrays (`needsAddressingPRs`, `waitingOnMaintainerPRs`) contain **PR URL strings**, not full objects. Look up full PR details via: `data.daily.digest.openPRs.find(pr => pr.url === url)`.
- `actionableIssues[].prUrl` is a URL string. Look up the full PR via: `data.daily.digest.openPRs.find(pr => pr.url === issue.prUrl)`.
- `repoGroups[].prUrls` are URL string arrays. Look up each PR from `digest.openPRs`.

**Display the `briefSummary` field with the version from `data.version`:**

```
data.daily.briefSummary + " | v" + data.version
```

Example output:
> 📊 16 Active PRs | 3 need attention | Interactive dashboard opened in browser | v0.42.6

If `data.dashboardUrl` is present, show it on a separate line so the user can re-open it:
```
Dashboard: data.dashboardUrl
```

Then check for auto-detected welcome (below), first-run, or proceed to **Action Menu**.

---

### Auto-Detected Welcome

If `data.autoDetected === true`, this is a zero-config first run. Show a welcome message before proceeding:

```
Welcome to OSS Autopilot! I detected your GitHub account and fetched your PRs automatically.

Run /setup-oss anytime to customize your preferences (languages, labels, PR limits, etc.).
```

Then continue to either **First-Run Welcome** (if 0 PRs) or **Action Menu** (if PRs exist).

---

### First-Run Welcome (Empty State)

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
- **Search for issues** → Invoke `/oss-search` directly (passing session state: `hasIssueList`, `availableCount`, `completedCount`, `issueListPath`). No intermediate hop.
- **Import existing PRs** → Run the import command: `GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" init "$(gh api user --jq '.login')" --json`. If it succeeds, re-run `startup --json` (`GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" startup --json 2>/tmp/oss-startup-stderr.log`) and parse the result from the top (same routing as the initial startup call). If it fails, show the error and suggest checking `gh auth status`.
- **Just exploring** → Show a brief tip: "Run `/oss` whenever you want to check on your contributions. It works best when you have a few open PRs to track." Then end.

**Skip this step** if `totalActivePRs > 0` — go directly to **Action Menu**.

---

## Action Menu

**If `data.daily.strategySummary` is present and non-null** (#1270), render a brief snapshot inline ahead of the action options. The cadence gate fires every 30 days OR after 5+ PRs merge since the last snapshot, whichever comes first; below the merge floor (`STRATEGY_MIN_PRS = 10`) the field is omitted.

Format:

```
## Strategy snapshot
- {profile.totalPRs} PRs tracked, {profile.mergedCount} merged ({Math.round(profile.mergeRate × 100)}% merge rate). Profile: {profile.style}.
- {capacity.dormantPRCount} dormant PR(s) across {capacity.dormantRepoCount} repo(s). {SUGGESTED_ACTION_PROSE}
- Top languages: {profile.primaryLanguages.join(', ')}. Top repos: {profile.favoriteRepos.join(', ')}.
- Pattern: {patterns.trajectoryDirection}.

For a deeper dive, ask the contribution-strategist agent.
```

`SUGGESTED_ACTION_PROSE` is a fixed mapping from `capacity.suggestedAction` — render exactly the matching string, do NOT paraphrase:

| `suggestedAction` | Prose |
|---|---|
| `'open_more'` | "Capacity to open more PRs." |
| `'follow_up_dormant'` | "Follow up on dormant PRs before opening more." |
| `'wait_on_maintainers'` | "Wait on maintainers; don't open new PRs yet." |
| `null` | omit the sentence (and the trailing period after `repo(s)`) |

If `recommendations.avoidPatterns` is non-empty, append a fifth bullet `- Watch for: {recommendations.avoidPatterns[0]}` — those strings come from `computeStrategy()` pre-formatted, render verbatim.

Then read `${CLAUDE_PLUGIN_ROOT}/workflows/action-menu.md` and follow the instructions to display PRs and present the action menu. After the user selects an action, continue to **Execute** below.

---

## Execute

### Action Tiers

| Tier | Scope | Examples | Agent Behavior |
|------|-------|----------|---------------|
| **Tier 1** — Routine Maintenance | Non-destructive, no code logic changes | Rebase, clone, fetch upstream | Execute directly (with user consent). Report result. |
| **Tier 2** — Code Changes | Changes code or posts public content | CI fixes, conflict resolution, review responses, missing files | Investigate and recommend. All writes require explicit user approval. |

**After Tier 2 code changes, ALWAYS proceed to Pre-Commit Review before committing or pushing.**

### Phase Routing Table

When the user selects an action from the menu above, **read the relevant workflow file** using the Read tool:

| User Action | Workflow File | Entry Point |
|-------------|---------------|-------------|
| "Work through all issues" | `${CLAUDE_PLUGIN_ROOT}/workflows/work-through-issues.md` | "Handle Work Through All Issues" |
| "Pick from your issue list" | `${CLAUDE_PLUGIN_ROOT}/workflows/work-through-issues.md` | "Handle Pick Issue From List" |
| Specific PR selection (via "Other") | `${CLAUDE_PLUGIN_ROOT}/workflows/work-through-issues.md` | "Handle Specific PR Selection" |
| "Review issue replies" | `${CLAUDE_PLUGIN_ROOT}/workflows/review-issue-replies.md` | "Handle Review Issue Replies" |
| "Follow up on stuck-CI / dormant PRs" (`follow_up`) | `${CLAUDE_PLUGIN_ROOT}/workflows/dormant-pr-follow-up.md` | "Trigger" |
| "Search for new issues" | Handled in core (below) | "Handle Find New Issues" |
| "Done for now" | Handled in core (below) | "Session End" |

**After completing any workflow**, return here for "After Each Action" and "Session End" logic.

**If a workflow file fails to load** (Read tool returns error): Tell the user which file could not be loaded and the error. Suggest reinstalling the plugin (`/plugin install oss-autopilot@oss-autopilot`). Do NOT attempt to reconstruct the workflow from memory.

For CLI command syntax and agent names, read: `${CLAUDE_PLUGIN_ROOT}/workflows/reference.md`

### Handle "View Waiting PRs"

Show when `capacity.hasCapacity === false` (user has critical issues to address first).

Look up waiting PRs by resolving each URL in `data.daily.digest.waitingOnMaintainerPRs` against `data.daily.digest.openPRs`:

```javascript
const waitingPRs = data.daily.digest.waitingOnMaintainerPRs.map(url =>
  data.daily.digest.openPRs.find(pr => pr.url === url)
);
```

```
Waiting on Others (no action needed):

- owner/repo#123 - Title here (approved, CI passing)
  https://github.com/owner/repo/pull/123
- owner/repo#456 - Title here (waiting for review)
  https://github.com/owner/repo/pull/456
...

These PRs are progressing normally. Focus on the {count} issues that need attention.
```

Then return to **Action Menu** to present action choices again.

### Handle "Find New Issues"

The full search workflow is in the `/oss-search` command. Tell the user:
> "Starting issue search — this uses the `/oss-search` workflow."

Then invoke `/oss-search`, passing session state (`hasIssueList`, `availableCount`, `completedCount`, `issueListPath`).

When the user selects any issue found through search and starts implementing, set `isNewContribution = true` and `issueContext = { title, url, description }`. This activates the draft-first workflow (see **Pre-Commit Review** below).

### After Each Action

1. **If ANY Tier 1 actions were taken** (rebases, force pushes), regardless of whether Tier 2 actions also occurred:
   - Re-run the daily check to refresh state
   - Return to **Action Menu** with updated action choices
2. **If ONLY Tier 2 actions were taken** (comment responses, code fixes, missing file additions) with no Tier 1 actions in this round:
   - Skip the daily re-run — the existing data is still valid
   - Remove completed items from the current action list
   - Inform the user: "Skipping full refresh — showing locally updated action list. Select 'Check for more PR updates' for a fresh check."
   - Return to **Action Menu** with current action choices
   - **Exception:** If any completed action involved merge conflict resolution (issue type `merge_conflict` from the actionableIssues list), treat the entire batch as Tier 1 and re-run the daily check
3. If `hasIssueList`, re-read the list file to get updated available/completed counts
4. Continue until user selects "Done for now"

---

## Pre-Commit Review

**Trigger:** After ANY Tier 2 code changes are made (code modified but not yet committed/pushed). This includes CI fixes, conflict resolution, addressing review feedback, adding missing files, or any other code modification.

This is a quality gate that catches issues before they reach the maintainer.

### Routing

**Check `isNewContribution`** (set in Execute when the user selects an issue and starts implementing):

- **If `isNewContribution === true`:** The feature branch MUST have been created from the upstream default branch per the Branch Setup Protocol in `${CLAUDE_PLUGIN_ROOT}/workflows/work-through-issues.md` Step 6. If no feature branch exists yet (e.g., the user started coding on the default branch), create one before proceeding. Read `${CLAUDE_PLUGIN_ROOT}/workflows/draft-first-workflow.md` and follow the Draft-First Path. This covers Steps 1 (pre-flight) → 2 (commit) → 3 (review cycle) → 4 (integration check) → 5 (manual testing) → 6 (human review) → 7 (squash) → 8 (push + create PR) → 9 (compliance) → 10 (list updates).
- **If `isNewContribution === false` (or not set):** Read `${CLAUDE_PLUGIN_ROOT}/workflows/pre-commit-review.md` and follow the Standard Path for existing PR updates.

---

## Session End

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

## Rules

### Human-in-the-Loop
1. **Tier 1 (maintenance)**: Rebase + force push is allowed after user selects "Work through all issues" or explicitly approves
2. **Tier 2 (code/comments)**: NEVER push code or post comments without explicit per-action approval
3. **Agents report results** for Tier 1, **investigate and recommend** for Tier 2
4. When working through actionable issues (see `workflows/work-through-issues.md` Phase C), present Tier 2 items one at a time for sequential approval and execution

### Workflow Control (CRITICAL)
5. **After workflow actions, always ask what's next** - after completing a workflow action (addressing a PR, running maintenance, searching for issues), prompt the user for the next step. **Exception:** If the user asked a simple informational question (e.g., "show me a link to issue #1", "what's the status of PR #5"), respond with text only — no AskUserQuestion. See "Handling Informational Questions" in `workflows/action-menu.md`.
6. **Drive the conversation** - Claude controls the flow, user responds to prompts
7. **Session ends ONLY when user selects "Done for now"** - never assume user is finished
8. **ALWAYS include "Done for now"** in every AskUserQuestion (when one is used — see rule 14 for the informational exception)
9. **Draft-first workflow is mandatory** — complete all draft-first workflow steps (Steps 1–7 in `draft-first-workflow.md`) in order before reaching Step 8 (Push + Create PR). The `gh pr create` call belongs exclusively in Step 8. Never push or create a PR before all review gates pass.

### UX Guidelines
10. Keep responses professional and concise
11. **NEVER add AI attribution** to commits, comments, or PRs — no `Co-Authored-By` trailers, no "Generated with Claude Code", no robot emoji, no mentions of AI assistance
12. **Display information before prompting** - show all PRs as text FIRST, then ask for action
13. **Parse "Other" input flexibly** - accept PR numbers, URLs, repo refs like "ink#861"
14. **Don't prompt after informational responses** - see "Handling Informational Questions" in `workflows/action-menu.md` for details

### Failure Protocol
15. **When a task or approach fails, STOP and report back to the user.** Do not silently switch to a fallback strategy, skip the failed step, or improvise a workaround. Explain what failed, why it failed, and what the options are — then let the user decide how to proceed. This applies to tool failures, automation failures, file operations, CI issues, agent failures, or any other task that does not succeed as intended. **Exception:** Fallbacks that are explicitly documented in the workflow or agent instructions (e.g., gh CLI fallback when the TypeScript CLI fails) are permitted, but ONLY if the user is informed before the fallback executes. Undocumented or improvised fallbacks are never permitted.

### Issue List Continuity
16. **After completing a PR from the issue list**, always offer to: (a) update the issue list to mark the item as done, (b) return to the remaining items on the list, or (c) find new issues. Never end the flow without offering to continue through the issue list. If the issue list file cannot be read or written, report the error and file path to the user — do NOT attempt to reconstruct the list from memory or other sources. Then offer: (a) specify a new path, (b) switch to search-based discovery, or (c) done for now.
17. **Context retention** — when working through the issue list, track which items have been addressed this session and which remain. Use this to avoid re-presenting completed items and to provide accurate remaining counts.

### Parallel Execution
18. **Group PRs by repository** - one agent per repo, not per PR, to avoid branch checkout conflicts
19. **Parallel execution** - when addressing multiple repos, launch ALL agents in a SINGLE message, then present consolidated results table

### Input Validation
20. **Validate every AskUserQuestion response** per the "AskUserQuestion Validation Protocol" in `workflows/reference.md`.
