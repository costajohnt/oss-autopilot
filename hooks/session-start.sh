#!/usr/bin/env bash
# SessionStart hook for oss-autopilot plugin
# Performs startup checks and outputs additionalContext via JSON

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

messages=""
NL=$'\n'

# Marketplace clone path; refresh is handled by safe-refresh-marketplace.sh in Step 2.
MARKETPLACE_DIR="$HOME/.claude/plugins/marketplaces/oss-autopilot"

# --- Step 1: Rebuild stale CLI bundle (if needed) ---
if [ -f "${PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ] && [ "${PLUGIN_ROOT}/packages/core/package.json" -nt "${PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ]; then
  if (cd "${PLUGIN_ROOT}/packages/core" && npm install --silent 2>/dev/null && npm run bundle --silent 2>/dev/null); then
    messages="CLI bundle rebuilt after plugin update."
  else
    messages="Warning: CLI bundle rebuild failed. Run /oss to retry, or: cd ${PLUGIN_ROOT}/packages/core && npm install && npm run bundle"
  fi
fi

# --- Step 1.5: Build dashboard SPA if missing or stale ---
# Stale check scans src/, vite.config.ts, tsconfig.json, and package.json
# against dist/index.html. Must match the check in commands/oss-dashboard.md —
# checking package.json alone misses the common case where only src/ changes
# (package.json is private, pinned at 0.1.0, and rarely touched).
DASHBOARD_INDEX="${PLUGIN_ROOT}/packages/dashboard/dist/index.html"
DASHBOARD_PKG="${PLUGIN_ROOT}/packages/dashboard/package.json"
if [ -f "${DASHBOARD_PKG}" ] && { [ ! -f "${DASHBOARD_INDEX}" ] || [ -n "$(find "${PLUGIN_ROOT}/packages/dashboard/src" "${DASHBOARD_PKG}" "${PLUGIN_ROOT}/packages/dashboard/vite.config.ts" "${PLUGIN_ROOT}/packages/dashboard/tsconfig.json" -newer "${DASHBOARD_INDEX}" -print -quit 2>/dev/null)" ]; }; then
  # Dashboard depends on @oss-autopilot/core types via workspace:* protocol.
  # Use pnpm if available (required for workspace: resolution), fall back to npm.
  if command -v pnpm &>/dev/null; then
    dashboard_build() { cd "${PLUGIN_ROOT}" && pnpm install --silent 2>/dev/null && pnpm --silent --filter @oss-autopilot/core run build 2>/dev/null && pnpm --silent --filter @oss-autopilot/dashboard run build 2>/dev/null; }
  else
    dashboard_build() { cd "${PLUGIN_ROOT}/packages/dashboard" && npm install --silent 2>/dev/null && npm run build 2>/dev/null; }
  fi
  if (dashboard_build); then
    messages="${messages:+${messages}${NL}}Dashboard SPA built successfully."
  else
    messages="${messages:+${messages}${NL}}Warning: Dashboard SPA build failed. To fix: cd ${PLUGIN_ROOT} && pnpm install && pnpm run build"
  fi
fi

# --- Step 2: Check for updates (every 6 hours) ---
LAST_CHECK="${HOME}/.oss-autopilot/.last-update-check"
CURRENT=$(node -e "console.log(require('${PLUGIN_ROOT}/packages/core/package.json').version)" 2>/dev/null || echo "")

if [ -n "$CURRENT" ]; then
  should_check=false
  if [ ! -f "$LAST_CHECK" ]; then
    should_check=true
  elif [ -n "$(find "$LAST_CHECK" -mmin +360 2>/dev/null)" ]; then
    should_check=true
  fi

  if [ "$should_check" = true ]; then
    mkdir -p "${HOME}/.oss-autopilot"
    LATEST=$(gh api repos/costajohnt/oss-autopilot/releases/latest --jq '.tag_name' 2>/dev/null | sed 's/^[^0-9]*//' || echo "")
    # Validate LATEST looks like a version (digits and dots), not an error response
    if [ -n "$LATEST" ] && echo "$LATEST" | grep -qE '^[0-9]+\.'; then
      # Mark check as done only after a successful API response
      touch "$LAST_CHECK"
      if [ "$LATEST" != "$CURRENT" ]; then
        # Pull marketplace clone so /plugin update sees the new version.
        # Helper preserves dirty trees (exit 1) and reports corrupt-repo state.
        marketplace_pulled=false
        marketplace_skip_msg=""
        refresh_output=$("${SCRIPT_DIR}/safe-refresh-marketplace.sh" "${MARKETPLACE_DIR}") && refresh_rc=0 || refresh_rc=$?
        case "$refresh_rc" in
          0) marketplace_pulled=true ;;
          1) marketplace_skip_msg="$refresh_output" ;;
          2|3) : ;;  # fetch/reset failed or no clone — generic "Auto-pull failed" fires below
          *) marketplace_skip_msg="Auto-refresh helper exited unexpectedly (code ${refresh_rc})." ;;
        esac
        # Update known_marketplaces.json only if the clone actually refreshed —
        # bumping `lastUpdated` when we skipped the pull would lie about state.
        # Uses atomic write (tmp + mv) to prevent corruption on interruption.
        if [ "$marketplace_pulled" = true ]; then
          KNOWN_MP="${HOME}/.claude/plugins/known_marketplaces.json"
          if [ -f "$KNOWN_MP" ] && command -v jq &>/dev/null; then
            jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
              'if has("oss-autopilot") then .["oss-autopilot"].lastUpdated = $ts else . end' \
              "$KNOWN_MP" > "${KNOWN_MP}.tmp" \
              && mv "${KNOWN_MP}.tmp" "$KNOWN_MP" \
              || rm -f "${KNOWN_MP}.tmp"
          fi
        fi
        if [ "$marketplace_pulled" = true ]; then
          update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). Run: /plugin update oss-autopilot"
        elif [ -n "$marketplace_skip_msg" ]; then
          update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). ${marketplace_skip_msg} Then run: /plugin update oss-autopilot"
        else
          update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). Auto-pull failed. Run: cd ${MARKETPLACE_DIR} && git pull origin main, then /plugin update oss-autopilot"
        fi
        messages="${messages:+${messages}${NL}}${update_msg}"
      fi
    fi
  fi
fi

# --- Step 3: Quick PR health check ---
HEALTH=$(node "${PLUGIN_ROOT}/.claude-plugin/scripts/health-check.cjs" 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then
  messages="${messages:+${messages}${NL}}${HEALTH}"
fi

# --- Output JSON ---
if [ -n "$messages" ]; then
  # Escape for JSON: use jq if available, fall back to sed
  if command -v jq &>/dev/null; then
    escaped=$(printf '%s' "$messages" | jq -Rrs '@json | .[1:-1]')
  else
    escaped=$(printf '%s' "$messages" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ')
  fi
  cat <<EOF
{
  "systemMessage": "${escaped}",
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "${escaped}"
  }
}
EOF
else
  # Silent — no output means no system-reminder noise
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart"
  }
}
EOF
fi

exit 0
