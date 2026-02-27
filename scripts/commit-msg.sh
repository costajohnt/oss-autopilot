#!/bin/sh
# Validates that commit messages follow the Conventional Commits format.
# Used by simple-git-hooks as the commit-msg hook.
# See: https://www.conventionalcommits.org/

commit_msg_file="$1"
commit_msg=$(cat "$commit_msg_file")

# Allow merge commits
if echo "$commit_msg" | grep -qE "^Merge "; then
  exit 0
fi

# Allow revert commits
if echo "$commit_msg" | grep -qE "^Revert "; then
  exit 0
fi

# Validate conventional commit format
if echo "$commit_msg" | grep -qE "^(feat|fix|chore|refactor|test|docs|ci|perf|build|style)(\(.+\))?!?: .+"; then
  exit 0
fi

echo >&2 "ERROR: Commit message does not follow Conventional Commits format."
echo >&2 ""
echo >&2 "  Got: $(head -1 "$commit_msg_file")"
echo >&2 ""
echo >&2 "  Expected format: <type>[optional scope]: <description>"
echo >&2 ""
echo >&2 "  Valid types: feat, fix, chore, refactor, test, docs, ci, perf, build, style"
echo >&2 ""
echo >&2 "  Examples:"
echo >&2 "    feat: add user authentication"
echo >&2 "    fix(cli): handle missing token gracefully"
echo >&2 "    chore: update dependencies"
echo >&2 "    refactor(core)!: redesign state management"
echo >&2 ""
exit 1
