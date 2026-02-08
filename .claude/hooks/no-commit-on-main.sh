#!/bin/bash
# Hook: Blocks commits directly on main/master branch.
# CLAUDE.md rule: "Do NOT push directly to main"

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only validate on git commit commands
if ! echo "$COMMAND" | grep -q "git commit"; then
  exit 0
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  cat >&2 <<EOF
BLOCKED: Cannot commit directly on '$BRANCH'.
Create a feature branch first:
  git checkout -b feature/your-description
  git checkout -b fix/your-description
  git checkout -b chore/your-description
EOF
  exit 2
fi

exit 0
