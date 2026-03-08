# CLI Commands & Agent Reference

> **Loaded on demand.** This file is read when you need CLI command syntax or agent names.

## CLI Commands

All commands support `--json` flag for structured output.

**Prefix:** `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs"`

Local-only commands (no GitHub token needed): `status`, `setup`, `checkSetup`, `config`, `local-repos`, `parse-issue-list`, `serve`.

### Core Workflow

```bash
# Startup (preferred entry point — combines auth, setup, daily, dashboard, issue list)
<prefix> startup --json

# Daily check (syncs and checks all PRs)
<prefix> daily --json

# Status overview (local-only)
<prefix> status --json
```

### Issue Discovery

```bash
# Search for issues (n = number of results, default 5)
<prefix> search [n] --json

# Deep-vet a specific issue
<prefix> vet <issue-url> --json

# Claim an issue with optional message
<prefix> claim <issue-url> [message...] --json

# Parse an issue list from a file
<prefix> parse-issue-list <path> --json
```

### PR Management

```bash
# Track a PR
<prefix> track <pr-url> --json

# Untrack a PR
<prefix> untrack <pr-url> --json

# Read PR details (or read all if no URL given)
<prefix> read [pr-url] --json

# View comments on a PR
<prefix> comments <pr-url> --json [--show-bots]

# Post a comment to an issue or PR
<prefix> post <url> "message" --json

# Move a PR between states
<prefix> move <pr-url> <attention|waiting|shelved|auto> --json

# Shelve/unshelve a PR (aliases for move)
<prefix> shelve <pr-url> --json
<prefix> unshelve <pr-url> --json

# Dismiss/undismiss an issue
<prefix> dismiss <issue-url> --json
<prefix> undismiss <issue-url> --json
```

### Dashboard

```bash
# Serve interactive dashboard SPA
<prefix> dashboard serve --port 3000 [--open]
```

### Configuration

```bash
# View/set config (local-only)
<prefix> config [key] [value] --json

# Interactive setup (local-only)
<prefix> setup --json [--set key=value...] [--reset]

# Check setup status (local-only)
<prefix> checkSetup --json

# Quick init with username (local-only)
<prefix> init <username> --json
```

### Utilities

```bash
# Scan for local git repos
<prefix> local-repos --json [--scan] [--clear-cache]

# Check GitHub integration
<prefix> check-integration --json
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
