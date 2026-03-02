# Work Through Issues

> **Session state:** Expects `actionableIssues`, `hasIssueList`, `issueListPath`, `availableCount`, `completedCount` from core router.
> **Routing:** Routes to `${CLAUDE_PLUGIN_ROOT}/workflows/pre-commit-review.md` for Tier 2 code changes on existing PRs. Routes to `${CLAUDE_PLUGIN_ROOT}/workflows/draft-first-workflow.md` when an issue is claimed and implementation begins. Returns to the core router (`commands/oss.md`) for "After Each Action" and "Session End".
> **Input validation:** The "AskUserQuestion Validation Protocol" from `commands/oss.md` applies to ALL `AskUserQuestion` calls in this file. After every call, check for empty/missing answers and fall back to text-based input if the picker auto-completed.

---

## Same-Repo PR Grouping

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
  3. If behind, rebase and push with --force-with-lease (see rebase push protocol below)
  4. Check CI status and review comments
  Report results for all 3 PRs.")
```

NOT:
```
Task(general-purpose, "Check ink#855...")
Task(general-purpose, "Check ink#856...")  // Will conflict with branch checkout!
Task(general-purpose, "Check ink#863...")
```

## Local Repo Registry

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

## Handle "Work Through All Issues"

This flow uses a three-phase approach: parallel investigation, consolidated presentation, and sequential execution with user control.

**CRITICAL: Group PRs by repository — one agent per repo, not per PR.**

### Phase A: Parallel Maintenance + Investigation

**CRITICAL: Dispatch ALL agents in a SINGLE message for true parallelism.**

For each issue in `actionableIssues`, include a Task tool call grouped by repo:

| Issue Type | Tier | Agent Action |
|------------|------|--------------|
| Needs Rebase | Tier 1 | Clone if needed, fetch upstream, rebase, push with `--force-with-lease` (see rebase push protocol). Report result. |
| CI Failing | Tier 2 | Investigate CI failures. Analyze logs, identify root cause, recommend fixes. DO NOT push code fixes without approval. If a re-run is needed, attempt `gh run rerun <id> --repo <repo> --failed`. If it fails (permission error, non-rerunnable state, or other error), report the error and suggest alternatives for user approval: push an empty commit to retrigger, ask maintainer to re-run, or wait. |
| CI Blocked | Info | Report that CI needs maintainer trigger. Suggest commenting to request it. |
| CI Not Running | Info | Investigate why CI isn't running. Check if workflows exist, if fork has actions enabled. |
| Fork Limitation | Info | Note as expected — no action needed. |
| Merge Conflict | Tier 2 | Identify conflicting files, recommend resolution strategy (see pr-health-checker's "Merge Conflict Resolution Strategies" for direct resolution vs squash-and-reapply vs asking the maintainer). DO NOT push. |
| Needs Response | Tier 2 | Analyze maintainer feedback, draft a response. DO NOT post — return for approval. |
| Changes Requested | Tier 2 | Analyze requested changes, investigate what needs to change, recommend approach. |
| Changes Addressed | Info | Note that changes were pushed after maintainer review — no contributor action needed, awaiting re-review. |
| Missing Required Files | Tier 2 | Identify what's missing (changeset, CLA, etc.), draft the file. DO NOT push. |

**Agent dispatch prompt template for comprehensive PR check:**

```
Check PR status for {repo}: {list of PR numbers}.
Local repo path: {path or "not cloned"}.

For each PR:
1. If not cloned, clone to ~/Documents/oss/{repo-name}
2. git checkout the PR branch
3. Fetch upstream, check how many commits behind
4. If behind and rebase is clean, push using the rebase push protocol below (Tier 1 - auto-safe)
5. If rebase has conflicts, abort and report the conflicts (Tier 2 - needs manual resolution)
6. Check CI status: gh pr checks {number} --repo {repo}
7. Check for review comments and changes requested
8. Check for bot comments (changeset-bot, CLA bot, etc.)

**Rebase Push Protocol (MANDATORY for all force pushes after rebase):**
After a successful rebase, you MUST follow these steps in order:
  a. Set upstream tracking: git branch --set-upstream-to=origin/{branch} {branch}
  b. Fetch the latest remote ref: git fetch origin {branch}
  c. Push with: git push --force-with-lease
  d. NEVER fall back to git push --force. If --force-with-lease fails, abort and report
     the error to the user. The --force-with-lease safety check exists to prevent
     overwriting commits pushed by others. Falling back to --force defeats this protection.

Report back:
(a) Commits behind / rebase result
(b) CI status (passing/failing/blocked/not running)
(c) Review comments and their status
(d) Any missing required files
(e) Whether --force-with-lease push was performed (or failed and why)
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

### Phase B: Present Consolidated Results

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
| 3 | repo#789 | incomplete_checklist | Missing changelog entry | Small | Add changeset file |

