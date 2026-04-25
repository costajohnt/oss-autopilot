---
name: pr-ready
description: Run the project's pre-commit review loop to determine whether the current branch is ready to push — lint, tests, parallel pr-review-toolkit agents, fix-and-re-run until convergence
allowed-tools: Bash, Read, Glob, Grep, Agent, TaskCreate, TaskUpdate, Edit, Write
---

# /pr-ready

This command drives the **mandatory pre-commit review loop** that the project's CLAUDE.md describes. It does not push or open a PR — it tells you whether the branch is ready to.

## What it does

For the diff currently uncommitted-and-staged or already on the local branch (whichever applies):

1. **Verify branch hygiene** — confirm we're not on `main`, the working tree has work to evaluate, and main has been pulled recently. If the working tree is clean and the branch matches main, abort with "nothing to review".

2. **Run the project's lint+format checks**:
   - `pnpm run lint`
   - `pnpm run format:check` (if the project's `package.json` defines it)
   - Surface any failures inline; do not auto-fix unless the user explicitly asks.

3. **Run the full test suite**: `pnpm test`. Block readiness on any failure.

4. **Dispatch the pr-review-toolkit agents in parallel** against the diff:
   - `pr-review-toolkit:code-reviewer` — bugs, dead code, consistency
   - `pr-review-toolkit:silent-failure-hunter` — error handling gaps
   - `pr-review-toolkit:code-simplifier` — refactoring opportunities

   For larger PRs (>15 files or new test surface), additionally run:
   - `pr-review-toolkit:pr-test-analyzer` — coverage gaps
   - `pr-review-toolkit:comment-analyzer` — outdated/over-explanatory comments
   - `pr-review-toolkit:type-design-analyzer` — when new types are introduced

5. **Triage findings**:
   - **Critical** and **Recommended** findings: report inline; the loop is not converged until they're resolved.
   - **Minor** findings: report but do not block.
   - **Out-of-scope** findings (e.g., a pre-existing issue in adjacent code): list them as "deferred" and recommend filing follow-up issues.

6. **Iterate**: after the user fixes findings (or asks the command to fix straightforward ones), **re-run only the agents that had findings** plus `code-reviewer` as a baseline. Do NOT re-run all five every loop — that's wasteful and slow.

7. **Convergence**: stop when zero Critical/Recommended findings remain. Hard cap at 5 iterations; if the loop hasn't converged, stop and report.

8. **Final gate**: re-run `pnpm run lint` and `pnpm test` after the last fix. A clean diff that converged on review but breaks lint/tests is not ready.

9. **Report**:
   - **READY**: branch passes lint, tests, and review-toolkit. Print the suggested commit message stub and the next-step command (e.g., `git push -u origin <branch>`).
   - **NOT READY**: list the remaining blockers in priority order.

## When to use

- After implementing a feature or fix and before staging the commit.
- After fixing review feedback locally, before pushing the response commits.
- Before opening a PR, as the last sanity check the project's CLAUDE.md mandates.

Roughly equivalent to running the project's "Pre-Commit Code Review" workflow (`workflows/pre-commit-review.md`) by hand, but with the loop, convergence check, and final lint/test gate automated.

## When NOT to use

- For an external repo where you don't have the project's `pnpm` scripts wired up — fall back to the `pr-review-toolkit:review-pr` skill instead.
- For a documentation-only change where the review-toolkit's code-focused agents don't add signal. (Lint/format check is still useful.)

## Output format

Always end with one of these two stanzas:

```
## ✅ Ready to push

Suggested commit message:
  <conventional-commit-format-line>

  <body explaining why>

Next step: git push -u origin <branch> && gh pr create --base main --head <branch> ...
```

```
## ❌ Not ready

Blockers (in priority order):
  1. <one-line blocker>
  2. <one-line blocker>

Pass count: <N> review iterations · convergence: <converged|stuck>
```

## Notes

- **Don't auto-commit or auto-push.** The user controls whether the work lands. This command answers "is the work ready?", not "ship it".
- **Cite findings by file:line.** Cheap pointer back to the change makes follow-up trivial.
- **Track iteration via TaskCreate**: one task per review-loop pass (subject `pr-ready pass N`, status `in_progress` while running, `completed` when the pass finishes). Mid-loop interrupt-and-resume stays clean.
