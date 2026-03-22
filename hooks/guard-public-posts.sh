#!/usr/bin/env bash
# PreToolUse hook: block Bash commands that post to public platforms
# (gh pr comment, gh issue comment, oss-autopilot post) unless the user
# has explicitly approved. Returns "ask" so Claude Code prompts the user
# for confirmation rather than silently blocking.

set -euo pipefail

input=$(cat)

command=$(echo "$input" | jq -r '.tool_input.command // empty')

if [ -z "$command" ]; then
  exit 0
fi

# Patterns that post publicly
if echo "$command" | grep -qE '(gh\s+(pr|issue)\s+comment|gh\s+pr\s+review|cli\.bundle\.cjs.*\bpost\b)'; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "permissionDecision": "ask",
    "updatedInput": {}
  },
  "systemMessage": "This command posts a public comment. The user must explicitly approve before posting to GitHub PRs, issues, or any public platform. Draft the comment text and present it to the user first."
}
EOF
  exit 0
fi

exit 0
