#!/usr/bin/env bash
# wait-for-ci.sh — poll `gh pr checks` until every required check has a
# terminal status (pass / fail / skipping). Exits 0 if all checks passed,
# 1 if any failed, 2 on usage error.
#
# Usage:
#   scripts/wait-for-ci.sh <pr-number> [--repo OWNER/REPO] [--interval N] [--timeout SEC]
#
# Defaults:
#   --repo costajohnt/oss-autopilot
#   --interval 25 seconds between polls
#   --timeout 600 seconds (10 minutes)
#
# Why this exists: `gh pr checks --watch` is unreliable in some terminals
# (exits mid-stream, miscounts queued runs, swallows status). The
# until-loop here is what the issue-batch skill documents — extracted so
# any contributor can invoke it without rewriting the loop.

set -uo pipefail

PR=""
REPO="costajohnt/oss-autopilot"
INTERVAL=25
TIMEOUT=600

usage() {
  cat <<'EOF'
Usage: scripts/wait-for-ci.sh <pr-number> [--repo OWNER/REPO] [--interval N] [--timeout SEC]

Polls until every check on the PR has a terminal status. Prints the final
table and exits 0 if all required checks passed, 1 if any failed.
EOF
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -h|--help) usage ;;
    *)
      if [ -z "$PR" ]; then
        PR="$1"
        shift
      else
        echo "Unexpected arg: $1" >&2
        usage
      fi
      ;;
  esac
done

if [ -z "$PR" ]; then
  echo "Missing PR number." >&2
  usage
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found on PATH." >&2
  exit 2
fi

start_ts=$(date +%s)

while true; do
  out=$(gh pr checks "$PR" --repo "$REPO" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ] && ! echo "$out" | grep -qE 'pass|fail|skip|pending|queued'; then
    echo "gh pr checks failed: $out" >&2
    exit 2
  fi

  # Each check is one line of `gh pr checks` output. A line is "settled"
  # when its status column is one of pass / fail / skipping. "pending" and
  # "queued" mean still in flight.
  total=$(echo "$out" | grep -cE 'pass|fail|skipping|pending|queued')
  settled=$(echo "$out" | grep -cE 'pass|fail|skipping')
  if [ "$total" -gt 0 ] && [ "$settled" -ge "$total" ]; then
    break
  fi

  now=$(date +%s)
  if [ $((now - start_ts)) -ge "$TIMEOUT" ]; then
    echo "Timed out after ${TIMEOUT}s waiting for ${total} checks (settled=${settled})." >&2
    echo "$out" >&2
    exit 1
  fi

  sleep "$INTERVAL"
done

# Final state — print table to stdout, exit code reflects pass/fail
echo "$out"

if echo "$out" | grep -qE '^[^[:space:]].*\bfail\b'; then
  exit 1
fi
exit 0
