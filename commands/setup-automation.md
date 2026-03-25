---
name: setup-automation
description: Configure optional headless cron jobs for automated OSS workflow tasks (daily PR status, dependabot triage, issue curation, weekly audit)
allowed-tools: Bash, Write, Read, Glob, AskUserQuestion
---

# Automation Setup Wizard

You are guiding the user through configuring optional headless cron jobs for OSS workflow automation.

**Important:** All automations are fully optional. The tool works identically without them. These just pre-compute results so they're ready when sessions start.

> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

## Step 1: Explain What's Available

Present the available automations:

```
## Available Automations

All of these are optional — your OSS workflow works fine without them.
These run Claude headlessly on a schedule to pre-compute results.

1. **Daily PR Status Report** — Generates ~/oss-daily.md each morning with all PR statuses,
   so Claude has context at session start without the "check my PRs" warmup.

2. **Dependabot Auto-Triage** — GitHub Action that auto-merges safe dependabot PRs
   (patch/minor with green CI), flags major bumps for manual review. No local crontab needed.

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
If "None", end with a brief note: "Run `/setup-automation` anytime to set these up later."

## Step 3: Detect Timezone

Get the user's timezone automatically and confirm:

```bash
# Detect system timezone
TZ_NAME=$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||' || date +%Z)
UTC_OFFSET=$(date +%z | sed 's/\([+-]\)\([0-9][0-9]\)\([0-9][0-9]\)/UTC\1\2:\3/')
echo "DETECTED: ${TZ_NAME} (${UTC_OFFSET})"
```

Present the detected timezone and ask for confirmation:

```
Your system timezone appears to be {TZ_NAME} ({UTC_OFFSET}).

Default schedule:
- Daily PR status: 8:00 AM local
- Issue curation: 5:00 AM local (runs slowly to avoid rate limits)
- Weekly audit: Sunday 7:00 AM local
- Dependabot triage: GitHub Action (no local cron)
```

Use AskUserQuestion:
```
Question: "Use these defaults?"
Header: "Schedule"

Options:
1. "Yes, use defaults (Recommended)" — "Standard schedule in your timezone"
2. "Customize times" — "Pick your own schedule for each job"
3. "Done for now" — "Cancel"
```

If "Customize times", ask for each enabled job's preferred time one at a time.

## Step 4: Compute Cron Expressions

Convert local times to UTC cron expressions. Use bash to compute:

```bash
# Convert a local HH:MM to UTC hour/minute for crontab
# Example: 8:00 AM in America/Los_Angeles
LOCAL_HOUR=8
LOCAL_MIN=0
UTC_EQUIV=$(TZ=UTC date -j -f "%H:%M" "${LOCAL_HOUR}:${LOCAL_MIN}" +"%H %M" 2>/dev/null || python3 -c "
from datetime import datetime, timezone
import zoneinfo
tz = zoneinfo.ZoneInfo('$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')')
local = datetime.now(tz).replace(hour=${LOCAL_HOUR}, minute=${LOCAL_MIN})
utc = local.astimezone(timezone.utc)
print(f'{utc.minute} {utc.hour}')
")
echo "CRON_TIME: ${UTC_EQUIV}"
```

Build the cron expressions. The CLI path is:
```
CLAUDE_PATH=$(which claude)
```

For each enabled automation, generate the cron line:

**Daily PR Status** (e.g., 8:00 AM local → computed UTC):
```
{MIN} {HOUR} * * * {CLAUDE_PATH} -p "Read workflows/daily-pr-status-cron.md from the oss-autopilot plugin directory and follow the instructions. Write output to ~/oss-daily.md." --allowedTools "Bash,Read,Write" > ~/oss-daily.log 2>&1
```

**Issue List Curation** (e.g., 5:00 AM local → computed UTC):
```
{MIN} {HOUR} * * * {CLAUDE_PATH} -p "Read workflows/issue-curation-cron.md from the oss-autopilot plugin directory and follow the instructions." --allowedTools "Bash,Read,Write,Glob" > ~/oss-issue-curation.log 2>&1
```

**Weekly PR Audit** (e.g., Sunday 7:00 AM local → computed UTC):
```
{MIN} {HOUR} * * 0 {CLAUDE_PATH} -p "Read workflows/weekly-pr-audit-cron.md from the oss-autopilot plugin directory and follow the instructions. Write output to ~/oss-weekly-audit.md." --allowedTools "Bash,Read,Write" > ~/oss-weekly-audit.log 2>&1
```

## Step 5: Show Generated Config for Approval

Display the complete crontab entries and ask for approval:

```
## Generated Crontab Entries

# OSS Autopilot — Daily PR status report ({LOCAL_TIME} {TZ_NAME})
{cron line}

# OSS Autopilot — Issue list curation ({LOCAL_TIME} {TZ_NAME})
{cron line}

# OSS Autopilot — Weekly PR audit ({LOCAL_TIME} {TZ_NAME}, Sundays)
{cron line}
```

If Dependabot triage was selected, note:
```
## Dependabot Triage (GitHub Action)

This automation runs as a GitHub Action, not a local cron job. Ensure:
1. The workflow file exists at .github/workflows/dependabot-triage.yml in your repos
2. GitHub Actions is enabled for your repos

No local installation needed for this one.
```

Use AskUserQuestion:
```
Question: "Install these crontab entries?"
Header: "Confirm Installation"

Options:
1. "Yes, install" — "Add to crontab now"
2. "Show me the raw crontab" — "Display the exact entries without installing"
3. "Cancel" — "Don't install anything"
```

## Step 6: Install

After user approval, install the crontab entries:

```bash
# Add entries to crontab (preserving existing entries)
EXISTING=$(crontab -l 2>/dev/null || true)
NEW_ENTRIES="{generated entries}"

# Check for duplicate oss-autopilot entries
if echo "$EXISTING" | grep -q "OSS Autopilot"; then
  echo "EXISTING_FOUND"
else
  echo "$EXISTING"$'\n'"$NEW_ENTRIES" | crontab -
  echo "INSTALLED"
fi
```

If `EXISTING_FOUND`, warn the user:
```
Existing OSS Autopilot cron entries found. Options:
1. "Replace existing" — Remove old entries and install new ones
2. "Keep both" — Add new entries alongside existing ones
3. "Cancel" — Don't change anything
```

To replace, filter out old entries and add new:
```bash
crontab -l 2>/dev/null | grep -v "OSS Autopilot\|oss-daily\|oss-weekly\|oss-issue-curation" | { cat; echo "$NEW_ENTRIES"; } | crontab -
```

Verify installation:
```bash
echo "=== Installed cron jobs ==="
crontab -l | grep -A1 "OSS Autopilot" || echo "No OSS Autopilot entries found"
```

## Step 7: Summary

Show what was installed:

```
## Automation Setup Complete

Installed:
- Daily PR status: {time} {timezone} → ~/oss-daily.md
- Issue curation: {time} {timezone} → updates your issue list
- Weekly audit: Sundays {time} {timezone} → ~/oss-weekly-audit.md

Logs: ~/oss-daily.log, ~/oss-issue-curation.log, ~/oss-weekly-audit.log

To check: crontab -l
To remove: crontab -e (delete the OSS Autopilot lines)
To reconfigure: /setup-automation
```

## Principles

- **Fully optional** — tool works identically without cron jobs
- **Transparent** — show exactly what will be installed before doing it
- **Reversible** — clear uninstall instructions
- **No surprises** — explain that headless runs consume API tokens
- **Idempotent** — detect existing entries and offer to replace
