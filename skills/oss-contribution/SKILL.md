---
name: OSS Contribution Best Practices
description: This skill should be used when the user is working on open source contributions, responding to maintainer feedback, writing PR descriptions, claiming issues, following up on dormant PRs, or needs guidance on open source etiquette and best practices.
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

## Responding to Code Review Feedback

### Mindset

Maintainer feedback is a gift - they're investing time to help you improve. Even critical feedback should be received gracefully.

### Response Approach

- Address every point they raise
- Keep it short. One or two sentences is usually enough.
- Push updates promptly after discussion
- Mark conversations as resolved after addressing
- If you disagree, explain once briefly, then defer to their judgment

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

## Claiming Issues

### Before Claiming

1. Read the entire issue and all comments
2. Check if someone else is already working on it
3. Make sure you understand the requirements
4. Verify you have the skills/time to complete it

### Claim Message Template

**Good:**
> "Hi! I'd like to work on this. I have experience with [relevant tech]. Should I proceed with [brief approach idea]?"

**Also good:**
> "I'd like to take this on! Any guidance on the expected approach?"

**Avoid:**
- Long introductions about yourself
- Detailed implementation plans (save for PR)
- Over-promising timelines
- Claiming multiple issues at once
- Claiming without any plan to start soon

### After Claiming

- Start within a reasonable time (1-3 days)
- If blocked, comment with your question
- If you can't continue, unclaim so others can work on it

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

- Attribute work properly (co-authors for pair work)
- Give credit in PR descriptions
- Share knowledge with other contributors

### Don't

- Add AI attribution to commits or PRs
- Claim credit for others' work
- Submit low-quality PRs just for contribution graphs
- Spam repos with trivial changes

## Resources

- [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/)
- [Best Practices for Maintainers](https://opensource.guide/best-practices/)
- [Building Welcoming Communities](https://opensource.guide/building-community/)
