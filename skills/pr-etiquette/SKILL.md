---
name: PR Etiquette
description: This skill should be used when responding to maintainer review feedback, writing or reviewing PR descriptions, following up on dormant PRs, validating PR quality before submission, or deciding how to communicate with maintainers. Sibling to oss-contribution and contribution-ethics.
version: 1.0.0
---

# PR Etiquette

How to communicate around a pull request — review responses, descriptions, follow-up cadence, and the readiness gate. Pair with the `oss-contribution` skill (universal rules) and `contribution-ethics` (attribution + AI-tell avoidance).

## Responding to Code Review Feedback

### Mindset

Maintainer feedback is a gift — they're investing time to help you improve. Even critical feedback should be received gracefully.

### Response Approach

- Address every point they raise
- Keep it short. One or two sentences is usually enough.
- Push updates promptly after discussion
- Mark conversations as resolved after addressing
- If you feel resistance to a request, investigate deeper — the maintainer likely knows something you don't. If you still think there's an issue after investigating, raise it to the human contributor — never override the maintainer

### Assumptions and Verification

When a maintainer requests changes, these rules govern how you respond:

1. **Maintainer is right by default.** If a maintainer says "do X," your starting assumption is that X is correct and appropriate for their codebase. Do not second-guess their judgment about their own project.

2. **Verify, never assume.** Before running any tool (linter, formatter, type checker), check the project's CI configuration to confirm that tool is actually enforced. Read `.pre-commit-config.yaml`, `.github/workflows/`, `Makefile`, or equivalent before deciding what to run. A tool that exists in `devDependencies` but is not in CI is not authoritative.

3. **Try before estimating scope.** When asked to make a change, attempt the simplest implementation first. Do not respond with effort estimates, propose TODOs, or suggest deferring to a follow-up PR. If the change turns out to be genuinely complex after attempting it, report what you found to the human.

4. **Pushback = escalate, don't override.** If you believe a maintainer's request is incorrect or harmful, raise the concern to the human contributor. Never push back on a maintainer directly, never ignore the request, and never silently do something different from what was asked.

5. **No TODOs as substitutes.** A maintainer asking for a change expects the change in this PR. Responding with a TODO comment or "I'll handle this in a follow-up" is not an acceptable response unless the maintainer explicitly suggested that approach.

### Pre-Push Review Checkpoint

Before pushing commits that address review feedback:

1. Run the project's code review tooling on your diff (the pr-review-toolkit agents if installed, otherwise the built-in pre-commit-reviewer)
2. Fix any issues found (bugs, style violations, missing error handling)
3. Re-run until clean — no actionable findings
4. Only then push your changes

This prevents maintainers from seeing issues that could have been caught locally. It's especially important when responding to feedback — pushing sloppy fix-up commits undermines credibility.

### PR Readiness Gate (Mandatory)

A PR is NEVER "ready" until all of these pass:

1. **Local lint/type check**: Run the repo's linters and type checkers
2. **Test suite**: Run the full test suite locally
3. **Code review**: Run review agents (pr-review-toolkit or pre-commit-reviewer)
4. **Fix and re-run**: Fix all findings, re-run checks
5. **Convergence**: Repeat until zero Critical/Recommended findings
6. **Push and verify CI**: Push and confirm CI passes remotely
7. **Only then** declare the PR ready for maintainer review

The tool should NEVER say "PR is ready", "work is complete", or "changes are done" without having run through this complete loop. This applies to:

- New contributions (draft-first workflow)
- Responses to maintainer feedback
- CI fix pushes
- Any commit that will be seen by maintainers

### Things to Avoid

- Being defensive or dismissive
- Long justifications for every decision
- Ignoring feedback points
- Taking days to respond
- Assuming what tools the project's CI enforces without checking CI config files
- Substituting TODOs or "follow-up PR" proposals for changes the maintainer requested in this PR
- Running tools not enforced by CI and treating their output as authoritative

## Writing Good PR Descriptions

