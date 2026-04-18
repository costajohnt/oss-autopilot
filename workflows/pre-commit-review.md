# Pre-Commit Code Review (Standard Path — Existing PR Updates)

> **Session state:** Expects Tier 2 code changes to exist (uncommitted or committed-but-not-pushed). This workflow handles existing PR updates.
> **Routing check:** If `isNewContribution === true`, **STOP** — read `${CLAUDE_PLUGIN_ROOT}/workflows/draft-first-workflow.md` instead and follow the Draft-First Path.
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

**This path is triggered automatically by the Pre-Commit Gate whenever Tier 2 code changes have been made to an existing PR.** You should already be here before any commit/push options are presented.

### 1. Pre-flight: Verify Changes Exist

Check for changes in two stages — uncommitted first, then committed-but-not-pushed:

```bash
# Stage 1: Check for uncommitted changes (staged or unstaged)
git status --porcelain
```

**If output is non-empty:** Uncommitted changes exist. Set `changeSource = "uncommitted"` and proceed to sub-step 2.

**If output is empty:** No uncommitted changes. Check for committed-but-not-pushed changes (common after squash-rebase or amend):

```bash
# Stage 2: Check for commits ahead of the remote tracking branch
git log --oneline @{upstream}..HEAD 2>/dev/null || git log --oneline origin/$(git rev-parse --abbrev-ref HEAD)..HEAD 2>/dev/null || git log --oneline origin/main..HEAD 2>/dev/null
```

**If this shows commits:** Changes have been committed but not pushed. Set `changeSource = "committed"` and proceed to sub-step 2. Report:
> "No uncommitted changes, but found {N} commit(s) not yet pushed. Reviewing committed changes."

**If this also shows nothing (or fails):** There are truly no changes to review. Report:
> "No uncommitted or unpushed changes detected. There is nothing to review."

Then skip the rest of this workflow and return to the core router (`commands/oss.md`).

### 2. Gather Change Context

**Choose diff commands based on `changeSource`:**

**If `changeSource = "uncommitted"`:**
```bash
git diff
git diff --cached
git status --porcelain
```
Save the combined `git diff` + `git diff --cached` output as `reviewDiff`.

**If `changeSource = "committed"`:**
```bash
# Diff of committed-but-not-pushed changes against the remote tracking branch
git diff @{upstream}..HEAD 2>/dev/null || git diff origin/$(git rev-parse --abbrev-ref HEAD)..HEAD 2>/dev/null || git diff origin/main..HEAD
```
Save this output as `reviewDiff` and note which diff range succeeded as `diffRange`. If all diff commands fail (no remote tracking branch found), report the error and ask the user to specify the base branch manually. Use `git diff --stat` with the same range to get the file count and line counts.

Identify changed files and their types (TypeScript, Python, etc.). Count files changed.

Read the target repo's conventions if not already loaded:
- `CONTRIBUTING.md`
- Lint/format configs (`.eslintrc*`, `.prettierrc*`, `biome.json`, etc.)
- Test directory structure (`test/`, `tests/`, `__tests__/`, `spec/`)

**Classify change size** from the diff and file count:
- **If `changeSource = "uncommitted"`:** Count diff lines from `git diff HEAD --stat` summary (captures both staged and unstaged changes; e.g., "3 files changed, 45 insertions(+), 12 deletions(-)"). Use insertions + deletions as the line count. Note: binary files report 0 lines — if the diff contains binary files, classify based on file count alone. Count changed files from `git status --porcelain`.
- **If `changeSource = "committed"`:** Count diff lines from the `git diff --stat` output using the same remote range as above. Count changed files from the stat summary.

Evaluate from largest to smallest — **first match wins**:

| Classification | Criteria |
|----------------|----------|
| **Large** | > 200 diff lines OR > 5 files |
| **Medium** | ≥ 50 diff lines OR 3–5 files |
| **Small** | Everything else (< 50 diff lines AND ≤ 2 files) |

Save as `changeSize` for informational reporting. Report: "> Change size: {tier} ({N} diff lines, {M} files) — dispatching full review suite."

