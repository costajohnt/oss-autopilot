#!/usr/bin/env bash
# Rebuild the @oss-autopilot/core CLI bundle if it's stale relative to source.
#
# A bundle is "stale" when it's missing OR when any of the following are
# newer than the built artifact:
#   packages/core/src/**         (source files)
#   packages/core/package.json   (dep changes)
#   packages/core/tsconfig.json  (compiler config changes)
#
# It is also considered stale when the installed @oss-scout/core dependency
# is behind the newest version published within its declared semver range.
# Local file mtimes never move when a dependency publishes a new version, so
# without this check an installed plugin would run a stale @oss-scout/core
# forever even though nothing in the plugin's own source changed. This check
# hits the npm registry, so it's throttled to once per day via a stamp file
# and is fully failure-tolerant: any network/registry error just skips the
# check for this run (the stamp is left untouched so it retries next time).
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

# --- Dependency-freshness check -------------------------------------------
# Catches the case where @oss-scout/core has published a new version that
# satisfies the range already declared in packages/core/package.json. The
# mtime-based check above can't see this: nothing local changed.
CORE_PKG_JSON="${PLUGIN_ROOT}/packages/core/package.json"
INSTALLED_PKG_JSON="${PLUGIN_ROOT}/packages/core/node_modules/@oss-scout/core/package.json"
# Lives under dist/, which is already gitignored wholesale, so the stamp
# never shows up as an untracked file in a contributor's working tree.
FRESHNESS_STAMP="${PLUGIN_ROOT}/packages/core/dist/.dep-freshness-checked"

dep_refresh_needed=false
dep_installed_version=""
dep_latest_version=""

if [ ! -f "${INSTALLED_PKG_JSON}" ]; then
  # Not installed at all yet: needs an install regardless of the daily
  # throttle below (there's nothing to compare against, and no network
  # round-trip is needed to know this).
  dep_refresh_needed=true
else
  dep_installed_version=$(grep -m1 '"version"[[:space:]]*:' "${INSTALLED_PKG_JSON}" 2>/dev/null |
    sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')

  today="$(date +%Y-%m-%d 2>/dev/null || true)"
  last_checked=""
  [ -f "${FRESHNESS_STAMP}" ] && last_checked=$(cat "${FRESHNESS_STAMP}" 2>/dev/null || true)

  if [ -n "$today" ] && [ "$last_checked" != "$today" ] && [ -f "${CORE_PKG_JSON}" ] && command -v npm >/dev/null 2>&1; then
    dep_range=$(grep -m1 '"@oss-scout/core"[[:space:]]*:' "${CORE_PKG_JSON}" 2>/dev/null |
      sed -E 's/.*"@oss-scout\/core"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')

    if [ -n "$dep_range" ]; then
      # `npm view pkg@range version` resolves the highest version in the
      # registry that satisfies the range directly, no manual semver compare
      # needed. Any failure here (offline, registry down, range unparsable)
      # is swallowed: the check is best-effort and must never fail the build.
      dep_latest_version=$(npm view "@oss-scout/core@${dep_range}" version 2>/dev/null)
      if [ -n "$dep_latest_version" ]; then
        # Registry was reachable: record today's date so we don't hit it
        # again until tomorrow, whether or not a refresh is needed. mkdir
        # covers the first-ever run, before dist/ exists.
        mkdir -p "${PLUGIN_ROOT}/packages/core/dist" 2>/dev/null || true
        echo "$today" >"${FRESHNESS_STAMP}" 2>/dev/null || true
        if [ "$dep_latest_version" != "$dep_installed_version" ]; then
          dep_refresh_needed=true
        fi
      fi
    fi
  fi
fi

if [ "$dep_refresh_needed" = true ]; then
  echo "build-cli-if-stale.sh: @oss-scout/core is stale (installed ${dep_installed_version:-none}, latest in range ${dep_latest_version:-unknown}); refreshing" >&2
  needs_rebuild=true
fi

if [ "$needs_rebuild" = false ]; then
  exit 0
fi

# --- Rebuild --------------------------------------------------------------
# Prefer pnpm: this is a pnpm workspace, and running `npm install` from
# packages/core/ would generate a stray package-lock.json next to
# pnpm-lock.yaml. Fall back to npm only when pnpm isn't installed (works
# today because @oss-autopilot/core has no workspace:* deps).
#
# When a dependency refresh is needed, an `install`/`pnpm install` alone
# isn't enough: both tools honor the checked-in lockfile by default and will
# happily keep resolving the already-locked (stale) version even though a
# newer one now satisfies the declared range. `update` re-resolves that one
# package against the range and rewrites the lockfile; a plain install after
# it is then a no-op for that package but still catches everything else.
remediation=""
if command -v pnpm >/dev/null 2>&1; then
  remediation="cd ${PLUGIN_ROOT} && pnpm install && pnpm --filter @oss-autopilot/core run bundle"
  if (
    cd "${PLUGIN_ROOT}" &&
      { [ "$dep_refresh_needed" = false ] || pnpm --silent --filter @oss-autopilot/core update @oss-scout/core; } &&
      pnpm install --silent &&
      pnpm --silent --filter @oss-autopilot/core run bundle
  ) >&2; then
    exit 1
  fi
else
  remediation="cd ${PLUGIN_ROOT}/packages/core && npm install && npm run bundle"
  if (
    cd "${PLUGIN_ROOT}/packages/core" &&
      { [ "$dep_refresh_needed" = false ] || npm update @oss-scout/core --silent; } &&
      npm install --silent &&
      npm run bundle --silent
  ) >&2; then
    exit 1
  fi
fi

echo "BUILD_FAILED: ${remediation}"
exit 2
