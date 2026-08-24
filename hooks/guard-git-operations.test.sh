#!/usr/bin/env bash
# Tests for guard-git-operations.sh own-repo trust: rebase asks are skipped on
# repos owned by config.githubUsername when trustOwnRepoWrites is on; force
# push / reset --hard keep asking; every unresolvable case fails closed.
#
# Run with: bash hooks/guard-git-operations.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/guard-git-operations.sh"

FAIL=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
mkdir -p "$HOME/.oss-autopilot"
printf '{"config":{"trustOwnRepoWrites":true,"githubUsername":"alice"}}' > "$HOME/.oss-autopilot/state.json"

mkrepo() { # name url
    git init -q "$TMP/$1" && git -C "$TMP/$1" remote add origin "$2"
}
mkrepo own https://github.com/alice/thing.git
mkrepo own-ssh git@github.com:alice/thing.git
mkrepo other https://github.com/bob/thing.git
mkrepo prefix https://github.com/alicealt/thing.git

decision() { # cwd command
    local out
    out=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$1" "$2" | bash "$SUBJECT")
    [ -n "$out" ] || { echo pass; return; }
    printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // "pass"'
}

check() { # label expected cwd command
    local got
    got=$(decision "$3" "$4")
    if [ "$got" = "$2" ]; then
        echo "  PASS: $1"
    else
        echo "  FAIL: $1 (expected $2, got $got)"
        FAIL=1
    fi
}

check "own repo rebase passes"                 pass "$TMP/own"     "git rebase main"
check "own repo (ssh remote) rebase passes"    pass "$TMP/own-ssh" "git rebase main"
check "own repo pull --rebase passes"          pass "$TMP/own"     "git pull --rebase"
check "own repo via leading cd passes"         pass "$TMP"         "cd $TMP/own && git rebase --continue"
check "own repo via git -C passes"             pass "$TMP"         "git -C $TMP/own rebase main"
check "multiple cd fails closed (ambiguous)"   ask  "$TMP"         "cd $TMP/own && cd $TMP/own && git rebase main"
check "own repo reset --hard still asks"       ask  "$TMP/own"     "git reset --hard HEAD"
check "own repo force-with-lease still asks"   ask  "$TMP/own"     "git push --force-with-lease"
check "own repo bare force push still denied"  deny "$TMP/own"     "git push --force"
check "other owner rebase asks"                ask  "$TMP/other"   "git rebase main"
check "owner prefix collision asks"            ask  "$TMP/prefix"  "git rebase main"
check "no git repo asks"                       ask  "$TMP"         "git rebase main"
check "missing cd target asks"                 ask  "$TMP"         "cd $TMP/nope && git rebase main"

printf '{"config":{"trustOwnRepoWrites":false,"githubUsername":"alice"}}' > "$HOME/.oss-autopilot/state.json"
check "feature off asks on own repo"           ask  "$TMP/own"     "git rebase main"

printf '{"config":{"trustOwnRepoWrites":true}}' > "$HOME/.oss-autopilot/state.json"
check "no username asks on own repo"           ask  "$TMP/own"     "git rebase main"

exit $FAIL