### When the upstream repo has a PR template

If `.github/PULL_REQUEST_TEMPLATE.md` (or a sibling at `.github/pull_request_template.md`, `docs/pull_request_template.md`, or repo root) exists, the template is the **baseline** for your PR body — you merge your summary INTO it, not over it. Use `oss-autopilot pr-template <owner>/<repo>` to fetch it.

- Preserve the template's headings, HTML comments, and checklist items verbatim.
- Leave every checkbox unchecked (`- [ ]`). Maintainers' bots (DCO, changesets, license headers) rely on those items being actively ticked.
- Drop your summary under an existing summary/description heading if there is one; otherwise prepend it.

Wiping the template is the most common reason a maintainer flags an autopilot PR as careless.

### Structure (when no template exists)

```markdown
## Summary

[1-2 sentences explaining what this PR does]

## Problem

[What problem does this solve? Link to issue if applicable]

## Solution

[Brief explanation of your approach]

## Testing

[How you tested the changes]

## Screenshots (if UI changes)

[Before/after screenshots]
```

### Tips

- Link to related issues: "Fixes #123" or "Closes #123"
- Keep it concise — maintainers review many PRs
- Highlight anything unusual or that needs special attention
- Don't pad with unnecessary sections

## Following Up on Dormant PRs

- **7 days:** Light check-in ("Anything else needed from my side?")
- **14 days:** Direct follow-up ("Still on your radar? Happy to make changes.")
- **30 days:** Final check ("Understand if priorities shifted. Let me know!")

Be patient, not pushy. Only follow up once per timeframe. Check if maintainers are active elsewhere before escalating.

**Workflow:** `workflows/dormant-pr-follow-up.md` operationalizes this cadence — run via the `/oss` router or the action menu. It surfaces dormant PRs, buckets them into tiers, and drafts a tier-appropriate follow-up through the `draft-review-post` skill (never auto-posts).

## PR Quality Checklist

Before submitting any PR, verify:

### Required

- [ ] **Issue Reference**: PR links to issue (`Closes #X` or `Fixes #X`)
- [ ] **Description Quality**: Explains what changed and why
- [ ] **Title Quality**: Descriptive, properly formatted (e.g., `fix: resolve login timeout`)
- [ ] **Focused Changes**: One logical change per PR (< 10 files, < 400 lines ideal)
- [ ] **Minimal Diff**: No unrelated formatting changes (whitespace, quotes, imports, trailing commas)

### Conditional

- [ ] **Tests Included**: If project requires tests, add them
- [ ] **Docs Updated**: If behavior changed, update docs

### Optional

- [ ] **Branch Naming**: Follows convention (`feature/`, `fix/`, `docs/`)
- [ ] **Screenshots**: Included for UI changes

> **Source of truth:** This checklist mirrors the canonical rubric at `packages/core/src/core/pr-quality-rubric.ts`. The `pr-compliance-checker` agent's scoring (`computeComplianceScore`) reads its weights and the `< 10 files, < 400 lines` threshold from that file. Edit the rubric source first, then update this checklist; a CI test pins that the scored weights total 100.

**Tip:** Use the `pr-compliance-checker` agent to validate your PR before requesting review.

## Communication Etiquette

### Always

- Be patient — maintainers are often volunteers
- Respond promptly to feedback (within 24-48 hours)
- Keep discussions public and constructive
- Accept decisions gracefully, even if you disagree

### Never

- Argue or be defensive
- Ping maintainers repeatedly
- Take rejection personally
- Ignore feedback points
- Make demands or set ultimatums

For AI-tell avoidance specifically (recognizable AI patterns to avoid in maintainer-visible writing) and the rules on when to defer to a human, see the `contribution-ethics` skill.

## See Also

- `oss-contribution` skill — universal contribution rules (minimal-diff discipline, working on issues, time management, failure protocol).
- `contribution-ethics` skill — AI attribution rules, AI-tell avoidance, when to defer to a human.
