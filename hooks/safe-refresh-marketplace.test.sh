#!/usr/bin/env bash
# Test harness for safe-refresh-marketplace.sh.
#
# Uses only bash + core git — no bats/jest. Run with:
#   bash hooks/safe-refresh-marketplace.test.sh
# Exits 0 if all pass, 1 on first failure. Prints a one-line result per case.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/safe-refresh-marketplace.sh"

if [ ! -x "$SUBJECT" ]; then
    echo "FAIL: subject under test is not executable: $SUBJECT"
    exit 1
fi

PASS=0
FAIL=0
CURRENT_CASE=""

fail() {
    echo "  FAIL: ${CURRENT_CASE}: $*"
    FAIL=$((FAIL + 1))
}

pass() {
    echo "  PASS: ${CURRENT_CASE}"
    PASS=$((PASS + 1))
}

# Build a fake "remote" + "clone" pair in a throwaway tmpdir. The clone is
# set up so `safe-refresh-marketplace.sh` can fast-forward it to remote main.
setup() {
    WORK=$(mktemp -d)
    REMOTE="${WORK}/remote"
    CLONE="${WORK}/clone"

    git init --quiet --initial-branch=main --bare "$REMOTE"

    git init --quiet --initial-branch=main "${WORK}/seed"
    (
        cd "${WORK}/seed"
        git config user.email test@example.com
        git config user.name Test
        echo "v1" >README.md
        git add README.md
        git commit --quiet -m "initial"
        git remote add origin "$REMOTE"
        git push --quiet origin main
    )

    git clone --quiet "$REMOTE" "$CLONE"
    # Note: no user.email/user.name config inside $CLONE — none of the test
    # cases create commits there, so the config is unused.

    # Advance the remote so a fetch sees a new commit.
    (
        cd "${WORK}/seed"
        echo "v2" >README.md
        git commit --quiet -am "bump"
        git push --quiet origin main
    )
}

teardown() {
    rm -rf "$WORK"
}

run() {
    CURRENT_CASE="$1"
    shift
    setup
    "$@"
    teardown
}

# --- Cases -----------------------------------------------------------------

case_invalid_usage() {
    # Direct call (no `if` wrapper): bash's `if cmd; then; fi` without else
    # returns 0 when cmd fails, masking the real exit code.
    "$SUBJECT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 4 ] && pass || fail "expected exit 4 for missing arg, got $rc"
}

case_not_a_repo() {
    plain="${WORK}/not-a-repo"
    mkdir -p "$plain"
    "$SUBJECT" "$plain" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 3 ] && pass || fail "expected exit 3 for non-git dir, got $rc"
}

case_clean_clone_refreshes() {
    # Clone is one commit behind remote; expect fast-forward success.
    "$SUBJECT" "$CLONE" >/dev/null 2>&1
    rc=$?
    if [ "$rc" != 0 ]; then
        fail "expected exit 0 on clean clone, got $rc"
        return
    fi
    head_msg=$(git -C "$CLONE" log -1 --format=%s)
    [ "$head_msg" = "bump" ] && pass || fail "expected HEAD to be 'bump' after refresh, got '$head_msg'"
}

case_uncommitted_edits_preserved() {
    # Modify a tracked file and verify it survives the call.
    echo "local edit" >>"$CLONE/README.md"
    out=$("$SUBJECT" "$CLONE" 2>/dev/null) && rc=0 || rc=$?
    if [ "$rc" != 1 ]; then
        fail "expected exit 1 on uncommitted change, got $rc"
        return
    fi
    if ! echo "$out" | grep -qi "local changes detected"; then
        fail "expected skip message to mention 'local changes', got '$out'"
        return
    fi
    content=$(cat "$CLONE/README.md")
    if ! echo "$content" | grep -q "local edit"; then
        fail "uncommitted edit was destroyed"
        return
    fi
    head_msg=$(git -C "$CLONE" log -1 --format=%s)
    [ "$head_msg" = "initial" ] && pass || fail "expected HEAD to stay at 'initial', got '$head_msg'"
}

case_staged_changes_preserved() {
    # Stage a change without committing. Must survive.
    echo "staged" >"$CLONE/staged.txt"
    git -C "$CLONE" add staged.txt
    "$SUBJECT" "$CLONE" >/dev/null 2>&1
    rc=$?
    if [ "$rc" != 1 ]; then
        fail "expected exit 1 on staged change, got $rc"
        return
    fi
    if [ ! -f "$CLONE/staged.txt" ]; then
        fail "staged file was destroyed"
        return
    fi
    staged_count=$(git -C "$CLONE" diff --cached --name-only | wc -l | tr -d ' ')
    [ "$staged_count" = "1" ] && pass || fail "expected 1 staged file, got $staged_count"
}

case_untracked_file_preserved() {
    # Untracked files should also block the reset.
    echo "untracked" >"$CLONE/notes.txt"
    "$SUBJECT" "$CLONE" >/dev/null 2>&1
    rc=$?
    if [ "$rc" != 1 ]; then
        fail "expected exit 1 on untracked file, got $rc"
        return
    fi
    [ -f "$CLONE/notes.txt" ] && pass || fail "untracked file was destroyed"
}

case_corrupt_repo_preserved() {
    # `git status` fails when HEAD is missing. Verify the clone is classified
    # as "unsafe to reset" (exit 1, user-visible message) rather than silently
    # treated as clean and reset.
    rm -f "$CLONE/.git/HEAD"
    out=$("$SUBJECT" "$CLONE" 2>/dev/null) && rc=0 || rc=$?
    if [ "$rc" != 1 ]; then
        fail "expected exit 1 for corrupt repo (missing HEAD), got $rc"
        return
    fi
    if ! echo "$out" | grep -qi "inconsistent state"; then
        fail "expected corrupt-repo message to mention 'inconsistent state', got '$out'"
        return
    fi
    # The clone's working tree must be untouched — no new checkout, no reset.
    [ ! -f "$CLONE/.git/HEAD" ] && pass || fail "HEAD reappeared — script performed an unsafe operation"
}

case_fetch_failure_returns_2() {
    # Point origin at a nonexistent path. Clean clone so the dirty check passes;
    # fetch must fail, and the script must exit 2 without touching the tree.
    git -C "$CLONE" remote set-url origin "${WORK}/nonexistent-remote"
    "$SUBJECT" "$CLONE" >/dev/null 2>&1
    rc=$?
    if [ "$rc" != 2 ]; then
        fail "expected exit 2 on unreachable remote, got $rc"
        return
    fi
    head_msg=$(git -C "$CLONE" log -1 --format=%s)
    [ "$head_msg" = "initial" ] && pass || fail "expected HEAD to stay at 'initial' after failed fetch, got '$head_msg'"
}

# --- Driver ----------------------------------------------------------------

echo "Running safe-refresh-marketplace.sh tests..."
run case_invalid_usage        case_invalid_usage
run case_not_a_repo           case_not_a_repo
run case_clean_clone_refreshes case_clean_clone_refreshes
run case_uncommitted_edits_preserved case_uncommitted_edits_preserved
run case_staged_changes_preserved    case_staged_changes_preserved
run case_untracked_file_preserved    case_untracked_file_preserved
run case_corrupt_repo_preserved      case_corrupt_repo_preserved
run case_fetch_failure_returns_2     case_fetch_failure_returns_2

echo
echo "Results: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
