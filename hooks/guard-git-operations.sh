#!/usr/bin/env bash
# PreToolUse hook: prevent unsafe git operations that can overwrite remote work.
#
# 1. Blocks bare `git push --force` (must use --force-with-lease)
# 2. Requires explicit fetch before rebase
# 3. Requires explicit fetch before force-with-lease push
#
# Returns "ask" to prompt user confirmation, or a systemMessage reminder.

set -euo pipefail

input=$(cat)

command=$(echo "$input" | jq -r '.tool_input.command // empty')

if [ -z "$command" ]; then
  exit 0
fi

# Block `git push --force` (without --force-with-lease)
# Match --force or -f but NOT --force-with-lease
if echo "$command" | grep -qE 'git\s+push\b' && echo "$command" | grep -qE '(\s--force\b|\s-f\b)' && ! echo "$command" | grep -qE '\s--force-with-lease'; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "updatedInput": {}
  },
  "systemMessage": "BLOCKED: Never use `git push --force`. Use `git push --force-with-lease` instead — it prevents overwriting commits pushed by others. Before pushing, always fetch the remote branch first: `git fetch <remote> <branch>`."
}
EOF
  exit 0
fi

# Warn before rebase: remind to fetch first
if echo "$command" | grep -qE 'git\s+rebase\b'; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "permissionDecision": "ask",
    "updatedInput": {}
  },
  "systemMessage": "Before rebasing, you MUST fetch the remote tracking branch to avoid overwriting commits pushed by others (e.g. maintainer cleanup commits). Run `git fetch <remote> <branch>` first and verify no new remote commits exist. If the remote has commits you don't have locally, incorporate them before rebasing."
}
EOF
  exit 0
fi

# Warn before force-with-lease push: remind to fetch first
if echo "$command" | grep -qE 'git\s+push\b.*--force-with-lease'; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "permissionDecision": "ask",
    "updatedInput": {}
  },
  "systemMessage": "Before force-pushing (even with --force-with-lease), verify you fetched the remote branch and incorporated any new commits. Maintainers may push directly to your PR branch. If you haven't fetched, --force-with-lease may still overwrite their work if your local remote-tracking ref is stale."
}
EOF
  exit 0
fi

exit 0
