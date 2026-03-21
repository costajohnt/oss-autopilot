---
name: setup-automation
description: Configure optional headless cron jobs for automated OSS workflow tasks (daily PR status, dependabot triage, issue curation, weekly audit)
allowed-tools: Bash, Write, Read, Glob
---

# Automation Setup Wizard

You are guiding the user through configuring optional headless cron jobs for OSS workflow automation.

**Important:** All automations are fully optional. The tool works identically without them. These just pre-compute results so they're ready when sessions start.

## Step 1: Explain What's Available

Present the available automations:

```
## Available Automations

All of these are optional — your OSS workflow works fine without them.
These run Claude headlessly on a schedule to pre-compute results.

1. **Daily PR Status Report** — Generates ~/oss-daily.md each morning with all PR statuses,
   so Claude has context at session start without the "check my PRs" warmup.

2. **Dependabot Auto-Triage** — Auto-merges safe dependabot PRs (patch/minor with green CI),
   flags major bumps and failures for manual review.

3. **Issue List Curation** — Overnight search + vet + prune + re-prioritize your issue list,
   so it's fresh when you start working.

4. **Weekly PR Audit** — Sunday audit of shelved and waiting-on-maintainer PRs to catch
   ones that silently became actionable.
```

## Step 2: Ask Which Automations

Use AskUserQuestion:
```
Question: "Which automations would you like to set up?"
Header: "Automations"

Options:
1. "All of them (Recommended)" — "Full automation suite"
2. "Let me pick" — "Choose individual automations"
3. "None — just browsing" — "Exit setup"
```

If "Let me pick", present each one individually with yes/no.

## Step 3: Schedule Preferences

For each selected automation, ask about timing:

```
Question: "What timezone are you in? (This determines when cron jobs run)"
```

Then confirm default times or let them customize:
- Daily PR status: 8:00 AM local
- Dependabot triage: 7:00 AM local
- Issue curation: 5:00 AM local (runs slow)
- Weekly audit: Sunday 7:00 AM local

## Step 4: Output Locations

Confirm default output paths:
- `~/oss-daily.md` — daily PR report
- `~/dependabot-report.md` — dependabot triage results
- `~/oss-weekly-audit.md` — weekly audit results
- Issue list path from config (or `~/Documents/notes/open-source/potential-issue-list.md`)

## Step 5: Generate Configuration

Detect the OS and generate appropriate config:

### macOS / Linux — crontab entries

Generate the crontab entries with correct UTC offsets for their timezone.
Show them the entries for approval:

```
## Generated Crontab Entries

These will be added to your crontab:

# Daily PR status report — 8:00 AM {timezone}
{cron expression} claude -p "..." --allowedTools "Bash,Read,Write" > ~/oss-daily.log 2>&1

# Dependabot triage — 7:00 AM {timezone}
{cron expression} claude -p "..." --allowedTools "Bash,Read,Write" > ~/dependabot-triage.log 2>&1

...
```

## Step 6: Install

After user approval, install the crontab entries:

```bash
(crontab -l 2>/dev/null; echo "{new entries}") | crontab -
```

Verify installation:
```bash
crontab -l | grep "oss-autopilot\|oss-daily\|dependabot\|oss-weekly"
```

## Step 7: SessionStart Hook

Offer to enable the SessionStart hook integration (reads daily report at session start):

```
Question: "Enable automatic PR status injection at session start?"
Header: "SessionStart Hook"

Options:
1. "Yes (Recommended)" — "Claude gets PR context automatically"
2. "No" — "I'll check status manually"
```

## Uninstalling

Provide instructions for removing automations:
```bash
# View current cron jobs
crontab -l

# Edit and remove oss-autopilot entries
crontab -e
```

## Principles

- **Fully optional** — tool works identically without cron jobs
- **Transparent** — show exactly what will be installed before doing it
- **Reversible** — clear uninstall instructions
- **No surprises** — explain that headless runs consume API tokens