**If classification fails** (command errors, unparseable output, or both counts are zero despite `git status --porcelain` showing changes): default to **Large** to ensure maximum review coverage and warn: "Could not determine change size — defaulting to Large for comprehensive review."

### 2b. Pre-Review Lint and Test Gate

Before dispatching review agents, run the repo's lint and test commands to catch basic issues early. Review agents should not waste cycles on code that does not pass lint or tests.

1. **Detect and run linter/type checker**: Check for `package.json` scripts (`lint`, `typecheck`, `tsc`), `Makefile` targets, or language-specific tooling. Run the detected command(s). If no linter is detected, skip and note: "No linter detected — skipping pre-review lint."

2. **Verify tools against CI configuration (CI-enforcement check):** Before treating any linter, formatter, or type checker output as authoritative, confirm the tool is actually enforced by the project's CI. Check these sources in order:
   - `.pre-commit-config.yaml` — lists hooks that run on every commit/PR. Save the list of repo URLs and hook IDs as `enforcedTools`.
   - `.github/workflows/*.yml` (or `.gitlab-ci.yml`, `Jenkinsfile`, etc.) — look for tool invocations in CI job steps.
   - `Makefile` targets referenced by CI — if CI runs `make lint`, check what `make lint` actually invokes.

   **Rules:**
   - If a tool is NOT in CI, its output is **informational only** — report findings but do not auto-apply fixes or block on its output.
   - Never auto-apply a formatter that is not CI-enforced. Running a formatter on a project that doesn't enforce it in CI creates noise the maintainer did not ask for.
   - If `.pre-commit-config.yaml` exists, read it early (during this sub-step) and save the enforced tools list for use in both this gate and sub-step 6a (formatter detection).
   - If no CI config files can be found, note: "Could not determine CI-enforced tools — treating all detected tools as informational." Run them but do not auto-apply fixes.

3. **Run test suite**: Check for `package.json` scripts (`test`), `Makefile` targets (`test`, `check`), or language-specific test runners. Run the detected command. If no test runner is detected, skip and note: "No test runner detected — skipping pre-review tests."

4. **Handle failures**: If lint or tests fail, fix the issues before proceeding to review agent dispatch. Report:
   > "Lint/tests failed — fixing before running review agents..."
   After fixing, re-run lint and tests to confirm they pass. Loop until both pass (soft limit: 3 attempts). If still failing after 3 attempts, present findings to the user and offer: "Fix manually" / "Proceed to review anyway" / "Done for now".

5. **On success**: Report:
   > "Lint and tests passed. Dispatching review agents..."
   Proceed to sub-step 3.

### 3. Dispatch Review Agents in Parallel

**CRITICAL: Dispatch ALL selected agents in a SINGLE message for true parallelism.**

Pass `reviewDiff` (from sub-step 2) as context to each agent.

**Initialize tracking:** Set `reviewPass = 1` and `agentsWithFindings = []` (empty list). These are used in the convergence loop (sub-step 5) to enable targeted re-dispatch.

**IMPORTANT: Always include `Working directory: {local repo path}` in every agent prompt so agents can find and read files in the correct location. Without this, agents inherit the parent session's working directory and file lookups will fail.**

**Always dispatch the full base agent suite** regardless of change size. The convergence loop (sub-step 5) depends on comprehensive coverage — scaling down agents undermines the guarantee that fixes don't introduce new problems.

**Base agents (always dispatched):** `code-reviewer`, `silent-failure-hunter`, `code-simplifier`, `pr-test-analyzer`, `comment-analyzer`

**Agent prompts** (dispatch ALL base agents plus any conditional agents in a SINGLE message; include the full `git diff` output in each):

