#!/bin/bash
# Hook: Blocks git commits when versions are out of sync across
# packages/core/package.json and .claude-plugin/plugin.json.
#
# Registered as a PreToolUse hook on Bash commands.

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only validate on git commit commands
if ! echo "$COMMAND" | grep -q "git commit"; then
  exit 0
fi

# Derive repo root from this script's location (.claude/hooks/ → repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Extract versions using absolute paths
PKG_VERSION=$(jq -r '.version' < "${REPO_ROOT}/packages/core/package.json" 2>/dev/null || echo "MISSING")
PLUGIN_VERSION=$(jq -r '.version' < "${REPO_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "MISSING")

# Skip check if version files are unreadable (e.g., worktree or CI context)
if [ "$PKG_VERSION" = "MISSING" ] || [ "$PLUGIN_VERSION" = "MISSING" ]; then
  echo "Warning: Could not read version files (PKG=$PKG_VERSION, PLUGIN=$PLUGIN_VERSION). Skipping version check." >&2
  exit 0
fi

# Check if versions match
if [ "$PKG_VERSION" != "$PLUGIN_VERSION" ]; then
  cat >&2 <<EOF
Version mismatch detected! Both must match before committing.
  packages/core/package.json:  $PKG_VERSION
  .claude-plugin/plugin.json:  $PLUGIN_VERSION
EOF
  exit 2
fi

exit 0
