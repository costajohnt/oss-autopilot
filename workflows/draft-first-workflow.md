# Draft-First Workflow (New Contributions)

> **Session state:** Expects `isNewContribution === true`, `issueContext = { title, url, description }`.
> **Produces:** `draftPRNumber`, `draftPRUrl`, `baseBranch`, `roundNumber`.
> **Returns to:** Core router (`commands/oss.md`) for "After Each Action" and "Session End".

---

## Step 1: Create Draft PR (new contributions only)

### 1a. Pre-flight: Verify Changes Exist

```bash
git status --porcelain
```

**If output is empty:** Report no changes and return to the core router (`commands/oss.md`).

### 1b. Stage and Commit

- Stage the specific changed files (not `git add -A`)
- If staging fails for any file, report which file(s) failed and why
- Commit following the repo's conventional commit format
- If commit fails (e.g., pre-commit hook failure, empty commit):
  - Report the specific error to the user
  - If pre-commit hook failed, show the hook output and offer to fix the issues
  - Do NOT proceed to push
- **Do NOT add AI attribution** (no Co-Authored-By, no "Generated with" mentions)

### 1c. Push

```bash
git push -u origin HEAD
```

**If push fails**, report the error and offer to retry or cancel.

### 1d. Create Draft PR

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

**CRITICAL: Do NOT call `gh pr ready` or skip to Step 6. You MUST complete Step 2 (review cycle), Step 3 (integration check), Step 4 (manual testing), and Step 5 (squash) first. The draft-first workflow exists to catch issues before maintainers see the PR.**

**→ Proceed to Step 2 (Draft PR Review Cycle) below**

**If `gh pr create --draft` fails:**
- Report the specific error (include stderr output)
- Offer options:
  1. "Retry" — re-run the command
  2. "Create as regular PR instead" — fall back to `gh pr create` without `--draft`. Only offer this if the error indicates draft PRs are not supported (e.g., GitHub Enterprise). For auth/network errors, this option won't help.
  3. "Done for now" — leave changes pushed, create PR manually later

**If non-draft fallback succeeds:**
- Store `draftPRNumber` and `draftPRUrl` from the created PR
- Warn: "Note: This PR is immediately visible to maintainers. The review cycle will still run, but maintainers may see the PR before review is complete."
- Proceed to Step 2 (review cycle still runs). Step 6 (Mark Ready) will be skipped since the PR is already public.

- **Do NOT proceed to Step 2 without a valid `draftPRNumber` and `draftPRUrl`**

---

## Step 2: Draft PR Review Cycle

**Trigger:** After draft PR created in Step 1. Only for new contributions (`isNewContribution === true`).

Initialize `roundNumber = 1`.

### 1. Gather Change Context

Compute `baseBranch` and `mergeBase` (store in session — reused in Steps 3 and 5):

```bash
baseBranch=$(gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null || git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}' || echo "main")
if ! git fetch origin "$baseBranch" 2>/dev/null; then
  echo "Warning: git fetch failed — diffs may be based on stale data."
fi
mergeBase=$(git merge-base "origin/$baseBranch" HEAD 2>/dev/null) || true
```

Use `git diff $mergeBase..HEAD` for the full branch diff. If `$mergeBase` is empty, fall back to `origin/$baseBranch...HEAD`. If neither works, report error — do NOT dispatch agents without diff context. Read `CONTRIBUTING.md` and lint configs if not already loaded.

### 2. Dispatch Scope-Aware Review Agents

**Dispatch ALL agents in a SINGLE message.** Always use the full Large tier (code-reviewer, silent-failure-hunter, code-simplifier, pr-test-analyzer + conditional agents) regardless of diff size. Include `Working directory: {local repo path}` in every prompt.

**Prepend this SCOPE block to each agent prompt:**
```
SCOPE: This PR addresses issue '{issueContext.title}' ({issueContext.url}).
Focus findings on changes related to this issue. Flag pre-existing issues only
if they are Critical severity. Do NOT suggest improvements outside the scope of this PR.
```

**Agent prompts** (include the full `git diff $mergeBase..HEAD` output in each):