```
Task(pr-review-toolkit:code-reviewer,
  "Review the following code changes for bugs, logic errors, security vulnerabilities,
   and adherence to project conventions.
   Repository: {repo name}
   Working directory: {local repo path}
   Convention notes: {any CONTRIBUTING.md or lint config findings}
   Changed files: {changed files list}

   Additional checks:
   - API naming conventions: If new public API surface is added (exports, options, CLI flags),
     scan existing APIs in the same module for naming patterns. Flag double-negative boolean
     names (e.g., nonInteractive when the codebase uses positive booleans like interactive).
   - JS/TS truthiness: Flag !obj.prop when the intent is to check for false specifically
     but undefined would also match. Flag === false vs !prop inconsistencies. Flag boolean
     coercion of values that could be 0, "", or null where the intent is only to check
     for undefined.
   - Formatting hygiene: Scan the diff for hunks that contain only formatting changes
     (whitespace, quote style, trailing commas, import reordering, line breaks) with no
     functional change. Flag each as Recommended: 'Formatting-only hunk at {file}:{line}
     — revert to keep diff minimal.' Do not flag formatting that is part of the functional
     fix (e.g., a new import that triggers automatic reordering).
   - Documentation accuracy: If docs/README/JSDoc are changed, cross-reference factual claims
     against the actual code. Check that option descriptions match defaults (don't say
     "Enable X" for a feature that's on by default). If code behavior changed but docs
     were NOT changed, flag any docs/JSDoc/comments on the changed functions that describe
     the old behavior.

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
   Do NOT suggest cosmetic changes (import reordering, quote style, trailing commas,
   whitespace) as improvements — those expand the diff without functional benefit.
   Working directory: {local repo path}
   Changed files: {changed files list}

   Diff:
   {git diff output}")

Task(pr-review-toolkit:pr-test-analyzer,
  "Analyze test coverage and assertion quality for the following code changes.
   Working directory: {local repo path}
   Test directory: {test dir path}
   Changed files: {changed files list}

   Coverage: Check if modified code paths have tests, identify gaps.

   Assertion strength: For each new or modified test, ask 'If I broke the feature under
   test, would this test actually catch it?' Flag:
   - Assertions too broad (only checking final output, not intermediate states)
   - Test names claiming comprehensive coverage but only checking a subset
   - Tests that would still pass if the feature regressed (e.g., only .toBeDefined()
     when a specific value is expected)
   - Override/disable tests that don't prove the override is working, just that code runs

   Diff:
   {git diff output}")

Task(pr-review-toolkit:comment-analyzer,
  "Review comments in the following code changes for accuracy, completeness,
   and long-term maintainability.
   Working directory: {local repo path}
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

**Track which agents found issues:** For each agent that reported Critical or Recommended findings, add its name to `agentsWithFindings`. This list is used in the convergence loop (sub-step 5) to enable targeted re-dispatch on subsequent passes.

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

### Test Coverage & Quality
- {assessment from pr-test-analyzer, including assertion strength concerns}

### Documentation Accuracy
- {any doc/README claims that don't match the code, or stale docs not updated after code changes}

### Convention Alignment
- {any style/convention/naming mismatches}
```

If NO issues found across all agents:
```
## Pre-Commit Review Summary

All agents passed. No issues found — changes are clean and ready to commit.
```

### 4b. Scope Discipline Check

**When responding to maintainer review feedback, cross-check the changes against what was actually requested before entering the convergence loop.** Skip this step for new contributions where you authored the original change.

1. **Compare requested vs. changed:** Extract the specific asks from the maintainer's latest review comments, then summarize each modified file/hunk. Any change that does not map to a specific request is a scope addition (e.g., unrequested test cases, docstrings, adjacent refactoring, or formatting changes).

2. **Report:**
```
### Scope Check
- Requested: {numbered list of maintainer asks}
- Implemented: {numbered list of changes made}
- Scope additions: {list of changes not mapping to a request, or "None"}
```

3. **Remove scope additions** before proceeding. Only do what was requested. If a removal seems risky, note it for the user but still remove it:
   > "Removed {count} scope addition(s) not in the maintainer's request. You can add them back after review."

### 5. Automatic Convergence Loop

After consolidating findings (sub-step 4), automatically fix and re-review until convergence. **Do not prompt the user during this loop** — it runs fully autonomously.

**Loop bound:** Maximum 5 passes total (including the initial review pass). If convergence is not reached after 5 passes, present remaining findings to the user and proceed to sub-step 6.

**Convergence criteria:** Zero Critical and zero Recommended findings in the latest pass. Minor findings do not block convergence.

**Procedure:**

