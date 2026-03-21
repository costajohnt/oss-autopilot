# Action Menu

> **Session state:** Expects `data.daily` (including `actionMenu`, `actionableIssues`, `digest`, `commentedIssues`), `hasIssueList`, `availableCount`, `completedCount` from core router.
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

The CLI pre-computes the action menu in `data.daily.actionMenu`. Use these items directly in AskUserQuestion instead of manually deriving options.

**Fallback:** If `data.daily.actionMenu` is missing (e.g., older CLI version), tell the user: "Action menu not found in CLI output — you may need to rebuild the CLI: `cd ${CLAUDE_PLUGIN_ROOT}/packages/core && npm run bundle`". Then derive options manually: always include "Done for now"; add "Work through all N issues (Recommended)" if `data.daily.actionableIssues.length > 0`; always add "Search for new issues".

### If No Actionable Issues

When `data.daily.actionMenu` is present and `data.daily.actionMenu.context.hasActionableIssues` is `false` (or when `data.daily.actionMenu` is absent and `data.daily.actionableIssues` is empty), display:
```
All PRs are on track — nothing needs your attention right now.
```

If `hasIssueList && availableCount === 0`:
```
Your curated issue list is depleted ({completedCount} done). Time to find new issues!
```

### Display All PRs First (Information Before Prompt)

When there are actionable issues, display them **before asking the user anything**.

Issues are listed in priority order based on issue `type`: `needs_response` → `needs_changes` → `ci_failing` → `merge_conflict` → `incomplete_checklist`. This matches the ordering from `collectActionableIssues()` in the CLI. All PRs shown here have `status: "needs_addressing"` — the issue `type` field provides the specific reason. Recently closed PRs are NOT included here — they appear in a separate informational section below (see "Recently Closed PRs").

For each issue, look up the full PR from `digest.openPRs` using the issue's `prUrl`:

```javascript
// For each actionable issue, resolve the full PR object:
const pr = data.daily.digest.openPRs.find(p => p.url === issue.prUrl);
```

Then show the enriched format using the resolved PR's fields:

```
{count} PRs Need Attention (in priority order):

1. {issue.label} [{pr.repo}#{pr.number}]({pr.url}) — {pr.title} ({pr.daysSinceActivity}d)
   └─ @{pr.lastMaintainerComment.author}: {formatted maintainerActionHints}
   └─ Effort: {effort} — {action summary}

2. {issue.label} [{pr.repo}#{pr.number}]({pr.url}) — {pr.title} ({pr.daysSinceActivity}d)
   └─ @{pr.lastMaintainerComment.author}: {formatted maintainerActionHints}
   └─ Effort: {effort} — {action summary}

... (list ALL actionable issues, no limit)

---
```

**Maintainer hints line**: Only show if `pr.lastMaintainerComment` exists. Format each hint from `pr.maintainerActionHints` using these labels: `demo_requested` → "demo/screenshot requested", `tests_requested` → "tests requested", `changes_requested` → "code changes requested", `docs_requested` → "documentation requested", `rebase_requested` → "rebase requested". If no hints, show just the maintainer name.

**Effort estimate**: Compute at display time from issue type + hint count:

| Effort | Condition |
|--------|-----------|
| **Small** | `needs_response` with 0-1 hints (just a reply), `incomplete_checklist` |
| **Medium** | `needs_response` with 2+ hints (reply + code changes), `needs_changes` with 0-2 hints, `ci_failing` |
| **Large** | `merge_conflict`, `needs_changes` with 3+ hints |

If an issue type doesn't match any row above, default to **Medium**.

**Action summary**: Brief description based on type (e.g., "respond + code changes", "rebase + push", "investigate CI logs").

Use `pr.daysSinceActivity` from the resolved PR (already computed).

### Recently Closed PRs (Informational)

If `data.daily.digest.recentlyClosedPRs` has entries, display them **after** the actionable issues list (or after "All PRs are on track" if none) as a separate informational section. These are NOT counted in the "Need Attention" total and do NOT receive priority numbers:

```
Recently closed (informational):
- [{repo}#{number}]({url}) — {title} (closed without merge on {closedAt date})
```

These do not require any action. They exist so the user knows what was closed. The Auto-Exclude prompt (in the work-through-issues workflow) may offer to exclude these repos from future searches.

### Ask for Action (Using Pre-Computed Menu)

