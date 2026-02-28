# Pre-Commit Code Review (Standard Path — Existing PR Updates)

> **Session state:** Expects Tier 2 code changes to exist (uncommitted or committed-but-not-pushed). This workflow handles existing PR updates.
> **Routing check:** If `isNewContribution === true`, **STOP** — read `${CLAUDE_PLUGIN_ROOT}/workflows/draft-first-workflow.md` instead and follow the Draft-First Path.

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

Save as `changeSize` for use in sub-step 3. Report: "> Change size: {tier} ({N} diff lines, {M} files) — dispatching {K} agents."

**If classification fails** (command errors, unparseable output, or both counts are zero despite `git status --porcelain` showing changes): default to **Large** to ensure maximum review coverage and warn: "Could not determine change size — defaulting to Large for comprehensive review."

### 3. Dispatch Review Agents in Parallel

**CRITICAL: Dispatch ALL selected agents in a SINGLE message for true parallelism.**

Pass `reviewDiff` (from sub-step 2) as context to each agent.

**Initialize tracking:** Set `reviewPass = 1` and `agentsWithFindings = []` (empty list). These are used in the re-review loop (sub-step 6) to enable targeted re-dispatch.

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

**Track which agents found issues:** For each agent that reported Critical or Recommended findings, add its name to `agentsWithFindings`. This list is used in sub-step 6 to enable targeted re-dispatch on subsequent passes.

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
- After fixes, increment `reviewPass` and loop back to sub-step 2 to re-gather changes
- **Targeted re-dispatch (pass 2+):** Instead of re-dispatching ALL agents, only re-run the agents listed in `agentsWithFindings` from the previous pass. In addition, always include `code-reviewer` as a sanity check even if it was not in `agentsWithFindings` — it serves as the baseline quality gate. Report which agents are being re-dispatched:
  > "Re-review pass {reviewPass}: Re-dispatching {agentsWithFindings list} (targeted) + code-reviewer (sanity check). Agents that passed cleanly last round are skipped."
- Reset `agentsWithFindings` to empty before collecting new results. After agents complete, rebuild `agentsWithFindings` from this pass's results
- **If `agentsWithFindings` is empty after a pass** (all re-dispatched agents passed cleanly), the review is clean — present the "no issues" decision prompt from sub-step 5
- Continue until user is satisfied or selects a different option

**"Show full diff" / "Show full diff first":**
- Run the appropriate diff command based on `changeSource` (`git diff` for uncommitted, or the same `diffRange` that succeeded during the gather phase for committed-but-not-pushed) and **output the full diff as a markdown code block in your text response** so the user can read it
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
- **If `changeSource = "uncommitted"`:** Stage the specific changed files (not `git add -A`), then commit following the repo's conventional commit format
- **If `changeSource = "committed"`:** Changes are already committed — skip staging and committing, proceed directly to push
- **Do NOT add AI attribution** (no Co-Authored-By, no "Generated with" mentions)
- Push to the PR branch
- **If any git operation fails** (staging, commit, or push), report the specific error to the user and offer to retry or cancel
- **After confirming the push succeeded, proceed to sub-step 7 (Post Response Comment)**

**"Done for now":**
- Return to the core router (`commands/oss.md`) without committing

### 7. Post Response Comment (for existing PR updates)

**Skip this step if** the PR's status (from Phase A or Execute section context) was NOT `needs_response` or `needs_changes` — i.e., no maintainer feedback was being addressed. Maintenance-only actions (rebase, CI fix where status was `ci_failing`) do not need a response comment.

**SAFETY: Posting a public PR comment is an irreversible action visible to maintainers.** The following safeguards MUST be applied:

- **Default to NOT posting** if the user's choice from AskUserQuestion is ambiguous (e.g., generic "User has answered your questions" response without a clear option selection). When in doubt, skip posting and inform the user.
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

5. **If `gh pr comment` fails (for either "Post" or "Edit" path):** Report the error, display the drafted comment so the user can copy it, and offer: "Retry" / "Copy and post manually" / "Skip". **Before retrying**, check whether the comment was actually posted despite the error: run `gh pr view {pr_number} --repo {upstream_repo} --json comments` and check if any comment by the authenticated user, posted within the last 5 minutes, starts with the same content as the draft. If already posted, inform the user: "The comment appears to have been posted despite the error — please verify on GitHub." Do not retry if the comment is already present. If the duplicate check command itself fails, inform the user that both post and verification failed, display the draft, and recommend they check the PR on GitHub manually before retrying. Clean up the temp file (`/tmp/pr-comment-{pr_number}.md`) after this sub-step completes — except when the user selected "Copy and post manually" (they need the file). Do NOT silently proceed without the comment.

**After this sub-step completes (or is skipped):** If currently in Phase C's sequential loop (from `work-through-issues.md`), return there to process the next item. Otherwise, return to "After Each Action" in the core router (`commands/oss.md`).
