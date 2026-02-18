# CLI Commands & Agent Reference

> **Loaded on demand.** This file is read when you need CLI command syntax or agent names.

## CLI Commands

All commands support `--json` flag for structured output:

```bash
# Startup (preferred entry point — combines auth, setup, daily, dashboard, issue list)
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" startup --json

# Daily check (syncs and checks all PRs — standalone, without dashboard/issue list)
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" daily --json

# Status overview
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" status --json

# Search for issues
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" search 10 --json

# Track a PR
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" track <pr-url> --json

# View comments
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" comments <pr-url> --json

# Post comment
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" post <url> "message" --json
```

---

## Agent Integration

| Agent | Purpose |
|-------|---------|
| `pr-responder` | Draft responses to maintainer feedback |
| `pr-health-checker` | Diagnose CI failures, merge conflicts, rebase status |
| `pr-compliance-checker` | Validate PRs against opensource.guide |
| `pre-commit-reviewer` | Review code changes before committing (fallback for PR review toolkit) |
| `issue-scout` | Find and vet new issues |
| `repo-evaluator` | Analyze repository health |
| `contribution-strategist` | Strategic OSS advice |
