#!/usr/bin/env bash
# PreToolUse Bash hook dispatcher (#1111).
#
# Runs the three Bash guards in defined order on a single shared stdin
# payload. Claude Code does not guarantee strict serial execution of
# multiple PreToolUse hooks with the same matcher, so a deny from guard A
# could race an allow from guard B with undefined outcome. Routing
# everything through one entry deduplicates.
#
# Short-circuit policy: the first guard that emits any stdout has the
# final say — its output is forwarded to Claude Code unchanged, and
# subsequent guards do not run. Empty stdout = pass; continue.
#
# Order matters:
#   1. guard-public-posts.sh       — must run first; "ask" decisions need
#                                    user approval before any side effects
#   2. guard-git-operations.sh     — block unsafe pushes/rebases
#   3. auto-format-before-push.sh  — opt-in formatter (has side effects);
#                                    only safe to run after the safety
#                                    guards have passed

# No `-e`: a guard exiting non-zero must not abort the dispatcher silently;
# we surface it explicitly below.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
INPUT=$(cat)

GUARDS=(
  guard-public-posts.sh
  guard-git-operations.sh
  auto-format-before-push.sh
)

for guard in "${GUARDS[@]}"; do
  output=$(printf '%s' "$INPUT" | "${SCRIPT_DIR}/${guard}")
  rc=$?
  if [ -n "$output" ]; then
    # Forward verbatim — this is a decision (ask/deny), a systemMessage
    # reminder, or a non-blocking warning. We can only emit one hook
    # response, so subsequent guards do not run.
    printf '%s' "$output"
    exit 0
  fi
  if [ "$rc" -ne 0 ]; then
    # Empty stdout + non-zero exit = guard hit an internal failure. Emit a
    # systemMessage so the failure is visible without blocking the call.
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","systemMessage":"oss-autopilot ${guard} exited with code ${rc}; check the guard's stderr for details"}}
EOF
    exit 0
  fi
done

exit 0