1. **Check for convergence:** If the consolidated report has zero Critical and zero Recommended findings, convergence is reached. Report the pass summary:
   > "Review converged on pass {reviewPass}. {minor_count} minor finding(s) noted — changes are clean and ready to commit."
   Proceed to sub-step 6 (User Decision Point) with the "clean" prompt.

2. **If Critical or Recommended findings exist:** Report the pass summary:
   > "Pass {reviewPass}: {critical_count} Critical, {recommended_count} Recommended, {minor_count} Minor. Fixing actionable findings..."

3. **Fix all Critical and Recommended findings.** Minor findings are noted but not auto-fixed. Apply fixes using standard editing tools.

4. **Increment `reviewPass`.** Loop back to sub-step 2 (Gather Change Context) to re-gather the updated diff after fixes.

5. **Targeted re-dispatch (pass 2+):** Instead of re-dispatching ALL agents, only re-run the agents in `agentsWithFindings` from the previous pass plus `code-reviewer` as a baseline quality gate. Reset `agentsWithFindings` before collecting new results. Report:
   > "Re-review pass {reviewPass}: Re-dispatching {agent list} (targeted) + code-reviewer (baseline). Agents that passed cleanly are skipped."

6. **Re-consolidate** (sub-step 4) and return to step 1 of this procedure.

**Cross-pass deduplication:** Deduplicate findings against previous passes. A finding referencing the same file, line range (±5 lines), and substantially similar description is a duplicate — do not re-report it. Only new or materially changed findings count toward convergence criteria.

**If max passes reached without convergence:**
> "Review did not converge after 5 passes. {remaining_count} finding(s) remain — presenting for manual review."
Present the latest consolidated report and proceed to sub-step 6 with the "unresolved findings" prompt.

### 6. User Decision Point and Action

Use AskUserQuestion based on convergence outcome:

**If convergence was reached (no Critical or Recommended findings):**
```
Question: "Changes look clean. Ready to commit?"
Header: "Review"

Options:
1. "Show full diff first" — "Review the complete diff before committing"
2. "Yes, commit (Recommended)" — "Stage and commit locally; confirm push separately"
3. "Done for now" — "Cancel, return to main flow"
```

**If max passes reached without convergence (unresolved findings remain):**
```
Question: "Review loop completed with remaining findings. How would you like to proceed?"
Header: "Review"

Options:
1. "Show full diff" — "Display complete diff for manual review"
2. "Commit anyway" — "Commit current changes despite remaining findings; confirm push separately"
3. "Done for now" — "Cancel, return to main flow"
```

**"Show full diff" / "Show full diff first":**

