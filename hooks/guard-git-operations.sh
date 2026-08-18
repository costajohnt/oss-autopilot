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

# --- Own-repo trust (opt-in, shares config with guard-public-posts.sh) -------
# The rebase asks below exist so a contributor fetches before rewriting a PR
# branch a maintainer may have pushed to. On a repo the user owns there is no
# maintainer, so `config.trustOwnRepoWrites` skips them when the working repo's
# `origin` belongs to `githubUsername`. Force pushes and `git reset --hard`
# keep their guards regardless: they destroy history whoever owns the remote.
state_file() {
  local local_state="${HOME}/.oss-autopilot/state.json"
  local gist_cache="${HOME}/.oss-autopilot/state-cache.json"
  [ -f "$gist_cache" ] || { printf '%s' "$local_state"; return 0; }
  [ -f "$local_state" ] || { printf '%s' "$gist_cache"; return 0; }
  if [ "$gist_cache" -nt "$local_state" ]; then printf '%s' "$gist_cache"; else printf '%s' "$local_state"; fi
}

read_config() {
  local key="$1" default="$2" file
  file=$(state_file)
  [ -f "$file" ] || { printf '%s' "$default"; return 0; }
  jq -r --arg d "$default" ".config.${key} // \$d" "$file" 2>/dev/null || printf '%s' "$default"
}

# Directory the git command runs in: a leading `cd <dir> &&` wins (the hook's
# cwd is the session's, not the subshell's), then `git -C <dir>`, then cwd.
git_workdir() {
  local cmd="$1" cwd="$2" dir
  dir=$(printf '%s' "$cmd" | grep -oE '^[[:space:]]*cd[[:space:]]+[^[:space:];&|]+' | awk '{print $2}')
  [ -n "$dir" ] || dir=$(printf '%s' "$cmd" | grep -oE 'git[[:space:]]+-C[[:space:]]+[^[:space:];&|]+' | head -1 | awk '{print $3}')
  [ -n "$dir" ] || dir="$cwd"
  printf '%s' "${dir/#\~/$HOME}"
}

# True when `origin` of the working repo is owned by the trusted user.
# Anything unresolvable (no owner, no repo, non-GitHub remote) fails closed.
own_repo() {
  local owner dir url
  [ "$(read_config trustOwnRepoWrites false)" = "true" ] || return 1
  owner=$(read_config githubUsername "")
  [ -n "$owner" ] || return 1
  dir=$(git_workdir "$command" "$(echo "$input" | jq -r '.cwd // empty')")
  [ -d "$dir" ] || return 1
  url=$(git -C "$dir" remote get-url origin 2>/dev/null) || return 1
  case "$url" in
    https://github.com/"$owner"/*|git@github.com:"$owner"/*|ssh://git@github.com/"$owner"/*) return 0 ;;
  esac
  return 1
}

# Block `git push --force` (without --force-with-lease)
# Match --force or -f but NOT --force-with-lease
if echo "$command" | grep -qE 'git\s+push\b' && echo "$command" | grep -qE '(\s--force\b|\s-f\b)' && ! echo "$command" | grep -qE '\s--force-with-lease'; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny"
  },
  "systemMessage": "BLOCKED: Never use `git push --force`. Use `git push --force-with-lease` instead — it prevents overwriting commits pushed by others. Before pushing, always fetch the remote branch first: `git fetch <remote> <branch>`."
}
EOF
  exit 0
fi

# Warn before rebase: remind to fetch first (skipped on the user's own repos)
if echo "$command" | grep -qE 'git\s+rebase\b' && ! own_repo; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask"
  },
  "systemMessage": "Before rebasing, you MUST fetch the remote tracking branch to avoid overwriting commits pushed by others (e.g. maintainer cleanup commits). Run `git fetch <remote> <branch>` first and verify no new remote commits exist. If the remote has commits you don't have locally, incorporate them before rebasing."
}
EOF
  exit 0
fi

# Warn before `git pull --rebase` (#1259) — same risk profile as `git rebase`.
# `git\s+rebase\b` above doesn't match the `pull --rebase` form because the
# verb is "pull". Local commits silently rebased over remote changes here too.
if echo "$command" | grep -qE 'git\s+pull\b' && echo "$command" | grep -qE '(\s--rebase\b|\s-r\b)' && ! own_repo; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask"
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
    "permissionDecision": "ask"
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
    "permissionDecision": "ask"
  },
  "systemMessage": "`git reset --hard` discards uncommitted work AND any local commits not in the target ref. If you have unpushed commits on this branch you want to keep, stash them first (`git stash`) or note them on a recovery branch (`git branch wip-recovery`). Confirm you've reviewed `git status` and `git log @{u}..HEAD` before proceeding."
}
EOF
  exit 0
fi

exit 0
