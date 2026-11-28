#!/usr/bin/env bash
# Test harness for scripts/commit-msg.sh, the commit-msg hook that
# simple-git-hooks installs (package.json "commit-msg").
#
# The hook reads only the first line of the message file and accepts a
# Conventional Commits subject, a "Merge ..." subject or a "Revert ..."
# subject. Anything else exits 1 with the format help on stderr.
#
# Run with:
#   bash scripts/commit-msg.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/commit-msg.sh"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1: $2"; FAIL=$((FAIL + 1)); }

MSG_DIR=$(mktemp -d)
trap 'rm -rf "$MSG_DIR"' EXIT
MSG_FILE="${MSG_DIR}/COMMIT_EDITMSG"

# run_hook <message>: writes the message file and runs the hook on it,
# leaving the exit code in $rc and stderr in $err.
run_hook() {
    printf '%s\n' "$1" >"$MSG_FILE"
    err=$(sh "$SUBJECT" "$MSG_FILE" 2>&1 >/dev/null)
    rc=$?
}

# expect_accepted <name> <message>
expect_accepted() {
    run_hook "$2"
    if [ "$rc" -eq 0 ]; then
        pass "$1"
    else
        fail "$1" "expected exit 0, got $rc ($err)"
    fi
}

# expect_rejected <name> <message>
expect_rejected() {
    run_hook "$2"
    if [ "$rc" -ne 1 ]; then
        fail "$1" "expected exit 1, got $rc"
    elif ! echo "$err" | grep -qF "does not follow Conventional Commits format"; then
        fail "$1" "expected the format error on stderr, got '$err'"
    else
        pass "$1"
    fi
}

echo "Running commit-msg.sh tests..."

expect_accepted "plain conventional subject" "fix: handle a missing token"
expect_accepted "scoped subject" "feat(cli): add a status flag"
expect_accepted "breaking-change marker" "refactor(core)!: redesign state management"
expect_accepted "perf type" "perf: cache the search results"
expect_accepted "merge commit" "Merge branch 'main' into fix/foo"
expect_accepted "revert commit" 'Revert "fix: handle a missing token"'
expect_accepted "only the subject line is checked" "$(printf 'ci: run every shell test\n\nnot a conventional line')"

expect_rejected "non-conventional subject" "Update the readme"
expect_rejected "unknown type" "feature: add a status flag"
expect_rejected "uppercase type" "Fix: handle a missing token"
expect_rejected "no space after the colon" "fix:handle a missing token"
expect_rejected "empty description" "fix: "
expect_rejected "empty scope" "fix(): handle a missing token"
expect_rejected "good body does not rescue a bad subject" "$(printf 'wip\n\nfix: handle a missing token')"

echo
echo "Results: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
