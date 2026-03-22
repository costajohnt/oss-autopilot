# Dependabot PR Auto-Triage (GitHub Action)

> **Type:** Automated — runs as a scheduled GitHub Action
> **Output:** GitHub Issue (auto-updated) — triage results and actions taken
> **Schedule:** Daily at 7:00 AM PT (14:00 UTC)

## Purpose

Automatically triage dependabot PRs across all your repos. Safe updates are auto-merged; risky ones are flagged for manual review. Runs as a deterministic GitHub Action — no LLM needed.

## Triage Rules

| Condition | Action |
|-----------|--------|
| Patch/minor bump + green CI + no conflicts | Auto-merge (`gh pr merge --squash --auto`) |
| Major version bump | Flag for manual review |
| Failing CI | Flag for manual review |
| Merge conflicts | Flag for manual review |
| Unknown bump type | Flag for manual review |

## How It Works

The GitHub Action (`.github/workflows/dependabot-triage.yml`):

1. Queries all open dependabot PRs via `gh search prs --author app/dependabot`
2. For each PR, parses the version bump type from the title (patch/minor/major)
3. Checks CI status and mergeability via `gh pr checks` and `gh pr view`
4. Applies the deterministic triage rules above
5. Creates or updates a pinned GitHub Issue with the report

### Setup

1. Create a GitHub PAT with `repo` scope (for cross-repo access)
2. Add it as a repository secret named `DEPENDABOT_TRIAGE_TOKEN`
3. The Action runs automatically on schedule, or trigger manually via `gh workflow run dependabot-triage.yml`

## Report Format

The report is posted as a GitHub Issue titled "Dependabot Triage Report (auto-updated)":

```markdown
# Dependabot Triage Report

**Date:** 2026-03-22
**PRs found:** 5

## Auto-Merged

| PR | Title | Bump |
|-----|-------|------|
| [owner/repo#42](url) | Bump lodash from 4.17.20 to 4.17.21 | patch |

## Needs Manual Review

| PR | Title | Reason | CI |
|-----|-------|--------|-----|
| [owner/repo#43](url) | Bump react from 17.0.2 to 18.0.0 | Major bump | passing |
```

## Integration

- The SessionStart hook can surface the report from the GitHub Issue (#813)
- Reduces PR noise so daily triage can focus on real contributions
- Pairs with: daily PR status (#810), session-start hook (#813)

## Safety

- Only auto-merges patch/minor bumps — never major versions
- Uses `--auto` flag — GitHub waits for CI to pass before merging
- Requires no merge conflicts
- All actions logged in the GitHub Action run log
- Report persisted as a GitHub Issue for audit

## Disabling

Disable the workflow in the GitHub Actions settings or delete `.github/workflows/dependabot-triage.yml`.
