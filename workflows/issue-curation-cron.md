# Issue List Curation (Headless Cron)

> **Type:** Headless automation — runs without user interaction
> **Output:** Updates `~/Documents/notes/open-source/potential-issue-list.md` in place
> **Schedule:** Daily, early morning (e.g., 5:00 AM local time)
> **Duration:** Runs slowly with API delays to avoid rate limits

## Purpose

Automated overnight curation of the OSS issue list. Searches for new issues, vets all entries, prunes low-quality ones, and re-prioritizes by score.

## Curation Steps

### 1. Search for New Issues
- Run all search strategies: good-first-issue labels, recent issues in watched repos, language/topic filters
- Use the CLI search command with built-in rate limit handling
- Add 5-second delays between API calls to stay within limits

### 2. Vet Every Issue (New and Existing)
For each issue on the list, check:
- Is the issue still open?
- Has someone else claimed it or submitted a PR?
- Does it match configured skills/interests?
- Assign a quality/fit score (1-10)

### 3. Prune
- Remove any issue scoring below 6
- Remove closed/claimed issues
- Remove issues from repos that have gone dormant

### 4. Prioritize
- Re-rank remaining issues by score (highest first)
- Group by category/language if configured

## Cron Setup

### macOS / Linux (crontab)

```bash
# 5:00 AM PT — issue list curation (runs slow, avoids rate limits)
0 12 * * * claude -p "Curate my OSS issue list at open-source/potential-issue-list.md in ~/Documents/notes. Steps: 1) Search for new candidate issues using all strategies, with 5-second delays between API calls to avoid rate limits. 2) Vet every issue on the list (new and existing) — check if still open, unclaimed, matches my skills. Score each 1-10. 3) Remove anything below a 6. 4) Re-prioritize the list by score. 5) Write the updated list back." --allowedTools "Bash,Read,Write,Edit,Glob,Grep" > ~/oss-issue-curation.log 2>&1
```

## Rate Limit Handling

- Deliberate 5-10 second delays between GitHub API calls
- If rate limited, back off exponentially and retry
- Log progress so partial runs are visible
- Partial results are still useful — write what you have

## Integration

- Updated list is ready when the user starts their session
- SessionStart hook can mention "X new issues added overnight"
- `/oss-search` remains available for on-demand searches
- Pairs with: daily PR status (#782), setup wizard (#791)

## Disabling

Remove the crontab entry or use `/setup-automation` to manage.
