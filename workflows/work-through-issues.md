# Work Through Issues

> **Session state:** Expects `actionableIssues`, `hasIssueList`, `issueListPath`, `availableCount`, `completedCount` from core router.
> **Routing:** Routes to `${CLAUDE_PLUGIN_ROOT}/workflows/pre-commit-review.md` for Tier 2 code changes on existing PRs. Routes to `${CLAUDE_PLUGIN_ROOT}/workflows/draft-first-workflow.md` when implementation begins on a new issue. Returns to the core router (`commands/oss.md`) for "After Each Action" and "Session End".
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

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

**Per-repo guidelines pre-fetch (#867, #1294 step 3).** Before assembling the dispatch, identify the set of repos with at least one **Tier 2** issue type (`Needs Response`, `Changes Requested`, `CI Failing`, `Merge Conflict`, `Missing Required Files`). For each such repo, fetch any stored guidelines once:

```bash
GUIDELINES_OUT=$(GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" guidelines view --repo {owner}/{repo} --json 2>/dev/null)
```

Cache the parsed `data.content` per repo. Routine-maintenance-only repos (Tier 1: rebase, CI status check, "no action needed" report) do NOT load guidelines — maintainer preferences don't change a clean rebase.

If a fetch fails or `data.exists === false`, skip that repo silently (the dispatch proceeds without guidelines).

For each issue in `actionableIssues`, include a Task tool call grouped by repo:

| Issue Type | Tier | Agent Action |
|------------|------|--------------|
| Needs Rebase | Tier 1 | Clone if needed, fetch upstream, rebase, push with `--force-with-lease` (see rebase push protocol). Report result. |
| CI Failing | Tier 2 | Investigate CI failures. Analyze logs, identify root cause, recommend fixes. DO NOT push code fixes without approval. If a re-run is needed, attempt `gh run rerun <id> --repo <repo> --failed`. If it fails (permission error, non-rerunnable state, or other error), report the error and suggest alternatives for user approval: push an empty commit to retrigger, ask maintainer to re-run, or wait. |
| CI Blocked | Info | Report that CI needs maintainer trigger. Suggest commenting to request it. |
| CI Not Running | Info | Investigate why CI isn't running. Check if workflows exist, if fork has actions enabled. |
| Fork Limitation | Info | Note as expected — no action needed. |
| Merge Conflict | Tier 2 | Identify conflicting files, recommend resolution strategy (see pr-health-checker's "Merge Conflict Resolution Strategies" for direct resolution vs squash-and-reapply vs asking the maintainer). DO NOT push. |
| Needs Response | Tier 2 | Analyze maintainer feedback, draft a response (see Code Verification Rules below). DO NOT post — return for approval. |
| Changes Requested | Tier 2 | Analyze requested changes, identify what's addressed vs outstanding (see Code Verification Rules below). Recommend approach. |
| Waiting on Maintainer | Info | Note that the ball is in the maintainer's court — either approved and waiting for merge, or changes were pushed after review and awaiting re-review. No contributor action needed. |
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

**Code Verification Rules (MANDATORY):** follow the **Claim Verification Protocol** in
`workflows/reference.md` (rules 1-5). In particular, verify every "already addressed"
claim by reading the current file, run commands rather than inferring their outputs,
distinguish what the LATEST review round asks for from earlier rounds, state explicitly
when you cannot verify a claim, and stay in scope (only what the maintainer asked for).

**Per-repo guidelines (#867, when present):** if guidelines were pre-fetched for this
repo (Tier 2 dispatch), include them verbatim in the agent's working context as
authoritative repo-specific rules. They take precedence over CONTRIBUTING.md when
they conflict. Flag any case where the agent's proposed approach contradicts a
stated preference so the user can confirm. Omit this section entirely when no
guidelines were fetched.

```
Maintainer preferences for {owner}/{repo} (from past PR feedback):
{repo_guidelines}
```

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

| # | PR | Issue Type | Maintainer Ask | Effort | Recommended Action |
|---|-----|-----------|---------------|--------|-------------------|
| 1 | repo#123 | needs_response | Requested shortcut change + tooltip | Small | Code change + respond |
| 2 | repo#456 | needs_changes | Fix trailing newline, sync docs | Medium | Code changes + push |
| 3 | repo#789 | incomplete_checklist | Missing changelog entry | Small | Add changeset file |

**Key findings:**
- **repo#123** ({url}): Maintainer wants X. 2-line fix in `file.ts`.
- **repo#456** ({url}): 3 changes requested. Tests need updating.
- **repo#789** ({url}): Missing changelog entry required by changeset-bot.
```

Populate the table using data from the Phase A agent results:
- **PR**: `{repo}#{number}` with the full URL on the next line or in parentheses — must be a bare URL so terminal emulators can detect and click it
- **Issue Type**: From `issue.type` (needs_response, needs_changes, ci_failing, merge_conflict, incomplete_checklist)
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
2. **Auto-verify the investigation** before implementing (no user prompt needed):
   - Re-read the specific code mentioned in the Phase A investigation — read actual function/method bodies, not just grep results
   - Cross-check each claim against the code:
     - "function X does Y" → read function X and verify
     - "the bug is in line N" → read that line with surrounding context
     - "change X to Y" → verify callers won't break
   - Check for edge cases: empty/null inputs, other callers, expected behavior match
   - If any claims are contradicted by the code, revise the approach before proceeding
   - **Node.js version check:** If the repo has `package.json`, check `engines.node` (or `.nvmrc`, `.node-version`) against `node --version`. If incompatible, warn before coding: "This repo requires Node {X} but you have Node {Y}. Tests may not run locally." Suggest switching via nvm/fnm/volta if available.
3. Execute the recommended action for that specific PR
4. After completing the action, if code was changed, route to Pre-Commit Review in the core router — it will read the appropriate workflow file based on `isNewContribution`. After the review completes, return here to Phase C's loop.

**Action failure handling:** After executing the action for a PR:
- **If successful**: Show "Completed: repo#123 — response posted + code pushed." with the full PR URL on the next line
- **If failed**: Show "Failed: repo#123 — {specific error message}. This PR was not addressed." with the full PR URL on the next line
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

Options (include full GitHub URL in each description):
1. Label: "{repo}#{number} — {brief title}", Description: "Score {score}/10. {brief context}. https://github.com/{repo}/issues/{number}"
2. Label: "{repo}#{number} — {brief title}", Description: "Score {score}/10. {brief context}. https://github.com/{repo}/issues/{number}"
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
  Verify it's still open, unassigned, and available.
  Check for recent linked PRs since the list was last updated.")
```

### 5. Investigate Feasibility

Show the vetting summary, then automatically proceed to investigate the issue. Investigation catches scope issues, identifies the right files, and prevents wasted effort.

1. **Clone/update the repo** — Check local repo registry (`local-repos --json`), clone if needed to `~/Documents/oss/<repo-name>`. **If clone/update fails** (network error, auth failure, repo deleted, disk full), report the error and offer: "Retry" / "Pick a different issue" / "Done for now". Do NOT proceed to sub-step 2 without a local repo.
2. **Read the issue context** — Parse the issue body for code references, error messages, expected behavior. If the issue cannot be fetched (rate limit, deleted), note the gap and continue with limited context.
3. **Analyze relevant code** — Use Grep/Read to find the relevant source files and understand the code path involved. If no relevant files can be identified, note "Could not identify relevant source files" in the assessment.
4. **Attempt diagnosis** — Identify root cause, propose a fix approach. If diagnosis is inconclusive, set Confidence to "Low" and explicitly state what could not be determined.
5. **Assess complexity** — Estimate effort (small/medium/large), identify risks and unknowns
6. **Report findings:**

```
## Feasibility Assessment

**Root cause:** {description of what causes the issue}
**Proposed fix:** {approach to fixing it}
**Complexity:** {Small|Medium|Large}
**Risk:** {Low|Medium|High — risk of unintended side effects}
**Files to change:** {list of files that need modification}
**Tests needed:** {yes/no — whether the repo has test infrastructure and tests should be added}

Confidence: {High|Medium|Low — how confident in the diagnosis}
```

7. **Post-investigation options:**


```
Question: "Investigation complete. How would you like to proceed?"
Header: "Next Step"

Options:
1. "Start implementing (Recommended)" — "The fix is feasible, begin working on it"
2. "Skip this issue" — "Too complex, risky, or unclear"
3. "Pick a different issue from the list"
4. "Done for now"
```

When user selects "Start implementing", proceed to Step 6 (implementation flow).

When user selects "Skip this issue":
1. Persist the skip so scout filters it out of future searches. Capture the JSON result and the exit code:
   ```bash
   SKIP_OUT=$(node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" skip-add "{issue_url}" --json)
   SKIP_RC=$?
   ```
   - On success (`$SKIP_RC == 0`), `SKIP_OUT` is JSON with `{ added, alreadyPresent, url, path, date? }`. Briefly confirm to the user whether the URL was newly added or already present.
   - On failure (`$SKIP_RC != 0`), do NOT silently return to Step 3. Parse the error envelope from `SKIP_OUT` (`{ success: false, error }`) or fall back to displaying the raw output. Offer: retry / skip-persistence-for-this-session / done-for-now. The user decides.
   - `skip-add` is `localOnly` — no GitHub token required.
2. Return to Step 3 (display available issues).

### 6. After selecting issue → implementation → draft PR → review → ready

When the user selects an issue and starts implementing, set:
- `isNewContribution = true`
- `issueContext = { title, url, description }` — the issue being addressed (used for scope-aware review)
- **Choose a consistent change type** based on the issue labels and nature of the change. Use this type for both the branch prefix and the commit message to avoid mismatches flagged by the compliance checker:
  - Issue labeled `bug` or fixes broken behavior → `fix/` branch, `fix:` commit
  - Issue labeled `enhancement`, `feature`, or adds new functionality → `feat/` branch, `feat:` commit
  - Documentation-only changes → `docs/` branch, `docs:` commit
  - If ambiguous, prefer `fix/` for correcting existing behavior and `feat/` for adding new capabilities

#### Branch Setup Protocol

Before writing any code, create the feature branch from the upstream default branch. This prevents merge conflicts from stale local branches (see [#821](https://github.com/costajohnt/oss-autopilot/issues/821)).

**1. Determine upstream repo and default branch:**

```bash
# Parse owner/repo from issue URL
upstreamRepo=$(echo "{issueContext.url}" | sed -n 's|https://github.com/\([^/]*/[^/]*\)/.*|\1|p')
upstreamDefault=$(gh repo view "$upstreamRepo" --json defaultBranchRef --jq '.defaultBranchRef.name')
```

**If either command fails:** Report the error. Offer: "Retry" / "Specify default branch manually" / "Done for now". Do NOT guess.

**2. Determine the correct remote:**

```bash
isFork=$(gh repo view --json isFork --jq '.isFork')
```

- **Fork (`true`):** Check for `upstream` remote (`git remote get-url upstream 2>/dev/null`). If missing, add it: `git remote add upstream "https://github.com/$upstreamRepo.git"`. Fetch: `git fetch upstream`. Base ref: `upstream/$upstreamDefault`.
- **Same-repo (`false`):** Fetch: `git fetch origin`. Base ref: `origin/$upstreamDefault`.
- **Detection fails:** Check `git remote -v` for an `upstream` remote. If found, use it. If not, use `origin`. Report which remote is being used.

**If `git fetch` fails:** Report the error. Do NOT proceed — creating a branch from a stale local ref is the bug this protocol prevents. Offer: "Retry" / "Specify a different remote URL" / "Done for now".

**3. Create the feature branch:**

```bash
git checkout -b {branchPrefix}{branchSuffix} {remote}/{upstreamDefault}
```

- `{branchPrefix}` comes from the change type logic above (`fix/`, `feat/`, `docs/`)
- `{branchSuffix}` is a short kebab-case descriptor from the issue title

**If checkout fails:**
- Branch already exists → Offer "Delete and recreate" / "Switch to existing" / "Different name"
- Uncommitted changes → Offer "Stash first" / "Discard changes" / "Done for now"
- Invalid ref → Re-check remote/branch, offer "Specify manually" / "Done for now"

**4. Confirm:**

> Feature branch `{branchName}` created from `{remote}/{upstreamDefault}` (at {short hash}).

Store in session context: `featureBranch`, `upstreamRemote`, `upstreamDefault`.

After implementation, the flow proceeds through the **draft-first workflow** (`${CLAUDE_PLUGIN_ROOT}/workflows/draft-first-workflow.md`):
1. Step 1 runs pre-flight checks (changes exist, branch base, CONTRIBUTING.md)
2. Step 2 stages and commits locally
3. Step 3 runs iterative review cycle (scope-aware, tied to `issueContext`)
4. Step 4 checks new files are properly integrated (imports, registrations)
5. Step 5 offers manual testing prompt (build/run locally)
6. Step 6 presents final diff for human review
7. Step 7 squashes commits and rewords message
8. Step 8 pushes and creates PR (ready or draft, user's choice)
9. Step 9 runs compliance check
10. Step 10 offers list updates (if issue came from curated list)

**CRITICAL: Track that the current issue came from the curated list** so Step 10 knows to offer list updates.
