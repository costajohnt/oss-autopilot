# Workflow: Plan Review Convergence Loop

Companion to `pre-commit-review.md` for the **planning phase** (#1249).
The pre-commit loop catches code-quality issues; this loop catches
design-level problems BEFORE any code is written. A plan caught and
refined here is much cheaper than the same problem caught after 200
lines of code exist.

## When this fires

Auto-dispatched by `draft-first-workflow.md` after the investigation
step completes and a plan artifact has been written to
`/tmp/oss-autopilot-plans/<repo>-<issue-number>.md`. Implementation
does not begin until this loop returns `READY TO IMPLEMENT`.

Can also be invoked manually via `/plan-ready` — same convergence
logic without the auto-dispatch.

## Plan artifact shape

The plan written by the investigation step should follow this
structure (the review loop checks for these sections):

```markdown
# Implementation Plan: <repo>#<issue-number>

## Issue Summary
[One-paragraph restatement of the problem]

## Investigation Findings
- What the agent learned about the codebase
- Existing conventions / patterns relevant to the change
- Alternative approaches considered (and why they were not chosen)

## Proposed Approach
[The chosen approach with explicit reasoning]

## Specific Changes
1. File: ... — change description
2. File: ... — change description
...

## Edge Cases Handled
- [Each edge case the plan addresses]

## Acceptance Criteria
- [How we'll know the implementation is complete]
```

A plan missing one of: `Investigation Findings`, `Proposed Approach`,
`Specific Changes`, `Acceptance Criteria` is too thin to review and
the loop returns `NEEDS DRAFTING` so the planning step iterates first.

## Convergence loop

The same shape as `pre-commit-review.md` but with design-focused
agents:

1. **First pass** — dispatch in parallel against the plan text:
   - `pr-review-toolkit:code-reviewer` — design-level critique
   - `pr-review-toolkit:silent-failure-hunter` — error / edge-case
     coverage
   - `pr-review-toolkit:code-simplifier` — scope-shrink opportunities
   - `devils-advocate` — adversarial scenarios that break the plan

2. **Triage** — same severity buckets as the code review:
   - **Critical**: plan would force a rewrite mid-implementation. Block.
   - **Recommended**: plan ships but suboptimal. Block.
   - **Minor**: wording / sectioning. Report, don't block.
   - **Deferred**: out-of-scope follow-ups. List separately.

3. **Iterate**: update the plan (the parent workflow / user does
   this), then re-run **only the agents that had findings** plus
   `code-reviewer` as a baseline. Same scope-down-on-rerun rule the
   pre-commit loop uses. Cap at 5 passes; if not converged, stop and
   surface the unresolved blockers.

4. **Report** — `READY TO IMPLEMENT` with a one-line plan summary, or
   `NEEDS REWORK` with the blockers.

## Why two loops, not one

`/pr-ready` cannot catch design-level problems because by the time it
runs, the design is sunk cost. Catching "this should have been a
config change instead of a 200-line refactor" after 200 lines exist
means throwing the work away or salvaging it; both are expensive.

`/plan-ready` cannot catch code-quality problems because the code
doesn't exist yet. Catching dead code or missing tests at the planning
stage is meaningless — those concerns live in the implementation
artifact.

The two loops complement each other; they do not replace each other.

## Out of scope

- Choosing the planning agent or planning skill that authors the plan.
  This loop is the *reviewer*; the author is upstream and exists in
  several forms (Plan subagent, `superpowers:writing-plans` skill,
  manual user-authored plans).
- Persisting the converged plan into project history. The artifact
  lives at `/tmp/oss-autopilot-plans/...` for the duration of the
  session and is regenerated each time. PR descriptions reproduce the
  relevant portions in their own format.

## Why now

The project has tight code-review discipline after code is written
(pre-commit-review.md) but no equivalent gate before. The cheapest bug
is the one caught at the planning stage; this workflow makes that
cheapness available without requiring users to remember to ask for a
plan critique manually.