Check the user's configured diff viewer preference:
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" config --json
```

Read `data.config.diffTool` (defaults to `inline` if not set):

| diffTool | Action |
|----------|--------|
| `inline` | Run the appropriate diff command based on `changeSource` and **output the full diff as a markdown code block in your text response** |
| `sourcetree` | Run `stree .` to open the repo in SourceTree. Tell the user: "Opened in SourceTree — review the diff there." |
| `vscode` | Run `code --diff` for each changed file against its HEAD version. Tell the user: "Opened diffs in VS Code." |
| `custom` | Read `data.config.diffToolCustomCommand` and run it with the repo path appended. If the command is not configured, fall back to `inline` and warn. |

- **If the diff command or external tool fails**, report the error and offer: "Retry" / "Continue without diff" / "Done for now". If the user selects "Continue without diff", skip the diff display and present the follow-up prompt directly (the user has explicitly chosen to proceed without reviewing the raw diff).
- **After** the diff is visible in your response (or user chose to continue without), use AskUserQuestion:
  ```
  Question: "Diff reviewed. Ready to proceed?"
  Header: "Diff"

  Options:
  1. "Yes, commit (Recommended)" — "Stage and commit; confirm push separately"
  2. "Fix something first" — "Make additional changes before committing"
  3. "Done for now" — "Cancel"
  ```

**"Commit anyway" / "Yes, commit" / "Yes, commit (Recommended)":**

**6a. Run project linter/formatter (uncommitted changes only):**

**If `changeSource = "committed"`:** Skip this sub-step — changes are already committed and cannot be reformatted without amending. Proceed directly to push.

**If `changeSource = "uncommitted"`:** Before staging, run the project's linter/formatter to catch formatting issues that would fail CI. Consult the `enforcedTools` list from sub-step 2b. Only auto-apply formatters that are CI-enforced. For non-CI-enforced formatters, report findings but do not use `--write` or `--fix` flags.

1. **Detect tooling** from lint/format configs gathered in sub-step 2. Check in order — **use the first match that supports auto-fix**:
   - `package.json` scripts: prefer fix-oriented scripts first: `lint:fix`, `format`, `fmt`. A plain `lint` script (without `:fix`) typically only reports issues — only use it as a last resort and note it will report but not auto-fix. **Important:** `npm run` scripts typically run on the entire project. Only use a script if it accepts file arguments via `--` passthrough (e.g., `npm run format -- {changed files}`). If the script does not accept file arguments, skip it and fall back to running the underlying tool directly on changed files.
   - `biome.json` / `biome.jsonc` → `npx biome check --write {changed files}`
   - `.prettierrc*` or `prettier` in devDependencies → `npx prettier --write {changed files}`
   - `.eslintrc*` or `eslint.config.*` → `npx eslint --fix {changed files}`
   - `Makefile` with `fmt` or `format` target → `make fmt` or `make format` (project-wide by design; no file list)
   - `Cargo.toml` → `cargo fmt` (project-wide by design; no file list)
   - `pyproject.toml` with `[tool.ruff]` or `[tool.black]` → `ruff format {changed files}` or `black {changed files}`
   - `go.mod` → `gofmt -w {changed files}`

   **If reading or parsing any config file fails** (malformed JSON, permission error, etc.), log a warning ("Could not parse {file}: {error}") and continue to the next detection strategy. Do not treat a parse failure as "no tooling detected."

   **Before running the detected tool**, verify it is available. For `npx`-based tools, check that the package exists in `node_modules/.bin/` or `devDependencies`. For system tools (`cargo fmt`, `gofmt`, `ruff`, `black`), check `which {tool}`. If the tool is not available, report: "Detected {tool} configuration but the tool is not installed. Skipping auto-format." Do not attempt to install tools.

2. **If no tooling detected:** Skip this sub-step. Report: "No linter/formatter detected — skipping auto-format." Proceed to staging.

3. **Capture baseline diff** before running the formatter so you can identify what the formatter changed vs. what you changed: `git diff > /tmp/pre-format.diff`. This baseline is used in step 5 to distinguish functional hunks from formatter-added hunks.

4. **Run the formatter** on the changed files only (not the entire repo — see file-scoping notes in item 1). Use a 60-second timeout on the bash command. Report what command is being run:
   > "Running `{command}` on changed files..."

5. **Handle results:**
   - **If the command succeeds (exit 0):** Check `git status --porcelain` for files modified by the formatter. Compare the modified files to the original changed files list. If the formatter modified files **outside** the original change set, warn: "Formatter modified {N} file(s) outside your original changes: {list}. Discarding those changes." Restore those files with `git checkout -- {unrelated files}`, then re-run `git status --porcelain` to verify they are no longer modified. If any files could not be restored, warn: "Could not discard formatter changes to {file}. These files will NOT be staged — please resolve manually." Also check for new untracked files (`??` in `git status`) created by the formatter (e.g., cache files) and warn if found — do not stage them. For files within the original change set: review the formatter's modifications within those files. If the formatter changed lines that were NOT part of the original diff (i.e., reformatted untouched regions of a file you edited), use `git diff` to identify which hunks are formatting-only. For files where ALL changes are formatting-only, use `git checkout -- {files}` to revert them entirely. For files with both formatting and functional changes, use the Edit tool to surgically undo only the formatting-only hunks — never `git checkout --` on these files, as it would destroy the functional changes too. Report: "Formatter applied changes to {N} file(s). Discarded {M} formatting-only hunk(s) to keep the diff minimal."
   - **If the command fails (non-zero exit):** Check `git status --porcelain` for files the formatter partially modified before failing. If files were modified, inform the user: "The linter/formatter modified {N} file(s) before failing. You can undo these partial changes or keep them." Report the error output. Use AskUserQuestion:
     ```
     Question: "Linter reported issues. How to proceed?"
     Header: "Lint"

     Options:
     1. "Fix first (Recommended)" — "Address lint issues before committing"
     2. "Commit anyway" — "Push as-is; lint issues may cause CI failures"
     3. "Undo formatter changes" — "Restore files to pre-format state and commit original code"
     ```
     If "Undo formatter changes": run `git checkout -- {formatter-modified files}` to restore original state. Verify with `git status --porcelain` that the files are restored. If any files could not be restored, report: "Could not fully undo formatter changes for: {files}. Please resolve manually before staging." Do not proceed to staging until the working tree matches the user's expectation.
   - **If the command times out (>60s):** Kill the process. Check for partial file modifications (same as failure case). Use AskUserQuestion:
     ```
     Question: "Linter timed out after 60s. This may indicate a configuration issue."
     Header: "Lint"

     Options:
     1. "Commit anyway" — "Push as-is; investigate timeout later"
     2. "Undo formatter changes" — "Restore any partial changes and commit original code"
     3. "Done for now" — "Cancel"
     ```

**6b. Stage and commit (local only):**

- **If `changeSource = "uncommitted"`:** Stage the specific changed files (not `git add -A`) — including any files modified by the formatter in 6a — then commit following the repo's conventional commit format
- **If `changeSource = "committed"`:** Changes are already committed — skip staging and committing, proceed directly to 6c
- **Do NOT add AI attribution** (no Co-Authored-By, no "Generated with" mentions)
- **Do NOT push yet.** Push is confirmed separately in 6c.
- **If staging or commit fails,** report the specific error to the user and offer to retry or cancel. Do not proceed to 6c until the local commit succeeds.

**6c. Confirm push (remote, visible, may trigger CI):**

After the commit succeeds, display the final state so the user can verify what is about to leave their machine:

- Branch name, target remote (e.g. `origin`), and target branch (`origin/{branch}` or the tracking branch)
- Commits that will be sent: `git log --oneline @{u}..HEAD` (or `git log --oneline origin/{branch}..HEAD` if no upstream is set)
- Whether this is a fast-forward push or a force push (from `changeSource` / rebase state — see force-push note below)

Then use AskUserQuestion:
```
Question: "Commit created locally. Push to {remote}/{branch}?"
Header: "Push"

