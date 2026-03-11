---
name: oss-search
description: "Search for new open source issues to contribute to — parallel multi-strategy search with vetting"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, mcp__*
---

# OSS Issue Search

This command searches for new open source issues to contribute to using parallel multi-strategy search with automated vetting.

> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

## Session State

**Initialize on entry** (reset each time):
- `searchRoundScores`: number[] = [] (average vetting score per search round)
- `searchedRepos`: string[] = [] (repos surfaced in previous rounds, auto-excluded from subsequent rounds)

**Inherited from `/oss` session** (if invoked from there):
- `hasIssueList`, `availableCount`, `completedCount`, `issueListPath` — curated issue list info

## Pre-Search: Issue List Check

**If `hasIssueList` is true and `availableCount > 0`**, present a preamble before searching:

Use AskUserQuestion:
- "Review from your curated list ({availableCount} available)" — "Pick from pre-vetted issues you've already researched"
- "Search GitHub" — "Find new issues via parallel multi-strategy search"
- "Both — list first, then search" — "Review your list, then search for more"
- "Done for now"

Route based on choice:
- "Review from list" → this command requires `/oss` context. Tell the user: "Returning to `/oss` to browse your issue list." End this command; the parent `/oss` session handles "Pick Issue From List".
- "Search GitHub" → continue with **Parallel Multi-Strategy Search** below
- "Both" → show list first (return to `/oss` for "Pick Issue From List"), then continue with **Parallel Multi-Strategy Search**
- "Done for now" → end this command. If invoked from `/oss`, return to the parent session. If standalone, exit.

## Parallel Multi-Strategy Search

**CRITICAL: Dispatch ALL 3 strategies in a SINGLE message for true parallelism.**

**Strategy A — Established repos (merged-PR + open-PR repos):**
```
Task(issue-scout, "Find recently-opened issues (last 30 days) in repos where the user has merged or open PRs.
  [If searchedRepos is non-empty, insert: "Exclude results from these repos (already searched in prior rounds): {searchedRepos as comma-separated list}."]
  Get merged-PR repos: read ~/.oss-autopilot/state.json, extract repo names from repoScores entries where mergedPRCount > 0 (sorted by mergedPRCount descending).
  Get open-PR repos: run `gh search prs --author @me --state open --json repository --jq '.[].repository.nameWithOwner' | sort -u`.
  Combine both lists (merged-PR repos first), deduplicate.
  For each repo: `gh search issues --repo OWNER/REPO --state open --sort created --limit 5`.
  Exclude issues authored by the user (get username from `gh api user -q .login`).
  Return at most 15 total results (prioritize repos with higher mergedPRCount).
  For each: repo, number, title, URL, labels, source: 'established-repo', and brief assessment.")
```

**Strategy B — Filtered CLI search (language + label + star filters):**
```
Task(general-purpose, "Run the CLI search command and return the raw JSON output verbatim:
  ```bash
  GITHUB_TOKEN=$(gh auth token) node \"${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs\" search 10 --json
  ```")
```

When Strategy B returns, check the JSON `success` field. If `success: false`, treat it as a failed strategy. If `success: true`, tag each candidate in `data.candidates` as source: `'cli-search'`.

**Strategy C — Trending/popular repos in user's language preferences:**
```
Task(issue-scout, "Search for good-first-issue candidates in trending/popular repos the user has NOT contributed to.
  [If searchedRepos is non-empty, insert: "Exclude results from these repos (already searched in prior rounds): {searchedRepos as comma-separated list}."]
  Exclude issues authored by the user (get username from `gh api user -q .login`).
  Read the user's language preferences from CLI: `config --json`.
  Read minStars from ~/.oss-autopilot/state.json at path config.minStars (default 50 if missing or null).
  Then: gh search issues --label 'good first issue' --language {lang} --state open --sort reactions-+1 --limit 20
  For each candidate, check the repo's star count via `gh api repos/{owner}/{repo} -q .stargazers_count`.
  Filter out repos with fewer stars than minStars.
  Focus on repos with high star counts and recent activity.
  Return at most 10 results that pass the filter.
  For each: repo, number, title, URL, labels, star count, source: 'trending-repo', and brief assessment.")
```

## Combine, Filter, and Deduplicate

After all 3 strategies return:

