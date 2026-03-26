---
name: OSS Contribution Best Practices
description: This skill should be used when the user is working on open source contributions, responding to maintainer feedback, writing PR descriptions, working on issues, following up on dormant PRs, or needs guidance on open source etiquette and best practices.
version: 1.1.0
---

# Open Source Contribution Best Practices

**Reference:** Based on [opensource.guide](https://opensource.guide/how-to-contribute/)

## Core Principles

**Be a good open source citizen:**
1. Respect maintainers' time - they're often unpaid volunteers
2. Read contribution guidelines before contributing
3. Communicate clearly and professionally
4. Be patient - open source moves at its own pace
5. Give back to the community when you can

## Minimal Diff Discipline

Every line in a PR diff must be directly related to the issue being fixed. Unrelated formatting changes (whitespace, quote style, trailing commas, import reordering, line breaks) make diffs noisy, harder to review, and signal carelessness. Maintainers will flag or reject PRs with formatting bloat.

**Rules:**
1. **Only touch lines the fix requires.** Don't reorder imports, change quote styles, fix whitespace, or add trailing commas in existing code — unless those changes are part of the fix itself.
2. **Scope formatter output.** If the repo's formatter must be run (e.g., CI requires it), review the formatter's changes afterward. Use `git diff` to identify formatting-only changes. Use `git checkout -- {files}` only for files where ALL changes are formatting-only. For files with mixed changes, use targeted edits to surgically remove formatting hunks. (In interactive terminal contexts, `git add -p` can also be used for hunk-level staging.)
3. **Match the repo's style, don't impose your own.** If the repo uses single quotes, use single quotes in your new code. If it uses tabs, use tabs. Never convert existing style to a different one.

**When formatting IS the fix:** If the issue itself is about formatting (e.g., "run prettier on codebase", "fix inconsistent indentation"), then formatting changes are in scope. In all other cases, they are not.

## Responding to Code Review Feedback

### Mindset

Maintainer feedback is a gift - they're investing time to help you improve. Even critical feedback should be received gracefully.

### Response Approach

- Address every point they raise
- Keep it short. One or two sentences is usually enough.
- Push updates promptly after discussion
- Mark conversations as resolved after addressing
- If you disagree, explain once briefly, then defer to their judgment

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

## Writing Good PR Descriptions

### Structure

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
- Keep it concise - maintainers review many PRs
- Highlight anything unusual or that needs special attention
- Don't pad with unnecessary sections

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

Move on silently. Don't comment that you tried and failed. Don't mark the issue in any way. Remove it from your list and continue to the next one.

### After Opening a PR

- Reference the issue in the PR body: "Fixes #123" or "Closes #123"
- Only comment on the issue if the PR needs additional context

## Following Up on Dormant PRs

- **7 days:** Light check-in ("Anything else needed from my side?")
- **14 days:** Direct follow-up ("Still on your radar? Happy to make changes.")
- **30 days:** Final check ("Understand if priorities shifted. Let me know!")

Be patient, not pushy. Only follow up once per timeframe. Check if maintainers are active elsewhere before escalating.

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

**Tip:** Use the `pr-compliance-checker` agent to validate your PR before requesting review.

## Communication Etiquette

### Always
- Be patient - maintainers are often volunteers
- Respond promptly to feedback (within 24-48 hours)
- Keep discussions public and constructive
- Accept decisions gracefully, even if you disagree

### Never
- Argue or be defensive
- Ping maintainers repeatedly
- Take rejection personally
- Ignore feedback points
- Make demands or set ultimatums

### Writing Style (Avoiding AI Tells)

AI-generated comments have recognizable patterns. Avoid these:

- **No changelogs in comments.** "Changes in the latest commit:" with bullet points is a dead giveaway. Describe what you did in a sentence, or let the diff speak.
- **Vary your openings.** Don't start every response with "Thanks for the review!" or "Good catch!" Sometimes just jump to the substance.
- **Match their length.** If the maintainer wrote two sentences, don't respond with four paragraphs.
- **Read the whole thread first.** Asking about something explained three comments up is the fastest way to lose credibility.
- **Mean what you say.** Don't defend a position then immediately abandon it. Push back or agree -- pick one.
- **Figure things out yourself.** If a maintainer says "add a screenshot," look at existing examples. Don't ask them to explain the tooling.

### When to Respond Personally

Some situations require the human contributor, not an AI tool:

- **Maintainer frustration or AI accusations** — respond honestly and personally
- **Visual/subjective tasks** — screenshots, design opinions, UX judgments
- **Heated discussions** — any thread about AI ethics, contribution policies, or governance
- **Process questions with obvious answers** — look at existing examples instead of asking

## Contribution Ethics

### Do

- Attribute work properly (co-authors for human pair work)
- Give credit to human contributors in PR descriptions
- Share knowledge with other contributors

### Don't

- Add AI attribution to commits or PRs:
  - No `Co-Authored-By: Claude` trailers
  - No "Generated with Claude Code" in PR descriptions
  - No robot emoji attributions
  - No mentions of AI assistance in comments
- Claim credit for others' work
- Submit low-quality PRs just for contribution graphs
- Spam repos with trivial changes

## Failure Protocol

When a task or approach fails, **STOP and report back to the user** with what failed and why. Do not silently switch strategies or improvise workarounds — let the user decide how to proceed. Documented fallbacks (e.g., gh CLI fallback) are permitted if the user is informed first. Undocumented or improvised fallbacks are never permitted.

## Resources

- [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/)
- [Best Practices for Maintainers](https://opensource.guide/best-practices/)
- [Building Welcoming Communities](https://opensource.guide/building-community/)
