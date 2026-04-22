# Dispatch Review Agents — Shared Template

**Canonical reference for the multi-agent review dispatch.** Both
`draft-first-workflow.md` (Step 3) and `pre-commit-review.md` (sub-step 3)
delegate to this file. Any change to the agent roster, prompt templates,
convergence loop, or fallback goes here — not in the calling workflows.

## Preconditions

Before dispatching agents, the caller must provide:

- `mergeBase` — the merge base commit for the full branch diff.
  (Callers typically compute `mergeBase=$(git merge-base "$remote/$baseBranch" HEAD)` and use `git diff $mergeBase..HEAD`.)
- `reviewDiff` — the full diff string (for inclusion in every agent prompt).
- `changedFiles` — list of changed file paths.
- `workingDir` — absolute path of the local repository.
- `issueContext` — `{ title, url }` when this review is scoped to a specific issue. Used for the SCOPE block. Omit when running a generic pre-commit review.
- `reviewPass` — integer, initialized to 1 by the caller.
- `agentsWithFindings` — empty array, initialized by the caller. Used for targeted re-dispatch on pass 2+.

## SCOPE Block

**Include this SCOPE block at the top of every agent prompt when `issueContext` is provided** (new contribution flow in draft-first-workflow Step 3):

```
SCOPE: This PR addresses issue '{issueContext.title}' ({issueContext.url}).
Focus findings on changes related to this issue. Flag pre-existing issues only
if they are Critical severity. Do NOT suggest improvements outside the scope of this PR.
FORMATTING RULE: Flag any diff hunks that are formatting-only (whitespace, quote style,
trailing commas, import reordering) and unrelated to the issue fix. These must be reverted
before the PR is submitted. Do not flag formatting that is part of the functional fix.
```

Omit the SCOPE block for generic pre-commit reviews (`pre-commit-review.md` sub-step 3 when no issue context is present). In that case, the caller's sub-step 4b runs a Scope Discipline Check after consolidation to catch unrelated changes.

## Dispatch Rule

**CRITICAL: Dispatch ALL agents in a SINGLE message for true parallelism.** Always dispatch the full base agent suite — do not scale down based on diff size; the convergence loop depends on comprehensive coverage.

**Always include `Working directory: {workingDir}` in every agent prompt.** Without it, agents inherit the parent session's working directory and file lookups fail.

## Base Agents (always dispatched)

`code-reviewer`, `silent-failure-hunter`, `code-simplifier`, `pr-test-analyzer`, `comment-analyzer`.

```
Task(pr-review-toolkit:code-reviewer,
  "[SCOPE block if applicable]

   Review the following code changes for bugs, logic errors, security vulnerabilities,
   and adherence to project conventions.
   Repository: {repo name}
   Working directory: {workingDir}
   Convention notes: {any CONTRIBUTING.md or lint config findings}
   Changed files: {changedFiles}

   Additional checks:
   - API naming conventions: If new public API surface is added, flag double-negative
     booleans (e.g., nonInteractive when the codebase uses positive booleans).
   - JS/TS truthiness: flag !obj.prop when the intent is strictly false, and === false
     vs !prop inconsistencies. Flag boolean coercion of values that could be 0, '', or null.
   - Formatting hygiene: flag diff hunks that are formatting-only (whitespace, quotes,
     trailing commas, import reordering). Do not flag formatting that is part of the
     functional fix.
   - Documentation accuracy: cross-reference doc/README/JSDoc claims against code; check
     option descriptions match defaults; flag stale docs when code behavior changed.

   Diff:
   {reviewDiff}")

Task(pr-review-toolkit:silent-failure-hunter,
  "[SCOPE block if applicable]

   Review the following code changes for silent failures, inadequate error handling,
   and inappropriate fallback behavior.
   Working directory: {workingDir}
   Changed files: {changedFiles}

   Diff:
   {reviewDiff}")

Task(pr-review-toolkit:code-simplifier,
  "[SCOPE block if applicable]

   Review the following code changes for dead code, unnecessary complexity, and
   simplification opportunities. Do NOT modify files — report findings only.
   Do NOT suggest cosmetic changes (import reordering, quote style, trailing commas,
   whitespace) as improvements — only flag them for reversion per the FORMATTING RULE.
   Working directory: {workingDir}
   Changed files: {changedFiles}

   Diff:
   {reviewDiff}")

Task(pr-review-toolkit:pr-test-analyzer,
  "[SCOPE block if applicable]

   Analyze test coverage and assertion quality for the following code changes.
   Working directory: {workingDir}
   Test directory: {test dir path}
   Changed files: {changedFiles}

   Coverage: check if modified code paths have tests; identify gaps.

   Assertion strength: for each new/modified test, ask 'if I broke the feature under
   test, would this test actually catch it?' Flag:
   - Assertions too broad (only checking final output, not intermediate states)
   - Test names claiming comprehensive coverage but only checking a subset
   - Tests that would still pass if the feature regressed (e.g., .toBeDefined() when a
     specific value is expected)
   - Override/disable tests that don't prove the override works, only that the code runs

   Diff:
   {reviewDiff}")

Task(pr-review-toolkit:comment-analyzer,
  "[SCOPE block if applicable]

   Review comments in the following code changes for accuracy, completeness, and
   long-term maintainability.
   Working directory: {workingDir}
   Changed files: {changedFiles}

   Diff:
   {reviewDiff}")
```

