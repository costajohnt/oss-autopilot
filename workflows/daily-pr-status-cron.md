# Daily PR Status Report (Headless Cron)

> **Type:** Headless automation — runs without user interaction
> **Output:** `~/oss-daily.md` — daily PR status summary
> **Schedule:** Daily, before your first session (e.g., 8:00 AM local time)

## Purpose

Generate a daily PR status report so Claude has PR context at session start, eliminating the "check my PRs" warmup step.

## Cron Setup

### macOS / Linux (crontab)

```bash
# 8:00 AM PT — daily OSS PR status report
0 15 * * * claude -p "Check all my open PRs with gh. For each: CI status, review state, days since last activity. Flag anything actionable. Write the summary to ~/oss-daily.md" --allowedTools "Bash,Read,Write" > ~/oss-daily.log 2>&1
```

### What the report includes

For each open PR:
- Repository and PR number
- CI status (passing/failing/pending)
- Review state (approved/changes requested/pending)
- Days since last activity
- Whether it needs attention (merge conflict, unresponded comment, etc.)

Summary section:
- Total active PRs
- PRs needing attention (count + list)
- PRs waiting on maintainer
- Any PRs approaching dormancy

### Integration

- The SessionStart hook reads `~/oss-daily.md` and surfaces it to Claude
- Claude can proactively suggest actions based on the report
- Pairs with: weekly PR audit (#785), dependabot triage (#783)

### Disabling

Remove the crontab entry:
```bash
crontab -e  # Remove the relevant line
```

Or use `/setup-automation` to manage all automation settings.
