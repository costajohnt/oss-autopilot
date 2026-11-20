#!/usr/bin/env bash
# Make sure the @oss-autopilot/core CLI bundle is present and current.
#
# Two layouts reach this script:
#
# 1. Prebuilt install (what the marketplace serves: the `directory` branch
#    assembled by scripts/build-directory-branch.sh). The bundle ships built,
#    with no package.json or src/ beside it. Nothing is ever installed or
#    built here: the bundle is current by definition, and a missing bundle is
#    an error with a reinstall hint.
#
# 2. Source checkout (contributors, `claude --plugin-dir .`). The bundle is
#    "stale" when it's missing, when @oss-scout/core is not installed, OR
#    when any of the following are newer than the built artifact:
#      packages/core/src/**         (source files)
#      packages/core/package.json   (dep changes)
#      packages/core/tsconfig.json  (compiler config changes)
#      scripts/bundle.mjs           (the esbuild build script)
#      pnpm-lock.yaml               (resolved dependency versions)
#    A stale bundle is rebuilt only from the committed lockfile:
#    `pnpm install --frozen-lockfile --ignore-scripts`, then the bundle
#    script. There is no npm fallback and no dependency re-resolution (#1935):
#    without pnpm or pnpm-lock.yaml the script fails closed with exit 2
#    instead of installing whatever the registry serves that day.
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
# All build noise (install + bundle output) is sent to stderr so
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

# --- Prebuilt layout --------------------------------------------------------
# No package.json beside the bundle means there is nothing to rebuild from.
if [ ! -f "${PLUGIN_ROOT}/packages/core/package.json" ]; then
  if [ -f "${CLI_BUNDLE}" ]; then
    exit 0
  fi
  echo "BUILD_FAILED: the prebuilt CLI bundle is missing from ${PLUGIN_ROOT}/packages/core/dist and this install has no source to build from. Reinstall the oss-autopilot plugin from the marketplace."
  exit 2
fi

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
    "${PLUGIN_ROOT}/scripts/bundle.mjs" \
    "${PLUGIN_ROOT}/pnpm-lock.yaml" \
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

# Dependencies never installed: the bundle on disk was not built from this
# checkout's lockfile, so rebuild it.
if [ ! -f "${PLUGIN_ROOT}/packages/core/node_modules/@oss-scout/core/package.json" ]; then
  needs_rebuild=true
fi

if [ "$needs_rebuild" = false ]; then
  exit 0
fi

# --- Rebuild (source checkout only) ----------------------------------------
# Frozen lockfile: exactly the versions pnpm-lock.yaml pins, or a failure.
# --ignore-scripts: no dependency lifecycle script runs during the install
# (esbuild resolves its platform binary without its postinstall).
remediation="cd ${PLUGIN_ROOT} && pnpm install --frozen-lockfile --ignore-scripts && pnpm --filter @oss-autopilot/core run bundle"
if ! command -v pnpm >/dev/null 2>&1; then
  echo "BUILD_FAILED: the CLI bundle in this source checkout is stale and pnpm is not on PATH. Dependencies are only installed from pnpm-lock.yaml, so there is no npm fallback. Install pnpm (npm install -g pnpm), then: ${remediation}. Not developing the plugin? Install it from the marketplace, which ships a prebuilt bundle."
  exit 2
fi
if [ ! -f "${PLUGIN_ROOT}/pnpm-lock.yaml" ]; then
  echo "BUILD_FAILED: ${PLUGIN_ROOT}/pnpm-lock.yaml is missing, so dependencies cannot be installed reproducibly. Restore it (git checkout pnpm-lock.yaml), then: ${remediation}"
  exit 2
fi

if (
  cd "${PLUGIN_ROOT}" &&
    pnpm install --silent --frozen-lockfile --ignore-scripts &&
    pnpm --silent --filter @oss-autopilot/core run bundle
) >&2; then
  exit 1
fi

echo "BUILD_FAILED: ${remediation}"
exit 2