Options:
1. "Yes, push" — "Push the commit(s) shown above to the remote"
2. "Not yet" — "Keep the commit local; I'll push later"
3. "Done for now" — "Cancel, return to main flow"
```

**Force-push friction:** If the push will require `--force-with-lease` (e.g. after a rebase rewrote history), the question above MUST call that out explicitly and include the count of commits being rewritten plus the old and new tip hashes, so the user can confirm they intend to replace the remote history with exactly what is being pushed. The options stay the same, but frame option 1 as "Yes, force-push with lease" and describe the rewrite scope in the option description.

On "Yes, push" / "Yes, force-push with lease":
- Run the push. For force-push, use `--force-with-lease` (never `--force`) so a concurrent remote update aborts the push instead of silently overwriting it.
- **If the push fails,** report the specific error and offer retry/cancel. Do not proceed to sub-step 7.
- **After confirming the push succeeded, proceed to sub-step 7 (Post Response Comment)**

On "Not yet":
- Leave the commit in place locally. Inform the user: "Commit made on `{branch}`. Push with `git push` when ready." Do NOT proceed to sub-step 7 (no push means nothing to respond to on the PR yet).

On "Done for now":
- Return to the core router without pushing. The commit remains in the local branch.

**"Done for now":**
- Return to the core router (`commands/oss.md`) without committing

### 7. Post Response Comment (for existing PR updates)

**Skip this step if** the PR's issue type (from Phase A or Execute section context) was NOT `needs_response` or `needs_changes` — i.e., no maintainer feedback was being addressed. Maintenance-only actions (rebase, CI fix where `actionReason` was `failing_ci`) do not need a response comment.

**SAFETY: Posting a public PR comment is an irreversible action visible to maintainers.** The following safeguards MUST be applied:

- **Default to NOT posting** if the user's choice from AskUserQuestion is ambiguous or empty (per the AskUserQuestion Validation Protocol in `workflows/reference.md`). For this safety-critical context, default to "Skip" rather than re-prompting — posting is irreversible. When in doubt, skip posting and inform the user.
- **Respect user-level CLAUDE.md overrides.** If the user's CLAUDE.md contains instructions like "never post PR comments" or "don't post comments on behalf of the user," those override this workflow's default posting behavior. Skip this step entirely and note: "Skipping comment posting per your CLAUDE.md instructions."
- **Never post without explicit, unambiguous user approval.**

> **Other comment-posting paths also have safeguards.** The `pr-responder` agent defaults to saving drafts to a temp file (user posts manually) and only posts when explicitly requested. The CLI `post` command is a programmatic tool invoked by callers — the safety gate is in the caller (this workflow or `pr-responder`), not the CLI itself.

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
   1. "Post this response" — "Post the comment as drafted"
   2. "Edit before posting" — "Modify the draft first"
   3. "Skip — don't post a comment (Recommended)" — "Push is enough, no comment needed"
   ```

