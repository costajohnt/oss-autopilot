#!/usr/bin/env bash
# Safely refresh a git clone to origin/main — preserves local changes.
#
# Usage: safe-refresh-marketplace.sh <clone-dir>
#
# Exit codes:
#   0 — refresh succeeded (fetch + reset --hard ran)
#   1 — skipped; clone is unsafe to reset. stdout carries a single user-visible
#       line explaining what happened. Covers both "has local changes" and
#       "git status itself failed" (corrupt repo, locked index, etc.).
#   2 — skipped because fetch or reset failed (network, no origin, etc.)
#   3 — skipped because <clone-dir> does not exist or is not a git repo
#   4 — invalid usage
#
# Contract: on exit 1, stdout MUST be a single line — the caller may interpolate
# it into a JSON field with basic escaping.

set -euo pipefail

CLONE_DIR="${1:-}"
if [ -z "$CLONE_DIR" ]; then
    echo "Usage: $(basename "$0") <clone-dir>" >&2
    exit 4
fi

if [ ! -d "${CLONE_DIR}/.git" ]; then
    exit 3
fi

# Capture both stdout and exit code of `git status --porcelain`. A non-zero
# exit (corrupt repo, missing HEAD, locked .git/index.lock, interrupted
# merge/rebase, etc.) produces empty stdout — without the explicit rc check
# those cases would be misclassified as clean, and the reset below would
# run on a broken clone.
status_output=$(git -C "${CLONE_DIR}" status --porcelain 2>/dev/null) && status_rc=0 || status_rc=$?

if [ "$status_rc" -ne 0 ]; then
    echo "Marketplace clone at ${CLONE_DIR} is in an inconsistent state (git status failed); your files are untouched. Inspect it manually to resume auto-updates."
    exit 1
fi

if [ -n "$status_output" ]; then
    echo "Local changes detected in marketplace clone (${CLONE_DIR}); your edits are preserved and auto-refresh was skipped. Commit, stash, or revert them to resume auto-updates."
    exit 1
fi

if git -C "${CLONE_DIR}" fetch --quiet origin main 2>/dev/null \
    && git -C "${CLONE_DIR}" reset --hard origin/main --quiet 2>/dev/null; then
    exit 0
fi

exit 2
