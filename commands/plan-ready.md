---
name: plan-ready
description: Run a review-and-critique convergence loop on an implementation plan BEFORE any code is written — mirrors /pr-ready for the planning phase
allowed-tools: Bash, Read, Glob, Grep, Agent, TaskCreate, TaskUpdate, Edit, Write
---

# /plan-ready

Drives the **plan-review convergence loop** that catches design-level
problems before any code is written. Mirrors `/pr-ready` exactly, but
applied to a plan artifact instead of a diff (#1249).

## When to use

Run after you have completed investigation and written an implementation
plan, BEFORE you start implementing. A solid plan caught and refined here
is much cheaper than the same problem caught after 200 lines of code
exist.

The slash command auto-locates the plan artifact at
`/tmp/oss-autopilot-plans/<repo>-<issue-number>.md`. Pass the path
explicitly if the plan lives elsewhere: `/plan-ready /tmp/some-plan.md`.

## What it does

For the named plan artifact:

1. **Verify the plan is complete enough to evaluate.** Check that it has
   sections covering: investigation findings, proposed approach,
   specific file-level changes, alternative approaches considered, and
   acceptance criteria. Block readiness if the plan is a stub (single
   paragraph, no structure) — that needs more drafting before review.

2. **Dispatch the pr-review-toolkit agents in parallel** against the
   plan text:
   - `pr-review-toolkit:code-reviewer` — design-level critique (does
     the proposed approach make sense for the codebase? Are there
     simpler / more idiomatic alternatives the plan missed?)
   - `pr-review-toolkit:silent-failure-hunter` — does the plan name how
     it handles edge cases, error paths, partial failures, or does it
     silently assume the happy path?
   - `pr-review-toolkit:code-simplifier` — is the plan's scope right?
     Is there a simpler change that achieves the same outcome?
   - `devils-advocate` — actively try to break the plan. List
     scenarios where the proposed approach fails or surprises a future
     reader.

   Brief each agent with the plan text, the issue body it targets, and
   any contributing-guidelines context already discovered.

3. **Triage findings**:
   - **Critical** findings (plan is wrong / incomplete in a way that
     would force a rewrite mid-implementation): block readiness.
   - **Recommended** findings (plan ships but is suboptimal — wrong
     file structure, missed alternative): block readiness.
   - **Minor** findings (wording, sectioning): report but don't block.
   - **Out-of-scope** findings: list as "deferred to follow-up plan".

4. **Iterate**: after the user updates the plan (or asks the command
   to update it), re-run **only the agents that had findings** plus
   `code-reviewer` as a baseline. Same scope-down-on-rerun pattern as
   `/pr-ready`. Hard cap at 5 passes; if convergence isn't reached,
   stop and report.

5. **Report**: produce a short status report — `READY TO IMPLEMENT`
   with a one-line summary of what the plan does, or `NEEDS REWORK`
   with the blockers.

## What it does NOT do

- Does not write or modify the plan itself. The user (or a parent
  workflow) does that. This command only critiques.
- Does not start implementation. Implementation is gated on the
  `READY TO IMPLEMENT` verdict but is a separate step.
- Does not replace `/pr-ready`. The two run at different stages of the
  pipeline:
  - `/plan-ready` → before code is written, catches design problems
  - `/pr-ready` → before code is pushed, catches code problems

Both are mandatory in the project's full draft-first workflow.

## How it integrates with `draft-first-workflow.md`

`workflows/plan-review.md` is the auto-fired sibling to
`workflows/pre-commit-review.md`. The draft-first workflow dispatches
plan-review immediately after investigation completes and a plan
artifact exists; implementation does not begin until plan-review
returns `READY`.

Manually invoking `/plan-ready` does the same convergence loop without
the auto-dispatch — useful when you want to critique a plan you wrote
outside the draft-first workflow.
