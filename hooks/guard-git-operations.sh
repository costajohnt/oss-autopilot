#!/usr/bin/env bash
# PreToolUse hook: prevent unsafe git operations that can overwrite remote work
# or destroy local commits.
#
# 1. Blocks bare `git push --force` (must use --force-with-lease)
# 2. Requires explicit fetch before rebase (including `git pull --rebase`, #1259)
# 3. Requires explicit fetch before force-with-lease push
# 4. Warns before `git reset --hard` (#1259) — discards uncommitted work AND
#    any local commits not in the target ref.
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
    "hookEventName": "PreToolUse",
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
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "updatedInput": {}
  },
  "systemMessage": "Before rebasing, you MUST fetch the remote tracking branch to avoid overwriting commits pushed by others (e.g. maintainer cleanup commits). Run `git fetch <remote> <branch>` first and verify no new remote commits exist. If the remote has commits you don't have locally, incorporate them before rebasing."
}
EOF
  exit 0
fi

# Warn before `git pull --rebase` (#1259) — same risk profile as `git rebase`.
# `git\s+rebase\b` above doesn't match the `pull --rebase` form because the
# verb is "pull". Local commits silently rebased over remote changes here too.
if echo "$command" | grep -qE 'git\s+pull\b' && echo "$command" | grep -qE '(\s--rebase\b|\s-r\b)'; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "updatedInput": {}
  },
  "systemMessage": "Before pulling with --rebase, you MUST fetch the remote tracking branch first to see what you're rebasing over. `git pull --rebase` rebases your local commits onto the latest remote head; if the remote has commits you didn't expect, this can rewrite history past them. Run `git fetch` and inspect `git log HEAD..@{u}` first."
}
EOF
  exit 0
fi

# Warn before force-with-lease push: remind to fetch first
if echo "$command" | grep -qE 'git\s+push\b.*--force-with-lease'; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "updatedInput": {}
  },
  "systemMessage": "Before force-pushing (even with --force-with-lease), verify you fetched the remote branch and incorporated any new commits. Maintainers may push directly to your PR branch. If you haven't fetched, --force-with-lease may still overwrite their work if your local remote-tracking ref is stale."
}
EOF
  exit 0
fi

# Warn before `git reset --hard` (#1259). Discards uncommitted work AND any
# local commits not in the target ref. The hook is opt-in friction; the
# false-positive case (resetting to where you already are) is fast for the
# user to confirm.
if echo "$command" | grep -qE 'git\s+reset\s+--hard\b'; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "updatedInput": {}
  },
  "systemMessage": "`git reset --hard` discards uncommitted work AND any local commits not in the target ref. If you have unpushed commits on this branch you want to keep, stash them first (`git stash`) or note them on a recovery branch (`git branch wip-recovery`). Confirm you've reviewed `git status` and `git log @{u}..HEAD` before proceeding."
}
EOF
  exit 0
fi

exit 0
