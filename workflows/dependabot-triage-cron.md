# Dependabot PR Auto-Triage (Headless Cron)

> **Type:** Headless automation — runs without user interaction
> **Output:** `~/dependabot-report.md` — triage results and actions taken
> **Schedule:** Daily, morning (e.g., 7:00 AM local time)

## Purpose

Automatically triage dependabot PRs across all your repos. Safe updates are auto-merged; risky ones are flagged for manual review.

## Triage Rules

| Condition | Action |
|-----------|--------|
| Patch/minor bump + green CI + no conflicts | Auto-merge |
| Major version bump | Flag for manual review |
| Failing CI | Flag for manual review |
| Merge conflicts | Flag for manual review |
| Security advisory fix (any version) | Auto-merge if CI passes |

## Cron Setup

### macOS / Linux (crontab)

```bash
# 7:00 AM PT — dependabot triage + auto-merge
0 14 * * * claude -p "Check all my repos for open dependabot PRs using gh. For patch and minor version bumps with passing CI and no conflicts, auto-merge them. For major bumps or anything with failing CI/conflicts, add to a report at ~/dependabot-report.md with the reason they need manual review." --allowedTools "Bash,Read,Write" > ~/dependabot-triage.log 2>&1
```

## Report Format

After each run, `~/dependabot-report.md` contains:

```markdown
# Dependabot Triage Report — {date}

## Auto-Merged ({count})
| Repo | Dependency | Version Change | Type |
|------|-----------|----------------|------|
| owner/repo | lodash | 4.17.20 → 4.17.21 | patch |

## Needs Manual Review ({count})
| Repo | Dependency | Version Change | Reason |
|------|-----------|----------------|--------|
| owner/repo | react | 17.0.2 → 18.0.0 | Major version bump |
| owner/repo | webpack | 5.88.0 → 5.89.0 | CI failing |
```

## Integration

- The SessionStart hook can surface what was auto-merged and what needs attention
- Reduces PR noise so daily triage can focus on real contributions
- Pairs with: daily PR status (#782), setup wizard (#791)

## Safety

- Only auto-merges patch/minor bumps — never major versions
- Requires passing CI before auto-merge
- Requires no merge conflicts
- All actions logged to `~/dependabot-triage.log`
- Report persisted to `~/dependabot-report.md` for audit

## Disabling

Remove the crontab entry or use `/setup-automation` to manage.
