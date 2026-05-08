#!/usr/bin/env bash
# Rebuild the @oss-autopilot/core CLI bundle if it's stale relative to source.
#
# A bundle is "stale" when it's missing OR when any of the following are
# newer than the built artifact:
#   packages/core/src/**         (source files)
#   packages/core/package.json   (dep changes)
#   packages/core/tsconfig.json  (compiler config changes)
#
# Editor swap files (.DS_Store, *~, *.swp, *.swo, .#*) and node_modules / .git
# trees are excluded so an editor leaving a temp file alongside src/ does not
# trigger a rebuild on every session.
#
# Exit codes:
#   0 — bundle is current; no rebuild attempted.
#   1 — bundle was rebuilt successfully.
#   2 — bundle is stale and the rebuild attempt FAILED. The remediation
#       command is printed to stdout for the caller to surface.
#   3 — invocation error (PLUGIN_ROOT missing, packages/core not found).
#
# Usage:
#   build-cli-if-stale.sh <plugin-root>
#
# Or, equivalently, with $CLAUDE_PLUGIN_ROOT exported:
#   build-cli-if-stale.sh
#
# All build noise (npm/pnpm install + bundle output) is sent to stderr so
# stdout stays clean for the caller (the BUILD_FAILED hint, if emitted, is
# the only stdout output).

set -uo pipefail

PLUGIN_ROOT="${1:-${CLAUDE_PLUGIN_ROOT:-}}"
if [ -z "${PLUGIN_ROOT}" ]; then
  echo "build-cli-if-stale.sh: missing plugin root (pass as arg or export CLAUDE_PLUGIN_ROOT)" >&2
  exit 3
fi
if [ ! -d "${PLUGIN_ROOT}/packages/core" ]; then
  echo "build-cli-if-stale.sh: packages/core not found under ${PLUGIN_ROOT}" >&2
  exit 3
fi

CLI_BUNDLE="${PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs"

# --- Staleness check ------------------------------------------------------
needs_rebuild=false
if [ ! -f "${CLI_BUNDLE}" ]; then
  needs_rebuild=true
else
  # `find -newer` returns the first newer file found (-print -quit). If the
  # output is non-empty, something was modified after the bundle was built.
  newer=$(find \
    "${PLUGIN_ROOT}/packages/core/src" \
    "${PLUGIN_ROOT}/packages/core/package.json" \
    "${PLUGIN_ROOT}/packages/core/tsconfig.json" \
    -type f \
    ! -path '*/node_modules/*' \
    ! -path '*/.git/*' \
    ! -name '.DS_Store' \
    ! -name '*~' \
    ! -name '*.swp' \
    ! -name '*.swo' \
    ! -name '.#*' \
    -newer "${CLI_BUNDLE}" -print -quit 2>/dev/null)
  if [ -n "$newer" ]; then
    needs_rebuild=true
  fi
fi

if [ "$needs_rebuild" = false ]; then
  exit 0
fi

# --- Rebuild --------------------------------------------------------------
# Prefer pnpm: this is a pnpm workspace, and running `npm install` from
# packages/core/ would generate a stray package-lock.json next to
# pnpm-lock.yaml. Fall back to npm only when pnpm isn't installed (works
# today because @oss-autopilot/core has no workspace:* deps).
remediation=""
if command -v pnpm >/dev/null 2>&1; then
  remediation="cd ${PLUGIN_ROOT} && pnpm install && pnpm --filter @oss-autopilot/core run bundle"
  if (cd "${PLUGIN_ROOT}" && pnpm install --silent && pnpm --silent --filter @oss-autopilot/core run bundle) >&2; then
    exit 1
  fi
else
  remediation="cd ${PLUGIN_ROOT}/packages/core && npm install && npm run bundle"
  if (cd "${PLUGIN_ROOT}/packages/core" && npm install --silent && npm run bundle --silent) >&2; then
    exit 1
  fi
fi

echo "BUILD_FAILED: ${remediation}"
exit 2