Use `data.daily.actionMenu.items` directly as AskUserQuestion options. Each item has `key`, `label`, and `description` fields ready for display.

**Issue list integration:** If the user has a curated issue list (detected from `data.issueList` in the startup output), insert an issue-list option **after `address_all`** (index 1) or **at the start** (index 0) when no actionable issues exist — i.e., always before the `search` item:

| Condition | Insert Item |
|-----------|-------------|
| `hasIssueList && availableCount >= 5` | Key: `pick_from_list`, Label: `"Pick from your issue list ({availableCount} ready)"`, Description: `"You have {availableCount} vetted issues ready to work on — starting one would be higher ROI than searching for more"` |
| `hasIssueList && availableCount > 0 && availableCount < 5` | Key: `pick_from_list`, Label: `"Pick from your issue list ({availableCount} available)"`, Description: `"Choose from your curated list of vetted issues"` |
| `hasIssueList && availableCount === 0` | Key: `replenish_list`, Label: `"Replenish your issue list"`, Description: `"All {completedCount} issues done — search for fresh ones"`. Also **remove** the `search` item (replenish replaces it). |

When inserting issue-list items, keep within the 4-option limit (the 5th is the auto "Other").

**Capacity warning:** If any menu item has a `capacityWarning` field, display the warning prominently before presenting the options:
> ⚠️ {capacityWarning}
The option remains available (override), but the warning provides friction before starting new issues.

**"Replenish your issue list"** routes to **Handle "Find New Issues"** (same as search), but agents should be told to suggest issues suitable for adding to the curated list.

### Example AskUserQuestion

```
Question: "What would you like to do?"
Header: "Action"

Options (from data.daily.actionMenu.items):
1. Label: "Work through all 7 issues (Recommended)"
   Description: "Run maintenance in parallel, then address code changes one at a time"

2. Label: "Search for new issues"
   Description: "Look for new contribution opportunities"

3. Label: "Done for now"
   Description: "End session with summary"

(Other is auto-added - user can type "#1", "fix ink#861", "just 3 and 5", etc.)
```

### Parsing "Other" Input

When user provides custom input via "Other", parse for:

| Input Format | Examples | Action |
|--------------|----------|--------|
| PR numbers | "1", "#1", "fix 1", "address #1" | Address that specific PR from the list |
| Multiple PRs | "1 and 3", "1,3,5", "#1 #3 #5", "1-3" | Address those PRs in parallel |
| Repo references | "ink#861", "shadcn-ui/ui#9263" | Find and address that PR |
| URLs | "https://github.com/..." | Address that PR directly |
| Keywords | "all", "none", "skip" | Map to corresponding action |

**If input is unclear**, ask for clarification:
> "I didn't understand '{input}'. Please enter PR numbers (e.g., '1 and 3'), a repo reference (e.g., 'ink#861'), or select an option above."

### Handling Informational Questions

When the user types a simple question via "Other" input (or at any point during the session), determine whether it's **informational** or **actionable**:

| Type | Examples | Behavior |
|------|----------|----------|
| **Informational** | "show me a link to issue #1", "what's the URL for PR #123", "how many PRs do I have open?", "list my waiting PRs", "what did the maintainer say on ink#855?" | Respond with the requested information as **text only**. Do NOT follow up with AskUserQuestion. Let the user read the answer and send their next message. |
| **Actionable** | "fix #1", "address all issues", "search for new issues", "rebase ink#855" | Execute the action, then prompt with AskUserQuestion as usual. |

**Why:** In Claude Code, AskUserQuestion renders as an interactive picker that replaces preceding text output. If informational text is immediately followed by a prompt, the user sees the answer for a brief moment before it's hidden behind the picker.

**Rule of thumb:** If the user's input is purely asking for information (starts with "what", "how many", "which", "where") or uses display verbs ("show", "list") without an accompanying action verb ("fix", "address", "rebase", "search"), treat it as informational. If the input contains both an informational request and an action (e.g., "show me the CI logs and fix #3"), treat it as actionable. This heuristic applies equally when the user sends a free-form message outside of an AskUserQuestion picker.

**After an informational response:** When the user sends their next message, route it through the same informational-vs-actionable classification. If their follow-up is actionable or selects a menu item, return to normal Action Menu flow.

**Return:** Core router (`commands/oss.md`) — **Execute** section with the user's selected action key.
