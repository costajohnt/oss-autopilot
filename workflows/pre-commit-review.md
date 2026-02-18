# Pre-Commit Code Review (Standard Path — Existing PR Updates)

> **Session state:** Expects Tier 2 code changes to exist (uncommitted). This workflow handles existing PR updates.
> **Routing check:** If `isNewContribution === true`, **STOP** — read `${CLAUDE_PLUGIN_ROOT}/workflows/draft-first-workflow.md` instead and follow the Draft-First Path.

---

**This path is triggered automatically by the Pre-Commit Gate whenever Tier 2 code changes have been made to an existing PR.** You should already be here before any commit/push options are presented.

### 1. Pre-flight: Verify Changes Exist

```bash
git status --porcelain
```

**If output is empty:** There are no pending changes to review. Report:
> "No uncommitted changes detected. Changes may have already been committed, or you may be on the wrong branch."

Then skip the rest of this workflow and return to the core router (`commands/oss.md`).

### 2. Gather Change Context

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

### 3. Dispatch Review Agents in Parallel

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

### 4. Consolidate Findings

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

### 5. User Decision Point

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

### 6. Handle User Choice

**"Address findings":**
- User makes fixes (with assistance as needed)
- After fixes, loop back to "Gather Change Context" (sub-step 2) to re-gather changes and re-dispatch agents
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
- Return to the core router (`commands/oss.md`) without committing

### 7. Post Response Comment (for existing PR updates)

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

**After this sub-step completes (or is skipped):** If currently in Phase C's sequential loop (from `work-through-issues.md`), return there to process the next item. Otherwise, return to "After Each Action" in the core router (`commands/oss.md`).
