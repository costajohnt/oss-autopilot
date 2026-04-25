#!/usr/bin/env bash
# Test harness for pre-tool-use-dispatcher.sh (#1111).
#
# Uses bash + a tmp directory of stub guard scripts — no test framework.
# Run with:
#   bash hooks/pre-tool-use-dispatcher.test.sh
# Exits 0 if all pass, 1 on first failure.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/pre-tool-use-dispatcher.sh"

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

# Build a sandbox directory with stub guard scripts and a copy of the
# dispatcher that points at it. The dispatcher resolves guard paths via
# its own SCRIPT_DIR, so dropping it next to the stubs is enough.
make_sandbox() {
    local sandbox
    sandbox=$(mktemp -d)
    cp "$SUBJECT" "${sandbox}/pre-tool-use-dispatcher.sh"
    chmod +x "${sandbox}/pre-tool-use-dispatcher.sh"
    echo "$sandbox"
}

write_guard() {
    local sandbox="$1" name="$2" stdout="$3" rc="$4"
    cat > "${sandbox}/${name}" <<STUB
#!/usr/bin/env bash
cat >/dev/null  # consume stdin
if [ -n "${stdout}" ]; then
    printf '%s' "${stdout}"
fi
exit ${rc}
STUB
    chmod +x "${sandbox}/${name}"
}

# Case 1: all guards pass silently → dispatcher emits nothing, exits 0
CURRENT_CASE="all guards pass"
SANDBOX=$(make_sandbox)
write_guard "$SANDBOX" guard-public-posts.sh "" 0
write_guard "$SANDBOX" guard-git-operations.sh "" 0
write_guard "$SANDBOX" auto-format-before-push.sh "" 0
output=$(echo '{"tool_input":{"command":"ls"}}' | "${SANDBOX}/pre-tool-use-dispatcher.sh")
rc=$?
if [ "$rc" -ne 0 ]; then
    fail "expected rc=0, got $rc"
elif [ -n "$output" ]; then
    fail "expected empty stdout, got: $output"
else
    pass
fi
rm -rf "$SANDBOX"

# Case 2: first guard emits a "deny" decision → dispatcher forwards it and
# does NOT run subsequent guards (proven by a marker file each stub touches).
CURRENT_CASE="short-circuits on first non-empty stdout"
SANDBOX=$(make_sandbox)
MARKER="${SANDBOX}/marker"
DENY_JSON='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"test"}}'
cat > "${SANDBOX}/guard-public-posts.sh" <<STUB
#!/usr/bin/env bash
cat >/dev/null
echo -n '${DENY_JSON}'
exit 0
STUB
chmod +x "${SANDBOX}/guard-public-posts.sh"
cat > "${SANDBOX}/guard-git-operations.sh" <<STUB
#!/usr/bin/env bash
cat >/dev/null
touch '${MARKER}'
exit 0
STUB
chmod +x "${SANDBOX}/guard-git-operations.sh"
cat > "${SANDBOX}/auto-format-before-push.sh" <<STUB
#!/usr/bin/env bash
cat >/dev/null
touch '${MARKER}'
exit 0
STUB
chmod +x "${SANDBOX}/auto-format-before-push.sh"
output=$(echo '{"tool_input":{"command":"ls"}}' | "${SANDBOX}/pre-tool-use-dispatcher.sh")
rc=$?
if [ "$rc" -ne 0 ]; then
    fail "expected rc=0, got $rc"
elif [ "$output" != "$DENY_JSON" ]; then
    fail "expected DENY JSON forwarded verbatim; got: $output"
elif [ -f "$MARKER" ]; then
    fail "subsequent guards ran despite short-circuit"
else
    pass
fi
rm -rf "$SANDBOX"

# Case 3: middle guard emits → dispatcher forwards it and does not run the
# third
CURRENT_CASE="short-circuits after middle guard"
SANDBOX=$(make_sandbox)
MARKER="${SANDBOX}/marker"
write_guard "$SANDBOX" guard-public-posts.sh "" 0
write_guard "$SANDBOX" guard-git-operations.sh '{"hookSpecificOutput":{"hookEventName":"PreToolUse","systemMessage":"reminder"}}' 0
cat > "${SANDBOX}/auto-format-before-push.sh" <<STUB
#!/usr/bin/env bash
cat >/dev/null
touch '${MARKER}'
exit 0
STUB
chmod +x "${SANDBOX}/auto-format-before-push.sh"
output=$(echo '{"tool_input":{"command":"git push"}}' | "${SANDBOX}/pre-tool-use-dispatcher.sh")
rc=$?
if [ "$rc" -ne 0 ]; then
    fail "expected rc=0, got $rc"
elif [ -z "$output" ]; then
    fail "expected non-empty stdout from middle guard"
elif [ -f "$MARKER" ]; then
    fail "third guard ran despite middle-guard output"
else
    pass
fi
rm -rf "$SANDBOX"

# Case 4: guard exits non-zero with empty stdout → dispatcher emits a
# systemMessage but exits 0 (does not abort the tool call)
CURRENT_CASE="non-zero rc with empty stdout surfaces systemMessage"
SANDBOX=$(make_sandbox)
write_guard "$SANDBOX" guard-public-posts.sh "" 7
write_guard "$SANDBOX" guard-git-operations.sh "" 0
write_guard "$SANDBOX" auto-format-before-push.sh "" 0
output=$(echo '{}' | "${SANDBOX}/pre-tool-use-dispatcher.sh")
rc=$?
if [ "$rc" -ne 0 ]; then
    fail "expected rc=0 even on guard error, got $rc"
elif ! echo "$output" | grep -q "guard-public-posts.sh exited with code 7"; then
    fail "expected systemMessage referencing guard rc; got: $output"
else
    pass
fi
rm -rf "$SANDBOX"

# Case 5: dispatcher passes the same stdin payload to each guard
CURRENT_CASE="each guard receives the original stdin"
SANDBOX=$(make_sandbox)
LOG="${SANDBOX}/stdin-log"
for g in guard-public-posts.sh guard-git-operations.sh auto-format-before-push.sh; do
    cat > "${SANDBOX}/${g}" <<STUB
#!/usr/bin/env bash
echo "[${g}] >>" >> '${LOG}'
cat >> '${LOG}'
echo >> '${LOG}'
exit 0
STUB
    chmod +x "${SANDBOX}/${g}"
done
echo '{"tool_input":{"command":"echo hi"}}' | "${SANDBOX}/pre-tool-use-dispatcher.sh" >/dev/null
# Should appear three times — once per guard
count=$(grep -c '\[.*\] >>' "$LOG")
if [ "$count" -ne 3 ]; then
    fail "expected 3 guard invocations, saw $count"
elif ! grep -q '"command":"echo hi"' "$LOG"; then
    fail "expected guards to receive the original payload; log was: $(cat "$LOG")"
else
    pass
fi
rm -rf "$SANDBOX"

echo
if [ "$FAIL" -gt 0 ]; then
    echo "${FAIL} failed, ${PASS} passed"
    exit 1
fi
echo "${PASS} passed"
exit 0
