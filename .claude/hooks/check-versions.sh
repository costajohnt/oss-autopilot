#!/bin/bash
# Hook: Blocks git commits when versions are out of sync across
# package.json, .claude-plugin/plugin.json, and README.md badge.
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
README_VERSION=$(grep -o 'version-[0-9]*\.[0-9]*\.[0-9]*' README.md | head -1 | sed 's/version-//')

if [ -z "$README_VERSION" ]; then
  README_VERSION="MISSING"
fi

# Check if all versions match
if [ "$PKG_VERSION" != "$PLUGIN_VERSION" ] || [ "$PKG_VERSION" != "$README_VERSION" ]; then
  cat >&2 <<EOF
Version mismatch detected! All three must match before committing.
  package.json:                $PKG_VERSION
  .claude-plugin/plugin.json:  $PLUGIN_VERSION
  README.md badge:             $README_VERSION
EOF
  exit 2
fi

exit 0