```
Task(pr-review-toolkit:code-reviewer,
  "SCOPE: This PR addresses issue '{issueContext.title}' ({issueContext.url}).
   Focus findings on changes related to this issue. Flag pre-existing issues only
   if they are Critical severity. Do NOT suggest improvements outside the scope of this PR.

   Review the following code changes for bugs, logic errors, security vulnerabilities,
   and adherence to project conventions. Focus on issue-related changes.
   Repository: {repo name}
   Working directory: {local repo path}
   Convention notes: {any CONTRIBUTING.md or lint config findings}
   Changed files: {changed files list}

   Diff:
   {git diff $mergeBase..HEAD output}")

Task(pr-review-toolkit:silent-failure-hunter,
  "SCOPE: This PR addresses issue '{issueContext.title}' ({issueContext.url}).
   Focus findings on changes related to this issue. Flag pre-existing issues only
   if they are Critical severity. Do NOT suggest improvements outside the scope of this PR.

   Review the following code changes for silent failures, inadequate error handling,
   and inappropriate fallback behavior. Focus on changed code paths only.
   Working directory: {local repo path}
   Changed files: {changed files list}

   Diff:
   {git diff $mergeBase..HEAD output}")

Task(pr-review-toolkit:code-simplifier,
  "SCOPE: This PR addresses issue '{issueContext.title}' ({issueContext.url}).
   Focus findings on changes related to this issue. Flag pre-existing issues only
   if they are Critical severity. Do NOT suggest improvements outside the scope of this PR.

   Review the following code changes for dead code, unnecessary complexity, and
   simplification opportunities. Focus on new/modified code only. Do NOT modify files — report findings only.
   Working directory: {local repo path}
   Changed files: {changed files list}

   Diff:
   {git diff $mergeBase..HEAD output}")

Task(pr-review-toolkit:pr-test-analyzer,
  "SCOPE: This PR addresses issue '{issueContext.title}' ({issueContext.url}).
   Focus findings on changes related to this issue. Flag pre-existing issues only
   if they are Critical severity. Do NOT suggest improvements outside the scope of this PR.

   Analyze test coverage for the following code changes. Focus on new functionality only.
   Check if modified code paths have tests, identify gaps, and recommend what tests should be added.
   Working directory: {local repo path}
   Test directory: {test dir path}
   Changed files: {changed files list}

   Diff:
   {git diff $mergeBase..HEAD output}")
```

**Conditional agents (dispatch in the SAME message if applicable):**

- **`pr-review-toolkit:type-design-analyzer`** — dispatch only if changed files include TypeScript (`.ts`, `.tsx`) or other typed languages
  ```
  Task(pr-review-toolkit:type-design-analyzer,
    "SCOPE: This PR addresses issue '{issueContext.title}' ({issueContext.url}).
     Focus on issue-related type changes only.

     Review type design in the following TypeScript changes. Check for proper
     encapsulation, invariant expression, and type safety.
     Working directory: {local repo path}
     Changed files: {changed .ts/.tsx files}

     Diff:
     {git diff $mergeBase..HEAD output for .ts/.tsx files}")
  ```

- **`pr-review-toolkit:comment-analyzer`** — dispatch only if 5+ files were changed
  ```
  Task(pr-review-toolkit:comment-analyzer,
    "SCOPE: This PR addresses issue '{issueContext.title}' ({issueContext.url}).
     Focus on comments in new/modified code only.

     Review comments in the following code changes for accuracy, completeness,
     and long-term maintainability.
     Working directory: {local repo path}
     Changed files: {changed files list}

     Diff:
     {git diff $mergeBase..HEAD output}")
  ```

**Fallback:** If the PR review toolkit agents are unavailable, dispatch the local `pre-commit-reviewer` agent instead:

> "PR review toolkit agents are not available. Falling back to the built-in pre-commit reviewer."

```
Task(pre-commit-reviewer,
  "Review my pending code changes before committing.
   Repository: {repo name}
   Working directory: {path}")
```

If ALL agents fail: offer "Proceed to integration check (skip review)" / "Retry" / "Done for now".

