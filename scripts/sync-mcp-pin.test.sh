#!/usr/bin/env bash
# Test harness for scripts/sync-mcp-pin.mjs.
#
# Builds a throwaway repo root containing .mcp.json and
# packages/mcp-server/package.json, then exercises the in-sync, drifted,
# malformed, and formatting-preservation paths of both the write mode and
# --check. Run with:
#   bash scripts/sync-mcp-pin.test.sh
# Exits 0 on all-pass, 1 on any failure.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/sync-mcp-pin.mjs"

if [ ! -f "$SUBJECT" ]; then
    echo "FAIL: subject under test is missing: $SUBJECT"
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

# Fixture: <root>/.mcp.json pinned to "$1" and
# <root>/packages/mcp-server/package.json at version "$2".
setup() {
    WORK=$(mktemp -d)
    ROOT="${WORK}/repo"
    mkdir -p "${ROOT}/packages/mcp-server"
    cat >"${ROOT}/.mcp.json" <<EOF
{
  "mcpServers": {
    "oss-autopilot": {
      "command": "npx",
      "args": ["$1"]
    }
  }
}
EOF
    cat >"${ROOT}/packages/mcp-server/package.json" <<EOF
{
  "name": "@oss-autopilot/mcp",
  "version": "$2"
}
EOF
}

teardown() {
    rm -rf "$WORK"
}

run() {
    CURRENT_CASE="$1"
    shift
    "$@"
    teardown
}

pinned_spec() {
    node -p "require('${ROOT}/.mcp.json').mcpServers['oss-autopilot'].args[0]"
}

# --- Cases -----------------------------------------------------------------

case_in_sync_check_passes() {
    setup "@oss-autopilot/mcp@5.7.6" "5.7.6"
    before=$(cat "${ROOT}/.mcp.json")
    node "$SUBJECT" --check "$ROOT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] || { fail "expected exit 0 when in sync, got $rc"; return; }
    [ "$(cat "${ROOT}/.mcp.json")" = "$before" ] || { fail "--check modified .mcp.json"; return; }
    pass
}

case_latest_check_fails_without_writing() {
    setup "@oss-autopilot/mcp@latest" "5.7.6"
    before=$(cat "${ROOT}/.mcp.json")
    out=$(node "$SUBJECT" --check "$ROOT" 2>&1)
    rc=$?
    [ "$rc" = 1 ] || { fail "expected exit 1 on @latest drift, got $rc"; return; }
    echo "$out" | grep -q "sync-mcp-pin.mjs" || { fail "error should name the fix command, got: $out"; return; }
    [ "$(cat "${ROOT}/.mcp.json")" = "$before" ] || { fail "--check modified .mcp.json"; return; }
    pass
}

case_write_pins_latest_and_preserves_formatting() {
    setup "@oss-autopilot/mcp@latest" "5.7.6"
    node "$SUBJECT" "$ROOT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] || { fail "expected exit 0 on write, got $rc"; return; }
    [ "$(pinned_spec)" = "@oss-autopilot/mcp@5.7.6" ] || { fail "pin not rewritten: $(pinned_spec)"; return; }
    expected=$(printf '{\n  "mcpServers": {\n    "oss-autopilot": {\n      "command": "npx",\n      "args": ["@oss-autopilot/mcp@5.7.6"]\n    }\n  }\n}\n')
    [ "$(cat "${ROOT}/.mcp.json")" = "$expected" ] || { fail "formatting changed:\n$(cat "${ROOT}/.mcp.json")"; return; }
    node "$SUBJECT" --check "$ROOT" >/dev/null 2>&1 || { fail "--check still fails after write"; return; }
    pass
}

case_write_bumps_old_pin() {
    setup "@oss-autopilot/mcp@5.7.1" "5.8.0"
    node "$SUBJECT" "$ROOT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] || { fail "expected exit 0 on write, got $rc"; return; }
    [ "$(pinned_spec)" = "@oss-autopilot/mcp@5.8.0" ] || { fail "pin not bumped: $(pinned_spec)"; return; }
    pass
}

case_write_in_sync_is_noop() {
    setup "@oss-autopilot/mcp@5.7.6" "5.7.6"
    before=$(cat "${ROOT}/.mcp.json")
    node "$SUBJECT" "$ROOT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] || { fail "expected exit 0, got $rc"; return; }
    [ "$(cat "${ROOT}/.mcp.json")" = "$before" ] || { fail "no-op write changed the file"; return; }
    pass
}

case_missing_spec_fails() {
    setup "some-other-package" "5.7.6"
    node "$SUBJECT" "$ROOT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 1 ] || { fail "expected exit 1 when no @oss-autopilot/mcp arg, got $rc"; return; }
    pass
}

case_invalid_mcp_json_fails() {
    setup "@oss-autopilot/mcp@latest" "5.7.6"
    echo "{ not json" >"${ROOT}/.mcp.json"
    node "$SUBJECT" "$ROOT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 1 ] || { fail "expected exit 1 on invalid .mcp.json, got $rc"; return; }
    [ "$(cat "${ROOT}/.mcp.json")" = "{ not json" ] || { fail "invalid file was rewritten"; return; }
    pass
}

case_invalid_version_fails() {
    setup "@oss-autopilot/mcp@latest" "not-a-version"
    before=$(cat "${ROOT}/.mcp.json")
    node "$SUBJECT" "$ROOT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 1 ] || { fail "expected exit 1 on invalid package.json version, got $rc"; return; }
    [ "$(cat "${ROOT}/.mcp.json")" = "$before" ] || { fail ".mcp.json rewritten despite bad version"; return; }
    pass
}

case_unknown_option_fails() {
    setup "@oss-autopilot/mcp@5.7.6" "5.7.6"
    node "$SUBJECT" --chekc "$ROOT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 1 ] || { fail "expected exit 1 on unknown option, got $rc"; return; }
    pass
}

# --- Driver ----------------------------------------------------------------

echo "Running sync-mcp-pin.mjs tests..."
run case_in_sync_check_passes                      case_in_sync_check_passes
run case_latest_check_fails_without_writing        case_latest_check_fails_without_writing
run case_write_pins_latest_and_preserves_formatting case_write_pins_latest_and_preserves_formatting
run case_write_bumps_old_pin                       case_write_bumps_old_pin
run case_write_in_sync_is_noop                     case_write_in_sync_is_noop
run case_missing_spec_fails                        case_missing_spec_fails
run case_invalid_mcp_json_fails                    case_invalid_mcp_json_fails
run case_invalid_version_fails                     case_invalid_version_fails
run case_unknown_option_fails                      case_unknown_option_fails

echo
echo "Results: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
