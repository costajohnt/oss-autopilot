#!/bin/bash
# Hook: Blocks git commits when versions are out of sync across
# package.json and .claude-plugin/plugin.json.
#
# Registered as a PreToolUse hook on Bash commands.

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only validate on git commit commands
if ! echo "$COMMAND" | grep -q "git commit"; then
  exit 0
fi

# Extract versions
PKG_VERSION=$(jq -r '.version' < package.json 2>/dev/null || echo "MISSING")
PLUGIN_VERSION=$(jq -r '.version' < .claude-plugin/plugin.json 2>/dev/null || echo "MISSING")

# Check if versions match
if [ "$PKG_VERSION" != "$PLUGIN_VERSION" ]; then
  cat >&2 <<EOF
Version mismatch detected! Both must match before committing.
  package.json:                $PKG_VERSION
  .claude-plugin/plugin.json:  $PLUGIN_VERSION
EOF
  exit 2
fi

exit 0
