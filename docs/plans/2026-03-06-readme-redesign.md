# README Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Streamline and update the README to reflect the current state of the project — interactive dashboard, three deployment models, simplified PR statuses — while cutting ~200 lines of redundant content.

**Architecture:** Single-file edit (README.md). No code changes. The user will provide a new dashboard screenshot/GIF separately; use a placeholder path until then.

**Tech Stack:** Markdown

---

### Task 1: Set up branch

**Step 1: Create branch from latest main**

```bash
git checkout main && git pull && git checkout -b docs/readme-redesign
```

**Step 2: Verify starting point**

```bash
wc -l README.md
# Expected: ~552 lines
```

---

### Task 2: Rewrite the Install section

**Files:**
- Modify: `README.md:18-63`

**Step 1: Replace the Install section**

Keep "Claude Code Plugin" as the primary visible block. Wrap MCP and CLI/npm sections in `<details>` tags. Merge the old "npm Package (programmatic use)" section into the CLI details block.

New content for lines 18-63:

```markdown
## Install

### Claude Code Plugin (recommended)

**Prerequisites:** [Claude Code](https://claude.ai/claude-code), Node.js 20+, [GitHub CLI](https://cli.github.com/) (`gh auth login`)

\```
/plugin marketplace add costajohnt/oss-autopilot
/plugin install oss-autopilot@oss-autopilot
\```

Restart Claude Code, then run `/setup-oss`. Done.

<details>
<summary><strong>MCP Server</strong> (Cursor, Claude Desktop, Codex, Windsurf)</summary>

\```bash
npx @oss-autopilot/mcp@latest --init <your-github-username>
\```

Then add to your MCP client config:

\```json
{
  "mcpServers": {
    "oss-autopilot": {
      "command": "npx",
      "args": ["@oss-autopilot/mcp@latest"]
    }
  }
}
\```

</details>

<details>
<summary><strong>Standalone CLI / npm package</strong></summary>

\```bash
# Run any command directly
GITHUB_TOKEN=$(gh auth token) npx @oss-autopilot/core daily --json
npx @oss-autopilot/core dashboard serve

# Or install globally
npm install -g @oss-autopilot/core

# Or import programmatically
npm install @oss-autopilot/core
\```

\```typescript
import { runDaily, runSearch, runStatus } from '@oss-autopilot/core/commands';

const digest = await runDaily();
const issues = await runSearch({ maxResults: 10 });
\```

All commands return `{ success, data, error, timestamp }` with `--json`.

</details>
```

**Step 2: Verify render** — Read back the section to check formatting.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite install section with collapsible MCP/CLI"
```

---

### Task 3: Create "What It Does" mega-section

**Files:**
- Modify: `README.md` — replace lines 65-126 ("What Happens When You Run /oss" through "When You Search for Issues") AND lines 195-205 (old Dashboard subsection)

**Step 1: Replace with unified "What It Does" section**

Four subsections:

**3a — PR Monitoring:** Keep the existing `/oss` output example. Update version from `v0.42.6` to `v0.44.18`.

**3b — Issue Discovery:** Keep the existing search output example as-is (it's already good).

**3c — Interactive Dashboard:** New content:

```markdown
### Interactive Dashboard

<!-- TODO: Replace with new dashboard screenshot or GIF -->
![OSS Autopilot Dashboard](docs/images/dashboard.png)

The dashboard auto-opens at `http://localhost:3000` when you run `/oss`. It's a Preact SPA you can also launch standalone with `npx @oss-autopilot/core dashboard serve`.

**At a glance:**
- Stats bar with active, shelved, merged, and closed PR counts plus merge rate
- Status doughnut, repository breakdown, and contribution timeline charts
- Filter and search across all PRs

**Manage your PRs:**
- PRs are grouped into **Action Required**, **Waiting on Others**, and **Shelved** sections
- Click any PR for a detail panel showing CI status, failing check classification, review decision, maintainer comments, and checklist progress
- **Shelve/Unshelve** — temporarily hide PRs you're not actively working on
- **Move to Waiting / Move to Action Required** — override the auto-detected status when you know better

All actions persist to `~/.oss-autopilot/state.json`.
```

**3d — Putting It Together:** Compressed multi-day lifecycle (~15 lines):

```markdown
### Putting It Together

A typical contribution lifecycle:

**Day 1 — Find and claim.** Search for issues, pick a high-scoring one from a repo where you've merged before. The issue scout drafts a claim comment for your review. Start working. Before you push, the pre-commit reviewer catches a missing test — you add it. The compliance checker validates your PR against the repo's contribution guidelines.

**Day 2 — Respond.** `/oss` shows the maintainer requested changes 12 hours ago. The PR responder reads the feedback, fetches code context, and drafts a reply. You review, edit, and post.

**Day 5 — Merged.** Your repo relationship score improves, and better-matched issues surface next time you search.
```

**Step 2: Remove the old standalone "Dashboard" subsection** from the Usage section (lines 195-205) since it's now covered in "What It Does".

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: create unified 'What It Does' section with dashboard showcase"
```

---

### Task 4: Replace "How OSS Autopilot Helps" with "Key Capabilities" bullets

