# Weekly PR Audit (Headless Cron)

> **Type:** Headless automation — runs without user interaction
> **Output:** `~/oss-weekly-audit.md` — audit results with categorized recommendations
> **Schedule:** Weekly, Sunday morning (e.g., 7:00 AM local time)

## Purpose

Audit every PR that isn't actively being worked on. Catches PRs that have silently become actionable — new comments, CI breakage, conflicts, competing PRs, or dormant repos.

## Audit Checks

For each shelved or waiting-on-maintainer PR:

| Check | Description |
|-------|-------------|
| **New comments** | Has the maintainer or anyone responded since last check? |
| **CI status change** | Did CI break due to upstream changes? |
| **Merge conflicts** | Has the base branch moved and created conflicts? |
| **Issue still open** | Is the underlying issue still open? |
| **Competing PRs** | Did someone else submit a PR for the same issue? |
| **Repo activity** | Is the repo/maintainer still active? |

## Categorization

For each PR, assign one of:

| Category | Meaning |
|----------|---------|
| **Still waiting** | Nothing changed, genuinely blocked on maintainer |
| **Needs action** | New comment, CI failure, conflict, or competing PR — include what changed and recommended action |
| **Consider closing** | Repo dormant, issue closed, or 60+ days with no signal |

## Cron Setup

### macOS / Linux (crontab)

```bash
# Sunday 7:00 AM PT — weekly PR audit
0 14 * * 0 claude -p "Audit all my open PRs that are shelved or waiting on maintainer. For each: check for new comments, CI status changes, merge conflicts, whether the issue is still open, competing PRs, and repo activity level. Categorize each as still-waiting, needs-action, or consider-closing. Write the report to ~/oss-weekly-audit.md" --allowedTools "Bash,Read,Write" > ~/oss-weekly-audit.log 2>&1
```

## Report Format

```markdown
# Weekly PR Audit — {date}

## Needs Action ({count})
- **owner/repo#123** — "Fix widget alignment"
  - Change: Maintainer commented 2 days ago asking for test coverage
  - Action: Respond to comment and add tests

## Consider Closing ({count})
- **owner/repo#456** — "Add dark mode support"
  - Reason: Repo has had no commits in 90 days, maintainer inactive
  - Action: Close PR with a polite note

## Still Waiting ({count})
- **owner/repo#789** — "Fix memory leak" (14 days)
  - Status: Approved, waiting for maintainer to merge
```

## Integration

- On Sundays/Mondays, SessionStart hook flags "weekly audit found X PRs needing attention"
- PRs recategorized as needs-action can be auto-promoted in daily triage
- Pairs with: daily PR status, setup wizard

## Disabling

Remove the crontab entry or use `/setup-automation` to manage.