4. Handle choice:
   - **"Post this response":** Only proceed if the AskUserQuestion response contains one of these acceptance phrases (case-insensitive): "Post this response", "post it", "post the comment", "option 1", or "yes, post". Any other response — including generic confirmations like "yes", "ok", "looks good", or "User has answered your questions" — does NOT qualify. **Negation check:** If the response also contains a negation word ("don't", "no", "not", "wait", "cancel", "stop", "actually", "never mind", "changed my mind") in the same sentence as the acceptance phrase, treat it as ambiguous and default to Skip. When proceeding: write comment to `/tmp/pr-comment-{pr_number}.md` and verify the file exists and is non-empty. **If write fails:** report the error, display the draft text so the user can copy it, and provide the `gh pr comment --body-file` command for manual use — do NOT fall back to inline `--body`, as shell metacharacters in code review comments may corrupt the content. If write succeeds, post via `gh pr comment {pr_number} --repo {upstream_repo} --body-file /tmp/pr-comment-{pr_number}.md`. Verify exit code 0, then delete the temp file.
   - **"Edit before posting":** Let the user modify the draft, then re-present for approval with the same AskUserQuestion. The same acceptance phrases, negation check, and ambiguous-response rules apply — do not loosen the criteria on subsequent rounds. **Loop bound:** After 3 rounds of "Edit before posting" without a successful post, inform the user: "Multiple edit rounds without posting. The draft is saved at `/tmp/pr-comment-{pr_number}.md` — you can post manually via `gh pr comment`." Then treat as Skip and exit. **Do not delete the temp file** in this case — the user needs it for manual posting.
   - **"Skip":** No comment posted. This is the safe default.
   - **Ambiguous or unclear response:** Treat as "Skip". Report: "Could not determine your choice — defaulting to skip (no comment posted). You can post manually via `gh pr comment`."

5. **If `gh pr comment` fails (for either "Post" or "Edit" path):** Report the error, display the drafted comment so the user can copy it, and offer: "Retry" / "Copy and post manually" / "Skip". **Before retrying**, check whether the comment was actually posted despite the error: run `gh pr view {pr_number} --repo {upstream_repo} --json comments` and check if any comment by the authenticated user, posted within the last 5 minutes, starts with the first 100 characters of the draft content. If already posted, inform the user: "The comment appears to have been posted despite the error — please verify on GitHub." Do not retry if the comment is already present. If the duplicate check command itself fails, inform the user that both post and verification failed, display the draft, and recommend they check the PR on GitHub manually before retrying. Clean up the temp file (`/tmp/pr-comment-{pr_number}.md`) after this sub-step completes — except when the user selected "Copy and post manually" (they need the file). Do NOT silently proceed without the comment.

**After this sub-step completes (or is skipped):** If currently in Phase C's sequential loop (from `work-through-issues.md`), return there to process the next item. Otherwise, return to "After Each Action" in the core router (`commands/oss.md`).
