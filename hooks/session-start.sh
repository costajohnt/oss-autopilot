#!/usr/bin/env bash
# SessionStart hook for oss-autopilot plugin
# Performs startup checks and outputs additionalContext via JSON

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

messages=""

# --- Step 1: Rebuild stale CLI bundle (if needed) ---
if [ -f "${PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ] && [ "${PLUGIN_ROOT}/packages/core/package.json" -nt "${PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ]; then
  if (cd "${PLUGIN_ROOT}/packages/core" && npm install --silent 2>/dev/null && npm run bundle --silent 2>/dev/null); then
    messages="CLI bundle rebuilt after plugin update."
  else
    messages="Warning: CLI bundle rebuild failed. Run /oss to retry, or: cd ${PLUGIN_ROOT}/packages/core && npm install && npm run bundle"
  fi
fi

# --- Step 1.5: Build dashboard SPA if missing or stale ---
DASHBOARD_INDEX="${PLUGIN_ROOT}/packages/dashboard/dist/index.html"
DASHBOARD_PKG="${PLUGIN_ROOT}/packages/dashboard/package.json"
if [ -f "${DASHBOARD_PKG}" ] && { [ ! -f "${DASHBOARD_INDEX}" ] || [ "${DASHBOARD_PKG}" -nt "${DASHBOARD_INDEX}" ]; }; then
  # Dashboard depends on @oss-autopilot/core types via workspace:* protocol.
  # Use pnpm if available (required for workspace: resolution), fall back to npm.
  if command -v pnpm &>/dev/null; then
    dashboard_build() { cd "${PLUGIN_ROOT}" && pnpm install --silent 2>/dev/null && pnpm --silent --filter @oss-autopilot/core run build 2>/dev/null && pnpm --silent --filter @oss-autopilot/dashboard run build 2>/dev/null; }
  else
    dashboard_build() { cd "${PLUGIN_ROOT}/packages/dashboard" && npm install --silent 2>/dev/null && npm run build 2>/dev/null; }
  fi
  if (dashboard_build); then
    messages="${messages:+${messages}\n}Dashboard SPA built successfully."
  else
    messages="${messages:+${messages}\n}Warning: Dashboard SPA build failed. To fix: cd ${PLUGIN_ROOT} && pnpm install && pnpm run build"
  fi
fi

# --- Step 2: Check for updates (once per day) ---
LAST_CHECK="${HOME}/.oss-autopilot/.last-update-check"
CURRENT=$(node -e "console.log(require('${PLUGIN_ROOT}/packages/core/package.json').version)" 2>/dev/null || echo "")

if [ -n "$CURRENT" ]; then
  should_check=false
  if [ ! -f "$LAST_CHECK" ]; then
    should_check=true
  elif [ -n "$(find "$LAST_CHECK" -mmin +1440 2>/dev/null)" ]; then
    should_check=true
  fi

  if [ "$should_check" = true ]; then
    mkdir -p "${HOME}/.oss-autopilot"
    touch "$LAST_CHECK"
    LATEST=$(gh api repos/costajohnt/oss-autopilot/releases/latest --jq '.tag_name' 2>/dev/null | sed 's/^[^0-9]*//' || echo "")
    # Validate LATEST looks like a version (digits and dots), not an error response
    if [ -n "$LATEST" ] && echo "$LATEST" | grep -qE '^[0-9]+\.' && [ "$LATEST" != "$CURRENT" ]; then
      update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). Run: /plugin update oss-autopilot"
      messages="${messages:+${messages}\n}${update_msg}"
    fi
  fi
fi

# --- Step 3: Quick PR health check ---
HEALTH=$(node "${PLUGIN_ROOT}/.claude-plugin/scripts/health-check.cjs" 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then
  messages="${messages:+${messages}\n}${HEALTH}"
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