### 3. Consolidate and Present

Same as the pre-commit review consolidation format, but separate findings into **In-Scope** (Critical/Recommended/Minor) and **Out-of-Scope** (pre-existing issues). Include test coverage assessment.

```
## Draft PR Review — Round {roundNumber}

### In-Scope Findings

#### Critical ({count}) — Must fix before publishing
- **{file}:{line}** — {description} (found by: {agent})
  Suggestion: {fix}

#### Recommended ({count}) — Should fix
- **{file}:{line}** — {description} (found by: {agent})
  Suggestion: {fix}

#### Minor ({count}) — Nice to have
- **{file}:{line}** — {description}

### Out-of-Scope (pre-existing)
- {list, if any Critical-severity pre-existing issues were flagged}

### Test Coverage
- {assessment from pr-test-analyzer}
```

### 4. User Decision

**If Critical/Recommended findings:** "Address findings" / "Show full diff" / "Finalize anyway" / "Done for now"
**If clean:** "Finalize (Recommended)" / "Show full diff" / "Done for now"

### 5. Handle Choice

**"Address findings":** Fix → commit → push → increment `roundNumber` → loop to sub-step 1. Only increment `roundNumber` if push succeeds. On push failure, report error and offer retry/done. **Soft limit after 3 rounds:** suggest finalizing (diminishing returns).

**"Show diff":** Output `git diff $mergeBase..HEAD` as code block. If the diff command fails, recompute `$mergeBase` and retry. If still failing, offer "Continue without diff" / "Retry" / "Done for now". Then offer: "Finalize" / "Fix something" / "Done for now".

**"Finalize":** → Step 3 (Integration Check) below

**"Done for now":** Report draft saved, return to the core router (`commands/oss.md`).

---

## Step 3: Integration Check for New Files

**Trigger:** After Step 2 finalized. Only for new contributions.

Review agents see diff contents but can't detect whether new files are wired into the codebase. This catches "dead code" PRs.

### Flow

1. **Find new files:** `git diff --name-only --diff-filter=A "$mergeBase"..HEAD`. If `$mergeBase` is invalid, recompute it. If no new files → skip to Step 4.

2. **Check references:** For each new file, search for its name stem in the source tree (grep for imports/registrations, excluding the file itself). Adjust file extensions to match the repo's language.

3. **Flag unreferenced files:** If any new file has zero references, warn the user and offer:
   - "Investigate and fix" — find entry points, add missing imports, commit + push. If git operations fail, report error and offer retry/skip/done. Do NOT proceed unless push succeeds or user explicitly skips.
   - "Skip — files are referenced differently" — e.g., dynamically loaded, auto-discovered
   - "Done for now" — leave as draft

**If all files referenced or user resolves:** → Step 4 (Manual Testing)

---

## Step 4: Manual Testing Prompt

**Trigger:** After Step 3 (Integration Check) completes or is skipped. Only runs for new contributions (`isNewContribution === true`).

Automated review catches code patterns, but cannot verify runtime behavior (UI rendering, keyboard shortcuts, browser behavior, CLI output, etc.). This step gives the user a chance to manually verify the feature works before finalizing.

**Auto-skip when ALL of the following are true:**
- The change is a utility function, library code, or backend logic (no visual/UI component)
- All relevant automated test suites pass
- Manual testing would require non-trivial environment setup (e.g., CSP headers, specific server config, browser extension loading)

When auto-skipping, note: "Skipping manual testing — non-visual change, all automated tests pass, and manual testing would require non-trivial environment setup." Then proceed directly to Step 5.

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
- **If any git operation fails** (stage, commit, or push), report the specific error and offer: "Retry" / "Skip push and review locally" / "Done for now". Do NOT loop back to Step 2 unless the push succeeds or the user explicitly chooses to review locally
- Loop back to Step 2 sub-step 1 (re-review with agents) above

**"Tests passed — proceed to squash" / "Skip — proceed to squash":**
- **→ Proceed to Step 5 (Squash + Reword) below**

