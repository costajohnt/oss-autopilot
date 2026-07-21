---
name: OSS Contribution Best Practices
description: This skill should be used when the user is working on open source contributions, responding to maintainer feedback, writing PR descriptions, working on issues, following up on dormant PRs, or needs guidance on open source etiquette and best practices.
version: 2.0.0
---

# Open Source Contribution Best Practices

**Reference:** Based on [opensource.guide](https://opensource.guide/how-to-contribute/)

This skill is the index. The detail topics live in two sibling skills that load on demand:

- **`pr-etiquette`** — responding to code review feedback, writing PR descriptions, dormant-PR follow-up cadence, PR quality checklist, communication etiquette.
- **`contribution-ethics`** — AI attribution rules, AI-tell avoidance in maintainer-visible writing, when to defer to a human.

Both are linked below. Use this file for the universal rules that apply to every contribution regardless of stage; jump to the sibling skills when you're at a specific stage in the cycle.

## Core Principles

**Be a good open source citizen:**

1. Respect maintainers' time — they're often unpaid volunteers
2. Read contribution guidelines before contributing
3. Communicate clearly and professionally
4. Be patient — open source moves at its own pace
5. Give back to the community when you can

## Minimal Diff Discipline

Every line in a PR diff must be directly related to the issue being fixed. Unrelated formatting changes (whitespace, quote style, trailing commas, import reordering, line breaks) make diffs noisy, harder to review, and signal carelessness. Maintainers will flag or reject PRs with formatting bloat.

**Rules:**

1. **Only touch lines the fix requires.** Don't reorder imports, change quote styles, fix whitespace, or add trailing commas in existing code — unless those changes are part of the fix itself.
2. **Scope formatter output.** If the repo's formatter must be run (e.g., CI requires it), review the formatter's changes afterward. Use `git diff` to identify formatting-only changes. Use `git checkout -- {files}` only for files where ALL changes are formatting-only. For files with mixed changes, use targeted edits to surgically remove formatting hunks. (In interactive terminal contexts, `git add -p` can also be used for hunk-level staging.)
3. **Match the repo's style, don't impose your own.** If the repo uses single quotes, use single quotes in your new code. If it uses tabs, use tabs. Never convert existing style to a different one.

**When formatting IS the fix:** If the issue itself is about formatting (e.g., "run prettier on codebase", "fix inconsistent indentation"), then formatting changes are in scope. In all other cases, they are not.

## Minimize Public API Surface

A narrow fix should not widen what the project must support forever. Prefer correcting behavior inside an existing public API over adding a new option, flag, method, or parameter. Every new surface is something maintainers have to document, test, and keep backward-compatible — reach for one only when the existing API genuinely cannot express the fix, and say so explicitly rather than defaulting to a new knob.

## Fix the Root Cause, Not a Workaround

Trace a bug to where it actually originates before patching. If the cause lives in an upstream dependency, fix or report it there rather than working around it downstream. If the maintainer rejects the root-cause fix as a known limitation, offer a documentation note that warns other users — don't submit a second local patch that papers over the same underlying problem.

## Regression Tests Must Actually Regress

A test added alongside a bug fix only earns its place if it fails without the fix. Before including it, check out the base branch (or revert your fix), run the new test, and confirm it FAILS; then restore the fix and confirm it passes. A test that passes on the unpatched base isn't guarding the bug — it's noise.

## Working on Issues

### Before Starting

1. Read the entire issue and all comments
2. Check if someone else is already working on it (check for linked PRs)
3. Make sure you understand the requirements
4. Verify you have the skills/time to complete it

### Work-First Approach

Do NOT comment to "claim" the issue before you have working code. The workflow is:

1. Fork/clone the repo
2. Implement the fix
3. Verify tests pass locally
4. Open a PR that references the issue (e.g., "Fixes #123")

The PR itself is the claim. A separate "I'm working on this" comment is unnecessary noise when the PR is coming soon.

### When to Comment on the Issue

Only comment on the issue itself when:

- You need clarification from the maintainer before starting
- The approach is ambiguous and you want confirmation
- The issue is old and you want to confirm it's still relevant

### If You Can't Solve It

Move on silently. Don't comment that you tried and failed. Don't mark the issue on the upstream repo in any way. Remove it from your local list and continue to the next one.

**Persistent skip (optional):** the `/oss` "Work Through Issues" workflow (`workflows/work-through-issues.md`, Phase C) can persist the skip to your local `skipped-issues.md` via the CLI's `skip-add` command so the same issue doesn't resurface in future searches. This is a local-only record — nothing is posted on GitHub.

### After Opening a PR

- Reference the issue in the PR body: "Fixes #123" or "Closes #123"
- Only comment on the issue if the PR needs additional context

## Time Management

### Sustainable Pace

- Don't over-commit
- It's okay to work on one PR at a time
- Quality over quantity
- Contribute consistently, not in bursts

### Managing Multiple PRs

- Prioritize PRs that are close to merge
- Respond to feedback within 24-48 hours
- Don't let PRs go stale
- Know when to close and move on

## Failure Protocol

When a task or approach fails, **STOP and report back to the user** with what failed and why. Don't silently switch strategies or improvise workarounds — let the user decide how to proceed.

This protocol governs **unexpected** failures: a tool crashing, an external command returning an error you weren't prepared for, a check producing output you don't know how to handle, an assumption turning out to be wrong. In those cases: stop, report what failed, ask.

It does **not** override decision points that the workflow itself documents. The `/oss` workflows surface explicit fallback choices in several places (e.g., "if retry fails, offer retry / skip / done for now"). Those branches were planned, are surfaced to the user, and are exactly the kind of "let the user decide" behavior this protocol asks for. Follow them as written.

In short:

- **Documented branch in a workflow** (a step that names its fallback options) → follow it; surface the choices to the user; do what they pick.
- **Improvised fallback** (substituting a different command, retrying with no plan, swapping in a less-specific approach because the first didn't work) → never. Stop and ask.

## See Also

- `pr-etiquette` skill — review responses, PR descriptions, dormant-PR follow-up, PR quality checklist, communication style.
- `contribution-ethics` skill — AI attribution rules, AI-tell avoidance, when to defer to a human.

## Resources

- [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/)
- [Best Practices for Maintainers](https://opensource.guide/best-practices/)
- [Building Welcoming Communities](https://opensource.guide/building-community/)