1. **Normalize** all results to: `{ repo, number, title, url, labels, source, metadata }`. For Strategy B, flatten `candidate.issue.{repo, number, title, url, labels}` to the top level and place `candidate.{recommendation, viabilityScore, repoScore, reasonsToApprove, reasonsToSkip}` into `metadata`.
2. **Filter Strategy B** against `searchedRepos` — remove candidates whose repo appears in `searchedRepos`
3. **Cross-strategy spam filter** — apply label-farming detection across ALL results:
   - Flag repos where a single issue has 5+ beginner-type labels (good first issue, hacktoberfest, easy, beginner, starter, up-for-grabs, first-timers-only, help wanted)
   - Flag repos where 3+ issues have near-identical titles (e.g., "Add Entry X", "Create Item Y")
   - Remove all issues from flagged repos across all strategies, log: "Filtered {count} issues from {repos} (label-farming detected)"
4. **Deduplicate** by issue URL — keep the entry with richest metadata, assign **highest-priority source tag** (Established repo > CLI search > Trending repo)
5. **Sort** by source priority: Established repo first, then CLI search, then Trending repo
6. **Update `searchedRepos`** — append all repos from deduplicated results

**If ALL strategies failed** (all 3 returned errors):
Show each strategy's specific error message, then:
> "All 3 search strategies failed. Check: `gh auth status`, CLI build exists, network connectivity."

Use AskUserQuestion: "Retry search" / "Done for now". Route: retry → top of search, done → end.

**If some strategies failed**, report which strategy failed and its error message, then continue with available results. Omit strategies that returned zero results without comment.

**If total candidate count is zero** (all succeeded but empty):
> "No matching issues found. Exclusion list may be too large or filters too narrow."

Use AskUserQuestion: "Retry with broader criteria" (broaden Strategy C to include `'help wanted'` label) / "Done for now".

Present combined results grouped by source (omit empty groups):
```
## Search Results ({totalCount} candidates from {successCount} strategies)

### From Established Repos ({count})
{results with source: 'established-repo'}

### From CLI Search ({count})
{results with source: 'cli-search'}

### From Trending Repos ({count})
{results with source: 'trending-repo'}
```

## Batch Vet Flow

Set `currentRound = searchRoundScores.length + 1`.

Use AskUserQuestion:
- "Add all to list and vet in parallel (Recommended)" — "Add candidates to your issue list as 'Pending vet', then dispatch parallel vet agents"
- "Pick one to vet now" — "Select a single candidate to investigate immediately"
- "Search again with different criteria" — "Run another parallel search round (prior repos auto-excluded)"
- "Done for now"

**"Add all to list and vet in parallel":**

1. Add each candidate to the curated list under `## Pending Vet`:
   ```markdown
   ### {owner}/{repo} ({stars}★) — {repo description}
   - [#{number}]({url}) — {issue title}
     - **Pending vet** — Found in search round {currentRound}, not yet vetted.
   ```

2. Dispatch parallel vet agents (up to 5 concurrent):
   ```
   Task(issue-scout, "Vet this issue: URL: {issue_url}, Source: search-round-{currentRound}.
     Check: still open, unassigned, no linked PRs, repo health, complexity.
     Return: score (1-10), recommendation (pursue/maybe/skip), red flags.")
   ```

3. Update list entries with results — move to appropriate tier (`## Pursue`, `## Maybe`, `## Skip`)

4. Track round scores: `searchRoundScores.push(mean of all scores)`

5. Present summary, then proceed to **Diminishing Returns Check**

**"Pick one to vet now":**
- Display results as numbered list, use AskUserQuestion with up to 3 + "Done for now"
- Dispatch single `issue-scout` agent, present result
- Offer: "Claim this issue and start working" / "Pick a different one" / "Done for now"
- Record score: `searchRoundScores.push(score)` → **Diminishing Returns Check**

**"Search again":** Route back to **Parallel Multi-Strategy Search** (exclusions carry forward).

## Diminishing Returns Check

After each vet round, if `searchRoundScores.length >= 2`:
```
dropPercent = (previousAvg - currentAvg) / previousAvg * 100
```

- **> 50% drop**: "Search quality dropped significantly (avg {currentAvg} vs {previousAvg}). Further searching yields diminishing returns. You have {availableCount} vetted issues ready."
- **> 30% drop**: "Lower quality than previous round (avg {currentAvg} vs {previousAvg}). Consider working on vetted issues instead."

Use AskUserQuestion (if `availableCount >= 5` and advisory shown, place list option first with "(Recommended)"):
- "Pick from your issue list ({availableCount} ready)" (if available) — "Start working on a vetted issue"
- "Search for new issues" — "Run another parallel search round"
- "Done for now" — end this command; return to parent `/oss` session if applicable

**When the user claims any issue and starts implementing**, set:
- `isNewContribution = true`
- `issueContext = { title, url, description }`

This activates the draft-first workflow (see Pre-Commit Review in `/oss`).