**Files:**
- Modify: `README.md` — replace the old table (lines 136-145)

**Step 1: Replace table with bullet list**

```markdown
## Key Capabilities

- **Monitors all your PRs** — comments, CI failures, merge conflicts, incomplete checklists, maintainer requests
- **Drafts responses** — reads maintainer feedback and writes a reply for your review
- **Finds issues matched to you** — prioritizes repos where you've merged PRs, scores every issue 0-100
- **Scores repositories** — evaluates merge rate, review speed, maintainer responsiveness
- **Interactive dashboard** — manage PRs visually, shelve/unshelve, override statuses, track stats over time
- **Never acts without you** — nothing is posted to GitHub without your explicit approval
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: replace capabilities table with concise bullet list"
```

---

### Task 5: Cut redundant sections

**Files:**
- Modify: `README.md`

**Step 1: Remove "The Problem" section** (lines 127-134) — redundant with the opening hook.

**Step 2: Remove "Why Not Just Use...?" comparison table** (lines 147-164) — confirmed by user.

**Step 3: Remove "Your First Contribution (Walkthrough)"** (lines 291-341) — replaced by "Putting It Together" in Task 3.

**Step 4: Remove "Tips" section** (lines 279-288). Move the "start small" tip to the FAQ section.

**Step 5: Commit**

```bash
git add README.md
git commit -m "docs: remove redundant sections (problem, comparison, walkthrough, tips)"
```

---

### Task 6: Streamline Usage section

**Files:**
- Modify: `README.md` — the Usage section

**Step 1: Remove "Finding Contributions" subsection** — covered by "What It Does > Issue Discovery".

**Step 2: Remove "Dashboard" subsection** — covered by "What It Does > Interactive Dashboard" (if not already removed in Task 3).

**Step 3: Remove "Curated Issue Lists" from Usage** — will be consolidated in Configuration section.

**Step 4: Replace "Available Commands" table with inline list**

```markdown
**Commands:** `/oss` (daily check), `/oss-search` (find issues), `/setup-oss` (configure), `/oss-help` (reference)
```

**Step 5: Add note to Specialized Agents table**

Add italic note below the table:
```markdown
*Agents are available in the Claude Code plugin. MCP and CLI users access the same capabilities through tools and commands.*
```

**Step 6: Simplify the "When it runs" column** in the agents table to short phrases:
- `pr-responder`: "PR needs a response to maintainer feedback"
- `pr-health-checker`: "PR has CI failure or merge conflict"
- `pr-compliance-checker`: "Before marking a new PR ready for review"
- `pre-commit-reviewer`: "After code changes, before commit"
- `issue-scout`: "User searches for new issues"
- `repo-evaluator`: "Before contributing to an unfamiliar repo"
- `contribution-strategist`: "User asks for contribution strategy"

**Step 7: Commit**

```bash
git add README.md
git commit -m "docs: streamline usage section and simplify agents table"
```

---

### Task 7: Update "How It Works" section

**Files:**
- Modify: `README.md` — the How It Works / architecture section

**Step 1: Update the architecture diagram** — change "Charts, PR health view" to "PR management, charts, actions" in the dashboard box.

**Step 2: Update the MCP Server section** — the tool list is still accurate (21 tools including dismiss/undismiss/snooze/unsnooze). No changes needed to the tool names.

**Step 3: Update the Dashboard row in the packages table** — change description from "Interactive Preact SPA dashboard with charts and PR health view" to "Interactive Preact SPA — PR management, charts, and contribution stats."

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update architecture diagram and package descriptions"
```

---

### Task 8: Merge Troubleshooting + FAQ, streamline tail

**Files:**
- Modify: `README.md` — Troubleshooting, FAQ, and Development sections

**Step 1: Merge "Troubleshooting" and "FAQ" into single "FAQ & Troubleshooting" section.** Keep all existing content but under one heading. Add the "start small" tip:

```markdown
**Any tips for getting started?**
Set `maxActivePRs` to 3-5 when starting out. Fewer active PRs with fast responses beats many stale ones. Run `/oss` every few days — stale PRs are hard to revive.
```

**Step 2: Move the "Pre-commit Hooks" table into a `<details>` block** inside the Development section.

**Step 3: Verify the "Updating" section** — ensure plugin update command reads `/plugin update oss-autopilot` (not the old marketplace update command).

Current line says:
```
/plugin marketplace update oss-autopilot
```

Should be:
```
/plugin update oss-autopilot
```

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: merge FAQ/troubleshooting, streamline development section"
```

---

### Task 9: Final review and PR

**Step 1: Read the entire README** to verify flow, catch duplicates, check rendering.

**Step 2: Count lines** — target is ~350 lines (down from ~552).

```bash
wc -l README.md
```

**Step 3: Run tests** to make sure nothing is broken (even though this is docs-only).

```bash
pnpm test
```

**Step 4: Push and open PR**

```bash
git push -u origin docs/readme-redesign
gh pr create --title "docs: redesign README — streamline, update dashboard, add collapsible install" --body "..."
```

**Step 5: Wait for CI, merge, wait for release-please, merge.**