## Conditional Agents (dispatch in the SAME message)

- **`pr-review-toolkit:type-design-analyzer`** — dispatch when changed files include TypeScript (`.ts`, `.tsx`) or other typed languages.

  ```
  Task(pr-review-toolkit:type-design-analyzer,
    "[SCOPE block if applicable]

     Review type design in the following TypeScript changes. Check for proper
     encapsulation, invariant expression, and type safety.
     Working directory: {workingDir}
     Changed files: {changed .ts/.tsx files}

     Diff:
     {reviewDiff filtered to .ts/.tsx files}")
  ```

## Fallback

If the PR review toolkit agents are unavailable (Task tool returns an error for those agent types), inform the user and dispatch the local `pre-commit-reviewer` agent instead:

> "PR review toolkit agents are not available. Falling back to the built-in pre-commit reviewer. This provides a general code review but does not include specialized checks for silent failures, type design, or test coverage."

```
Task(pre-commit-reviewer,
  "Review my pending code changes before committing.
   Repository: {repo name}
   Working directory: {workingDir}")
```

**Partial failure:** if some toolkit agents succeed and others fail, consolidate the successful results and note which reviews were skipped:
> "Note: The following specialized reviews could not be completed: {list}."

**Total failure:** if all agents fail, offer "Proceed (skip review)" / "Retry" / "Done for now".

## Consolidated Report

After all agents complete, merge outputs into a unified report. Deduplicate findings that multiple agents flagged.

**Track which agents found issues:** for each agent that reported Critical or Recommended findings, add its name to `agentsWithFindings`. This enables targeted re-dispatch on subsequent passes.

If any agent failed to complete, note it in the report:
> "Warning: {agent-name} did not complete. Its findings are not included."

```
## Review Summary — Pass {reviewPass}

### Critical ({count}) — Must fix before committing
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
- {any doc/README claims that don't match the code, or stale docs}

### Convention Alignment
- {any style/convention/naming mismatches}
```

**In-scope vs out-of-scope split** (when `issueContext` is provided):
- Separate findings into **In-Scope** (Critical/Recommended/Minor) and **Out-of-Scope** (pre-existing issues flagged as Critical-severity only).

If NO issues:
```
## Review Summary

All agents passed. No issues found — changes are clean and ready to commit.
```

## Automatic Convergence Loop

After consolidating findings, automatically fix and re-review until convergence. **Do not prompt the user during this loop** — it runs fully autonomously.

**Loop bound:** maximum 5 passes total (including the initial pass). If convergence is not reached after 5, present remaining findings and proceed to the caller's user-decision step.

**Convergence criteria:** zero Critical AND zero Recommended findings in the latest pass. Minor findings do not block convergence.

**Procedure:**

1. **Check convergence.** If zero Critical and zero Recommended: report
   > "Review converged on pass {reviewPass}. {minor_count} minor finding(s) noted — changes are clean."
   Proceed to the caller's decision step.

2. **If Critical or Recommended exist:** report
   > "Pass {reviewPass}: {critical} Critical, {recommended} Recommended, {minor} Minor. Fixing actionable findings..."

3. **Fix all Critical and Recommended findings.** Minor findings are noted but not auto-fixed.

4. **Increment `reviewPass`.** Re-gather the updated diff (caller's context-gather step).

5. **Targeted re-dispatch (pass 2+):** re-run only agents in `agentsWithFindings` from the previous pass plus `code-reviewer` as a baseline quality gate. Reset `agentsWithFindings` before collecting new results. Report:
   > "Re-review pass {reviewPass}: re-dispatching {agent list} (targeted) + code-reviewer (baseline). Agents that passed cleanly are skipped."

6. **Re-consolidate** and return to step 1.

**Cross-pass deduplication:** findings referencing the same file, line range (±5 lines), and substantially similar description are duplicates — do not re-report. Only new or materially changed findings count toward convergence.

**If max passes reached without convergence:**
> "Review did not converge after 5 passes. {remaining_count} finding(s) remain — presenting for manual review."

## After the Loop

Return control to the caller with:
- final consolidated report
- convergence status (`converged` or `max_passes_reached`)
- `reviewPass` count
- `agentsWithFindings` from the final pass

The caller decides the next user-facing action (commit / show diff / done for now).
