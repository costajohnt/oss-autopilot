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

### Response Framework

**For suggestions you'll implement:**
> "Good catch! I'll [specific action] and push an update."

Keep it short. Don't over-explain.

**For questions or clarifications:**
> "The reason I did X was [brief explanation]. Would you prefer [alternative]?"

**For feedback you disagree with:**
Be careful here. Maintainers usually have context you don't.

> "I see your point about X. I went with this approach because [reason]. Happy to change if you'd prefer [alternative]."

Never argue. If you strongly disagree, explain once, then defer to their judgment.

### Things to Avoid

- Being defensive or dismissive
- Long justifications for every decision
- "Actually, that's intentional" without explanation
- Ignoring feedback points
- Taking days to respond

### Things to Do

- Thank them for reviewing
- Address every point they raise
- Ask clarifying questions when genuinely confused
- Push updates promptly after discussion
- Mark conversations as resolved after addressing

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

### When to Follow Up

- No response in 7+ days: Light check-in
- No response in 14+ days: Direct follow-up
- No response in 30+ days: Consider if repo is maintained

### Follow-Up Messages

**7-day check-in:**
> "Hi! Just checking if there's anything else needed from my side?"

**14-day follow-up:**
> "Hi! Is this PR still on your radar? Happy to make any changes needed."

**30-day follow-up:**
> "Checking in again. I'd love to get this merged but understand if priorities have shifted. Let me know!"

### Tips

- Be patient, not pushy
- Only follow up once per timeframe
- Check if maintainers are active elsewhere (maybe they're on vacation)
- Consider if the project is still maintained

## Understanding CI Failures

### Common CI Issues

**Test failures:**
- Read the test output carefully
- Reproduce locally before pushing fixes
- Don't blindly adjust tests to pass

**Lint/format failures:**
- Run project's lint command locally
- Check for consistent formatting tools
- Follow project's style, not your preference

**Build failures:**
- Check for type errors
- Verify all imports are correct
- Ensure dependencies are properly declared

**Coverage failures:**
- Add tests for new code paths
- Check project's coverage requirements

### Responding to CI Failures

1. Investigate before asking - most failures have clear error messages
2. Fix and push - don't leave PR in failing state
3. If stuck, ask specific questions: "CI is failing with [error]. I've tried [X]. Any suggestions?"

## Evaluating Repositories

### Green Flags

- Recent commits (< 30 days)
- PRs getting merged regularly
- Issues getting responses
- CONTRIBUTING.md exists
- Active maintainer participation
- Regular releases

### Red Flags

- No commits in 60+ days
- Many stale PRs
- Unanswered issues
- Archived repository
- Single maintainer with no activity
- Hostile comments

### Before Contributing

1. Check recent PR activity - are they merging?
2. Read CONTRIBUTING.md
3. Look at merged PRs for style expectations
4. Check if there are issue templates to follow

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
- Thank maintainers for their time
- Accept decisions gracefully, even if you disagree

### Never
- Argue or be defensive
- Ping maintainers repeatedly
- Take rejection personally
- Ignore feedback points
- Make demands or set ultimatums

## Contribution Ethics

### Do

- Attribute work properly (co-authors for pair work)
- Give credit in PR descriptions
- Thank maintainers for their time
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
