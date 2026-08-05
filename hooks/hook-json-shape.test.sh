#!/usr/bin/env bash
# Shape test for every hook script that emits a hookSpecificOutput block.
#
# Claude Code validates hook stdout and discards the ENTIRE hookSpecificOutput
# block when the required "hookEventName" field is missing. The hook still
# exits 0, so the run is logged as a non-blocking error and the permission
# decision — including a "deny" — is silently dropped. A guard in that state
# looks healthy in the source and does nothing at runtime.
#
# Run via: bash hooks/hook-json-shape.test.sh
# Exits 0 on success, 1 on first failure.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

PASS=0
FAIL=0

for subject in "$SCRIPT_DIR"/*.sh; do
    case "$subject" in
        *.test.sh) continue ;;
    esac

    name=$(basename "$subject")
    blocks=$(grep -c 'hookSpecificOutput' "$subject" 2>/dev/null || true)
    [ "${blocks:-0}" -gt 0 ] || continue

    events=$(grep -c 'hookEventName' "$subject" 2>/dev/null || true)
    if [ "${events:-0}" -ge "$blocks" ]; then
        echo "  PASS: ${name} (${blocks} block(s), each carries hookEventName)"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: ${name}: ${blocks} hookSpecificOutput block(s) but only ${events} hookEventName field(s) — the missing ones are discarded at runtime"
        FAIL=$((FAIL + 1))
    fi

    # An empty "updatedInput": {} is not a no-op — it REPLACES the tool's
    # arguments with nothing. On a Bash call the harness rejects the result
    # ("required parameter `command` is missing") and the call dies before
    # reaching a permission prompt; on an MCP call the server receives {}
    # and fails on its own required fields. A guard that only wants to ask
    # or warn must omit the field entirely.
    empties=$(grep -cE '"?updatedInput"?[[:space:]]*:[[:space:]]*\{\}' "$subject" 2>/dev/null || true)
    if [ "${empties:-0}" -eq 0 ]; then
        echo "  PASS: ${name} (no empty updatedInput)"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: ${name}: ${empties} empty updatedInput block(s) — this wipes the tool input instead of passing it through"
        FAIL=$((FAIL + 1))
    fi
done

echo "Results: ${PASS} passed, ${FAIL} failed."
[ "$FAIL" -eq 0 ] || exit 1
