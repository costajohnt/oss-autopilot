#!/usr/bin/env bash
# SessionStart hook for oss-autopilot plugin
# Performs startup checks and outputs additionalContext via JSON

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

messages=""

# --- Step 0: Auto-refresh marketplace cache (non-blocking) ---
# Claude Code caches third-party marketplace repos as git clones but never
# auto-refreshes them, so plugin updates aren't discoverable. A background
# fetch+reset on every session keeps the cache current without blocking startup.
# Uses fetch+reset instead of pull to handle divergent branches gracefully
# (e.g. if a local commit was accidentally made in the marketplace clone).
MARKETPLACE_DIR="$HOME/.claude/plugins/marketplaces/oss-autopilot"
if [ -d "$MARKETPLACE_DIR/.git" ]; then
  (cd "$MARKETPLACE_DIR" && git fetch --quiet origin main 2>/dev/null && git reset --hard origin/main --quiet 2>/dev/null) &
fi

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
        # Pull the marketplace clone so /plugin update sees the new version
        MARKETPLACE_DIR="${HOME}/.claude/plugins/marketplaces/oss-autopilot"
        marketplace_pulled=false
        if [ -d "${MARKETPLACE_DIR}/.git" ]; then
          if git -C "${MARKETPLACE_DIR}" fetch origin main --quiet 2>/dev/null \
            && git -C "${MARKETPLACE_DIR}" reset --hard origin/main --quiet 2>/dev/null; then
            marketplace_pulled=true
          fi
        fi
        # Update known_marketplaces.json so Claude Code recognises the marketplace change.
        # Uses atomic write (tmp + mv) to prevent corruption on interruption.
        KNOWN_MP="${HOME}/.claude/plugins/known_marketplaces.json"
        if [ -f "$KNOWN_MP" ] && command -v jq &>/dev/null; then
          jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
            'if has("oss-autopilot") then .["oss-autopilot"].lastUpdated = $ts else . end' \
            "$KNOWN_MP" > "${KNOWN_MP}.tmp" \
            && mv "${KNOWN_MP}.tmp" "$KNOWN_MP" \
            || rm -f "${KNOWN_MP}.tmp"
        fi
        if [ "$marketplace_pulled" = true ]; then
          update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). Run: /plugin update oss-autopilot"
        else
          update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). Auto-pull failed. Run: cd ${MARKETPLACE_DIR} && git pull origin main, then /plugin update oss-autopilot"
        fi
        messages="${messages:+${messages}\n}${update_msg}"
      fi
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