**"Done for now":**
- Report: "Draft PR #{draftPRNumber} remains as a draft. Run `/oss` later to continue."
- Return to the core router (`commands/oss.md`)

---

## Step 5: Squash + Reword

**Trigger:** After Step 4 completes or is skipped. Only for new contributions.

### Flow

1. **Count commits:** Validate `$mergeBase` (recompute if invalid), then `git rev-list --count "$mergeBase"..HEAD`. If only 1 commit → skip to Step 6.

2. **Check config:** Read squash setting from `.claude/oss-autopilot/config.md` (check `repoOverrides.{repo}.squash`, then `squashByDefault`, default `true`). If `false` → Step 6. If `"ask"` → prompt user.

3. **Generate message:** Create a commit message covering all work (implementation + tests + fixes). Follow repo's commit format, include issue reference. **Present to user for approval BEFORE squashing:**
   - "Approve and squash (Recommended)" / "Edit message" / "Skip squash" / "Done for now"

4. **Squash (after user approval):** Run each command individually — check for failure before proceeding:
   ```bash
   git tag -d oss-autopilot-pre-squash 2>/dev/null  # cleanup stale tag
   git tag oss-autopilot-pre-squash                  # safety tag — MUST succeed
   git reset --soft "$mergeBase"
   git commit -m "{approved message}"
   branch=$(git branch --show-current)
   git fetch origin "$branch"
   git push --force-with-lease
   git tag -d oss-autopilot-pre-squash               # cleanup after success
   ```
   **CRITICAL: If the safety tag creation fails, do NOT proceed with the squash.** Report: "Could not create safety recovery tag. Aborting squash to protect your work." Offer: "Retry" / "Skip squash" / "Done for now".
   On any other failure: recover via `git reset --hard oss-autopilot-pre-squash`, report error, offer retry/undo/done. If `--force-with-lease` fails with stale info, retry once with explicit lease: `git push "--force-with-lease=$branch:$(git rev-parse origin/$branch)" origin $branch`. If force push blocked by branch protection: `git reset --hard oss-autopilot-pre-squash && git push && git tag -d oss-autopilot-pre-squash`. Do NOT proceed to Step 6 unless push succeeded.

**→ Step 6 after successful push**

---

## Step 6: Mark Ready for Review

**Trigger:** After Step 5 (Squash + Reword) completes or is skipped. Only runs for new contributions (`isNewContribution === true`).

**CRITICAL: This step must NOT be reached without completing Steps 2 (review cycle), 3 (integration check), 4 (manual testing prompt), and 5 (squash). If `gh pr ready` is called before these steps, the draft-first workflow has been bypassed — this is a bug.**

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
**→ Proceed to Step 7 (compliance check) below**

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
- Return to the core router (`commands/oss.md`)

> **Context tip:** You've done significant work this session. Starting a fresh `/oss` session later may help with context limits. Your draft PR is saved.

---

## Step 7: Compliance Check

**For PRs that completed the full draft-first workflow** (Steps 2–6, i.e., `isNewContribution === true` and all steps completed): Skip the compliance check. The PR was already reviewed by 5+ agents, integration-checked, manually tested, and squashed. Note:

> "Compliance check skipped — this PR went through the full draft-first review workflow."

**For all other PR updates** (existing PRs, quick fixes, responses to maintainer feedback): Always offer a compliance check:

> "Would you like me to run a compliance check on this PR to ensure it meets opensource.guide best practices?"

Dispatch the `pr-compliance-checker` agent with the PR URL.

### Test Coverage Requirements

**Include tests when the repo has test infrastructure and the change involves code (not docs-only, config-only, or trivial typo fixes).**

Before submitting a PR, check if the repo has a test directory:
- `test/`, `tests/`, `__tests__/`, `spec/`

---

## Step 8: Post-PR List Continuity

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
- "Pick another" → Read `${CLAUDE_PLUGIN_ROOT}/workflows/work-through-issues.md` — "Handle Pick Issue From List" section
- "Search GitHub" → Return to the core router (`commands/oss.md`) — "Handle Find New Issues"
- "Done for now" → Return to the core router (`commands/oss.md`) — "Session End"
