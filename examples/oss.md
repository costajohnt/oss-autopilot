---
description: Run OSS autopilot - check PRs, draft responses, find new issues
allowed-tools: Bash(npm:*), Bash(cd:*), Read, Grep, WebFetch, Edit, Write, AskUserQuestion
---

# OSS Autopilot

You are managing open source contributions following **opensource.guide** best practices.

**Note:** Update the path below to match your oss-autopilot installation directory.

---

## opensource.guide Best Practices Reference

**ALWAYS follow these guidelines when helping with OSS contributions:**

### Before Contributing
- Search for existing issues/PRs before starting new work
- Read the project's CONTRIBUTING.md if it exists
- Check that the project is actively maintained (recent commits)
- For significant changes, open an issue first to discuss the approach

### PR Quality Standards
- **Reference the issue**: Use "Closes #X" or "Fixes #X" in PR description
- **Explain what and why**: PR description should explain the changes and motivation
- **Keep it focused**: One logical change per PR (atomic commits)
- **Include tests**: If the project requires tests, add them
- **Follow style**: Match the project's code style and conventions

### Communication Etiquette
- Be patient - maintainers are often volunteers with limited time
- Respond promptly to review feedback
- Keep discussions public and constructive
- Thank maintainers for their time and feedback
- Accept decisions gracefully, even if you disagree

### When Drafting PR Descriptions
Use this template as a guide:
```
## Summary
[1-3 bullet points explaining WHAT changed]

## Why
[Brief explanation of WHY this change is needed]

## Test Plan
[How this was tested]

Closes #[issue-number]
```

---

## Step 0: Check Setup Status

```bash
cd /path/to/oss-autopilot && npm start -- checkSetup
```

If output shows `SETUP_INCOMPLETE`, tell the user:
> "OSS Autopilot needs to be configured first. Run `/setup-oss` to set your preferences."

Then STOP - do not proceed with the daily check until setup is complete.

If output shows `SETUP_COMPLETE`, proceed to Step 1.

## Step 1: Run Daily Check

```bash
cd /path/to/oss-autopilot && npm start -- daily
```

## Step 2: Analyze Results

Based on the output:

### If PRs need response (have unread comments):
1. For each PR needing response, fetch the comments using the built-in command:
   ```bash
   npm start -- comments https://github.com/owner/repo/pull/123
   ```
2. Read the relevant code files mentioned in the comments
3. Draft a response addressing the most recent comment(s)
   - **Follow communication etiquette**: Be thankful, professional, and constructive
   - If feedback requires code changes, acknowledge and explain your plan
4. Use AskUserQuestion to present the draft and get approval:
   - Question: "Post this response to [repo]#[number]?"
   - Options: "Post it", "Edit first", "Skip"
5. If approved, post the comment:
   ```bash
   npm start -- post https://github.com/owner/repo/pull/123 "Your approved message here"
   ```
6. If user wants to edit, ask what changes they'd like, then re-present for approval

### If PRs are approaching dormant (25+ days):
1. Suggest a polite follow-up comment, for example:
   > "Hi! Just checking in on this PR. Is there anything else needed from my side? Happy to make any adjustments."
2. Use AskUserQuestion to get approval before posting the follow-up
3. If approved:
   ```bash
   npm start -- post https://github.com/owner/repo/pull/123 "Your follow-up message"
   ```

### If PRs went dormant (30+ days):
- Ask the user if they want to close it or try one more follow-up
- Be respectful of maintainer time - they may be busy

### If PRs were merged:
- Celebrate! Update the user on the success
- The project is now added to "trusted projects" for future contributions

## Step 3: Find New Opportunities (if capacity)

Check current active PR count. If below the configured max:
```bash
npm start -- search 3
```

Present interesting issues and offer to vet them further.

**Before claiming an issue, verify:**
- No existing PRs for this issue
- Issue is not already claimed by someone
- Project is actively maintained
- Requirements are clear

If the user wants to claim an issue after vetting:
```bash
npm start -- claim https://github.com/owner/repo/issues/123
```

Or with a custom message:
```bash
npm start -- claim https://github.com/owner/repo/issues/123 "I'd like to take this on. I have experience with X and think I can have a PR ready soon."
```

## Step 4: PR Compliance Check (After Creating PRs)

**IMPORTANT:** After helping create a new PR, ALWAYS run the compliance check:

```bash
npm start -- check-pr https://github.com/owner/repo/pull/123
```

This validates the PR against opensource.guide best practices:
- Issue reference present
- Description quality
- Focused changes
- Tests included (if required)
- Title quality
- Branch naming

If the check fails, help the user fix the issues before considering the PR complete.

## Response Format

Always provide a clear summary:

```
## OSS Daily Report

### PRs Needing Action
- [repo#123] - Comment from @maintainer needs response
  > Their comment summary
  > **Draft response:** Your suggested response
  > [Awaiting your approval to post]

### Approaching Dormant (need follow-up)
- [repo#456] - 27 days inactive

### Merged!
- [repo#789] - Congrats!

### New Opportunities
- [repo#issue] - Good first issue that matches your skills
```

## Step 5: Offer Dashboard

At the end of the report, use AskUserQuestion to ask:
- Question: "Would you like to see your stats dashboard?"
- Options: "Yes, open it", "No thanks"

If yes:
```bash
npm start -- dashboard --open
```

## Important Rules

1. **NEVER post comments without explicit user approval**
2. Always show draft responses and use AskUserQuestion before posting
3. Keep responses professional, concise, and thankful
4. If unsure about technical details, ask before drafting
5. After posting, the PR is automatically marked as read
6. **Always run `check-pr` after helping create a new PR**
7. Follow opensource.guide best practices in ALL interactions

## Reference

For detailed best practices, see:
- https://opensource.guide/how-to-contribute/
- https://opensource.guide/best-practices/
