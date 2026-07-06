#!/bin/bash
# Hook: Blocks commits directly on main/master branch.
# CLAUDE.md rule: "Do NOT push directly to main"

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

strip_quotes() {
  local s="$1"
  s="${s%\"}"; s="${s#\"}"
  s="${s%\'}"; s="${s#\'}"
  printf '%s' "$s"
}

# Resolve the directory the commit actually targets, in priority order:
#   1. an explicit `-C <path>` argument on the git invocation itself
#   2. the last `cd <path>` earlier in a `&&`/`;` chain
#   3. fall back to the hook's own cwd (previous behavior)
GIT_COMMIT_MATCH="${BASH_REMATCH[0]}"
PREFIX="${COMMAND%%"$GIT_COMMIT_MATCH"*}"

TARGET_DIR="$PWD"

DASH_C_RE="git[[:space:]]+-C[[:space:]]+${QPATH}"
if [[ "$GIT_COMMIT_MATCH" =~ $DASH_C_RE ]]; then
  TARGET_DIR=$(strip_quotes "${BASH_REMATCH[1]}")
else
  CD_RE="(^|[[:space:];&|])cd[[:space:]]+${QPATH}"
  REMAINING="$PREFIX"
  while [[ "$REMAINING" =~ $CD_RE ]]; do
    TARGET_DIR=$(strip_quotes "${BASH_REMATCH[2]}")
    REMAINING="${REMAINING#*"${BASH_REMATCH[0]}"}"
  done
fi

# Fail open: if the target isn't a git repo (or doesn't exist), don't block.
BRANCH=$(git -C "$TARGET_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  cat >&2 <<EOF
BLOCKED: Cannot commit directly on '$BRANCH' (target: $TARGET_DIR).
Create a feature branch first:
  git checkout -b feature/your-description
  git checkout -b fix/your-description
  git checkout -b chore/your-description
EOF
  exit 2
fi

exit 0
