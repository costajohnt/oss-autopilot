---
name: pr-ready
description: Run the project's pre-commit review loop to determine whether the current branch is ready to push — lint, tests, parallel pr-review-toolkit agents plus an over-engineering audit, fix-and-re-run until convergence
allowed-tools: Bash, Read, Glob, Grep, Agent, TaskCreate, TaskUpdate, Edit, Write
---

# /pr-ready

This command drives the **mandatory pre-commit review loop** that the project's CLAUDE.md describes. It does not push or open a PR — it tells you whether the branch is ready to.

## What it does

For the diff currently uncommitted-and-staged or already on the local branch (whichever applies):

1. **Verify branch hygiene** — confirm we're not on `main`, the working tree has work to evaluate, and main has been pulled recently. If the working tree is clean and the branch matches main, abort with "nothing to review".

   **Upstream drift check (mandatory).** Re-fetch the upstream default branch and detect any commits since this branch diverged that touch files in this branch's diff:

   ```bash
   git fetch <remote> <default> 2>/dev/null
   mergeBase=$(git merge-base <remote>/<default> HEAD)
   touchedFiles=$(git diff --name-only "$mergeBase" HEAD)
   overlappingCommits=$(git log "$mergeBase..<remote>/<default>" --oneline -- $touchedFiles)
   ```

   If `$overlappingCommits` is non-empty, surface the list and recommend re-vetting the issue before declaring READY. The same fix may have already merged; the CONTRIBUTING-style "no other open PRs" check passes vacuously when the duplicate has merged, so this drift check is the only safety net. Report as a Critical finding if any overlapping commits are found and the user hasn't acknowledged them.

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

   **Over-engineering audit (always).** While the agents run, apply the `ponytail-review` skill (ponytail plugin) to the same diff. If the plugin isn't installed, apply its format by hand — one line per finding, `<file>:L<line>: <tag> <what>. <replacement>.` with tags `delete:` (dead code, speculative flexibility), `stdlib:` (hand-rolled thing the standard library ships), `native:` (dependency doing what the platform does), `yagni:` (abstraction with one implementation, config nobody sets), `shrink:` (same logic, fewer lines). Scope is complexity only; correctness stays with the agents above. Before triage, drop any finding that duplicates a `code-simplifier` finding — keep whichever line is more specific.

5. **Triage findings**:
   - **Critical** and **Recommended** findings: report inline; the loop is not converged until they're resolved.
   - **Minor** findings: report but do not block.
   - Over-engineering findings map in: `delete`/`yagni`/`stdlib`/`native` → Recommended (they remove code or a dependency); `shrink` → Minor. For an OSS PR to an external repo, cap all of them at Minor — unrequested refactors widen the diff and annoy maintainers.
   - **Out-of-scope** findings (e.g., a pre-existing issue in adjacent code): list them as "deferred" and recommend filing follow-up issues.

6. **Iterate**: after the user fixes findings (or asks the command to fix straightforward ones), **re-run only the agents that had findings** plus `code-reviewer` as a baseline. Same for the over-engineering audit: re-run it only if it had findings. Do NOT re-run everything every loop — that's wasteful and slow.

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
