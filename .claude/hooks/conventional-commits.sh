#!/bin/bash
# Hook: Enforces conventional commit format (feat:, fix:, chore:, etc.)
# CLAUDE.md rule: "Commit with conventional format: feat:, fix:, refactor:"

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Matches `git commit`, optionally with a `-C <path>` global option inserted
# before the subcommand (e.g. `git -C /some/worktree commit -m ...`).
QPATH='("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+)'
GIT_COMMIT_RE="git([[:space:]]+-C[[:space:]]+${QPATH})?[[:space:]]+commit([[:space:]]|\$)"

# Only validate on git commit commands
if ! [[ "$COMMAND" =~ $GIT_COMMIT_RE ]]; then
  exit 0
fi

# Skip merge commits and amend without message
if echo "$COMMAND" | grep -qE "(--amend --no-edit|git merge)"; then
  exit 0
fi

# Extract the commit message from -m flag or heredoc
# Handle both: git commit -m "message" and git commit -m "$(cat <<'EOF'...)"
MSG=$(echo "$COMMAND" | grep -oE '\-m "[^"]*"' | head -1 | sed 's/^-m "//;s/"$//' || true)

# Also try single quotes
if [ -z "$MSG" ]; then
  MSG=$(echo "$COMMAND" | grep -oE "\-m '[^']*'" | head -1 | sed "s/^-m '//;s/'$//" || true)
fi

# Try heredoc pattern (common with Claude Code commits)
if [ -z "$MSG" ]; then
  MSG=$(echo "$COMMAND" | grep -oE "(feat|fix|chore|refactor|docs|test|ci|build|perf|style|revert)[:(]" | head -1 || true)
  if [ -n "$MSG" ]; then
    # Found a conventional prefix in the heredoc, that's enough
    exit 0
  fi
fi

# If we couldn't extract a message, let it through (don't block on parse failure)
if [ -z "$MSG" ]; then
  exit 0
fi

# Check for conventional commit prefix
if ! echo "$MSG" | grep -qE "^(feat|fix|chore|refactor|docs|test|ci|build|perf|style|revert)(\(.+\))?[!]?:"; then
  cat >&2 <<EOF
BLOCKED: Commit message must use conventional format.
Got: "$MSG"
Expected prefix: feat:, fix:, chore:, refactor:, docs:, test:, ci:, build:, perf:, style:, or revert:
Examples:
  feat: add version sync hook
  fix(cli): handle missing token
  chore: update dependencies
EOF
  exit 2
fi

exit 0
