---
name: oss-search
description: "Search for new open source issues to contribute to — delegates to oss-scout"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, mcp__plugin_oss-autopilot_*
---

# OSS Issue Search

This command searches for new open source issues to contribute to by delegating to the `@oss-scout/core` package (via the CLI's `search` command). Scout runs a staged multi-phase search (merged-PR repos + open-PR repos → starred → broad → maintained) with built-in rate-limit budgeting, skip-list dedup, spam filtering, and vetting — there is no reason for this skill to duplicate any of that logic (#929).

> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

## Session State

**Initialize on entry** (reset each time):
- `searchRoundScores`: number[] = [] (average vetting score per search round)

**Inherited from `/oss` session** (if invoked from there):
- `hasIssueList`, `availableCount`, `completedCount`, `issueListPath` — curated issue list info

## Pre-Search: Issue List Check

**If `hasIssueList` is true and `availableCount > 0`**, present a preamble before searching:

Use AskUserQuestion:
- "Review from your curated list ({availableCount} available)" — "Pick from pre-vetted issues you've already researched"
- "Search GitHub" — "Find new issues via oss-scout"
- "Both — list first, then search" — "Review your list, then search for more"
- "Done for now"

Route based on choice:
- "Review from list" → this command requires `/oss` context. Tell the user: "Returning to `/oss` to browse your issue list." End this command; the parent `/oss` session handles "Pick Issue From List".
- "Search GitHub" → continue with **Run Search** below
- "Both" → show list first (return to `/oss` for "Pick Issue From List"), then continue with **Run Search**
- "Done for now" → end this command. If invoked from `/oss`, return to the parent session. If standalone, exit.

## Run Search

### Pre-Search: Cull Skip File

If a skipped issues file exists (from startup data's `skippedIssuesPath`, or probe `skipped-issues.md` in the same directory as the issue list), auto-cull entries older than 90 days:

```bash
SKIP_FILE="{skippedIssuesPath}"
if [ -f "$SKIP_FILE" ]; then
  CUTOFF=$(date -v-90d +%Y-%m-%d 2>/dev/null || date -d '90 days ago' +%Y-%m-%d)
  BEFORE=$(grep -cv '^#\|^$' "$SKIP_FILE" 2>/dev/null || echo 0)
  awk -v cutoff="$CUTOFF" '/^#/ || /^$/ { print; next } $1 >= cutoff { print }' "$SKIP_FILE" > "${SKIP_FILE}.tmp" && mv "${SKIP_FILE}.tmp" "$SKIP_FILE"
  AFTER=$(grep -cv '^#\|^$' "$SKIP_FILE" 2>/dev/null || echo 0)
  if [ "$BEFORE" != "$AFTER" ]; then
    echo "Culled $((BEFORE - AFTER)) expired entries from skip list (>90 days old)"
  fi
fi
```

### Dispatch Scout Search

Run the CLI search command — one call replaces the old 3-strategy orchestration. Scout handles rate-limit budgeting, skip-list integration, exclude-list filtering, spam detection, and deduplication internally:

```
Task(general-purpose, "Run the CLI search command and return the raw JSON output verbatim:
  ```bash
  GITHUB_TOKEN=$(gh auth token) node \"${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs\" search 25 --json
  ```")
```

**Parsing the response:**

1. Check the JSON `success` field. If `success: false`, display the `error` field and offer retry/done.
2. If `success: true`, each entry in `data.candidates` has this shape:
   ```
   {
     issue: { repo, repoUrl, number, title, url, labels },
     recommendation: "approve" | "skip" | "needs_review",
     viabilityScore: number,
     grade: { letter: "A" | "B" | "C" | "F", reason: string },
     searchPriority: "merged_pr" | "preferred_org" | "starred" | "normal",
     reasonsToApprove: string[],
     reasonsToSkip: string[],
     repoScore?: { score, mergedPRCount, closedWithoutMergeCount, isResponsive, lastMergedAt? },
     linkedPR?: { number, state, url, updatedAt?, isStalled },
     boostScore?: number,        // strategy-biased ranking (#1244)
     boostReasons?: string[],    // human-readable "why surfaced" lines
     diversitySlot?: boolean     // filled a diversity slot outside the usual stack
   }
   ```
3. Normalize to `{ repo, number, title, url, labels, source, metadata }` where `source` is derived from `searchPriority`:
   - `merged_pr` → `"established-repo"` (user has merged or open PRs in this repo)
   - `preferred_org` → `"preferred-org-repo"` (repo belongs to a configured preferred org)
   - `starred` → `"starred-repo"` (user starred this repo)
   - `normal` → `"trending-repo"` (discovered via broad/maintained phases)

   Present `diversitySlot: true` candidates normally inside their group with a short "(diversity pick — outside your usual languages/repos)" annotation; the standard skip-file threshold applies during tiering. The counterweight operates at selection time, so no special scoring treatment is needed here.

**If `data.candidates` is empty:**
> "No matching issues found. Scout's search returned zero candidates — the skip list, exclude list, or filters may be too narrow."

Use AskUserQuestion: "Retry" / "Done for now".

## Present Results

Group candidates by `source` (omit empty groups):

```
## Search Results ({totalCount} candidates)

### From Established Repos ({count})
{results with source: 'established-repo'}

### From Preferred Orgs ({count})
{results with source: 'preferred-org-repo'}

### From Starred Repos ({count})
{results with source: 'starred-repo'}

### From Trending Repos ({count})
{results with source: 'trending-repo'}
```

## Batch Vet Flow

Set `currentRound = searchRoundScores.length + 1`.

Use AskUserQuestion:
- "Add all to list and vet in parallel (Recommended)" — "Add candidates to your issue list as 'Pending vet', then dispatch parallel vet agents"
- "Pick one to vet now" — "Select a single candidate to investigate immediately"
- "Search again" — "Run another search round (scout's skip list carries forward)"
- "Done for now"

**"Add all to list and vet in parallel":**

1. Add each candidate to the curated list under `## Pending Vet`:
   ```markdown
   ### [{owner}/{repo}](https://github.com/{owner}/{repo}) ({stars}★) — {repo description}
   - [#{number}]({url}) — {issue title}
     - **Pending vet** — Found in search round {currentRound}, not yet vetted.
   ```

2. Dispatch parallel vet agents (up to 5 concurrent):
   ```
   Task(issue-scout, "Vet this issue: URL: {issue_url}, Source: search-round-{currentRound}.
     Check: still open, unassigned, no linked PRs, repo health, complexity.
     Return: score (1-10), recommendation (pursue/maybe/skip), red flags.")
   ```

3. **Score Threshold Filter:** After all vet agents return, filter on a fixed threshold of 6/10.

   For each vetted issue:
   - Score **>= 6** → proceed to tier assignment (step 4)
   - Score **< 6** → skip, do NOT add to any tier

   If any filtered, display:
   > "Filtered {count} issue(s) below score threshold (6/10)."

   List filtered issues briefly:
   ```
   - owner/repo#123 (score: 4) — Issue title
   ```

   Append each filtered issue to the skip file:
   ```bash
   SKIP_FILE="{skippedIssuesPath}"
   if [ ! -f "$SKIP_FILE" ]; then
     printf '# Skipped Issues — auto-culled after 90 days\n# Format: YYYY-MM-DD URL\n\n' > "$SKIP_FILE"
   fi
   echo "$(date +%Y-%m-%d) {issue_url}" >> "$SKIP_FILE"
   ```

   **Important:** `searchRoundScores` should use the **unfiltered** mean (all vetted scores) so diminishing returns detection remains accurate.

4. Update list entries with results — move each surviving issue into its vet-recommended tier (`## Pursue`, `## Maybe`, `## Skip`) using the deterministic CLI helper (#1107):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" list-move-tier "{issue_url}" \
     --tier {pursue|maybe|skip} \
     --list-path "{issueListPath}" \
     --json
   ```

   The command preserves blank lines and sub-bullets between entries, is idempotent (re-running with the same tier is a no-op), and creates the target tier section if it doesn't already exist. It does NOT create list entries: if the issue URL is missing from the list (e.g. step 1 was skipped or wrote a different URL), the command exits non-zero with `success: false` (#1355) — add the entry under `## Pending Vet` first, then re-run the move.

5. Track round scores: `searchRoundScores.push(mean of all scores)` (unfiltered — includes scores below threshold)

6. Present summary, then proceed to **Diminishing Returns Check**

**"Pick one to vet now":**
- Display results as numbered list, use AskUserQuestion with up to 3 + "Done for now". Include the full GitHub issue URL in each option's description field.
- Dispatch single `issue-scout` agent, present result
- If vet result recommendation is "skip", append the issue to the skip file:
  ```bash
  SKIP_FILE="{skippedIssuesPath}"
  if [ ! -f "$SKIP_FILE" ]; then
    printf '# Skipped Issues — auto-culled after 90 days\n# Format: YYYY-MM-DD URL\n\n' > "$SKIP_FILE"
  fi
  echo "$(date +%Y-%m-%d) {issue_url}" >> "$SKIP_FILE"
  ```
- Offer: "Start working on this issue" / "Pick a different one" / "Done for now"
- Record score: `searchRoundScores.push(score)` → **Diminishing Returns Check**

**"Search again":** Route back to **Run Search** (scout's internal state tracks the skip list across rounds; no manual repo-exclusion bookkeeping required here).

## Diminishing Returns Check

After each vet round, if `searchRoundScores.length >= 2`:
```
dropPercent = (previousAvg - currentAvg) / previousAvg * 100
```

- **> 50% drop**: "Search quality dropped significantly (avg {currentAvg} vs {previousAvg}). Further searching yields diminishing returns. You have {availableCount} vetted issues ready."
- **> 30% drop**: "Lower quality than previous round (avg {currentAvg} vs {previousAvg}). Consider working on vetted issues instead."

Use AskUserQuestion (if `availableCount >= 5` and advisory shown, place list option first with "(Recommended)"):
- "Pick from your issue list ({availableCount} ready)" (if available) — "Start working on a vetted issue"
- "Search for new issues" — "Run another search round"
- "Done for now" — end this command; return to parent `/oss` session if applicable

**When the user selects any issue and starts implementing**, set:
- `isNewContribution = true`
- `issueContext = { title, url, description }`

Before writing code, follow the **Branch Setup Protocol** in `${CLAUDE_PLUGIN_ROOT}/workflows/work-through-issues.md` Step 6 to create the feature branch from the upstream default branch. This activates the draft-first workflow (see Pre-Commit Review in `/oss`).
