# Plugin Layer Index

Complete index of all Claude Code plugin components in oss-autopilot.

## Commands (6)

User-invocable slash commands.

| Command | File | Purpose |
|---------|------|---------|
| `/oss` | `commands/oss.md` | Daily contribution check — fetches PRs, shows dashboard, suggests actions |
| `/oss-search` | `commands/oss-search.md` | Parallel multi-strategy issue search with vetting |
| `/oss-dashboard` | `commands/oss-dashboard.md` | Open the interactive SPA dashboard in your browser |
| `/oss-help` | `commands/oss-help.md` | Quick reference card for commands, agents, and workflows |
| `/setup-oss` | `commands/setup-oss.md` | Configure preferences (languages, labels, PR limits) |
| `/setup-automation` | `commands/setup-automation.md` | Configure headless cron jobs for automated tasks |

## Agents (7)

Specialized agents that activate automatically or on request.

| Agent | File | When to Use |
|-------|------|-------------|
| **pr-responder** | `agents/pr-responder.md` | Draft responses to maintainer feedback on PRs |
| **pr-health-checker** | `agents/pr-health-checker.md` | Diagnose CI failures, merge conflicts, stale reviews; perform rebases |
| **pr-compliance-checker** | `agents/pr-compliance-checker.md` | Validate PRs against opensource.guide best practices before submission |
| **pre-commit-reviewer** | `agents/pre-commit-reviewer.md` | Review diffs for bugs, style issues, dead code before committing |
| **issue-scout** | `agents/issue-scout.md` | Find and vet contributable issues matching your preferences |
| **repo-evaluator** | `agents/repo-evaluator.md` | Evaluate repository health and maintainer responsiveness |
| **contribution-strategist** | `agents/contribution-strategist.md` | Analyze contribution patterns and provide strategic advice |

## Workflows (11)

Orchestration files that define multi-step processes. Read by commands and agents on demand.

| Workflow | File | Invoked By |
|----------|------|------------|
| **Startup & Build** | `workflows/startup-and-build.md` | `/oss` on entry |
| **Action Menu** | `workflows/action-menu.md` | `/oss` after summary |
| **Work Through Issues** | `workflows/work-through-issues.md` | `/oss` when user selects "Work through all issues", "Pick from list", or specific PRs |
| **Draft-First Workflow** | `workflows/draft-first-workflow.md` | `/oss` for new contributions (10-step pipeline) |
| **Pre-Commit Review** | `workflows/pre-commit-review.md` | `/oss` after Tier 2 code changes to existing PRs |
| **Review Issue Replies** | `workflows/review-issue-replies.md` | `/oss` when user selects "Review issue replies" |
| **Reference** | `workflows/reference.md` | On demand — CLI syntax, agent names, shared policies |
| **Daily PR Status (cron)** | `workflows/daily-pr-status-cron.md` | `/setup-automation` scheduled task |
| **Dependabot Triage (cron)** | `workflows/dependabot-triage-cron.md` | `/setup-automation` scheduled task |
| **Issue Curation (cron)** | `workflows/issue-curation-cron.md` | `/setup-automation` scheduled task |
| **Weekly PR Audit (cron)** | `workflows/weekly-pr-audit-cron.md` | `/setup-automation` scheduled task |

## Skills (1)

Knowledge and best-practice guides loaded by Claude for context.

| Skill | File | Content |
|-------|------|---------|
| **oss-contribution** | `skills/oss-contribution/SKILL.md` | PR etiquette, responding to feedback, draft-first workflow, contribution ethics |

## Hooks (2)

Event-driven automation that runs on specific triggers.

| Hook | File | Trigger | Purpose |
|------|------|---------|---------|
| **Session Start** | `hooks/session-start.sh` | `SessionStart` | Health check — shows PR status summary on session start |
| **Guard Public Posts** | `hooks/guard-public-posts.sh` | `PreToolUse` (Bash) | Prevents accidental public posts to GitHub |

Configuration: `hooks/hooks.json`

## Shared Policies

Cross-cutting documentation referenced by multiple agents, defined once in `workflows/reference.md`:

- **Prompt Injection Awareness** — Rules for handling untrusted GitHub content
- **AI Attribution Rule** — Never add AI attribution to external contributions
- **AskUserQuestion Validation Protocol** — Input validation for interactive prompts
