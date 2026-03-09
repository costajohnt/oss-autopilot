# Document pr-review-toolkit External Dependency

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Document the optional pr-review-toolkit dependency so users understand what it adds, that the plugin works without it, and how to install it.

**Architecture:** Four documentation touchpoints — README (public-facing), `/oss-help` (in-app reference), `/setup-oss` (onboarding), SKILL.md (Claude guidance). No new code logic — the fallback already exists in the workflow files.

**Tech Stack:** Markdown only. No TypeScript, no tests needed.

**Issue:** #626

---

### Task 1: Add "Optional Enhancements" section to README

**Files:**
- Modify: `README.md:26-33` (after the Prerequisites line, before `Restart Claude Code`)

**Step 1: Add the section**

After the existing prerequisites line (`**Prerequisites:** [Claude Code]...`), and after the plugin install commands but before "Restart Claude Code, then run `/setup-oss`. Done.", add:

```markdown
<details>
<summary><strong>Optional:</strong> Enhanced code review with pr-review-toolkit</summary>

The plugin includes a built-in **pre-commit-reviewer** agent that reviews all code changes before pushing. For enhanced review, install the [pr-review-toolkit](https://github.com/anthropics/claude-code) plugin, which adds 5 specialized parallel reviewers:

| Agent | Focus |
|-------|-------|
| `code-reviewer` | Bugs, logic errors, security, conventions |
| `silent-failure-hunter` | Error handling gaps, swallowed errors |
| `code-simplifier` | Dead code, unnecessary complexity |
| `pr-test-analyzer` | Test coverage and assertion quality |
| `comment-analyzer` | Comment accuracy and maintainability |

**Without pr-review-toolkit:** The built-in pre-commit-reviewer handles all reviews in a single pass with the same fix-and-re-review loop. Everything works — you just get one generalist reviewer instead of five specialists.

</details>
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document optional pr-review-toolkit dependency in README

Closes #626 — adds Optional Enhancements section explaining what
pr-review-toolkit adds (5 parallel specialized reviewers) and that
the built-in pre-commit-reviewer handles all reviews without it."
```

---

### Task 2: Add integration note to `/oss-help`

**Files:**
- Modify: `commands/oss-help.md:46-53` (after the Skill section, before Configuration)

**Step 1: Add the section**

After the "Skill" section and before "Configuration", add:

```markdown
## Optional: Enhanced Code Review

The pre-commit review workflow supports the **pr-review-toolkit** plugin for parallel specialized code review (5 agents). Without it, the built-in `pre-commit-reviewer` agent handles all reviews. Both paths include iterative fix-and-re-review loops.

To install: search for `pr-review-toolkit` in Claude Code's plugin marketplace.
```

**Step 2: Commit**

```bash
git add commands/oss-help.md
git commit -m "docs: add pr-review-toolkit note to /oss-help reference card"
```

---

### Task 3: Add tip to `/setup-oss` confirmation step

**Files:**
- Modify: `commands/setup-oss.md:215-217` (Step 7-CLI confirmation, after "Next Steps")
- Modify: `commands/setup-oss.md:500-507` (Step 10 markdown fallback confirmation, after "Next Steps")

**Step 1: Add tip to CLI confirmation (Step 7-CLI)**

In the Step 7-CLI confirmation markdown block, after the existing "Next Steps" items, add:

```markdown
### Optional Enhancement
- **Enhanced code review**: Install the `pr-review-toolkit` plugin for parallel specialized code review (5 agents instead of 1). Search for it in the plugin marketplace. The built-in pre-commit reviewer works without it.
```

**Step 2: Add tip to markdown fallback confirmation (Step 10)**

Same content, added after the "Next Steps" section in Step 10.

**Step 3: Commit**

```bash
git add commands/setup-oss.md
git commit -m "docs: mention pr-review-toolkit in setup confirmation"
```

---

### Task 4: Clarify fallback in SKILL.md

**Files:**
- Modify: `skills/oss-contribution/SKILL.md:38` (the pr-review-toolkit reference)

**Step 1: Update the reference**

Change line 38 from:
```markdown
1. Run the project's code review tooling (e.g., pr-review-toolkit agents) on your diff
```

To:
```markdown
1. Run the project's code review tooling on your diff (the pr-review-toolkit agents if installed, otherwise the built-in pre-commit-reviewer)
```

**Step 2: Commit**

```bash
git add skills/oss-contribution/SKILL.md
git commit -m "docs: clarify pr-review-toolkit fallback in contribution skill"
```

---

### Task 5: Final squash commit

After all edits are verified, squash all commits into one:

```bash
git rebase -i main
# Squash all into one commit with message:
# "chore: document external pr-review-toolkit agent dependency (#626)"
```

Or if preferred, just make all edits in one commit from the start.
