#!/usr/bin/env bash
# Test harness for no-commit-on-main.sh's git-target-dir resolution.
#
# `.claude/hooks/` is a local, gitignored-settings hook (not wired into CI
# like the top-level `hooks/*.test.sh` files — see `.claude/settings.json`,
# which is gitignored). Run manually via:
#   bash .claude/hooks/no-commit-on-main.test.sh
# Exits 0 on success, 1 on first failure.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/no-commit-on-main.sh"

if [ ! -x "$SUBJECT" ]; then
    echo "FAIL: subject not executable: $SUBJECT"
    exit 1
fi

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1: $2"; FAIL=$((FAIL + 1)); }

bash_payload() {
    local cmd="$1"
    printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(jq -Rn --arg c "$cmd" '$c')"
}

# expect_blocked <name> <cwd> <command>
expect_blocked() {
    local name="$1" cwd="$2" cmd="$3"
    local out status
    out=$(cd "$cwd" && printf '%s' "$(bash_payload "$cmd")" | "$SUBJECT" 2>&1)
    status=$?
    if [ "$status" -eq 2 ] && echo "$out" | grep -q "BLOCKED"; then
        pass "$name"
    else
        fail "$name" "expected block (exit 2); got exit=$status out=$out"
    fi
}

# expect_allowed <name> <cwd> <command>
expect_allowed() {
    local name="$1" cwd="$2" cmd="$3"
    local out status
    out=$(cd "$cwd" && printf '%s' "$(bash_payload "$cmd")" | "$SUBJECT" 2>&1)
    status=$?
    if [ "$status" -eq 0 ]; then
        pass "$name"
    else
        fail "$name" "expected allow (exit 0); got exit=$status out=$out"
    fi
}

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# A "main checkout" repo, on the main branch.
MAIN_REPO="$TMPROOT/main-checkout"
mkdir -p "$MAIN_REPO"
git -C "$MAIN_REPO" init -q -b main
git -C "$MAIN_REPO" -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m "init"

# A worktree off that repo, on a feature branch (mirrors the real bug: the
# project checkout sits on main, but a worktree targets a feature branch).
FEATURE_WT="$TMPROOT/feature-worktree"
git -C "$MAIN_REPO" worktree add -q -b feature/test "$FEATURE_WT" main >/dev/null

echo "Running no-commit-on-main.sh tests..."

expect_blocked "plain git commit on main is blocked" \
    "$MAIN_REPO" 'git commit -m "fix: x"'

expect_allowed "git -C <feature-worktree> commit is allowed" \
    "$TMPROOT" "git -C $FEATURE_WT commit -m \"fix: x\""

expect_allowed "cd <feature-worktree> && git commit is allowed" \
    "$TMPROOT" "cd $FEATURE_WT && git commit -m \"fix: x\""

expect_blocked "git -C <main-checkout> commit is blocked" \
    "$TMPROOT" "git -C $MAIN_REPO commit -m \"fix: x\""

expect_allowed "non-git-commit command is allowed" \
    "$MAIN_REPO" 'git status'

echo
echo "Results: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
