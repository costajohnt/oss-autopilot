---
description: Configure OSS autopilot preferences
allowed-tools: Bash(npm:*), Bash(cd:*), AskUserQuestion
---

# OSS Autopilot Setup

Guide the user through configuring their OSS autopilot preferences.

**Note:** Update the path below to match your oss-autopilot installation directory.

## Step 1: Check Current Status

```bash
cd /path/to/oss-autopilot && npm start -- setup
```

If output shows "Setup already complete", ask the user if they want to reconfigure. If yes, run:
```bash
npm start -- setup --reset
```

## Step 2: Gather Preferences

Use AskUserQuestion to ask the user about their preferences. Ask these questions:

1. **GitHub Username** (required)
   - "What is your GitHub username?"

2. **Max Active PRs**
   - "How many PRs do you want to work on at once?"
   - Options: 5, 10 (default), 15, 20

3. **Dormant Threshold**
   - "After how many days should a PR be considered dormant?"
   - Options: 14 days, 21 days, 30 days (default), 45 days

4. **Languages** (can select multiple)
   - "What programming languages do you want to contribute to?"
   - Options: TypeScript, JavaScript, Python, Go, Rust, Other

5. **Issue Labels** (can select multiple)
   - "What types of issues should we search for?"
   - Options: good first issue, help wanted, bug, enhancement, documentation

## Step 3: Apply Settings

Once you have the answers, apply them:

```bash
npm start -- setup --set username=THEIR_USERNAME maxActivePRs=NUMBER dormantDays=NUMBER languages=lang1,lang2 labels=label1,label2 complete=true
```

Example:
```bash
npm start -- setup --set username=costajohnt maxActivePRs=10 dormantDays=30 languages=typescript,javascript labels="good first issue,help wanted" complete=true
```

## Step 4: Initialize PRs

After setup is complete, offer to import the user's existing open PRs:

```bash
npm start -- init USERNAME
```

## Step 5: Confirm

Show the user their configured settings and confirm setup is complete:

```bash
npm start -- setup
```

Tell the user: "Setup complete! You can now run `/oss` to check your PRs and find new contribution opportunities."