**Key findings:**
- **repo#123**: Maintainer wants X. 2-line fix in `file.ts`.
- **repo#456**: 3 changes requested. Tests need updating.
- **repo#789**: Missing changelog entry required by changeset-bot.
```

Populate the table using data from the Phase A agent results:
- **PR**: `{repo}#{number}` — short form
- **Status**: From `issue.type` (needs_response, needs_changes, ci_failing, etc.)
- **Maintainer Ask**: 1-line summary of what the maintainer requested (from agent investigation findings)
- **Effort**: Use the same heuristic as the Action Menu display (Small/Medium/Large)
- **Recommended Action**: Brief action description from agent findings

**Key findings**: 1-line summary per PR from the agent investigation results. Focus on what the maintainer is asking and what code change is needed.

### Phase C: Sequential Tier 2 Execution

If no Tier 2 items remain after Phase A:
> "All issues were routine maintenance (rebases, status checks) — handled automatically. No code changes needed."
> Return to the core router (`commands/oss.md`) — "After Each Action" section.

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
3. After completing the action, if code was changed, route to Pre-Commit Review in the core router — it will read the appropriate workflow file based on `isNewContribution`. After the review completes, return here to Phase C's loop.

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

Return to the core router (`commands/oss.md`) — "After Each Action" section.

**Phase C and "After Each Action" interaction:** The "After Each Action" logic runs ONCE after Phase C ends — NOT between individual Phase C actions. During Phase C's sequential loop, track what was done but defer the state refresh. Pass the combined Tier 1 (from Phase A) and Tier 2 (from Phase C) actions to "After Each Action" so it can decide whether a daily re-run is needed.

### Pre-Commit Gate (MANDATORY)

**STOP. Before presenting commit/push options to the user, you MUST complete the Pre-Commit Code Review.** Do not skip this step. Do not offer to commit first. Run the review agents, present findings, THEN offer commit options. The only exception is if `git status --porcelain` confirms there are no uncommitted changes (e.g., only a comment was posted, or the action was investigation-only). Always verify with git status — do not assume based on which actions were dispatched.

**Routing:** Read `${CLAUDE_PLUGIN_ROOT}/workflows/pre-commit-review.md` for the pre-commit review. That file will check `isNewContribution` and route to the draft-first workflow if needed.

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
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" config exclude-repo {repo} --json
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

---

## Handle "Pick Issue From List"

Only available when `hasIssueList` is true and `availableCount > 0`.

### 1. Read and parse the list file

Re-read the file at `issueListPath` (it may have been updated since initial detection). Parse available issues — those NOT struck through and NOT marked "**Done**".

### 2. Display available issues grouped by priority tier

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

### 3. Ask user to pick

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

### 4. Vet the selected issue

Dispatch the `issue-scout` agent to vet the picked issue. Pass the issue URL and note that it came from the curated list:

```
Task(issue-scout, "Vet this issue from the user's curated list:
  URL: {issue_url}
  Source: curated-list (pre-vetted, apply +2 score bonus)
  Verify it's still open, unassigned, and claimable.
  Check for recent claims or linked PRs since the list was last updated.")
```

### 5. Present vetting results and offer to claim

Show the vetting summary. If claimable, offer:
- "Claim this issue and start working"
- "Pick a different issue from the list"
- "Search GitHub instead"
- "Done for now"

### 6. After claiming → implementation → draft PR → review → ready

When the user claims an issue and starts implementing, set:
- `isNewContribution = true`
- `issueContext = { title, url, description }` — the issue being addressed (used for scope-aware review)
- **Choose a consistent change type** based on the issue labels and nature of the change. Use this type for both the branch prefix and the commit message to avoid mismatches flagged by the compliance checker:
  - Issue labeled `bug` or fixes broken behavior → `fix/` branch, `fix:` commit
  - Issue labeled `enhancement`, `feature`, or adds new functionality → `feat/` branch, `feat:` commit
  - Documentation-only changes → `docs/` branch, `docs:` commit
  - If ambiguous, prefer `fix/` for correcting existing behavior and `feat/` for adding new capabilities

After implementation, the flow proceeds through the **draft-first workflow** (`${CLAUDE_PLUGIN_ROOT}/workflows/draft-first-workflow.md`):
1. Step 1 creates the draft PR
2. Step 2 runs iterative review cycle (scope-aware, tied to `issueContext`)
3. Step 3 checks new files are properly integrated (imports, registrations)
4. Step 4 offers manual testing prompt (build/run the project locally)
5. Step 5 squashes commits and rewords message
6. Step 6 marks PR ready for review after user confirmation
7. Step 7 runs compliance check
8. Step 8 offers list updates (if issue came from curated list)

**CRITICAL: Track that the current issue came from the curated list** so Step 8 knows to offer list updates.
