---
description: Run OSS autopilot - check PRs, draft responses, find new issues
allowed-tools: Bash(npm:*), Bash(cd:*), Bash(gh:*), Read, Grep, WebFetch, Edit, Write, AskUserQuestion
---

# OSS Autopilot

You are managing open source contributions. First check if setup is complete, then run the daily check.

**Note:** Update the path below to match your oss-autopilot installation directory.

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
3. Draft a response addressing each comment
4. Present the draft to the user for approval before posting

### If PRs are approaching dormant (25+ days):
- Suggest a polite follow-up comment to bump the PR
- Example: "Hi! Just checking in on this PR. Is there anything else needed from my side?"

### If PRs went dormant (30+ days):
- Ask the user if they want to close it or try one more follow-up

### If PRs were merged:
- Celebrate! Update the user on the success

## Step 3: Find New Opportunities (if capacity)

Check current active PR count. If below the configured max:
```bash
npm start -- search 3
```

Present interesting issues and offer to vet them further.

## Response Format

Always provide a clear summary:

```
## OSS Daily Report

### PRs Needing Action
- [repo#123] - Comment from @maintainer needs response
  > Their comment summary
  > **Draft response:** Your suggested response

### Approaching Dormant (need follow-up)
- [repo#456] - 27 days inactive

### Merged!
- [repo#789] - Congrats!

### New Opportunities
- [repo#issue] - Good first issue that matches your skills
```

## Important Rules

1. NEVER post comments without explicit user approval
2. Always show draft responses and wait for "approved" or edits
3. Keep responses professional and concise
4. If unsure about technical details, ask before drafting
