---
name: oss-help
description: "Quick reference card for OSS Autopilot commands, agents, and workflows"
allowed-tools: Read
---

# OSS Autopilot Quick Reference

Print this reference card for the user. Do NOT run any commands — just display the information below.

---

## Commands

| Command | Purpose |
|---------|---------|
| `/oss` | **Daily check** — fetches open PRs, shows status dashboard, suggests actions (respond to reviews, fix CI, rebase, find new issues) |
| `/oss-search` | **Find issues** — multi-strategy search across GitHub for contributable issues matching your language/label preferences |
| `/setup-oss` | **Configure** — set GitHub username, languages, labels, PR limits, and other preferences |
| `/oss-help` | **This card** — quick reference for all plugin capabilities |

## Agents

These agents activate automatically when relevant, or you can ask for them directly:

| Agent | When to Use |
|-------|-------------|
| **pr-responder** | "Help me respond to comments on my PR" — drafts professional replies to maintainer feedback |
| **pr-health-checker** | "Why is my PR failing CI?" — diagnoses CI failures, merge conflicts, stale reviews, and performs rebases |
| **pr-compliance-checker** | "Check if my PR is ready" — validates against opensource.guide best practices before submission |
| **issue-scout** | "Find me issues to work on" — searches, vets, and helps claim good contribution opportunities |
| **repo-evaluator** | "Is this repo worth contributing to?" — analyzes maintainer responsiveness and project health |
| **contribution-strategist** | "How am I doing?" — analyzes contribution patterns and provides strategic advice |
| **pre-commit-reviewer** | "Review my changes before I push" — checks diffs for bugs, style issues, and dead code |

## Typical Workflow

```
1. /oss              → See what needs attention
2. Pick an action    → Respond to review, fix CI, rebase
3. /oss-search       → Find new issues when you have capacity
4. Claim an issue    → Work on it → Submit PR
5. /oss              → Monitor PR until merged
```

## Skill

The **oss-contribution** skill provides best practices for:
- Writing PR descriptions and commit messages
- Responding to maintainer feedback
- Following repository contribution guidelines
- Open source etiquette (claiming issues, draft PRs, etc.)

## Configuration

Settings are stored in `~/.oss-autopilot/state.json`. Run `/setup-oss` to reconfigure.

Key settings: GitHub username, max active PRs, dormant threshold, preferred languages, issue labels, squash preference.

### Session Start Health Check

On every session start, the plugin shows a one-liner PR status summary (e.g., "OSS: 15 active PRs — 1 need response, 5 awaiting re-review (2h ago)"). This reads cached state from your last `/oss` run — no network calls.

To disable: `node packages/core/dist/cli.bundle.cjs setup --set showHealthCheck=false`
